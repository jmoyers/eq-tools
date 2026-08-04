// ============================================================================
// TELEMETRY ROLLUP — the ONE definition of what a batch becomes once it lands.
// ============================================================================
//
// `./telemetry.ts` says what a client may SEND. This file says what the server may KEEP, and
// the two are deliberately different documents: the wire schema is a privacy promise, this is
// a storage decision (plan T6 — "ingest aggregates on arrival … no raw-event store at all").
//
// WHO READS IT, and why it is shared rather than living in the Lambda:
//   * `infra/lambda/telemetry.ts` — turns one validated batch into the UPSERT rows;
//   * `src/main/triage/analytics.ts` — reads those same rows back for the Analytics panel;
//   * `scripts/triage-feedback.mts analytics digest` — the text version of the same numbers;
//   * `scripts/dev-feedback-server.mts` — the local rehearsal of the ingest path.
//
// If the metric NAMES lived in the handler, the readout would be a second hand-typed copy of
// them, and the first typo would be a silently empty panel rather than a compile error. They
// live here, spelled once, and every reader imports them.
//
// PURE, like the contract: the only import is `./telemetry` (types, the closed enums and
// `bucketOf`). No `node:`, no Electron, no DOM — it bundles into a Lambda and compiles under
// both of the repo's tsconfigs.
//
// ---------------------------------------------------------------------------------------
// WHAT AN AGGREGATE CAN AND CANNOT ANSWER — read this before adding a panel row.
// ---------------------------------------------------------------------------------------
// A daily counter keyed on (day, metric, dim) can answer "how many", "how much" and "how
// long" per day. It CANNOT answer anything that needs the identity behind the count:
//
//   * DISTINCT-PER-DAY is possible only where the ingest path already knows it is seeing an
//     id for the first time today — which it does, once, from the `analytics_install` UPSERT.
//     That is why `activeInstalls` (DAU) exists as a counter at all, and why the envelope
//     facts (version/channel/platform/tz) are counted ONLY on that first batch: counted per
//     batch they would measure flush loops, not people.
//   * WAU / MAU / retention are NOT unions of daily counters (an install active on Monday and
//     Tuesday would be counted twice). They are computed at READ time from
//     `analytics_install`, which is the one place a per-id fact survives.
//   * PER-FEATURE REACH ("what share of installs opened Maps") is not derivable here at all —
//     it would need per-id, per-feature state, which is exactly the per-user event trail T6
//     refused to keep. The panel reports uses and uses-per-session instead, and says so.
//   * A MEDIAN cannot be summed. So session length is kept twice: a total (for the mean) and
//     a HISTOGRAM over `SESSION_MS_EDGES` (for a median that is honest to a bucket, and is
//     rendered as a range rather than a fake exact number).

import {
  bucketOf,
  type TelemetryBatch,
  type TelemetryEvent,
  type TelemetryRecord
} from './telemetry'

/** `dim` is NOT NULL in the schema; this is what "this metric has no dimension" looks like. */
export const DIM_NONE = '-'

/**
 * Every metric name the ingest path may write. A closed table for the same reason the event
 * union is closed: `usage_daily.metric` is free-form TEXT as far as postgres knows, and the
 * only thing that keeps it an enum is this object plus the fact that nothing else writes it.
 */
export const USAGE_METRICS = {
  /** Distinct installs that sent anything that day. Emitted once per id per day. */
  activeInstalls: 'activeInstalls',
  /** Installs whose `analytics_install` row was created that day. */
  newInstalls: 'newInstalls',
  sessions: 'sessions',
  sessionEnds: 'sessionEnds',
  sessionMsTotal: 'sessionMsTotal',
  /** dim = index into SESSION_MS_EDGES. The median's only honest source. */
  sessionLenBucket: 'sessionLenBucket',
  heartbeats: 'heartbeats',
  /** dim = index into COLD_START_MS_EDGES. */
  coldStartBucket: 'coldStartBucket',
  /** dim = view id. */
  viewDwellMs: 'viewDwellMs',
  viewVisits: 'viewVisits',
  /** dim = overlay kind. */
  overlayOpen: 'overlayOpen',
  overlayClose: 'overlayClose',
  /** dim = feature id. */
  featureUse: 'featureUse',
  alertsFired: 'alertsFired',
  alertsSpoken: 'alertsSpoken',
  /** The envelope facts, counted once per active install per day (see the header). */
  version: 'version',
  channel: 'channel',
  platform: 'platform',
  tzOffset: 'tzOffset',
  /** setupSnapshot, one metric per field; dim is the bucket index or the enum member. */
  setups: 'setups',
  setupChars: 'setupChars',
  setupLogSize: 'setupLogSize',
  setupAlerts: 'setupAlerts',
  setupOverlay: 'setupOverlay',
  setupCursorRing: 'setupCursorRing',
  setupAutoHide: 'setupAutoHide',
  setupVoice: 'setupVoice',
  setupPacks: 'setupPacks',
  setupUpdateChannel: 'setupUpdateChannel',
  /** dim = the healthCounters field name; n = the count reported. */
  health: 'health',
  healthReports: 'healthReports',
  /** dim = `<step>:ok` / `<step>:failed`. */
  update: 'update',
  /** dim = `<step>:<failureClass>`. */
  updateFailure: 'updateFailure',
  /** dim = `<funnel>:<step>:<failureClass>` — the funnel table has no class column. */
  funnelFailure: 'funnelFailure'
} as const

export type UsageMetric = (typeof USAGE_METRICS)[keyof typeof USAGE_METRICS]

/**
 * Session-length histogram edges: 1m / 5m / 15m / 30m / 1h / 2h / 4h ⇒ eight buckets.
 *
 * A STORAGE decision, not a wire one — the client sends `durationMs` and the server chooses
 * how coarsely to remember it — which is why these edges live here and not in the contract
 * (nothing in TELEMETRY.md needs to promise them; the number the user sent is the number the
 * payload viewer shows).
 */
export const SESSION_MS_EDGES = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  120 * 60_000,
  240 * 60_000
] as const

/** Minutes, or hours once past the hour mark: `15 min`, `2 h`. */
function span(ms: number): string {
  return ms >= 60 * 60_000
    ? `${String(Math.round(ms / 3_600_000))} h`
    : `${String(Math.round(ms / 60_000))} min`
}

/** Human range for a `sessionLenBucket` index: `15 min–30 min`, `4 h+`. */
export function sessionBucketLabel(i: number): string {
  const clamped = Math.max(0, Math.min(i, SESSION_MS_EDGES.length))
  const lo = clamped === 0 ? 0 : SESSION_MS_EDGES[clamped - 1]
  if (clamped >= SESSION_MS_EDGES.length) return `${span(lo)}+`
  return `${clamped === 0 ? '0' : span(lo)}–${span(SESSION_MS_EDGES[clamped])}`
}

/**
 * The median's bucket index, or -1 when the histogram is empty. Interpolating INSIDE a bucket
 * would be inventing precision the storage deliberately threw away, so the panel renders the
 * bucket's own range instead of a number.
 */
export function medianBucket(counts: readonly number[]): number {
  const total = counts.reduce((sum, n) => sum + Math.max(0, n), 0)
  if (total <= 0) return -1
  let seen = 0
  for (let i = 0; i < counts.length; i++) {
    seen += Math.max(0, counts[i])
    if (seen * 2 >= total) return i
  }
  return counts.length - 1
}

// ---------------------------------------------------------------- the rollup

export interface UsageCounter {
  metric: string
  dim: string
  n: number
}

export interface FunnelCounter {
  funnel: string
  step: string
  /** `'-'` when the client reported no outcome — the column is NOT NULL and part of the key. */
  outcome: string
  appVersion: string
  n: number
}

export interface RollupResult {
  counters: UsageCounter[]
  funnels: FunnelCounter[]
}

/**
 * What the `analytics_install` UPSERT already learned, and the rollup cannot learn for itself.
 * Both facts are per-id-per-day and are the ONLY reason a distinct-install counter is possible
 * without keeping an id anywhere but that one row.
 */
export interface RollupContext {
  /** Is this the first batch this analyticsId has sent today? */
  firstOfDay: boolean
  /** Was the install row created by this batch? */
  newInstall: boolean
}

/**
 * The accumulator key is the (metric, dim) PAIR, joined. A space is unambiguous: every legal
 * `dim` is a closed-enum member, a bucket index or a semver, none of which can contain one —
 * and the key is never parsed back apart (the counter it points at carries both fields).
 */
const KEY_SEP = ' '

type Bag = Map<string, UsageCounter>

function add(bag: Bag, metric: string, dim: string, n: number): void {
  if (!Number.isFinite(n) || n <= 0) return
  const key = `${metric}${KEY_SEP}${dim}`
  const held = bag.get(key)
  if (held) held.n += n
  else bag.set(key, { metric, dim, n })
}

const flag = (on: boolean): string => (on ? 'on' : 'off')

function foldSetup(bag: Bag, ev: Extract<TelemetryEvent, { t: 'setupSnapshot' }>): void {
  add(bag, USAGE_METRICS.setups, DIM_NONE, 1)
  add(bag, USAGE_METRICS.setupChars, String(ev.charCountBucket), 1)
  add(bag, USAGE_METRICS.setupLogSize, String(ev.logSizeBucket), 1)
  add(bag, USAGE_METRICS.setupAlerts, String(ev.alertCountBucket), 1)
  for (const kind of ev.overlaysEnabled) add(bag, USAGE_METRICS.setupOverlay, kind, 1)
  add(bag, USAGE_METRICS.setupCursorRing, flag(ev.cursorRing), 1)
  add(bag, USAGE_METRICS.setupAutoHide, flag(ev.autoHide), 1)
  add(bag, USAGE_METRICS.setupVoice, ev.voiceEngine, 1)
  add(bag, USAGE_METRICS.setupPacks, DIM_NONE, ev.soundPackCount)
  add(bag, USAGE_METRICS.setupUpdateChannel, ev.updateChannel, 1)
}

function foldHealth(bag: Bag, ev: Extract<TelemetryEvent, { t: 'healthCounters' }>): void {
  add(bag, USAGE_METRICS.healthReports, DIM_NONE, 1)
  add(bag, USAGE_METRICS.health, 'rendererCrashes', ev.rendererCrashes)
  add(bag, USAGE_METRICS.health, 'mainErrorLogLines', ev.mainErrorLogLines)
  add(bag, USAGE_METRICS.health, 'parserStalls', ev.parserStalls)
  add(bag, USAGE_METRICS.health, 'presenceRestarts', ev.presenceRestarts)
  add(bag, USAGE_METRICS.health, 'speechFailures', ev.speechFailures)
}

/**
 * The three session events, split out of `foldEvent` so neither switch is past the repo's
 * complexity ceiling. Returns whether it handled the event — the caller's `switch` then covers
 * exactly the kinds this one does not, and a new event kind still fails to compile in one of
 * them (both are exhaustive over the union).
 */
function foldSession(bag: Bag, ev: TelemetryEvent): boolean {
  switch (ev.t) {
    case 'sessionStart':
      add(bag, USAGE_METRICS.sessions, DIM_NONE, 1)
      add(bag, USAGE_METRICS.coldStartBucket, String(ev.coldStartMsBucket), 1)
      return true
    case 'sessionHeartbeat':
      add(bag, USAGE_METRICS.heartbeats, DIM_NONE, 1)
      return true
    case 'sessionEnd':
      add(bag, USAGE_METRICS.sessionEnds, DIM_NONE, 1)
      add(bag, USAGE_METRICS.sessionMsTotal, DIM_NONE, ev.durationMs)
      add(bag, USAGE_METRICS.sessionLenBucket, String(bucketOf(ev.durationMs, SESSION_MS_EDGES)), 1)
      return true
    default:
      return false
  }
}

/**
 * The two events that carry an OUTCOME — an update step and a funnel step. Split out for the
 * same reason `foldSession` is: three of the union's eleven kinds carry conditional fields, and
 * one switch over all eleven is past the repo's complexity ceiling.
 */
function foldOutcome(bag: Bag, ev: TelemetryEvent): boolean {
  if (ev.t === 'updateOutcome') {
    add(bag, USAGE_METRICS.update, `${ev.step}:${ev.ok ? 'ok' : 'failed'}`, 1)
    if (ev.failureClass !== undefined) {
      add(bag, USAGE_METRICS.updateFailure, `${ev.step}:${ev.failureClass}`, 1)
    }
    return true
  }
  if (ev.t !== 'funnelStep') return false
  // A funnel step's STEPS go to the funnel table (foldFunnels); only its failure class lands
  // here, because `usage_funnel_daily`'s key has no column for one.
  if (ev.failureClass !== undefined) {
    add(bag, USAGE_METRICS.funnelFailure, `${ev.funnel}:${ev.step}:${ev.failureClass}`, 1)
  }
  return true
}

/** One event's contribution. TOTAL: a kind with nothing to count simply adds nothing. */
function foldEvent(bag: Bag, ev: TelemetryEvent): void {
  if (foldSession(bag, ev) || foldOutcome(bag, ev)) return
  switch (ev.t) {
    case 'viewDwell':
      add(bag, USAGE_METRICS.viewVisits, ev.view, 1)
      add(bag, USAGE_METRICS.viewDwellMs, ev.view, ev.ms)
      return
    case 'overlayToggle':
      add(bag, ev.open ? USAGE_METRICS.overlayOpen : USAGE_METRICS.overlayClose, ev.kind, 1)
      return
    case 'featureUse':
      add(bag, USAGE_METRICS.featureUse, ev.feature, ev.count)
      return
    case 'alertFired':
      add(bag, USAGE_METRICS.alertsFired, DIM_NONE, ev.count)
      add(bag, USAGE_METRICS.alertsSpoken, DIM_NONE, ev.spokenCount)
      return
    case 'setupSnapshot':
      foldSetup(bag, ev)
      return
    case 'healthCounters':
      foldHealth(bag, ev)
      return
    default:
      // The session kinds and the two outcome kinds, already folded by the helpers above.
      return
  }
}

/** The envelope facts, counted ONCE per active install per day. See the header. */
function foldEnvelope(bag: Bag, batch: TelemetryBatch): void {
  add(bag, USAGE_METRICS.activeInstalls, DIM_NONE, 1)
  add(bag, USAGE_METRICS.version, batch.env.appVersion, 1)
  add(bag, USAGE_METRICS.channel, batch.env.channel, 1)
  add(bag, USAGE_METRICS.platform, batch.env.platform, 1)
  add(bag, USAGE_METRICS.tzOffset, String(batch.env.tzOffsetBucket), 1)
}

function foldFunnels(records: readonly TelemetryRecord[], appVersion: string): FunnelCounter[] {
  const bag = new Map<string, FunnelCounter>()
  for (const { ev } of records) {
    if (ev.t !== 'funnelStep') continue
    const outcome = ev.outcome ?? DIM_NONE
    const key = [ev.funnel, ev.step, outcome].join(KEY_SEP)
    const held = bag.get(key)
    if (held) held.n += 1
    else bag.set(key, { funnel: ev.funnel, step: ev.step, outcome, appVersion, n: 1 })
  }
  return [...bag.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v)
}

/**
 * ONE validated batch → the rows the ingest handler UPSERTs. Pure and deterministic: the same
 * batch always yields the same rows in the same order, which is what makes the handler's
 * multi-row UPSERT reproducible and this file testable without a database.
 *
 * The funnel FAILURE CLASS is folded into `usage_daily` rather than the funnel table: plan §4
 * keys that table on (day, funnel, step, outcome, appVersion), and adding a sixth key column
 * to carry a rarely-set coarse enum would multiply every funnel row for one field.
 */
export function rollupBatch(batch: TelemetryBatch, ctx: RollupContext): RollupResult {
  const bag: Bag = new Map()
  if (ctx.firstOfDay) foldEnvelope(bag, batch)
  if (ctx.newInstall) add(bag, USAGE_METRICS.newInstalls, DIM_NONE, 1)
  for (const { ev } of batch.events) foldEvent(bag, ev)
  const counters = [...bag.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v)
  return { counters, funnels: foldFunnels(batch.events, batch.env.appVersion) }
}

/** The UTC day a row is keyed on. ARRIVAL day, never the client's clock (which can lie). */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}
