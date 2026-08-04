/**
 * POST /v1/telemetry — usage analytics ingest (docs/plans/usage-analytics.md wave A2).
 *
 * A SECOND FUNCTION, NOT A SECOND ROUTE ON THE FIRST. The two handlers share this repo, this
 * bundler and ./db.ts, and share nothing else — different IAM role, different DATABASE role,
 * different log group, different alarms. The reason is the one that shaped `feedback_ingest`:
 * what a public write endpoint may do should be readable as a GRANT list. Folding telemetry
 * into `submit` would have given the telemetry path `INSERT ON report` and an S3 presign
 * permission it has no use for, and given the feedback path write access to the counters — for
 * the saving of one 3 MB zip. (`infra/README.md` states the choice; `iam.tf` enforces it.)
 *
 * ONE VALIDATOR, CLIENT AND SERVER, exactly as feedback does it: `validateTelemetryBatch` is
 * IMPORTED from src/shared/telemetryValidate.ts — the same pure function the renderer's
 * `track()` shim and the main-process IPC handler already run. It does not sanitize an object,
 * it CONSTRUCTS one field by field from the schema, so a field the schema has no room for
 * cannot survive the boundary however it was smuggled in.
 *
 * STEPS, CHEAPEST FIRST, and every one is a place to stop before touching state:
 *
 *   1. size            -> 413 too_large        (BEFORE JSON.parse)
 *   2. json            -> 400 invalid_event
 *   3. shape           -> 400 invalid_event    (the shared validator; {field})
 *   4. empty batch     -> 202 accepted:0       (legal, and costs no round trip)
 *   5. config          -> 503 closed           (kill switch `telemetry_accepting`, seeded FALSE)
 *   6. install UPSERT  -> 429 quota_exceeded   (guarded; also mints the per-day facts)
 *   7. AGGREGATE       -> counter UPSERTs, one transaction
 *   8. EMF             -> the near-real-time view
 *   9. 202
 *
 * THERE IS NO RAW EVENT STORE (T6). The batch exists in this process for the length of one
 * invocation and is then garbage; what persists is counters. Nothing here logs an analyticsId,
 * and the function's own CloudWatch log (14 days) carries counts only.
 */

import { Buffer } from 'node:buffer'
import process from 'node:process'
import { errorMessage, log, query, resetClient, sqlState, transaction, withRetry } from './db'
import { emit } from './emf'
import { MAX_TELEMETRY_BODY_BYTES } from '../../src/shared/telemetry'
import type { TelemetryBatch } from '../../src/shared/telemetry'
import { validateTelemetryBatch } from '../../src/shared/telemetryValidate'
import {
  rollupBatch,
  utcDay,
  USAGE_METRICS,
  type FunnelCounter,
  type RollupResult,
  type UsageCounter
} from '../../src/shared/telemetryRollup'

/** Warm invocations reuse the CONFIG row for this long instead of re-reading it. */
const CONFIG_CACHE_MS = 60_000
/** Cold-start fallback for the daily per-id event cap when the config column is NULL. */
const FALLBACK_MAX_EVENTS_PER_DAY = Number(process.env.MAX_EVENTS_PER_DAY ?? '20000')
/**
 * Rows per UPSERT statement. A maximal batch collapses to a few dozen distinct (metric, dim)
 * pairs, so this is a ceiling nothing normally reaches — it exists because DSQL caps a
 * transaction at 3,000 MODIFIED ROWS and an unbounded multi-row VALUES list would eventually
 * FAIL rather than merely be slow. Same reasoning as db.ts's sweep bound.
 */
const UPSERT_CHUNK = 100
/** Funnel-step EMF documents per invocation. A dimension value is a billed metric. */
const MAX_FUNNEL_EMF = 20

type TelemetryErrorCode =
  | 'too_large'
  | 'invalid_event'
  | 'closed'
  | 'quota_exceeded'
  | 'internal'

interface HttpEvent {
  body?: string
  isBase64Encoded?: boolean
}

interface HttpResult {
  statusCode: number
  headers: Record<string, string>
  body: string
}

interface TelemetryConfig {
  accepting: boolean
  maxEventsPerIdPerDay: number
}

/**
 * CLOSED IS THE DEFAULT, and it is the default in three independent places: the seed statement
 * writes false, the column is nullable and a NULL reads as false HERE, and a missing config row
 * reads as false too. A telemetry endpoint that fails OPEN would collect from users whose
 * server-side switch nobody has ever set.
 */
const DEFAULT_CONFIG: TelemetryConfig = {
  accepting: false,
  maxEventsPerIdPerDay: FALLBACK_MAX_EVENTS_PER_DAY
}

let configCache: { at: number; value: TelemetryConfig } | null = null

interface ConfigRow {
  telemetry_accepting?: boolean | null
  max_events_per_id_per_day?: number | null
}

/** Field by field, with a typed fallback: an operator-written row can hold anything. */
function toConfig(row: ConfigRow | undefined): TelemetryConfig {
  const accepting = row?.telemetry_accepting
  const max = row?.max_events_per_id_per_day
  return {
    accepting: accepting === true,
    maxEventsPerIdPerDay:
      typeof max === 'number' && max > 0 ? max : DEFAULT_CONFIG.maxEventsPerIdPerDay
  }
}

function json(statusCode: number, body: unknown): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }
}

function fail(
  statusCode: number,
  error: TelemetryErrorCode,
  message: string,
  extra?: { field?: string }
): HttpResult {
  return json(statusCode, { ok: false, error, message, ...extra })
}

// ---- step 5: the kill switch --------------------------------------------------------

const CONFIG_SQL = `SELECT telemetry_accepting, max_events_per_id_per_day
  FROM feedback_config WHERE id = 'FEEDBACK'`

async function loadConfig(now: number): Promise<TelemetryConfig> {
  if (configCache && now - configCache.at < CONFIG_CACHE_MS) return configCache.value
  const rows = await query<ConfigRow>(CONFIG_SQL)
  const value = toConfig(rows[0])
  configCache = { at: now, value }
  return value
}

// ---- step 6: the install row, the day facts and the cap, in ONE statement ------------

/**
 * The per-id row IS the quota counter (schema.sql says why), so one guarded UPSERT does four
 * jobs: create-or-touch the row, advance `days_seen` on a new day, consume the daily event cap,
 * and REPORT BACK the two facts the rollup cannot know for itself.
 *
 * WHY THE CAP CANNOT BE EXCEEDED under DSQL's fixed Repeatable Read + optimistic concurrency —
 * the same two-case argument submit.ts makes for `install_quota`:
 *   1. THEY SERIALIZE. The second transaction sees the first's increment, evaluates the guard
 *      against the real count, and is refused at the cap.
 *   2. THEY CONFLICT. Both read one snapshot; DSQL detects the write-write conflict AT COMMIT
 *      and aborts one with SQLSTATE 40001. The loser never committed, so nothing double-counted.
 * `withRetry` exists for the CALLER's sake in case 2, not for the cap's: on retry the racer
 * lands in case 1 and gets the honest answer.
 *
 * The cap is a FLOOR, not a ceiling: the guard reads the count BEFORE this batch, so an id at
 * 19,999 events may still land one full batch. Bounding it exactly would mean rejecting a
 * partially-counted batch, which is a worse answer than an overshoot of at most MAX_BATCH_EVENTS.
 */
const INSTALL_SQL = `INSERT INTO analytics_install (
  analytics_id, first_seen_day, last_seen_day, days_seen, app_version, channel, quota_day, quota_n)
VALUES ($1, $2, $2, 1, $3, $4, $2, $5)
ON CONFLICT (analytics_id) DO UPDATE
   SET last_seen_day = GREATEST(analytics_install.last_seen_day, $2),
       days_seen     = analytics_install.days_seen
                     + (CASE WHEN analytics_install.last_seen_day < $2 THEN 1 ELSE 0 END),
       app_version   = EXCLUDED.app_version,
       channel       = EXCLUDED.channel,
       quota_day     = $2,
       quota_n       = (CASE WHEN analytics_install.quota_day = $2
                             THEN analytics_install.quota_n ELSE 0 END) + $5
 WHERE analytics_install.quota_day <> $2 OR analytics_install.quota_n < $6
RETURNING first_seen_day, quota_n`

interface InstallRow {
  first_seen_day: string
  quota_n: number
}

export interface InstallFacts {
  firstOfDay: boolean
  newInstall: boolean
}

/**
 * Null means the cap is spent (zero rows can only be the DO UPDATE's guard being false).
 *
 * THE INFERENCE, spelled out because it is doing real work with no extra column: `quota_n` is
 * reset to this batch's event count on the first batch of a day and accumulates thereafter, so
 * `quota_n === events` IS "first batch today" — and an empty batch, which would make that
 * reasoning false, is refused before this statement ever runs (step 4).
 */
async function touchInstall(
  batch: TelemetryBatch,
  config: TelemetryConfig,
  day: string
): Promise<InstallFacts | null> {
  const events = batch.events.length
  const rows = await withRetry('install', () =>
    query<InstallRow>(INSTALL_SQL, [
      batch.env.analyticsId,
      day,
      batch.env.appVersion,
      batch.env.channel,
      events,
      config.maxEventsPerIdPerDay
    ])
  )
  const row = rows[0]
  if (row === undefined) return null
  const firstOfDay = row.quota_n === events
  return { firstOfDay, newInstall: firstOfDay && row.first_seen_day === day }
}

// ---- step 7: the aggregate UPSERTs ---------------------------------------------------

/** `($1,$2,$3,$4),($1,$5,$6,$7)…` — the day is parameter 1 and is shared by every tuple. */
function tuples(rows: number, columns: number): string {
  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    const cells = ['$1']
    for (let c = 0; c < columns; c++) cells.push(`$${String(2 + r * columns + c)}`)
    out.push(`(${cells.join(',')})`)
  }
  return out.join(',')
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const COUNTER_HEAD = 'INSERT INTO usage_daily (day, metric, dim, n) VALUES '
const COUNTER_TAIL = ' ON CONFLICT (day, metric, dim) DO UPDATE SET n = usage_daily.n + EXCLUDED.n'

const FUNNEL_HEAD =
  'INSERT INTO usage_funnel_daily (day, funnel, step, outcome, app_version, n) VALUES '
const FUNNEL_TAIL =
  ' ON CONFLICT (day, funnel, step, outcome, app_version) DO UPDATE' +
  ' SET n = usage_funnel_daily.n + EXCLUDED.n'

/**
 * Every counter for this batch, in ONE transaction so a batch is counted completely or not at
 * all — a half-applied batch would put a funnel step in the table with no session beside it and
 * quietly bend a conversion rate.
 *
 * The UPSERTs are additive (`n = existing + EXCLUDED.n`), so a retried transaction after a
 * commit-time abort re-adds nothing: the aborted attempt never committed. That is the only
 * at-most-once property this path needs, and it is the database's, not a flag's.
 */
async function writeCounters(day: string, roll: RollupResult): Promise<void> {
  const counterChunks = chunk<UsageCounter>(roll.counters, UPSERT_CHUNK)
  const funnelChunks = chunk<FunnelCounter>(roll.funnels, UPSERT_CHUNK)
  if (counterChunks.length === 0 && funnelChunks.length === 0) return
  await withRetry('counters', () =>
    transaction(async (c) => {
      for (const rows of counterChunks) {
        const params: unknown[] = [day]
        for (const r of rows) params.push(r.metric, r.dim, r.n)
        await c.query(`${COUNTER_HEAD}${tuples(rows.length, 3)}${COUNTER_TAIL}`, params)
      }
      for (const rows of funnelChunks) {
        const params: unknown[] = [day]
        for (const r of rows) params.push(r.funnel, r.step, r.outcome, r.appVersion, r.n)
        await c.query(`${FUNNEL_HEAD}${tuples(rows.length, 5)}${FUNNEL_TAIL}`, params)
      }
    })
  )
}

// ---- step 8: the near-real-time view --------------------------------------------------

const counterOf = (roll: RollupResult, metric: string): number =>
  roll.counters.filter((c) => c.metric === metric).reduce((sum, c) => sum + c.n, 0)

/**
 * Two shapes of document, and the dimensions are the reason for the split: the pulse metrics
 * are per-channel, the funnel counters are per (funnel, step). CloudWatch aggregates a metric
 * across a dimension set it is not given, so this is exactly what makes the dashboard able to
 * show "events/min" overall and "conversion at step N" separately.
 */
function emitMetrics(batch: TelemetryBatch, roll: RollupResult, now: number): void {
  emit(
    { Channel: batch.env.channel },
    [
      { name: 'Batches', value: 1 },
      { name: 'EventsAccepted', value: batch.events.length },
      // Heartbeats are the "is anyone in the app RIGHT NOW" signal: one per session per 5 min.
      { name: 'Heartbeats', value: counterOf(roll, USAGE_METRICS.heartbeats) },
      { name: 'SessionsStarted', value: counterOf(roll, USAGE_METRICS.sessions) },
      { name: 'ActiveInstalls', value: counterOf(roll, USAGE_METRICS.activeInstalls) }
    ],
    now
  )
  for (const f of roll.funnels.slice(0, MAX_FUNNEL_EMF)) {
    emit({ Funnel: f.funnel, Step: f.step, Outcome: f.outcome }, [{ name: 'FunnelStep', value: f.n }], now)
  }
}

/** Refusals are metrics too — a dashboard that only counts successes cannot show a kill switch
 *  doing its job, or a client stuck in a 400 loop. `Reason` is a closed set of five strings. */
function emitRejected(reason: TelemetryErrorCode, now: number): void {
  emit({ Reason: reason }, [{ name: 'Rejected', value: 1 }], now)
}

// ---- the handler ----------------------------------------------------------------------

async function accept(batch: TelemetryBatch, now: number): Promise<HttpResult> {
  const config = await loadConfig(now)
  if (!config.accepting) {
    emitRejected('closed', now)
    return fail(503, 'closed', 'Usage analytics is not being collected right now.')
  }
  const day = utcDay(now)
  const facts = await touchInstall(batch, config, day)
  if (facts === null) {
    emitRejected('quota_exceeded', now)
    return fail(429, 'quota_exceeded', 'Daily event limit reached for this analytics id.')
  }
  const roll = rollupBatch(batch, facts)
  await writeCounters(day, roll)
  emitMetrics(batch, roll, now)
  // COUNTS ONLY. No analyticsId, no dims, nothing that could reconstruct a batch from the log.
  log({
    msg: 'telemetry.accepted',
    channel: batch.env.channel,
    events: batch.events.length,
    counters: roll.counters.length,
    funnels: roll.funnels.length,
    firstOfDay: facts.firstOfDay
  })
  return json(202, { ok: true, accepted: batch.events.length })
}

export async function handler(event: HttpEvent): Promise<HttpResult> {
  const now = Date.now()
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '')
    if (Buffer.byteLength(raw, 'utf8') > MAX_TELEMETRY_BODY_BYTES) {
      emitRejected('too_large', now)
      return fail(413, 'too_large', 'Telemetry batch is too large.')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch {
      emitRejected('invalid_event', now)
      return fail(400, 'invalid_event', 'Body is not valid JSON.')
    }

    const v = validateTelemetryBatch(parsed)
    if (!v.ok) {
      emitRejected('invalid_event', now)
      return fail(400, 'invalid_event', v.message, { field: v.field })
    }
    // An EMPTY batch is legal (the validator says so) and is answered without a round trip.
    // The flush loop never sends one; a server that 400'd it would be asserting something it
    // does not need to, and step 6's "first batch today" inference assumes events > 0.
    if (v.value.events.length === 0) return json(202, { ok: true, accepted: 0 })
    return await accept(v.value, now)
  } catch (err) {
    // An unclassified failure may well be the CONNECTION. Retiring it costs one handshake on
    // the next invoke and stops a dead socket poisoning a warm container for its whole life.
    if (sqlState(err) === null) resetClient()
    log({ msg: 'unhandled', error: errorMessage(err) })
    emitRejected('internal', now)
    return fail(500, 'internal', 'Something went wrong on our side.')
  }
}

