// telemetry/flush.ts — the session lifecycle and the (currently unreachable) flush loop.
//
// TWO TIMERS, and they answer different questions, which is why they are not one:
//
//   * THE HEARTBEAT (5 min) is COLLECTION. It records `sessionHeartbeat` into the local ring so
//     "how long do sessions actually last" survives a process that is killed rather than closed
//     — a `sessionEnd` that never fires is exactly the data point you most want. It runs
//     whenever the user's switch is on, dark build or not, because nothing it does leaves the
//     machine.
//
//   * THE FLUSH (60 s) is NETWORK. It starts only when `telemetryFlushEnabled` says so, which
//     in every build shipped today is never: the endpoint is ''. Same discipline as
//     `startQueueFlush` — one predicate (net.ts), shared by the starter and the worker, because
//     two copies of a network gate is how one of them drifts.
//
// Both timers are `unref`'d, so neither can be the reason the process stays alive.
//
// WIRED INTO STARTUP from `src/main/index.ts` (the composition root), immediately beside
// `startQueueFlush()`, and stopped from `window-all-closed` beside `stopQueueFlush()`.

import { E2E } from '../e2e'
import { logInfo } from '../errorLog'
import {
  bucketOf,
  COLD_START_MS_EDGES,
  type TelemetryBatch,
  type TelemetryPrefs
} from '../../shared/telemetry'
import { TELEMETRY_API_URL, telemetryFlushEnabled } from './net'
import {
  beginSession,
  endSession,
  ensureAnalyticsId,
  markNoticeShown,
  pendingBatch,
  recordEvent,
  sessionUptimeMs,
  setTelemetryEnabled,
  viewsVisited
} from './collector'
import { getTelemetryPrefs } from '../store'

/** Batch cadence. Counts, not click streams — 60 s is the plan's number (T5). */
export const FLUSH_INTERVAL_MS = 60 * 1000
/** Session heartbeat cadence (T5): the "is anyone using it right now" pulse. */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000

/**
 * Build the batch this tick would send, or null when the gate is shut / there is nothing to
 * send. Returning the batch rather than void is what makes the loop testable at all while the
 * build is dark, and it is the exact value wave A2 will POST.
 *
 * ==================== WAVE A2 ATTACHES THE TRANSPORT HERE ====================
 * There is deliberately no fetch anywhere under `src/main/telemetry/` (pinned by
 * tests/telemetryNet.test.mts). A2 adds the POST, removes the sent records from the ring on a
 * 2xx, stores the batch as `lastBatch` for the Preferences viewer — and amends SECURITY.md and
 * README in the SAME commit, because the "no telemetry of any kind" promise stops being true
 * the moment the endpoint is non-empty.
 */
export function flushTelemetry(): TelemetryBatch | null {
  if (!telemetryFlushEnabled(E2E, TELEMETRY_API_URL, getTelemetryPrefs())) return null
  return pendingBatch()
}

let heartbeat: ReturnType<typeof setInterval> | null = null
let flushTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start collection for this session. Idempotent.
 *
 * `coldStartMs` is how long the app took to become usable — measured by the caller (the
 * composition root knows when the process began and when the window was created; this module
 * does not) and bucketed here so the raw millisecond never enters the ring.
 */
export function startTelemetry(coldStartMs: number): void {
  if (heartbeat !== null) return
  const prefs = getTelemetryPrefs()
  if (!prefs.enabled) return
  ensureAnalyticsId()
  beginSession()
  recordEvent({ t: 'sessionStart', coldStartMsBucket: bucketOf(coldStartMs, COLD_START_MS_EDGES) })
  startTimers(prefs)
}

/** Both timers, once the decision to run them has been made. */
function startTimers(prefs: TelemetryPrefs): void {
  heartbeat = setInterval(() => {
    recordEvent({ t: 'sessionHeartbeat', uptimeMs: sessionUptimeMs() })
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref()

  // The network half. `telemetryFlushEnabled` is false in every build that exists today, so
  // this timer is not created at all — a timer that can only ever no-op is noise, not
  // resilience (the `startQueueFlush` precedent).
  if (telemetryFlushEnabled(E2E, TELEMETRY_API_URL, prefs)) {
    flushTimer = setInterval(() => {
      void flushTelemetry()
    }, FLUSH_INTERVAL_MS)
    flushTimer.unref()
    logInfo('[everquest-companion] telemetry: flush loop started')
  }
}

function clearTimers(): void {
  if (heartbeat !== null) clearInterval(heartbeat)
  if (flushTimer !== null) clearInterval(flushTimer)
  heartbeat = null
  flushTimer = null
}

/**
 * The user switched it ON from Preferences, part-way through a session that started with it
 * off. Starts the session and its timers — but records NO `sessionStart`, deliberately: this
 * session began before collection did, and there is no honest cold-start figure for it. A
 * bucketed guess would be indistinguishable from a measurement in the aggregate, which is
 * exactly the kind of number world-model law 1 exists to refuse.
 *
 * (The e2e spec is what found this: enabling from the pane used to leave the heartbeat dead
 * until the next launch, so a session the user had explicitly opted into produced view dwells
 * but no session at all.)
 */
export function resumeTelemetry(): void {
  if (heartbeat !== null) return
  const prefs = getTelemetryPrefs()
  if (!prefs.enabled) return
  beginSession()
  startTimers(prefs)
}

/** The user switched it OFF mid-session. Stops the timers WITHOUT a `sessionEnd` — a session
 *  they opted out of is not a session we get to write a closing record for. */
export function pauseTelemetry(): void {
  clearTimers()
  endSession()
}

/**
 * Apply the switch AND bring this session's timers into line with it. The one place both the
 * Preferences toggle and the first-run notice go through, so the two can never diverge.
 */
export function applyTelemetryEnabled(enabled: boolean): TelemetryPrefs {
  const next = setTelemetryEnabled(enabled)
  if (next.enabled) resumeTelemetry()
  else pauseTelemetry()
  return next
}

/** The first-run notice was answered (or dismissed, which keeps it on — T1). */
export function answerNotice(keepEnabled: boolean): TelemetryPrefs {
  markNoticeShown()
  return applyTelemetryEnabled(keepEnabled)
}

/** Close the session: record `sessionEnd`, stop both timers. Safe to call more than once. */
export function stopTelemetry(): void {
  const uptime = sessionUptimeMs()
  if (uptime > 0) {
    recordEvent({ t: 'sessionEnd', durationMs: uptime, viewsVisited: viewsVisited() })
  }
  clearTimers()
  endSession()
}
