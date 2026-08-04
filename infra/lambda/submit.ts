/**
 * POST /v1/feedback — the ENTIRE public surface of this product's cloud (§8).
 *
 * ONE VALIDATOR, CLIENT AND SERVER. `validateSubmit` is imported from
 * src/shared/feedback.ts — the same pure function the dialog runs before it
 * enables Send and the main process runs before it opens a socket. That is the
 * whole reason this handler is TypeScript in this repo instead of a hand-written
 * bundle in a second one: a change to the request shape is ONE commit that moves
 * the contract, the client and the server together. infra/build.mjs bundles it
 * with esbuild; nothing here is transpiled by hand.
 *
 * THE STORE IS AURORA DSQL (serverless postgres). The step order below is
 * unchanged from the DynamoDB version — it was never about DynamoDB, it was
 * about stopping as early as possible — but every step is now one SQL statement
 * instead of one item operation, and connection/retry/retention live in ./db.ts.
 *
 * STEPS ARE ORDERED CHEAPEST FIRST, and every one of them is a place to stop
 * before touching state:
 *
 *   1. size          -> 413 too_large        (before JSON.parse)
 *   2. shape         -> 400 invalid_payload  (the shared validator; {field})
 *   3. config+profile+idempotency, ONE round trip
 *        kill switch -> 503 closed           (message rendered verbatim)
 *        blocked     -> 403 blocked          (client stops retrying)
 *        replay      -> 200 + original reportId, upload: null
 *   4. quota         -> 429 quota_exceeded   (guarded UPSERT, {retryAfterSec})
 *   5. mint ULID + spam score (SCORED, NEVER REJECTED — §9.5)
 *   6. ONE TRANSACTION: report + idempotency row (they cannot fork)
 *   7. presigned POST, pinned to one key / 2 MB / 5 min / AES256
 *   8. 201
 *
 * WHAT THIS HANDLER CANNOT DO, by GRANT (§8.5): read the corpus, update or
 * delete a report, list the bucket. It logs in as the `feedback_ingest` database
 * role, which holds INSERT on `report` and nothing else. It creates and it
 * counts. A full compromise leaks nothing and destroys nothing.
 *
 * The client is never told anything about internals: a thrown error is logged
 * and answered with a flat 500 `internal`.
 */

import { S3Client } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { createHash } from 'node:crypto'
// Explicit builtin imports, not ambient globals: infra/ is outside the repo's two
// tsconfigs and outside eslint's node-globals patterns, so `process`/`Buffer` would
// be undeclared identifiers here. Importing them is also just more honest.
import { Buffer } from 'node:buffer'
import process from 'node:process'
import {
  errorMessage,
  execute,
  log,
  query,
  resetClient,
  sqlState,
  sweepExpired,
  transaction,
  withRetry,
} from './db'
import {
  MAX_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  validateSubmit,
  type SubmitErrorCode,
  type SubmitRequest,
  type Validated,
} from '../../src/shared/feedback'

const BUCKET = process.env.BUCKET_NAME ?? ''
const FALLBACK_MAX_PER_DAY = Number(process.env.MAX_PER_DAY ?? '10')

/** How long a presigned POST stays valid. Short enough that a leak is near-worthless. */
const UPLOAD_TTL_SEC = 300
/** Warm invocations reuse the CONFIG row for this long instead of re-reading it. */
const CONFIG_CACHE_MS = 60_000
/** Retention windows (§3.5). No TTL exists in DSQL — db.ts sweeps on these stamps. */
const QUOTA_TTL_MS = 3 * 24 * 60 * 60 * 1000
const IDEMP_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEDUPE_TTL_MS = 2 * 24 * 60 * 60 * 1000

/** postgres unique_violation — here it can only be a dead-heat idempotent retry. */
const UNIQUE_VIOLATION = '23505'

const s3 = new S3Client({})

// ---- the API Gateway payload-2.0 slice we actually use ------------------------------
// Deliberately hand-declared rather than pulling in @types/aws-lambda: three fields is
// not worth a dependency, and a narrow local type cannot drift into "trust the event".

interface HttpEvent {
  body?: string
  isBase64Encoded?: boolean
}

interface HttpResult {
  statusCode: number
  headers: Record<string, string>
  body: string
}

interface FeedbackConfig {
  acceptingReports: boolean
  closedMessage: string
  maxPerInstallPerDay: number
}

const DEFAULT_CONFIG: FeedbackConfig = {
  acceptingReports: true,
  closedMessage: 'Feedback is paused right now. Please try again later.',
  maxPerInstallPerDay: FALLBACK_MAX_PER_DAY,
}

let configCache: { at: number; value: FeedbackConfig } | null = null

/** The shape of the one row step 3 reads. Every column is a scalar subquery, so all nullable. */
interface ContextRow {
  accepting?: boolean | null
  closed_message?: string | null
  max_per_day?: number | null
  blocked: boolean | null
  replay_report_id: string | null
}

/**
 * The config row is operator-written and therefore shaped by hand. Read it
 * FIELD BY FIELD with a typed fallback: a hand-edited `accepting` that came back
 * NULL (or a row that does not exist yet) must not silently become truthy and it
 * must never crash ingest.
 */
function toConfig(row: ContextRow | undefined): FeedbackConfig {
  const accepting = row?.accepting
  const closed = row?.closed_message
  const max = row?.max_per_day
  return {
    acceptingReports:
      typeof accepting === 'boolean' ? accepting : DEFAULT_CONFIG.acceptingReports,
    closedMessage: typeof closed === 'string' ? closed : DEFAULT_CONFIG.closedMessage,
    maxPerInstallPerDay:
      typeof max === 'number' && max > 0 ? max : DEFAULT_CONFIG.maxPerInstallPerDay,
  }
}

function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function fail(
  statusCode: number,
  error: SubmitErrorCode,
  message: string,
  extra?: { field?: string; retryAfterSec?: number },
): HttpResult {
  return json(statusCode, { ok: false, error, message, ...extra })
}

// ---- ULID ---------------------------------------------------------------------------
// 48-bit timestamp + 80 bits of randomness, Crockford base32. Lexicographic order IS
// creation order. Under DynamoDB that property was load-bearing (it WAS the GSI sort
// key); here `received_at` carries the timeline and the ULID is simply a compact,
// collision-free, time-ordered public id. Server-minted only; a client id is never
// trusted.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeBase32(value: number, length: number): string {
  let out = ''
  let rest = value
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[rest % 32] + out
    rest = Math.floor(rest / 32)
  }
  return out
}

function ulid(now: number): string {
  const random = Array.from({ length: 16 }, () =>
    CROCKFORD[Math.floor(Math.random() * 32)],
  ).join('')
  return encodeBase32(now, 10) + random
}

// ---- spam scoring (§9.5) ------------------------------------------------------------
// SCORED, NEVER REJECTED. A wrongly-rejected real bug report costs far more than a
// database row, so nothing here can change the response — triage bulk-marks later.

const URL_RE = /https?:\/\//g
const REPEAT_RE = /(.)\1{20,}/

function distinctWords(text: string): number {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length > 0),
  ).size
}

function ratio(text: string, re: RegExp): number {
  if (text.length === 0) return 0
  return (text.match(re) ?? []).length / text.length
}

const SPAM_RULES: { points: number; hit: (d: string) => boolean }[] = [
  { points: 20, hit: (d) => d.length < 25 },
  { points: 25, hit: (d) => distinctWords(d) < 4 },
  { points: 30, hit: (d) => (d.match(URL_RE) ?? []).length > 3 },
  { points: 25, hit: (d) => ratio(d, /[^\p{ASCII}]/gu) > 0.5 || REPEAT_RE.test(d) },
  { points: 15, hit: (d) => d.length >= 40 && ratio(d, /[A-Z]/g) > 0.8 },
]

export function spamScore(description: string): number {
  const d = description.trim()
  const total = SPAM_RULES.reduce((sum, r) => sum + (r.hit(d) ? r.points : 0), 0)
  return Math.min(total, 100)
}

// ---- steps --------------------------------------------------------------------------

/**
 * ADAPTER — the ONE place this handler touches the validator's return SHAPE (as
 * opposed to its meaning). If `Validated<T>` ever changes discriminant, this is the
 * only line that has to move.
 */
function validate(body: unknown): Validated<SubmitRequest> {
  return validateSubmit(body)
}

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function secondsToUtcMidnight(now: number): number {
  const midnight = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1,
  )
  return Math.max(1, Math.ceil((midnight - now) / 1000))
}

interface LoadedContext {
  config: FeedbackConfig
  blocked: boolean
  replayReportId: string | null
}

const PROFILE_AND_IDEMP = `
  (SELECT blocked FROM install_profile WHERE install_id = $1)        AS blocked,
  (SELECT report_id FROM report_idempotency
     WHERE install_id = $1 AND client_report_id = $2)                AS replay_report_id`

/** Everything step 3 needs, as scalar subqueries in ONE statement = ONE round trip. */
const CONTEXT_SQL = `SELECT
  (SELECT accepting               FROM feedback_config WHERE id = 'FEEDBACK') AS accepting,
  (SELECT closed_message          FROM feedback_config WHERE id = 'FEEDBACK') AS closed_message,
  (SELECT max_per_install_per_day FROM feedback_config WHERE id = 'FEEDBACK') AS max_per_day,
${PROFILE_AND_IDEMP}`

/** Warm variant: the config is cached for 60s, so do not pay to read it again. */
const CONTEXT_CACHED_SQL = `SELECT${PROFILE_AND_IDEMP}`

/** Step 3: config + install profile + idempotency probe in ONE round trip. */
async function loadContext(req: SubmitRequest, now: number): Promise<LoadedContext> {
  const cached =
    configCache && now - configCache.at < CONFIG_CACHE_MS ? configCache.value : null
  const rows = await query<ContextRow>(cached ? CONTEXT_CACHED_SQL : CONTEXT_SQL, [
    req.installId,
    req.clientReportId,
  ])
  const row = rows[0]

  const config = cached ?? toConfig(row)
  if (!cached) configCache = { at: now, value: config }

  return {
    config,
    blocked: row?.blocked === true,
    replayReportId: row?.replay_report_id ?? null,
  }
}

/**
 * Step 4: consume one unit of the per-install daily quota. Returns false when
 * exhausted. The check and the increment are ONE statement — there is no
 * read-modify-write window for a snapshot to sit inside.
 *
 * WHY THE CAP CANNOT BE EXCEEDED under DSQL's fixed Repeatable Read + optimistic
 * concurrency. Two submits from one install on one day can race in exactly two
 * ways, and neither of them over-counts:
 *
 *   1. THEY SERIALIZE. The second transaction's snapshot already contains the
 *      first's increment, so `install_quota.n < :max` is evaluated against the
 *      real current count. At the cap the DO UPDATE's WHERE is false, no row is
 *      returned, and the request is refused. This is the ordinary path.
 *   2. THEY CONFLICT. Both read the same row from the same snapshot; DSQL takes
 *      no locks, detects the write-write conflict AT COMMIT, and aborts one with
 *      SQLSTATE 40001. The loser never committed, so nothing was double-counted
 *      and nothing was lost.
 *
 * There is no third case. What case 2 costs is a spurious 500 for a user who did
 * nothing wrong, which is why this runs inside `withRetry` — THE RETRY IS FOR THE
 * CALLER'S SAKE, NOT FOR THE CAP'S. On retry the racer lands in case 1 and gets
 * the honest answer. The INSERT arm is covered by the same reasoning through the
 * primary key: two first-of-the-day submits cannot both insert.
 */
const QUOTA_SQL = `INSERT INTO install_quota (install_id, quota_day, n, bytes, expires_at)
VALUES ($1, $2, 1, $3, $4)
ON CONFLICT (install_id, quota_day) DO UPDATE
   SET n          = install_quota.n + 1,
       bytes      = install_quota.bytes + EXCLUDED.bytes,
       expires_at = EXCLUDED.expires_at
 WHERE install_quota.n < $5
RETURNING n`

async function consumeQuota(
  req: SubmitRequest,
  config: FeedbackConfig,
  now: number,
): Promise<boolean> {
  const consumed = await withRetry('quota', () =>
    execute(QUOTA_SQL, [
      req.installId,
      utcDate(now),
      req.log?.bytes ?? 0,
      now + QUOTA_TTL_MS,
      config.maxPerInstallPerDay,
    ]),
  )
  // Zero rows can only mean the DO UPDATE's guard was false: the cap is spent.
  return consumed > 0
}

/**
 * A cheap copy-paste-flood signal: the same description text arriving today from a
 * DIFFERENT install. One counter row, swept after 2 days, never blocks anything.
 * `first_install` is only ever set by the INSERT arm, so the RETURNING value is
 * always the FIRST install to send this text today — which is the whole question.
 */
const DEDUPE_SQL = `INSERT INTO dedupe_probe (hash, probe_day, first_install, n, expires_at)
VALUES ($1, $2, $3, 1, $4)
ON CONFLICT (hash, probe_day) DO UPDATE
   SET n = dedupe_probe.n + 1
RETURNING first_install`

async function duplicateDescription(
  req: SubmitRequest,
  hash: string,
  now: number,
): Promise<boolean> {
  const rows = await withRetry('dedupe', () =>
    query<{ first_install: string }>(DEDUPE_SQL, [
      hash,
      utcDate(now),
      req.installId,
      now + DEDUPE_TTL_MS,
    ]),
  )
  const first = rows[0]?.first_install
  return typeof first === 'string' && first !== req.installId
}

/**
 * Date-partitioned so a lifecycle rule, an `aws s3 ls` and a "wipe last Tuesday's
 * flood" are all trivial. Computed BEFORE the row is written and stored on it, so
 * triage can find (and HeadObject, and delete) the object without guessing.
 */
function logObjectKey(reportId: string, now: number): string {
  const d = new Date(now)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `logs/${d.getUTCFullYear()}/${mm}/${dd}/${reportId}.log.gz`
}

// The triage-only columns (severity, cluster_id, dupe_of, disposition, issue_url,
// triaged_at, redacted_at) are deliberately absent: ingest never writes them, and
// the GRANT list says INSERT, so it could not amend them afterwards either.
const REPORT_SQL = `INSERT INTO report (
  report_id, install_id, report_type, title, description, contact,
  channel, app_version, platform, env_json, log_json, log_key,
  client_ts, received_at, spam_score, status
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'new')`

const IDEMP_SQL = `INSERT INTO report_idempotency
  (install_id, client_report_id, report_id, expires_at)
VALUES ($1, $2, $3, $4)`

const IDEMP_LOOKUP_SQL = `SELECT report_id FROM report_idempotency
 WHERE install_id = $1 AND client_report_id = $2`

function reportParams(
  req: SubmitRequest,
  reportId: string,
  score: number,
  now: number,
): unknown[] {
  return [
    reportId,
    req.installId,
    req.draft.type,
    // title/contact were retired from the wire contract; the columns stay for legacy rows.
    null,
    req.draft.description,
    null,
    req.env.channel,
    req.env.appVersion,
    req.env.platform,
    JSON.stringify(req.env),
    req.log ? JSON.stringify(req.log) : null,
    req.log ? logObjectKey(reportId, now) : null,
    req.clientTs,
    now,
    score,
  ]
}

/**
 * Step 6: the report and its idempotency row land together or not at all.
 *
 * A dead-heat retry (the same clientReportId submitted twice, concurrently, from
 * one install) loses the race on the idempotency PRIMARY KEY rather than forking
 * into two reports — which is stronger than the TransactWriteItems this replaces,
 * where the second write simply overwrote the first's pointer. The loser reads
 * back the WINNER's id and answers as an idempotent replay.
 */
async function writeReport(
  req: SubmitRequest,
  reportId: string,
  score: number,
  now: number,
): Promise<{ reportId: string; created: boolean }> {
  try {
    await withRetry('report', () =>
      transaction(async (c) => {
        await c.query(REPORT_SQL, reportParams(req, reportId, score, now))
        await c.query(IDEMP_SQL, [
          req.installId,
          req.clientReportId,
          reportId,
          now + IDEMP_TTL_MS,
        ])
      }),
    )
    return { reportId, created: true }
  } catch (err) {
    if (sqlState(err) !== UNIQUE_VIOLATION) throw err
    const rows = await query<{ report_id: string }>(IDEMP_LOOKUP_SQL, [
      req.installId,
      req.clientReportId,
    ])
    const won = rows[0]?.report_id
    if (won === undefined) throw err
    return { reportId: won, created: false }
  }
}

/**
 * Step 7 (§8.4): POST, not PUT — only the POST policy language supports
 * `content-length-range`. A presigned PUT accepts anything up to 5 GB, which would
 * turn the whole cost model into a promise. The key is EXACT (not starts-with), so
 * one presign writes exactly one object at exactly one path.
 */
async function mintUpload(reportId: string, now: number) {
  const key = logObjectKey(reportId, now)
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: BUCKET,
    Key: key,
    Expires: UPLOAD_TTL_SEC,
    Fields: {
      'Content-Type': 'application/gzip',
      'x-amz-server-side-encryption': 'AES256',
    },
    Conditions: [
      ['content-length-range', 1, MAX_UPLOAD_BYTES],
      ['eq', '$Content-Type', 'application/gzip'],
      ['eq', '$x-amz-server-side-encryption', 'AES256'],
    ],
  })
  return { url, fields, key, expiresInSec: UPLOAD_TTL_SEC }
}

// ---- handler ------------------------------------------------------------------------

async function accept(req: SubmitRequest, now: number): Promise<HttpResult> {
  const ctx = await loadContext(req, now)
  if (!ctx.config.acceptingReports) {
    return fail(503, 'closed', ctx.config.closedMessage)
  }
  if (ctx.blocked) {
    return fail(403, 'blocked', 'This install is blocked from submitting feedback.')
  }
  if (ctx.replayReportId) {
    return json(200, { ok: true, reportId: ctx.replayReportId, upload: null })
  }
  if (!(await consumeQuota(req, ctx.config, now))) {
    return fail(429, 'quota_exceeded', 'Daily report limit reached for this install.', {
      retryAfterSec: secondsToUtcMidnight(now),
    })
  }
  // The one place the retention janitor runs: past the quota gate (so a flood of
  // refusals cannot trigger it) and before anything that matters. Best effort.
  await sweepExpired(now)

  const hash = createHash('sha256').update(req.draft.description.trim()).digest('hex')
  const score =
    spamScore(req.draft.description) + ((await duplicateDescription(req, hash, now)) ? 40 : 0)

  const written = await writeReport(req, ulid(now), Math.min(score, 100), now)
  if (!written.created) {
    return json(200, { ok: true, reportId: written.reportId, upload: null })
  }
  const upload = req.log ? await mintUpload(written.reportId, now) : null
  log({
    msg: 'report.created',
    reportId: written.reportId,
    channel: req.env.channel,
    score,
    log: req.log !== null,
  })
  return json(201, { ok: true, reportId: written.reportId, upload })
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  const now = Date.now()
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '')
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      return fail(413, 'too_large', 'Report body is too large.')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      return fail(400, 'invalid_payload', 'Body is not valid JSON.')
    }

    const v = validate(parsed)
    if (!v.ok) return fail(400, 'invalid_payload', v.message, { field: v.field })
    return await accept(v.value, now)
  } catch (err) {
    // A failure we did not classify may well be the CONNECTION. Retiring it costs
    // one handshake on the next invoke and stops a dead socket poisoning a warm
    // container for its whole lifetime.
    if (sqlState(err) === null) resetClient()
    log({ msg: 'unhandled', error: errorMessage(err) })
    return fail(500, 'internal', 'Something went wrong on our side.')
  }
}
