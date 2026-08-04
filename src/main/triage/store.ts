/**
 * store.ts — the I/O half of triage: Aurora DSQL + S3, directly over IAM.
 *
 * RELOCATED from `scripts/triageStore.mts` (unchanged in substance) so that the SAME code
 * backs both readers: the `triage-feedback` CLI, which still imports it, and the dev-only
 * triage tab in the app. There is exactly one implementation of "read the backlog", and the
 * two front ends cannot drift apart.
 *
 * ===========================================================================================
 * WHO CAN USE THIS: whoever holds the owner's AWS credentials. Nobody else. That is the whole
 * access-control story and it is deliberate.
 *
 *   * NO PASSWORD EXISTS. DSQL authenticates with a short-lived IAM token that
 *     `@aws-sdk/dsql-signer` derives LOCALLY from whatever credentials the process is running
 *     under — read from the launching shell's `AWS_PROFILE` (default `eqc`), exactly like the
 *     CLI. Nothing is stored in the app, nothing is rotated, nothing can be copied out of a
 *     config file — the same reason the ingest Lambda needs no secret.
 *   * A build shipped to a user has no credentials, so every statement here would fail at the
 *     IAM boundary. It also has no `@aws-sdk/*` to load in the first place: those are
 *     devDependencies, which electron-builder never packages. The dev-flag guard in
 *     `src/main/index.ts` is the third, outermost lock, not the only one.
 *   * The CLI connects as `admin` (IAM action `dsql:DbConnectAdmin`, granted to the triage
 *     role in iam.tf) because it is the operator identity: it applies the schema and it is the
 *     deletion path for `forget` and `wipe`.
 * ===========================================================================================
 *
 * THERE IS NO SERVER-SIDE READ API (D4). The dev machine has an AWS profile; this module opens
 * a postgres connection to the DSQL cluster and talks to S3 with the SDK. Building a public,
 * authenticated read endpoint would be a second thing to secure for zero benefit.
 *
 * POLITENESS, the same discipline AGENTS.md's scraper law asks of every fetcher in this repo,
 * applied to a paid API instead of someone else's server:
 *   * CACHE FIRST — `terraform output -json` is shelled out ONCE and cached in
 *     .triage/stack.json; a downloaded slice is written to .triage/slices/ and a second read
 *     never re-downloads it. Re-runs are free, and the app shares the CLI's cache.
 *   * ONE ROUND TRIP — every read is a single indexed statement with a LIMIT.
 *   * BACK OFF — DSQL is optimistic: a write that raced is aborted at commit with SQLSTATE
 *     40001 and must be retried, not hammered. `withRetry` is bounded and jittered.
 *   * IDEMPOTENT — every mutation is keyed by primary key; re-running a command converges
 *     instead of duplicating.
 *
 * PHYSICAL NAMES ARE NEVER COMMITTED. Everything comes from the Terraform outputs at run time;
 * .triage/ is gitignored.
 */

import pg from 'pg'
import type { Client as PgClient, QueryResultRow } from 'pg'
import { DsqlSigner } from '@aws-sdk/dsql-signer'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { setTimeout as sleep } from 'node:timers/promises'
import type { TriageReport } from '../../../scripts/triageCluster.mjs'
import type { AppChannelTag, FeedbackType, ReportStatus, Severity } from '../../shared/feedback'

const { Client, types } = pg

/**
 * The repo root — where `.triage/` and `infra/schema.sql` live.
 *
 * This used to be `resolve(import.meta.dirname, '..')`, one fixed hop up from `scripts/`. That
 * stopped being a single rule the moment the module gained a second caller: under `tsx` it
 * sits at `src/main/triage/`, and inside the dev app it has been bundled into `out/main/`.
 * Walking UP for the marker file is the one rule true for both, and it also survives a CLI
 * invocation from a subdirectory (which the old form handled and a bare `process.cwd()` would
 * not).
 */
function findRepoRoot(): string {
  let dir = process.cwd()
  for (;;) {
    if (existsSync(join(dir, 'infra', 'schema.sql'))) return dir
    const up = dirname(dir)
    if (up === dir) return process.cwd()
    dir = up
  }
}

const ROOT = findRepoRoot()
export const TRIAGE_DIR = join(ROOT, '.triage')
const STACK_FILE = join(TRIAGE_DIR, 'stack.json')
const SLICE_DIR = join(TRIAGE_DIR, 'slices')
export const SCHEMA_FILE = join(ROOT, 'infra', 'schema.sql')

/**
 * Same reasoning as the Lambda's db.ts: int8 comes back as a STRING by default,
 * and every bigint in this schema is an epoch-millisecond or a byte count that the
 * shared contract types as `number`.
 */
types.setTypeParser(20, (value: string): number => Number(value))

export interface Stack {
  region: string
  cluster_endpoint: string
  bucket_name: string
  triage_role_arn: string
  lambda_role_arn: string
  api_url: string
}

export interface AccessOptions {
  profile?: string
  roleArn?: string
}

const STACK_KEYS = [
  'region',
  'cluster_endpoint',
  'bucket_name',
  'triage_role_arn',
  'lambda_role_arn',
  'api_url',
] as const

/**
 * Resolve every physical name from `terraform output -json`, ONCE, and cache it.
 * Delete .triage/stack.json (or pass refresh) after an apply that renamed anything.
 */
export function loadStack(refresh = false): Stack {
  if (!refresh && existsSync(STACK_FILE)) {
    return JSON.parse(readFileSync(STACK_FILE, 'utf8')) as Stack
  }
  const raw = execFileSync('terraform', ['output', '-json'], {
    cwd: join(ROOT, 'infra'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const outputs = JSON.parse(raw) as Record<string, { value: unknown } | undefined>
  const stack = {} as Record<string, string>
  for (const key of STACK_KEYS) {
    const value = outputs[key]?.value
    if (typeof value !== 'string') {
      throw new Error(`terraform output is missing "${key}" — has the stack been applied?`)
    }
    stack[key] = value
  }
  mkdirSync(TRIAGE_DIR, { recursive: true })
  writeFileSync(STACK_FILE, `${JSON.stringify(stack, null, 2)}\n`)
  return stack as unknown as Stack
}

export type Row = Record<string, unknown>

export interface Clients {
  query: <R extends QueryResultRow = Row>(text: string, params?: unknown[]) => Promise<R[]>
  execute: (text: string, params?: unknown[]) => Promise<number>
  s3: S3Client
  stack: Stack
  close: () => Promise<void>
}

const RETRYABLE = new Set(['40001', '40P01'])
const MAX_ATTEMPTS = 4

function sqlState(err: unknown): string | null {
  const code: unknown = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      const code = sqlState(err)
      if (attempt >= MAX_ATTEMPTS || code === null || !RETRYABLE.has(code)) throw err
      await sleep(25 * attempt)
    }
  }
}

/**
 * `--profile` is usually all that is needed: the deploy profile itself performs the
 * role assumption (source_profile + role_arn in ~/.aws/config). `--role-arn` is for
 * the case where it does not — a second machine, or a future CI job. Whichever it
 * is, the same credentials sign the DSQL token AND the S3 requests.
 *
 * The connection is opened LAZILY on the first statement: `list --help` and a bad
 * argument must not cost a database round trip.
 */
export function makeClients(stack: Stack, options: AccessOptions): Clients {
  if (options.profile) process.env.AWS_PROFILE = options.profile
  const credentials = options.roleArn
    ? fromTemporaryCredentials({
        params: { RoleArn: options.roleArn, RoleSessionName: 'eq-companion-triage' },
      })
    : undefined
  const config = {
    region: stack.region,
    maxAttempts: 5,
    retryMode: 'adaptive',
    ...(credentials ? { credentials } : {}),
  }

  let client: PgClient | null = null
  const connect = async (): Promise<PgClient> => {
    if (client) return client
    const signer = new DsqlSigner({
      hostname: stack.cluster_endpoint,
      region: stack.region,
      ...(credentials ? { credentials } : {}),
    })
    const fresh = new Client({
      host: stack.cluster_endpoint,
      port: 5432,
      database: 'postgres',
      user: 'admin',
      password: await signer.getDbConnectAdminAuthToken(),
      ssl: { rejectUnauthorized: true },
      application_name: 'eq-companion-triage',
    })
    await fresh.connect()
    client = fresh
    return fresh
  }

  return {
    query: async <R extends QueryResultRow = Row>(text: string, params: unknown[] = []) => {
      const c = await connect()
      return withRetry(async () => (await c.query<R>(text, params)).rows)
    },
    execute: async (text: string, params: unknown[] = []) => {
      const c = await connect()
      return withRetry(async () => (await c.query(text, params)).rowCount ?? 0)
    },
    s3: new S3Client(config),
    stack,
    close: async () => {
      const open = client
      client = null
      if (open) await open.end()
    },
  }
}

// ---- schema ------------------------------------------------------------------------

/**
 * Statement splitter for infra/schema.sql: a statement ends at the first line whose
 * last character is `;`. That is enough because the file is authored for it (no
 * string literal ends a line with a semicolon, and DSQL has no PL/pgSQL to
 * dollar-quote) — the rule is written down at the top of schema.sql.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let buffer: string[] = []
  for (const line of sql.split(/\r?\n/)) {
    const code = line.replace(/^\s*--.*$/, '')
    if (code.trim().length === 0) continue
    buffer.push(code)
    if (code.trimEnd().endsWith(';')) {
      out.push(buffer.join('\n').trimEnd().replace(/;$/, ''))
      buffer = []
    }
  }
  if (buffer.join('').trim().length > 0) throw new Error('schema.sql ends mid-statement')
  return out
}

/** Already-exists codes: duplicate_table (also index), duplicate_object (role/grant), duplicate_schema. */
const ALREADY_EXISTS = new Set(['42P07', '42710', '42P06'])

export interface MigrateStep {
  sql: string
  status: 'applied' | 'exists'
}

/**
 * Apply the schema, ONE STATEMENT PER TRANSACTION — a DSQL law (a transaction may
 * carry only one DDL statement, and may not mix DDL with DML). node-postgres runs
 * each `query` in its own implicit transaction, so obeying the law is simply a
 * matter of never batching.
 *
 * IDEMPOTENT: an "already exists" is reported, not thrown. Anything else IS thrown,
 * with the offending statement, because a half-applied schema is worth stopping on.
 */
export async function applySchema(c: Clients, sql: string): Promise<MigrateStep[]> {
  const steps: MigrateStep[] = []
  for (const statement of splitStatements(sql)) {
    try {
      await c.execute(statement)
      steps.push({ sql: statement, status: 'applied' })
    } catch (err) {
      const code = sqlState(err)
      if (code === null || !ALREADY_EXISTS.has(code)) {
        throw new Error(`${String(err)}\n\nwhile applying:\n${statement}`)
      }
      steps.push({ sql: statement, status: 'exists' })
    }
  }
  return steps
}

// ---- reads -------------------------------------------------------------------------

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)

/** Report row -> the PII-free projection clustering and the digest work on. */
export function toTriageReport(row: Row): TriageReport {
  return {
    reportId: str(row.report_id),
    type: str(row.report_type, 'bug') as FeedbackType,
    description: str(row.description),
    appVersion: str(row.app_version, '?'),
    platform: str(row.platform, '?'),
    channel: str(row.channel, 'prod') as AppChannelTag,
    status: str(row.status, 'new') as ReportStatus,
    spamScore: num(row.spam_score),
    receivedAt: num(row.received_at),
    hasLog: row.log_json !== null && row.log_json !== undefined,
  }
}

export interface ListFilter {
  channel: AppChannelTag | 'all'
  sinceMs: number
  limit: number
  status?: ReportStatus
  type?: FeedbackType
  minScore?: number
}

/**
 * ONE indexed statement. `--since` is `received_at >= :floor` against
 * `report_by_channel (channel, received_at)`, which is what gsi1 was for.
 *
 * DELIBERATE IMPROVEMENT over the DynamoDB version, which could only key on
 * channel + time and had to filter status/type/score in JS AFTER the page limit —
 * so `--status new --limit 100` really meant "of the last 100 reports, the new
 * ones". Here the predicates are in the WHERE and the LIMIT applies to the
 * ANSWER. Same flags, same meaning, no truncation artefact.
 */
const LIST_SQL = `SELECT * FROM report
 WHERE channel = ANY($1::text[])
   AND received_at >= $2
   AND ($3::text IS NULL OR status = $3)
   AND ($4::text IS NULL OR report_type = $4)
   AND spam_score >= $5
 ORDER BY received_at DESC
 LIMIT $6`

export function listReports(c: Clients, filter: ListFilter): Promise<Row[]> {
  const channels: AppChannelTag[] = filter.channel === 'all' ? ['prod', 'dev'] : [filter.channel]
  return c.query(LIST_SQL, [
    channels,
    filter.sinceMs,
    filter.status ?? null,
    filter.type ?? null,
    filter.minScore ?? 0,
    filter.limit,
  ])
}

export async function getReport(c: Clients, reportId: string): Promise<Row | null> {
  const rows = await c.query('SELECT * FROM report WHERE report_id = $1', [reportId])
  return rows[0] ?? null
}

/**
 * `wipe --install` only. There is deliberately NO index on install_id (the plan
 * refused a third GSI for the same reason), so this is a full table read; callers
 * print a loud warning before using it (§10.2).
 */
export function reportsForInstall(c: Clients, installId: string): Promise<Row[]> {
  return c.query('SELECT * FROM report WHERE install_id = $1', [installId])
}

/**
 * The kill-switch row (§9.6), keyed read. `setAccepting` upserts it and the CLI never needed
 * to read it back — an Ops PANEL does, because a toggle that cannot show its current position
 * is a button, not a switch. Null when the seed statement has not run against this cluster.
 */
export async function getFeedbackConfig(c: Clients): Promise<Row | null> {
  const rows = await c.query(`SELECT * FROM feedback_config WHERE id = 'FEEDBACK'`)
  return rows[0] ?? null
}

/**
 * The block list. Bounded by a LIMIT like every other read here: this table has one row per
 * install ever blocked OR unblocked (a `block` followed by an `unblock` leaves a row with
 * `blocked = false`), so "everything" is not a size the UI should promise to render.
 */
export function listInstallProfiles(c: Clients, limit = 200): Promise<Row[]> {
  return c.query('SELECT * FROM install_profile ORDER BY blocked_at DESC NULLS LAST LIMIT $1', [
    limit,
  ])
}

// ---- writes ------------------------------------------------------------------------

export interface TriagePatch {
  status?: ReportStatus
  severity?: Severity
  cluster?: string
  dupeOf?: string
  note?: string
  issueUrl?: string
}

/** The triage-only columns, keyed by the patch field that writes them. */
const PATCH_COLUMN: Record<keyof TriagePatch, string> = {
  status: 'status',
  severity: 'severity',
  cluster: 'cluster_id',
  dupeOf: 'dupe_of',
  note: 'disposition',
  issueUrl: 'issue_url',
}

/** Idempotent by construction: a keyed UPDATE of exactly the fields provided. */
export async function setTriage(c: Clients, reportId: string, patch: TriagePatch): Promise<void> {
  const sets = ['triaged_at = $1']
  const values: unknown[] = [Date.now()]
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    values.push(value)
    sets.push(`${PATCH_COLUMN[key as keyof TriagePatch]} = $${String(values.length)}`)
  }
  values.push(reportId)
  const rows = await c.execute(
    `UPDATE report SET ${sets.join(', ')} WHERE report_id = $${String(values.length)}`,
    values,
  )
  // The DynamoDB version used `ConditionExpression: attribute_exists(pk)`; a typo'd
  // reportId must fail loudly rather than silently update nothing.
  if (rows === 0) throw new Error(`no such report: ${reportId}`)
}

export async function setBlocked(
  c: Clients,
  installId: string,
  blocked: boolean,
  reason: string,
): Promise<void> {
  await c.execute(
    `INSERT INTO install_profile (install_id, blocked, blocked_reason, blocked_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (install_id) DO UPDATE
        SET blocked = EXCLUDED.blocked,
            blocked_reason = EXCLUDED.blocked_reason,
            blocked_at = EXCLUDED.blocked_at`,
    [installId, blocked, reason, Date.now()],
  )
}

/**
 * The kill switch (§9.6). One statement — instant, no deploy, no release. Written
 * as an UPSERT so it works even against a cluster whose config row was never
 * seeded; `$2 IS NULL` keeps the existing message when `--message` is omitted.
 */
export async function setAccepting(c: Clients, accepting: boolean, message?: string): Promise<void> {
  await c.execute(
    `INSERT INTO feedback_config (id, accepting, closed_message, max_per_install_per_day)
     VALUES ('FEEDBACK', $1, COALESCE($2::text, 'Feedback is paused right now. Please try again later.'), 10)
     ON CONFLICT (id) DO UPDATE
        SET accepting = EXCLUDED.accepting,
            closed_message = COALESCE($2::text, feedback_config.closed_message)`,
    [accepting, message ?? null],
  )
}

/**
 * `forget` (§3.5): stamp the report as redacted. The caller has just deleted the log
 * slice object; this records on the row that it happened, so a later reader can tell a
 * report that never attached a slice from one whose slice was destroyed on request.
 *
 * IT NO LONGER CLEARS A CONTACT FIELD because there is no longer one to clear — `title`
 * and `contact` left the wire contract and then the schema. The description stays, as it
 * always did: it IS the bug report.
 */
export async function stampRedacted(c: Clients, reportId: string): Promise<void> {
  const rows = await c.execute('UPDATE report SET redacted_at = $1 WHERE report_id = $2', [
    Date.now(),
    reportId,
  ])
  if (rows === 0) throw new Error(`no such report: ${reportId}`)
}

export async function deleteReportRow(c: Clients, reportId: string): Promise<void> {
  await c.execute('DELETE FROM report WHERE report_id = $1', [reportId])
}

// ---- the log objects ---------------------------------------------------------------

export function logKeyOf(row: Row): string | null {
  const key = str(row.log_key)
  return key.length > 0 ? key : null
}

/** Did the upload actually land? One HeadObject, which is why no S3 event Lambda exists. */
export async function logObjectExists(c: Clients, key: string): Promise<boolean> {
  try {
    await c.s3.send(new HeadObjectCommand({ Bucket: c.stack.bucket_name, Key: key }))
    return true
  } catch {
    return false
  }
}

/**
 * Download + gunzip a slice to .triage/slices/<reportId>.log. CACHED: a second call
 * is a no-op. The file is gitignored twice over (`.triage/` and the blanket `*.log`)
 * and its contents never reach a public issue.
 */
export async function downloadSlice(c: Clients, reportId: string, key: string): Promise<string> {
  mkdirSync(SLICE_DIR, { recursive: true })
  const dest = join(SLICE_DIR, `${reportId}.log`)
  if (existsSync(dest)) return dest
  const res = await c.s3.send(new GetObjectCommand({ Bucket: c.stack.bucket_name, Key: key }))
  if (!res.Body) throw new Error(`S3 returned no body for ${key}`)
  const gz = Buffer.from(await res.Body.transformToByteArray())
  writeFileSync(dest, gunzipSync(gz))
  return dest
}

export async function deleteSlice(c: Clients, key: string): Promise<void> {
  await c.s3.send(new DeleteObjectCommand({ Bucket: c.stack.bucket_name, Key: key }))
}
