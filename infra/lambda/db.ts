/**
 * db.ts — the Aurora DSQL access layer for the submit handler.
 *
 * Split out of submit.ts for the same reason triageStore.mts is split out of
 * triage-feedback.mts: the handler should read as the §8.3 step list, not as
 * connection lifecycle. Everything DSQL-specific lives here.
 *
 * ---------------------------------------------------------------------------
 * NO SECRETS. THE PASSWORD IS AN IAM SIGNATURE.
 * ---------------------------------------------------------------------------
 * `@aws-sdk/dsql-signer` mints a short-lived auth token by SigV4-signing the
 * cluster hostname with the Lambda's own execution-role credentials — LOCALLY,
 * with no network call. That token is handed to postgres as the password. There
 * is no Secrets Manager entry, no SSM parameter, no rotation job and nothing to
 * leak: the credential is derived from the role at the moment it is needed, and
 * the role can only mint it because iam.tf grants `dsql:DbConnect`.
 *
 * It logs in as `feedback_ingest`, NOT `admin`. That database role holds INSERT
 * on `report` and nothing else — no SELECT, no UPDATE, no DELETE on the backlog
 * (schema.sql spells out every grant). §8.5's "the ingest path can create and
 * count; it cannot read the corpus or destroy anything" is enforced there.
 *
 * ---------------------------------------------------------------------------
 * ONE CLIENT, CACHED ACROSS WARM INVOKES
 * ---------------------------------------------------------------------------
 * Lambda runs one invocation per execution environment at a time, so there is no
 * connection race to guard and no pool to size: one `Client`, opened lazily on
 * the first request a container serves and reused by every later one. Only cold
 * requests pay for the token + TLS handshake, which is what keeps the function's
 * 10s timeout comfortable.
 *
 * The connection is retired after 45 minutes because DSQL closes connections at
 * 60. A socket-level error retires it immediately, so the next invoke reconnects
 * instead of inheriting a dead handle.
 *
 * ---------------------------------------------------------------------------
 * OPTIMISTIC CONCURRENCY: RETRY IS PART OF THE CONTRACT
 * ---------------------------------------------------------------------------
 * DSQL takes no locks. Two transactions that touch the same row both proceed,
 * and the second to commit is ABORTED with a serialization error (SQLSTATE
 * 40001). That is not an outage, it is how the database says "you raced" — so
 * every write here runs through `withRetry`, which is bounded, jittered, and
 * gives up rather than hammering. `alarms.tf` watches `OccConflicts` for the
 * case where retries stop being rare.
 */

import pg from 'pg'
import type { Client as PgClient, QueryResultRow } from 'pg'
import { DsqlSigner } from '@aws-sdk/dsql-signer'
// Explicit builtin imports, not ambient globals: infra/ is outside the repo's two
// tsconfigs and outside eslint's node-globals patterns, so `process` would be an
// undeclared identifier here. Importing it is also just more honest.
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

const { Client, types } = pg

const HOST = process.env.DSQL_ENDPOINT ?? ''
const DB_USER = process.env.DSQL_USER ?? 'feedback_ingest'
const REGION = process.env.AWS_REGION ?? 'us-east-1'

/** DSQL hangs up at 60 minutes. Retire well before, so we never race the hangup. */
const MAX_CONNECTION_AGE_MS = 45 * 60_000
/** A cold connect that has not landed in 4s is not going to save this request. */
const CONNECT_TIMEOUT_MS = 4_000
/** Four sequential statements at 3s each still fits inside the 10s function timeout. */
const STATEMENT_TIMEOUT_MS = 3_000

const MAX_ATTEMPTS = 4
const BACKOFF_MS = 25

/**
 * node-postgres returns int8 as a STRING to avoid precision loss. Every bigint in
 * this schema is an epoch-millisecond or a byte count — both exactly a double —
 * and `src/shared/feedback.ts` types all of them `number`. Convert once, here,
 * instead of casting at twenty call sites.
 */
types.setTypeParser(20, (value: string): number => Number(value))

/** CloudWatch gets structured lines; `no-console` is on repo-wide and stdout is the sink anyway. */
export function log(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(fields)}\n`)
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** postgres puts the five-character SQLSTATE on `err.code`. */
export function sqlState(err: unknown): string | null {
  const code: unknown = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** Serialization failure / deadlock: the caller raced and should simply try again. */
const RETRYABLE = new Set(['40001', '40P01'])

export async function withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run()
    } catch (err) {
      const code = sqlState(err)
      if (attempt >= MAX_ATTEMPTS || code === null || !RETRYABLE.has(code)) throw err
      log({ msg: 'db.conflict', label, attempt, code })
      await sleep(BACKOFF_MS * attempt + Math.floor(Math.random() * BACKOFF_MS))
    }
  }
}

// ---- connection ---------------------------------------------------------------------

let client: PgClient | null = null
let connectedAt = 0

/** Drop the cached connection. The next call opens a fresh one. */
export function resetClient(): void {
  const dead = client
  client = null
  if (dead) void dead.end().catch(() => undefined)
}

async function open(): Promise<PgClient> {
  const signer = new DsqlSigner({ hostname: HOST, region: REGION })
  // getDbConnectAuthToken (not ...AdminAuthToken) — this is the non-admin path,
  // and asking for the admin token would fail against `dsql:DbConnect` anyway.
  const token = await signer.getDbConnectAuthToken()
  const fresh = new Client({
    host: HOST,
    port: 5432,
    // DSQL gives exactly one database per cluster and it is always called this.
    database: 'postgres',
    user: DB_USER,
    password: token,
    ssl: { rejectUnauthorized: true },
    application_name: 'eqc-feedback-submit',
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
  })
  // A dropped socket surfaces here, NOT at the next query. Without this listener
  // it would be an unhandled 'error' event and the container would die.
  fresh.on('error', (err: Error) => {
    log({ msg: 'db.socket', error: err.message })
    if (client === fresh) client = null
  })
  await fresh.connect()
  client = fresh
  connectedAt = Date.now()
  return fresh
}

export async function connect(): Promise<PgClient> {
  if (client && Date.now() - connectedAt < MAX_CONNECTION_AGE_MS) return client
  if (client) resetClient()
  return open()
}

export async function query<R extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const c = await connect()
  const res = await c.query<R>(text, params)
  return res.rows
}

export async function execute(text: string, params: unknown[] = []): Promise<number> {
  const c = await connect()
  const res = await c.query(text, params)
  return res.rowCount ?? 0
}

/**
 * The report and its idempotency row land together or not at all. In DynamoDB
 * that took a TransactWriteItems; here it is what a transaction is for.
 */
export async function transaction<T>(run: (c: PgClient) => Promise<T>): Promise<T> {
  const c = await connect()
  await c.query('BEGIN')
  try {
    const out = await run(c)
    await c.query('COMMIT')
    return out
  } catch (err) {
    try {
      await c.query('ROLLBACK')
    } catch {
      // The rollback itself failed, which means the connection is unusable.
      resetClient()
    }
    throw err
  }
}

// ---- retention ----------------------------------------------------------------------
//
// DYNAMODB HAD TTL. DSQL HAS NOTHING. So the three counter tables — quota (3d),
// idempotency (7d), dedupe probe (2d) — are swept by the ingest path itself,
// right after a submit has cleared the quota gate.
//
// THE RULES THAT MAKE THAT SAFE:
//   * TIME-GATED — at most once per 10 minutes per warm container, so it is not
//     on the critical path of a typical request.
//   * BOUNDED — 200 rows per table per pass, via a subquery LIMIT. DSQL caps a
//     transaction at 3,000 modified rows, so an unbounded DELETE would not just
//     be slow, it would FAIL once enough rows expired. The bound is correctness.
//   * BEST EFFORT — every failure is logged and swallowed. A janitor must never
//     be able to turn a good report into a 500.
//
// Rows therefore expire *lazily*: they go away as traffic flows, not on a clock.
// If ingest goes idle they linger, which costs a few kilobytes and leaks nothing
// (an installId is an anonymous token, §9.3). That is the honest trade for not
// standing up an EventBridge rule and a second Lambda to delete six rows a week.

const SWEEP_INTERVAL_MS = 10 * 60_000
const SWEEP_LIMIT = 200

const SWEEP_TABLES = [
  { table: 'install_quota', keys: 'install_id, quota_day' },
  { table: 'report_idempotency', keys: 'install_id, client_report_id' },
  { table: 'dedupe_probe', keys: 'hash, probe_day' },
]

let lastSweepAt = 0

export async function sweepExpired(now: number): Promise<void> {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  for (const { table, keys } of SWEEP_TABLES) {
    // Table and key names are compile-time constants from the list above; the
    // only value that crosses is the parameterised cutoff.
    const sql =
      `DELETE FROM ${table} WHERE (${keys}) IN ` +
      `(SELECT ${keys} FROM ${table} WHERE expires_at < $1 LIMIT ${SWEEP_LIMIT})`
    try {
      const rows = await execute(sql, [now])
      if (rows > 0) log({ msg: 'retention.swept', table, rows })
    } catch (err) {
      log({ msg: 'retention.failed', table, error: errorMessage(err) })
    }
  }
}
