// ============================================================================
// TELEMETRY VALIDATORS — the gate every usage event passes, three times.
// ============================================================================
//
// The other half of `./telemetry.ts`. It is a separate file for one reason and it is a boring
// one: the contract plus its validators is past the repo's 400-code-line factoring ceiling, and
// the answer to that here is a split, not a widened threshold (the same call
// `storeMigrationsPresence.test.mts` and `appHarness.mts` made). Nothing else changes — this is
// still ONE definition of what an event may be, spelled across two files that only ever move
// together.
//
// WHO RUNS THESE, AND WHY ALL THREE:
//   * the renderer's `track()` shim — so a mistake is caught where it was made;
//   * MAIN, at the IPC handler — because the renderer is untrusted, always, and the renderer is
//     where this app's strings live (character names, zones, search boxes, alert text);
//   * wave A2's ingest Lambda — because a client is a client.
//
// THE MECHANISM THAT MAKES THE PRIVACY CLAIM STRUCTURAL: these functions do not SANITIZE an
// object, they CONSTRUCT a new one field by field from the schema. So an event that arrives
// carrying `characterName` does not get it stripped by a rule someone has to remember — the
// property simply never appears in the value that comes back. `tests/telemetryContract.test.mts`
// pins exactly that.
//
// PURE, like the contract: zero imports beyond `./telemetry`, total (every failure is a typed
// value), and side-effect free (nothing throws, and the same input always gives the same
// answer).

import {
  ALERT_COUNT_EDGES,
  APP_VERSION_RE,
  CHAR_COUNT_EDGES,
  COLD_START_MS_EDGES,
  isTelemetryObject,
  LOG_SIZE_BYTES_EDGES,
  MAX_BATCH_EVENTS,
  MAX_COUNT,
  MAX_DURATION_MS,
  MAX_TZ_OFFSET_HOURS,
  MIN_TZ_OFFSET_HOURS,
  TELEMETRY_API_VERSION,
  TELEMETRY_CHANNELS,
  TELEMETRY_EVENT_KINDS,
  TELEMETRY_FAILURE_CLASSES,
  TELEMETRY_FEATURES,
  TELEMETRY_FUNNELS,
  TELEMETRY_FUNNEL_STEPS,
  TELEMETRY_OUTCOMES,
  TELEMETRY_OVERLAY_KINDS,
  TELEMETRY_PLATFORMS,
  TELEMETRY_UPDATE_CHANNELS,
  TELEMETRY_UPDATE_STEPS,
  TELEMETRY_VIEWS,
  TELEMETRY_VOICE_ENGINES,
  UUID_V4_RE,
  type EvFunnelStep,
  type EvUpdateOutcome,
  type TelemetryBatch,
  type TelemetryEnvelope,
  type TelemetryEvent,
  type TelemetryEventKind,
  type TelemetryOverlayKind,
  type TelemetryRecord
} from './telemetry'

export interface TelemetryValidationFailure {
  ok: false
  error: 'invalid_event'
  /** Safe to render verbatim: it names the field and the legal values, nothing internal. */
  message: string
  /** Dotted path of the offending field. */
  field: string
}

export type Validated<T> = { ok: true; value: T } | TelemetryValidationFailure

const fail = (field: string, message: string): TelemetryValidationFailure => ({
  ok: false,
  error: 'invalid_event',
  message,
  field
})

function oneOf<T extends string>(
  raw: unknown,
  field: string,
  allowed: readonly T[]
): Validated<T> {
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) {
    return { ok: true, value: raw as T }
  }
  return fail(field, `${field} must be one of: ${allowed.join(', ')}.`)
}

/** A whole number in `[0, max]`. Every count and every duration in the schema goes through it. */
function whole(raw: unknown, field: string, max: number): Validated<number> {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > max) {
    return fail(field, `${field} must be a whole number between 0 and ${max}.`)
  }
  return { ok: true, value: raw }
}

/** A bucket INDEX for `edges` — `0 .. edges.length`. */
function bucket(raw: unknown, field: string, edges: readonly number[]): Validated<number> {
  return whole(raw, field, edges.length)
}

function flag(raw: unknown, field: string): Validated<boolean> {
  if (typeof raw !== 'boolean') return fail(field, `${field} must be true or false.`)
  return { ok: true, value: raw }
}

function matching(raw: unknown, field: string, re: RegExp, what: string): Validated<string> {
  if (typeof raw === 'string' && re.test(raw)) return { ok: true, value: raw }
  return fail(field, `${field} must be ${what}.`)
}

/** An integer in `[min, max]` (the one signed field: the timezone bucket). */
function signedInt(raw: unknown, field: string, min: number, max: number): Validated<number> {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max) {
    return fail(field, `${field} must be a whole number between ${min} and ${max}.`)
  }
  return { ok: true, value: raw }
}

// --- one validator per event kind. Small on purpose: the dispatch table below is the only
// --- place that knows which is which, so adding an event is one interface + one entry + one
// --- doc row (and the doc-parity test fails until the row exists).

function vSessionStart(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const b = bucket(o.coldStartMsBucket, 'coldStartMsBucket', COLD_START_MS_EDGES)
  return b.ok ? { ok: true, value: { t: 'sessionStart', coldStartMsBucket: b.value } } : b
}

function vSessionHeartbeat(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const ms = whole(o.uptimeMs, 'uptimeMs', MAX_DURATION_MS)
  return ms.ok ? { ok: true, value: { t: 'sessionHeartbeat', uptimeMs: ms.value } } : ms
}

function vSessionEnd(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const ms = whole(o.durationMs, 'durationMs', MAX_DURATION_MS)
  if (!ms.ok) return ms
  const views = whole(o.viewsVisited, 'viewsVisited', TELEMETRY_VIEWS.length)
  if (!views.ok) return views
  return { ok: true, value: { t: 'sessionEnd', durationMs: ms.value, viewsVisited: views.value } }
}

function vViewDwell(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const view = oneOf(o.view, 'view', TELEMETRY_VIEWS)
  if (!view.ok) return view
  const ms = whole(o.ms, 'ms', MAX_DURATION_MS)
  if (!ms.ok) return ms
  return { ok: true, value: { t: 'viewDwell', view: view.value, ms: ms.value } }
}

function vOverlayToggle(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const kind = oneOf(o.kind, 'kind', TELEMETRY_OVERLAY_KINDS)
  if (!kind.ok) return kind
  const open = flag(o.open, 'open')
  if (!open.ok) return open
  return { ok: true, value: { t: 'overlayToggle', kind: kind.value, open: open.value } }
}

function vFeatureUse(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const feature = oneOf(o.feature, 'feature', TELEMETRY_FEATURES)
  if (!feature.ok) return feature
  const count = whole(o.count, 'count', MAX_COUNT)
  if (!count.ok) return count
  return { ok: true, value: { t: 'featureUse', feature: feature.value, count: count.value } }
}

function vAlertFired(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const count = whole(o.count, 'count', MAX_COUNT)
  if (!count.ok) return count
  const spoken = whole(o.spokenCount, 'spokenCount', MAX_COUNT)
  if (!spoken.ok) return spoken
  return { ok: true, value: { t: 'alertFired', count: count.value, spokenCount: spoken.value } }
}

/** The overlay list, as a SET of the closed kinds — deduped and re-ordered canonically, so the
 *  field carries membership and nothing else (not click order, not a repeat count). */
function overlaySet(raw: unknown): Validated<TelemetryOverlayKind[]> {
  if (!Array.isArray(raw)) return fail('overlaysEnabled', 'overlaysEnabled must be a list.')
  for (const k of raw) {
    const one = oneOf(k, 'overlaysEnabled[]', TELEMETRY_OVERLAY_KINDS)
    if (!one.ok) return one
  }
  const set = new Set(raw as TelemetryOverlayKind[])
  return { ok: true, value: TELEMETRY_OVERLAY_KINDS.filter((k) => set.has(k)) }
}

function vSetupSnapshot(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const chars = bucket(o.charCountBucket, 'charCountBucket', CHAR_COUNT_EDGES)
  if (!chars.ok) return chars
  const logSize = bucket(o.logSizeBucket, 'logSizeBucket', LOG_SIZE_BYTES_EDGES)
  if (!logSize.ok) return logSize
  const alerts = bucket(o.alertCountBucket, 'alertCountBucket', ALERT_COUNT_EDGES)
  if (!alerts.ok) return alerts
  const overlays = overlaySet(o.overlaysEnabled)
  if (!overlays.ok) return overlays
  const ring = flag(o.cursorRing, 'cursorRing')
  if (!ring.ok) return ring
  const autoHide = flag(o.autoHide, 'autoHide')
  if (!autoHide.ok) return autoHide
  const engine = oneOf(o.voiceEngine, 'voiceEngine', TELEMETRY_VOICE_ENGINES)
  if (!engine.ok) return engine
  const packs = whole(o.soundPackCount, 'soundPackCount', MAX_COUNT)
  if (!packs.ok) return packs
  const channel = oneOf(o.updateChannel, 'updateChannel', TELEMETRY_UPDATE_CHANNELS)
  if (!channel.ok) return channel
  return {
    ok: true,
    value: {
      t: 'setupSnapshot',
      charCountBucket: chars.value,
      logSizeBucket: logSize.value,
      alertCountBucket: alerts.value,
      overlaysEnabled: overlays.value,
      cursorRing: ring.value,
      autoHide: autoHide.value,
      voiceEngine: engine.value,
      soundPackCount: packs.value,
      updateChannel: channel.value
    }
  }
}

function vFunnelStep(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const funnel = oneOf(o.funnel, 'funnel', TELEMETRY_FUNNELS)
  if (!funnel.ok) return funnel
  // The PAIR is checked, not the step alone: a step belongs to exactly one funnel.
  const step = oneOf(o.step, 'step', TELEMETRY_FUNNEL_STEPS[funnel.value])
  if (!step.ok) return step
  const value: EvFunnelStep = { t: 'funnelStep', funnel: funnel.value, step: step.value }
  if (o.outcome !== undefined && o.outcome !== null) {
    const outcome = oneOf(o.outcome, 'outcome', TELEMETRY_OUTCOMES)
    if (!outcome.ok) return outcome
    value.outcome = outcome.value
  }
  if (o.failureClass !== undefined && o.failureClass !== null) {
    const cls = oneOf(o.failureClass, 'failureClass', TELEMETRY_FAILURE_CLASSES)
    if (!cls.ok) return cls
    value.failureClass = cls.value
  }
  return { ok: true, value }
}

const HEALTH_FIELDS = [
  'rendererCrashes',
  'mainErrorLogLines',
  'parserStalls',
  'presenceRestarts',
  'speechFailures'
] as const

function vHealthCounters(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const counts: number[] = []
  for (const field of HEALTH_FIELDS) {
    const n = whole(o[field], field, MAX_COUNT)
    if (!n.ok) return n
    counts.push(n.value)
  }
  return {
    ok: true,
    value: {
      t: 'healthCounters',
      rendererCrashes: counts[0],
      mainErrorLogLines: counts[1],
      parserStalls: counts[2],
      presenceRestarts: counts[3],
      speechFailures: counts[4]
    }
  }
}

function vUpdateOutcome(o: Record<string, unknown>): Validated<TelemetryEvent> {
  const step = oneOf(o.step, 'step', TELEMETRY_UPDATE_STEPS)
  if (!step.ok) return step
  const ok = flag(o.ok, 'ok')
  if (!ok.ok) return ok
  const value: EvUpdateOutcome = { t: 'updateOutcome', step: step.value, ok: ok.value }
  if (o.failureClass !== undefined && o.failureClass !== null) {
    const cls = oneOf(o.failureClass, 'failureClass', TELEMETRY_FAILURE_CLASSES)
    if (!cls.ok) return cls
    value.failureClass = cls.value
  }
  return { ok: true, value }
}

const EVENT_VALIDATORS: Record<
  TelemetryEventKind,
  (o: Record<string, unknown>) => Validated<TelemetryEvent>
> = {
  sessionStart: vSessionStart,
  sessionHeartbeat: vSessionHeartbeat,
  sessionEnd: vSessionEnd,
  viewDwell: vViewDwell,
  overlayToggle: vOverlayToggle,
  featureUse: vFeatureUse,
  alertFired: vAlertFired,
  setupSnapshot: vSetupSnapshot,
  funnelStep: vFunnelStep,
  healthCounters: vHealthCounters,
  updateOutcome: vUpdateOutcome
}

/**
 * ONE event. Run in the renderer's own `track()` shim (so a mistake is caught where it was
 * made), AGAIN in main at the IPC handler (renderer input is untrusted), and AGAIN in the
 * ingest Lambda (wave A2). Unknown fields are DROPPED, never rejected: the returned value is
 * constructed field by field from the schema, so nothing that is not in this file survives.
 */
export function validateTelemetryEvent(input: unknown): Validated<TelemetryEvent> {
  if (!isTelemetryObject(input)) return fail('event', 'An event object is required.')
  const t = input.t
  if (typeof t !== 'string' || !(t in EVENT_VALIDATORS)) {
    return fail('t', `t must be one of: ${TELEMETRY_EVENT_KINDS.join(', ')}.`)
  }
  return EVENT_VALIDATORS[t as TelemetryEventKind](input)
}

export function validateEnvelope(input: unknown): Validated<TelemetryEnvelope> {
  if (!isTelemetryObject(input)) return fail('env', 'env is required.')
  const analyticsId = matching(input.analyticsId, 'env.analyticsId', UUID_V4_RE, 'a v4 UUID')
  if (!analyticsId.ok) return analyticsId
  const appVersion = matching(
    input.appVersion,
    'env.appVersion',
    APP_VERSION_RE,
    'a semver version'
  )
  if (!appVersion.ok) return appVersion
  const channel = oneOf(input.channel, 'env.channel', TELEMETRY_CHANNELS)
  if (!channel.ok) return channel
  const platform = oneOf(input.platform, 'env.platform', TELEMETRY_PLATFORMS)
  if (!platform.ok) return platform
  const tz = signedInt(
    input.tzOffsetBucket,
    'env.tzOffsetBucket',
    MIN_TZ_OFFSET_HOURS,
    MAX_TZ_OFFSET_HOURS
  )
  if (!tz.ok) return tz
  return {
    ok: true,
    value: {
      analyticsId: analyticsId.value,
      appVersion: appVersion.value,
      channel: channel.value,
      platform: platform.value,
      tzOffsetBucket: tz.value
    }
  }
}

/** One buffered record: a client timestamp plus a validated event. */
export function validateRecord(input: unknown): Validated<TelemetryRecord> {
  if (!isTelemetryObject(input)) return fail('record', 'A record object is required.')
  if (typeof input.ts !== 'number' || !Number.isFinite(input.ts)) {
    return fail('ts', 'ts must be a number.')
  }
  const ev = validateTelemetryEvent(input.ev)
  if (!ev.ok) return ev
  return { ok: true, value: { ts: input.ts, ev: ev.value } }
}

/**
 * The whole batch, as the ingest Lambda will see it (wave A2). Cheapest checks first; the first
 * failure wins and names its field. An EMPTY batch is legal — the flush loop never sends one,
 * but a server that rejects it would be asserting something it does not need to.
 */
export function validateTelemetryBatch(input: unknown): Validated<TelemetryBatch> {
  if (!isTelemetryObject(input)) return fail('body', 'A JSON object body is required.')
  if (input.v !== TELEMETRY_API_VERSION) {
    return fail('v', `v must be ${TELEMETRY_API_VERSION}.`)
  }
  const env = validateEnvelope(input.env)
  if (!env.ok) return env
  if (!Array.isArray(input.events)) return fail('events', 'events must be a list.')
  if (input.events.length > MAX_BATCH_EVENTS) {
    return fail('events', `events must hold at most ${MAX_BATCH_EVENTS} records.`)
  }
  const events: TelemetryRecord[] = []
  for (const raw of input.events) {
    const rec = validateRecord(raw)
    if (!rec.ok) return rec
    events.push(rec.value)
  }
  return { ok: true, value: { v: TELEMETRY_API_VERSION, env: env.value, events } }
}
