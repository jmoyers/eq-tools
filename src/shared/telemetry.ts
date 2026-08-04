// ============================================================================
// TELEMETRY CONTRACT — the ONE definition of what usage analytics may ever say.
// ============================================================================
//
// Imported by FOUR consumers and owned by none of them:
//   * the renderer          (`window.eq.track()` builds these values and nothing else),
//   * the main process      (re-validates at the IPC boundary before a single event is
//                            buffered — renderer input is untrusted, same law as every
//                            other handler),
//   * the doc generator     (`src/shared/telemetryDoc.ts` renders TELEMETRY.md from the
//                            tables below, so the published doc cannot drift from the code),
//   * the ingest Lambda     (wave A2 — `validateTelemetryBatch` is the server's whole shape
//                            check, exactly as `validateSubmit` is for feedback).
//
// THE VALIDATORS LIVE NEXT DOOR, in `./telemetryValidate.ts`. That split is a factoring
// decision and nothing more (the contract plus its validators is past the repo's 400-code-line
// ceiling); the two files are one definition and only ever move together.
//
// LAWS THIS FILE OBEYS (docs/plans/usage-analytics.md T2):
//
//   * PURE. Zero imports — no `node:`, no Electron, no DOM, not even `shared/types.ts`.
//     It compiles under both tsconfigs, is read by `storeMigrations.ts` at store.ts's module
//     scope, and has to bundle into a Lambda. (`tests/telemetryContract.test.mts` pins the
//     duplicated overlay-kind list against the real `OVERLAY_KINDS`, so the copy cannot rot.)
//
//   * THE SCHEMA CANNOT EXPRESS A NAME. There is no free-text field anywhere in the event
//     union. Every string-typed field is a member of a CLOSED enum declared in this file;
//     the only two exceptions are `analyticsId` (a v4 UUID, regex-pinned) and `appVersion`
//     (semver, regex-pinned), neither of which can carry prose. A character, zone, mob,
//     spell, item, file path or log line has nowhere to go — not because we remember to
//     strip it, but because the type has no slot for it.
//
//   * WHERE A RAW NUMBER IS ITSELF REVEALING, THE SCHEMA CARRIES A BUCKET, and the bucket
//     EDGES are declared here so TELEMETRY.md prints them exactly. "How many characters do
//     you play" and "how big is your log" are facts about a person; "3–4" and "100–512 MB"
//     are facts about a population.
//
//   * The validators are TOTAL and side-effect free: every failure is a typed value, nothing
//     throws, and the same call on the same input always returns the same answer.

/** Bumped only for a BREAKING wire change; the server rejects anything else outright. */
export const TELEMETRY_API_VERSION = 1

// ---------------------------------------------------------------- closed enums
//
// Every one of these is a CLOSED set that grows by schema PR only. That is the whole point:
// a value not listed here is refused by the validator on the client before it is buffered and
// again on the server before it is counted.

/** `'e2e'` is deliberately absent — the headless harness never sends (T7). */
export const TELEMETRY_CHANNELS = ['prod', 'dev'] as const
export type TelemetryChannel = (typeof TELEMETRY_CHANNELS)[number]

/** `process.platform`, folded to a closed set. A raw platform string is still a string. */
export const TELEMETRY_PLATFORMS = ['win32', 'darwin', 'linux', 'other'] as const
export type TelemetryPlatform = (typeof TELEMETRY_PLATFORMS)[number]

/**
 * The app's top-level views (`renderer/src/appViews.ts`). Duplicated rather than imported
 * because that module is renderer-only (it reads a vite define through `devFlags`), and this
 * file may import nothing at all.
 */
export const TELEMETRY_VIEWS = [
  'overview',
  'combat',
  'mobs',
  'maps',
  'bosses',
  'posky',
  'alerts',
  'leveling',
  'loot',
  'buffs',
  'preferences',
  'triage'
] as const
export type TelemetryView = (typeof TELEMETRY_VIEWS)[number]

/** The five floating-overlay kinds (`shared/types.ts OVERLAY_KINDS`; parity is pinned). */
export const TELEMETRY_OVERLAY_KINDS = [
  'fight',
  'overall',
  'heal-fight',
  'heal-overall',
  'events'
] as const
export type TelemetryOverlayKind = (typeof TELEMETRY_OVERLAY_KINDS)[number]

/**
 * The feature-reach enum (plan §2). It is deliberately WIDER than the call sites wave A1
 * wires: the enum exists so later waves add a `track()` call without touching the schema,
 * the doc, or the server. An entry with no call site simply never appears in the data.
 */
export const TELEMETRY_FEATURES = [
  'mapOpen',
  'mapSearch',
  'rangeSelect',
  'comboCorrection',
  'feedbackOpen',
  'alertGroupAdd',
  'drillPet',
  'copyView',
  'speechPreview',
  'procAnalyticsOpen',
  'questFavorite',
  'lootFilter',
  'profileSwitch'
] as const
export type TelemetryFeature = (typeof TELEMETRY_FEATURES)[number]

/** Which TTS tier is selected (voice-alerts §2). */
export const TELEMETRY_VOICE_ENGINES = ['system', 'kokoro', 'off'] as const
export type TelemetryVoiceEngine = (typeof TELEMETRY_VOICE_ENGINES)[number]

/** The auto-update release channel. */
export const TELEMETRY_UPDATE_CHANNELS = ['main', 'stable'] as const
export type TelemetryUpdateChannel = (typeof TELEMETRY_UPDATE_CHANNELS)[number]

/** The three funnels of plan §3. */
export const TELEMETRY_FUNNELS = ['first-run', 'voice-install', 'feedback'] as const
export type TelemetryFunnel = (typeof TELEMETRY_FUNNELS)[number]

/**
 * Each funnel's steps, in ORDER — the order is the funnel (the panel reads conversion between
 * adjacent entries). A step is legal only inside its own funnel; `validateFunnelStep` checks
 * the PAIR, so `{funnel:'feedback', step:'downloadStarted'}` is refused.
 */
export const TELEMETRY_FUNNEL_STEPS: Readonly<Record<TelemetryFunnel, readonly string[]>> = {
  'first-run': [
    'installed',
    'logDetected',
    'firstParse',
    'firstNonOverviewView',
    'firstOverlayEnabled'
  ],
  'voice-install': ['engineSelected', 'downloadStarted', 'downloadCompleted', 'firstUtterance'],
  feedback: ['dialogOpened', 'sendPressed', 'sendFinished']
}

/** How a step ended, when it ended at all. Absent means "reached", which is the common case. */
export const TELEMETRY_OUTCOMES = ['ok', 'failed', 'queued'] as const
export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[number]

/** A COARSE class, never a message. Five values, and 'other' is where everything else lands. */
export const TELEMETRY_FAILURE_CLASSES = [
  'network',
  'checksum',
  'disk',
  'timeout',
  'other'
] as const
export type TelemetryFailureClass = (typeof TELEMETRY_FAILURE_CLASSES)[number]

/** The auto-updater's three observable steps. */
export const TELEMETRY_UPDATE_STEPS = ['check', 'download', 'apply'] as const
export type TelemetryUpdateStep = (typeof TELEMETRY_UPDATE_STEPS)[number]

// ---------------------------------------------------------------- buckets
//
// EDGES, not labels: bucket `i` is the number of edges strictly at or below the value, so
// bucket 0 is "below the first edge" and bucket `edges.length` is "at or above the last".
// `edges.length + 1` buckets in total, and TELEMETRY.md prints every range from these arrays.

/** Time from process start to the first window paint. */
export const COLD_START_MS_EDGES = [1_000, 2_500, 5_000, 10_000, 20_000] as const
/** How many character logs the install can see. 1 is the overwhelming common case. */
export const CHAR_COUNT_EDGES = [1, 2, 3, 5, 9] as const
/** Size of the tailed log on disk. A raw byte count is a fingerprint; a decade is not. */
export const LOG_SIZE_BYTES_EDGES = [
  1_048_576,
  10_485_760,
  104_857_600,
  536_870_912,
  2_147_483_648
] as const
/** How many alert definitions the user keeps. */
export const ALERT_COUNT_EDGES = [1, 5, 10, 25, 50] as const

/** The bucket index of `value` under `edges`. Non-finite input lands in bucket 0. */
export function bucketOf(value: number, edges: readonly number[]): number {
  if (!Number.isFinite(value)) return 0
  let i = 0
  while (i < edges.length && value >= edges[i]) i++
  return i
}

/** The half-open range bucket `i` covers: `[lo, hi)`, with `hi: null` for the open top. */
export function bucketRange(
  edges: readonly number[],
  i: number
): { lo: number; hi: number | null } {
  return { lo: i === 0 ? 0 : edges[i - 1], hi: i < edges.length ? edges[i] : null }
}

/** UTC offset in WHOLE HOURS — the coarsest useful "when do people play" signal. */
export const MIN_TZ_OFFSET_HOURS = -12
export const MAX_TZ_OFFSET_HOURS = 14

/** Offset in minutes (`-new Date().getTimezoneOffset()`) → whole hours, clamped. */
export function tzOffsetBucket(offsetMinutes: number): number {
  if (!Number.isFinite(offsetMinutes)) return 0
  const hours = Math.round(offsetMinutes / 60)
  return Math.max(MIN_TZ_OFFSET_HOURS, Math.min(MAX_TZ_OFFSET_HOURS, hours))
}

// ---------------------------------------------------------------- limits

/** Ring capacity of `<userData>/telemetry.json`. Oldest is dropped; nothing is ever refused. */
export const TELEMETRY_BUFFER_CAP = 500
/** Most events one flush may carry. Same number: a full buffer is one batch. */
export const MAX_BATCH_EVENTS = TELEMETRY_BUFFER_CAP
/** Ceiling for every plain count field. Well past any real session; refuses nonsense. */
export const MAX_COUNT = 1_000_000
/** Ceiling for every duration field (30 days). A longer session is a broken clock. */
export const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000

/** `crypto.randomUUID()` shape — the analyticsId's only permitted spelling. */
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** `app.getVersion()` — semver, optionally with the CI channel prerelease tag. */
export const APP_VERSION_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/

// ---------------------------------------------------------------- the event union

export interface EvSessionStart {
  t: 'sessionStart'
  coldStartMsBucket: number
}
export interface EvSessionHeartbeat {
  t: 'sessionHeartbeat'
  uptimeMs: number
}
export interface EvSessionEnd {
  t: 'sessionEnd'
  durationMs: number
  viewsVisited: number
}
export interface EvViewDwell {
  t: 'viewDwell'
  view: TelemetryView
  ms: number
}
export interface EvOverlayToggle {
  t: 'overlayToggle'
  kind: TelemetryOverlayKind
  open: boolean
}
export interface EvFeatureUse {
  t: 'featureUse'
  feature: TelemetryFeature
  count: number
}
export interface EvAlertFired {
  t: 'alertFired'
  count: number
  spokenCount: number
}
export interface EvSetupSnapshot {
  t: 'setupSnapshot'
  charCountBucket: number
  logSizeBucket: number
  alertCountBucket: number
  overlaysEnabled: TelemetryOverlayKind[]
  cursorRing: boolean
  autoHide: boolean
  voiceEngine: TelemetryVoiceEngine
  soundPackCount: number
  updateChannel: TelemetryUpdateChannel
}
export interface EvFunnelStep {
  t: 'funnelStep'
  funnel: TelemetryFunnel
  step: string
  outcome?: TelemetryOutcome
  failureClass?: TelemetryFailureClass
}
export interface EvHealthCounters {
  t: 'healthCounters'
  rendererCrashes: number
  mainErrorLogLines: number
  parserStalls: number
  presenceRestarts: number
  speechFailures: number
}
export interface EvUpdateOutcome {
  t: 'updateOutcome'
  step: TelemetryUpdateStep
  ok: boolean
  failureClass?: TelemetryFailureClass
}

export type TelemetryEvent =
  | EvSessionStart
  | EvSessionHeartbeat
  | EvSessionEnd
  | EvViewDwell
  | EvOverlayToggle
  | EvFeatureUse
  | EvAlertFired
  | EvSetupSnapshot
  | EvFunnelStep
  | EvHealthCounters
  | EvUpdateOutcome

export type TelemetryEventKind = TelemetryEvent['t']

/** Runtime spelling of the union's tags, in doc order. */
export const TELEMETRY_EVENT_KINDS = [
  'sessionStart',
  'sessionHeartbeat',
  'sessionEnd',
  'viewDwell',
  'overlayToggle',
  'featureUse',
  'alertFired',
  'setupSnapshot',
  'funnelStep',
  'healthCounters',
  'updateOutcome'
] as const

// ---------------------------------------------------------------- envelope + batch
//
// Plan §2: "all events carry {v, analyticsId, appVersion, channel, platform, tzOffsetBucket}".
// They do — through the BATCH, which is the unit that crosses the wire. Every one of those
// fields is constant for the life of a session, and stamping six copies onto every event so a
// flush of 500 can repeat them 500 times would be payload, not information.

export interface TelemetryEnvelope {
  /** The rotatable anonymous id. NOT the feedback installId — deliberately non-correlatable. */
  analyticsId: string
  appVersion: string
  channel: TelemetryChannel
  platform: TelemetryPlatform
  /** UTC offset in whole hours (`tzOffsetBucket`). */
  tzOffsetBucket: number
}

/** One buffered event plus the client clock. The SERVER aggregates by arrival day; `ts` exists
 *  so the Preferences payload viewer can say when, and for ordering inside the ring. */
export interface TelemetryRecord {
  ts: number
  ev: TelemetryEvent
}

export interface TelemetryBatch {
  v: typeof TELEMETRY_API_VERSION
  env: TelemetryEnvelope
  events: TelemetryRecord[]
}

/**
 * What the Preferences payload viewer renders (T4: "show the payload"). It crosses the preload
 * bridge, so it is a SHARED shape — main and the renderer name one definition.
 *
 * `lastBatch` is null in every build shipped today and the pane SAYS so: there is no transport,
 * so there has never been a batch. An empty box the user has to interpret would be a worse
 * answer than a sentence explaining why it is empty.
 */
export interface TelemetryPayloadView {
  prefs: TelemetryPrefs
  /** False in every dark build — see `src/main/telemetry/net.ts`. */
  endpointConfigured: boolean
  /** The live ring, oldest first. */
  buffered: TelemetryRecord[]
  lastBatch: TelemetryBatch | null
}

// ---------------------------------------------------------------- prefs (persisted)
//
// The store blob behind schema migration 5 → 6. It lives here rather than in a `telemetryPrefs`
// module because this file is already the pure, import-free home of everything telemetry-shaped
// that main, the renderer and `storeMigrations.ts` all have to agree on.
//
// OPT-OUT (owner decision T1) — `enabled: true` on a fresh install — but `noticeShown: false`,
// and NOTHING may transmit until that flips. `analyticsId: null` until the collector first
// starts: there is no reason to mint an identifier for a user who has not run the app yet.

export interface TelemetryPrefs {
  /** Master switch. False ⇒ the buffer is dropped immediately and nothing is collected. */
  enabled: boolean
  /** Has the first-run notice RENDERED? The network gate, not just a UI flag. */
  noticeShown: boolean
  /** The rotatable anonymous id, or null until the collector mints one. */
  analyticsId: string | null
}

export const DEFAULT_TELEMETRY_PREFS: TelemetryPrefs = {
  enabled: true,
  noticeShown: false,
  analyticsId: null
}

/** A plain object, or not. Shared with every validator in `./telemetryValidate.ts` — one
 *  answer to "is this even a record", so the prefs normalizer and the wire validators can
 *  never disagree about what an object is. */
export function isTelemetryObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Defaulted field by field. Takes `unknown`: a hand edit, a downgrade or a share import can
 *  leave anything in this key, and a malformed id is DROPPED (⇒ a fresh one is minted) rather
 *  than repaired into something that is not a UUID. */
export function normalizeTelemetryPrefs(value: unknown): TelemetryPrefs {
  const v = isTelemetryObject(value) ? value : {}
  const id = v.analyticsId
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_TELEMETRY_PREFS.enabled,
    noticeShown:
      typeof v.noticeShown === 'boolean' ? v.noticeShown : DEFAULT_TELEMETRY_PREFS.noticeShown,
    analyticsId: typeof id === 'string' && UUID_V4_RE.test(id) ? id : null
  }
}
