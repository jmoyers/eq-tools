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
 * STEPS ARE ORDERED CHEAPEST FIRST, and every one of them is a place to stop
 * before touching state:
 *
 *   1. size          -> 413 too_large        (before JSON.parse)
 *   2. shape         -> 400 invalid_payload  (the shared validator; {field})
 *   3. config+profile+idempotency, ONE BatchGet
 *        kill switch -> 503 closed           (message rendered verbatim)
 *        blocked     -> 403 blocked          (client stops retrying)
 *        replay      -> 200 + original reportId, upload: null
 *   4. quota         -> 429 quota_exceeded   (conditional UpdateItem, {retryAfterSec})
 *   5. mint ULID + spam score (SCORED, NEVER REJECTED — §9.5)
 *   6. TransactWrite report + idempotency item (they cannot fork)
 *   7. presigned POST, pinned to one key / 2 MB / 5 min / AES256
 *   8. 201
 *
 * WHAT THIS HANDLER CANNOT DO, by IAM (§8.5): read the corpus, list the bucket,
 * delete anything. It creates and it counts. A full compromise leaks nothing and
 * destroys nothing.
 *
 * The client is never told anything about internals: a thrown error is logged
 * and answered with a flat 500 `internal`.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { createHash } from 'node:crypto'
// Explicit builtin imports, not ambient globals: infra/ is outside the repo's two
// tsconfigs and outside eslint's node-globals patterns, so `process`/`Buffer` would
// be undeclared identifiers here. Importing them is also just more honest.
import { Buffer } from 'node:buffer'
import process from 'node:process'
import {
  MAX_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  validateSubmit,
  type SubmitErrorCode,
  type SubmitRequest,
  type Validated,
} from '../../src/shared/feedback'

const TABLE = process.env.TABLE_NAME ?? ''
const BUCKET = process.env.BUCKET_NAME ?? ''
const FALLBACK_MAX_PER_DAY = Number(process.env.MAX_PER_DAY ?? '10')

/** How long a presigned POST stays valid. Short enough that a leak is near-worthless. */
const UPLOAD_TTL_SEC = 300
/** Warm invocations reuse the CONFIG item for this long instead of re-reading it. */
const CONFIG_CACHE_MS = 60_000
const QUOTA_TTL_SEC = 3 * 24 * 60 * 60
const IDEMP_TTL_SEC = 7 * 24 * 60 * 60
const DEDUPE_TTL_SEC = 2 * 24 * 60 * 60

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
})
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

interface InstallProfile {
  blocked?: boolean
  blockedReason?: string
}

const DEFAULT_CONFIG: FeedbackConfig = {
  acceptingReports: true,
  closedMessage: 'Feedback is paused right now. Please try again later.',
  maxPerInstallPerDay: FALLBACK_MAX_PER_DAY,
}

let configCache: { at: number; value: FeedbackConfig } | null = null

/**
 * The CONFIG item is operator-written and therefore shaped by hand. Read it
 * FIELD BY FIELD with a typed fallback: a fat-fingered `acceptingReports: "false"`
 * must not silently become truthy and it must never crash ingest.
 */
function toConfig(item: Record<string, unknown> | undefined): FeedbackConfig {
  const accepting = item?.acceptingReports
  const closed = item?.closedMessage
  const max = item?.maxPerInstallPerDay
  return {
    acceptingReports:
      typeof accepting === 'boolean' ? accepting : DEFAULT_CONFIG.acceptingReports,
    closedMessage: typeof closed === 'string' ? closed : DEFAULT_CONFIG.closedMessage,
    maxPerInstallPerDay:
      typeof max === 'number' && max > 0 ? max : DEFAULT_CONFIG.maxPerInstallPerDay,
  }
}

/** CloudWatch gets structured lines; `no-console` is on repo-wide and stdout is the sink anyway. */
function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(fields)}\n`)
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
// creation order, which is what makes `--since 7d` a BETWEEN on the GSI sort key with
// no filter expression and no scan. Server-minted only; a client id is never trusted.

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
// DynamoDB row, so nothing here can change the response — triage bulk-marks later.

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
 * opposed to its meaning. If `Validated<T>` ever changes discriminant, this is the
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
  profile: InstallProfile | null
  replayReportId: string | null
}

/** Step 3: config + install profile + idempotency probe in ONE round trip. */
async function loadContext(req: SubmitRequest, now: number): Promise<LoadedContext> {
  const cached = configCache && now - configCache.at < CONFIG_CACHE_MS ? configCache.value : null
  const keys: { pk: string; sk: string }[] = [
    { pk: `INSTALL#${req.installId}`, sk: 'PROFILE' },
    { pk: `INSTALL#${req.installId}`, sk: `IDEMP#${req.clientReportId}` },
  ]
  if (!cached) keys.push({ pk: 'CONFIG', sk: 'FEEDBACK' })

  const res = await ddb.send(
    new BatchGetCommand({ RequestItems: { [TABLE]: { Keys: keys } } }),
  )
  const items = (res.Responses?.[TABLE] ?? []) as Record<string, unknown>[]
  const find = (sk: string): Record<string, unknown> | undefined =>
    items.find((i) => i.sk === sk)

  const config = cached ?? toConfig(find('FEEDBACK'))
  if (!cached) configCache = { at: now, value: config }

  const idemp = find(`IDEMP#${req.clientReportId}`)
  return {
    config,
    profile: (find('PROFILE') ?? null) as InstallProfile | null,
    replayReportId: typeof idemp?.reportId === 'string' ? idemp.reportId : null,
  }
}

/** Step 4: consume one unit of the per-install daily quota. Returns false when exhausted. */
async function consumeQuota(req: SubmitRequest, config: FeedbackConfig, now: number): Promise<boolean> {
  const max = config.maxPerInstallPerDay
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `INSTALL#${req.installId}`, sk: `QUOTA#${utcDate(now)}` },
        UpdateExpression: 'ADD #n :one, #b :bytes SET expiresAt = :ttl',
        ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
        ExpressionAttributeNames: { '#n': 'n', '#b': 'bytes' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':bytes': req.log?.bytes ?? 0,
          ':max': max,
          ':ttl': Math.floor(now / 1000) + QUOTA_TTL_SEC,
        },
      }),
    )
    return true
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false
    throw err
  }
}

/**
 * A cheap copy-paste-flood signal: the same description text arriving today from a
 * DIFFERENT install. One counter item, TTL 2 days, never blocks anything.
 */
async function duplicateDescription(req: SubmitRequest, hash: string, now: number): Promise<boolean> {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `DEDUPE#${hash}`, sk: `DAY#${utcDate(now)}` },
      UpdateExpression:
        'SET firstInstall = if_not_exists(firstInstall, :id), expiresAt = :ttl ADD #n :one',
      ExpressionAttributeNames: { '#n': 'n' },
      ExpressionAttributeValues: {
        ':id': req.installId,
        ':one': 1,
        ':ttl': Math.floor(now / 1000) + DEDUPE_TTL_SEC,
      },
      ReturnValues: 'ALL_NEW',
    }),
  )
  const first: unknown = res.Attributes?.firstInstall
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

function reportItem(req: SubmitRequest, reportId: string, score: number, now: number) {
  return {
    pk: `REPORT#${reportId}`,
    sk: 'META',
    gsi1pk: `CH#${req.env.channel}`,
    gsi1sk: reportId,
    gsi2pk: 'ST#new',
    gsi2sk: reportId,
    reportId,
    installId: req.installId,
    type: req.draft.type,
    title: req.draft.title,
    description: req.draft.description,
    contact: req.draft.contact,
    env: req.env,
    log: req.log,
    logRef: req.log ? { key: logObjectKey(reportId, now) } : null,
    clientTs: req.clientTs,
    receivedAt: now,
    status: 'new',
    spamScore: score,
  }
}

/** Step 6: the report and its idempotency key land together or not at all. */
async function writeReport(req: SubmitRequest, reportId: string, score: number, now: number): Promise<void> {
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE,
            Item: reportItem(req, reportId, score, now),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: TABLE,
            Item: {
              pk: `INSTALL#${req.installId}`,
              sk: `IDEMP#${req.clientReportId}`,
              reportId,
              expiresAt: Math.floor(now / 1000) + IDEMP_TTL_SEC,
            },
          },
        },
      ],
    }),
  )
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
  if (ctx.profile?.blocked === true) {
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

  const reportId = ulid(now)
  const hash = createHash('sha256').update(req.draft.description.trim()).digest('hex')
  const score = spamScore(req.draft.description) + ((await duplicateDescription(req, hash, now)) ? 40 : 0)

  await writeReport(req, reportId, Math.min(score, 100), now)
  const upload = req.log ? await mintUpload(reportId, now) : null
  log({ msg: 'report.created', reportId, channel: req.env.channel, score, log: req.log !== null })
  return json(201, { ok: true, reportId, upload })
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
    log({ msg: 'unhandled', error: err instanceof Error ? err.message : String(err) })
    return fail(500, 'internal', 'Something went wrong on our side.')
  }
}
