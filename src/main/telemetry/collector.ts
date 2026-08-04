// telemetry/collector.ts — accept an event, put it in the ring, and own the analyticsId.
//
// Everything that WRITES to the ring goes through `recordEvent`, and `recordEvent` refuses when
// the user's switch is off. That is one gate, in one place, rather than a check at each of the
// (eventually many) call sites — the same reasoning that put `queueFlushEnabled` inside
// `startQueueFlush` instead of restating it in the composition root.
//
// THE analyticsId (plan T3). A separate, anonymous, ROTATABLE id — deliberately NOT the
// feedback `installId`, so the two data sets cannot be joined even by us. It is minted LAZILY on
// the collector's first start, never at migration time: a store migration that minted an
// identifier would create one for a user who then turns the feature off before it is ever used.
// Rotation mints a new one AND drops the ring, which by design severs the retention chain — a
// rotated id is a new cohort member, and TELEMETRY.md says so.

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  tzOffsetBucket,
  TELEMETRY_API_VERSION,
  type TelemetryBatch,
  type TelemetryEnvelope,
  type TelemetryEvent,
  type TelemetryPayloadView,
  type TelemetryPlatform,
  type TelemetryPrefs
} from '../../shared/telemetry'
import { CHANNEL } from '../channel'
import { logInfo } from '../errorLog'
import { getTelemetryPrefs, setTelemetryPrefs } from '../store'
import { telemetryCollectEnabled, telemetryEndpointConfigured } from './net'
import { dropRing, pushCapped, readRing, writeRing } from './ring'

/** `process.platform` folded onto the closed enum — a raw platform string is still a string. */
export function platformOf(platform: string): TelemetryPlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform
  return 'other'
}

/** Session bookkeeping. In-memory only: a session is by definition this process's lifetime. */
let startedAt = 0
const viewsSeen = new Set<string>()

/** Wall-clock ms since `startTelemetry()` — 0 before it has run. */
export function sessionUptimeMs(now = Date.now()): number {
  return startedAt === 0 ? 0 : Math.max(0, now - startedAt)
}

export function beginSession(now = Date.now()): void {
  startedAt = now
  viewsSeen.clear()
}

export function endSession(): void {
  startedAt = 0
  viewsSeen.clear()
}

/**
 * Mint the analyticsId if this install does not have one yet. Only when the feature is ON: a
 * user who has turned it off gets no identifier at all, not even an unused one.
 */
export function ensureAnalyticsId(): string | null {
  const prefs = getTelemetryPrefs()
  if (!telemetryCollectEnabled(prefs)) return null
  if (prefs.analyticsId !== null) return prefs.analyticsId
  const analyticsId = randomUUID()
  setTelemetryPrefs({ analyticsId })
  logInfo('[everquest-companion] telemetry: minted a new anonymous analytics id')
  return analyticsId
}

/**
 * Record one ALREADY-VALIDATED event. The IPC handler validates renderer input at the boundary
 * and main-side callers construct typed values, so this function's job is the gate and the ring,
 * not the shape.
 */
export function recordEvent(ev: TelemetryEvent): void {
  if (!telemetryCollectEnabled(getTelemetryPrefs())) return
  if (ev.t === 'viewDwell') viewsSeen.add(ev.view)
  const ring = readRing()
  writeRing({ ...ring, events: pushCapped(ring.events, { ts: Date.now(), ev }) })
}

/** How many distinct views this session has dwelled on (the `sessionEnd` field). */
export function viewsVisited(): number {
  return viewsSeen.size
}

/** The per-session constants every batch carries. Null until an id exists (⇒ nothing to send). */
export function envelope(prefs: TelemetryPrefs = getTelemetryPrefs()): TelemetryEnvelope | null {
  if (prefs.analyticsId === null) return null
  return {
    analyticsId: prefs.analyticsId,
    appVersion: app.getVersion(),
    // 'e2e' is not a telemetry channel (T7 — the harness never sends). It cannot reach here
    // while the flush gate excludes e2e, and if it ever did it would read as a dev run.
    channel: CHANNEL === 'prod' ? 'prod' : 'dev',
    platform: platformOf(process.platform),
    tzOffsetBucket: tzOffsetBucket(-new Date().getTimezoneOffset())
  }
}

/**
 * The batch a flush WOULD send right now, or null when there is nothing to send / no id yet.
 * Pure with respect to the ring: building a batch never removes anything, because nothing has
 * been sent. (Wave A2 removes records on a 2xx, and only then.)
 */
export function pendingBatch(): TelemetryBatch | null {
  const env = envelope()
  if (env === null) return null
  const events = readRing().events
  if (events.length === 0) return null
  return { v: TELEMETRY_API_VERSION, env, events: [...events] }
}

/**
 * The user's switch. OFF drops the ring IMMEDIATELY and DISCARDS THE ANALYTICS ID.
 *
 * The id going too was not the first design, and the e2e spec is what found it: because the
 * feature is opt-OUT, the collector mints an id on the very first launch — before the notice
 * has been answered — so a user who then presses "Turn it off" was left carrying an identifier
 * for something they had just declined. Nothing could have been done with it (the buffer is
 * gone and the build is dark), but "off" that leaves an id in your settings file is off with an
 * asterisk. Turning it back on mints a fresh one, which is exactly the rotate semantics: a
 * re-enable is a new cohort member, and that is the honest cost of having switched off.
 */
export function setTelemetryEnabled(enabled: boolean): TelemetryPrefs {
  if (!enabled) {
    dropRing()
    return setTelemetryPrefs({ enabled: false, analyticsId: null })
  }
  setTelemetryPrefs({ enabled: true })
  ensureAnalyticsId()
  // Re-read: `ensureAnalyticsId` writes the id through the store, not through this call.
  return getTelemetryPrefs()
}

/**
 * The first-run notice has RENDERED. It flips whichever button was pressed — and a plain
 * dismissal counts as an answer too, because that is what opt-out means (T1) — so the modal is
 * a once-ever event and the network gate above it opens exactly once.
 *
 * It does NOT touch `enabled`: `answerNotice` (flush.ts) pairs it with the switch, so the
 * session's timers come into line with the answer in one place.
 */
export function markNoticeShown(): TelemetryPrefs {
  return setTelemetryPrefs({ noticeShown: true })
}

/** New id, empty ring. Severs the retention chain on purpose (T3). */
export function rotateAnalyticsId(): TelemetryPrefs {
  dropRing()
  const next = setTelemetryPrefs({ analyticsId: randomUUID() })
  logInfo('[everquest-companion] telemetry: analytics id rotated; the local buffer was dropped')
  return next
}

/** Everything the Preferences payload viewer renders (T4). */
export function telemetryPayload(): TelemetryPayloadView {
  const ring = readRing()
  return {
    prefs: getTelemetryPrefs(),
    endpointConfigured: telemetryEndpointConfigured(),
    buffered: ring.events,
    lastBatch: ring.lastBatch
  }
}
