// ============================================================================
// perf.ts — the main-process half of performance profiling.
// ============================================================================
//
// Two independent things live here, and they are wired from the composition root
// (`src/main/index.ts`) the same way `startQueueFlush` and `startTelemetry` are:
//
//   THE HUD SAMPLER — `app.getAppMetrics()` every 2 s plus an event-loop lag probe every
//   500 ms, aggregated into one `PerfSample` pushed to the renderer. It runs ONLY while the
//   user's switch is on.
//
//   THE STARTUP PROFILE — eight phase marks, recorded on EVERY launch whether the HUD is on or
//   off, written once to `<userData>/perf-startup.json`.
//
// ============================== THE PERFORMANCE CONTRACT ==============================
// An instrument that costs something when it is off is a bug, not a feature. Concretely:
//
//   1. NOTHING RUNS WHEN THE HUD IS OFF. No interval is created — not a skipped one, not a
//      no-op one. With the default install (`perfHud.enabled: false`) this module's entire
//      runtime cost is the eight `markStartupPhase` calls below, which are an array push each.
//   2. BOTH TIMERS ARE `unref`'d, so neither can be the reason the process outlives its windows.
//   3. THE PUSH IS ONE MESSAGE PER 2 s, and only while a renderer exists to receive it.
//   4. MARKING IS FREE, WHICH IS WHY IT IS UNCONDITIONAL. `performance.now()` plus a push is
//      microseconds; the launch you wish you had profiled is always the one that already
//      happened (plan P4), so there is no switch to forget to turn on.
//
// The pure half — aggregation, lag stats, severity, phase accounting, formatting — is
// `src/shared/perf.ts` and is pinned by `tests/perf.test.mts`. What is left here is I/O.

import { app } from 'electron'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import {
  addMark,
  aggregateMetrics,
  buildProfile,
  describeMarkError,
  lagStats,
  PERF_LAG_PROBE_INTERVAL_MS,
  PERF_SAMPLE_INTERVAL_MS,
  totalsOf,
  type PerfSample,
  type RawProcessMetric,
  type StartupMark,
  type StartupPhase,
  type StartupProfile
} from '../shared/perf'
import { logError, logInfo } from './errorLog'
import { sendToMain } from './windows'

const PROFILE_FILE = 'perf-startup.json'

// ------------------------------------------------------------------------ startup marking

/**
 * Wall clock of this launch, captured against `performance.timeOrigin` — the process's OWN
 * start, not this module's evaluation. That distinction is the whole point: the earliest phase
 * (`storeLoaded`) measures work that finished before anything in this file ran, and a start
 * captured at module scope would silently exclude it.
 */
const LAUNCH_STARTED_AT = Math.round(performance.timeOrigin)

let marks: StartupMark[] = []
let eventsReplayed: number | undefined
let profileWritten = false

/** Extra facts a mark may carry. `atMs` exists because the two module-evaluation phases finished
 *  BEFORE the composition root could speak (see shared/perf.ts's phase table) and are marked with
 *  the timestamp the module that did the work recorded. */
export interface MarkOptions {
  atMs?: number
  eventsReplayed?: number
}

/**
 * Record one startup phase. NEVER THROWS and never takes the app down: a refused mark (a
 * duplicate, or one that arrived out of order) is a wiring bug worth one log line, not a reason
 * for the app not to start. The refusal is a TYPED value from `addMark`, so the log line can say
 * which phase and why instead of a NaN appearing three screens later in the UI.
 *
 * Completing the last phase writes the profile — once. Everything after that is ignored.
 */
export function markStartupPhase(phase: StartupPhase, opts: MarkOptions = {}): void {
  const at = opts.atMs ?? performance.now()
  if (opts.eventsReplayed !== undefined) eventsReplayed = opts.eventsReplayed
  const result = addMark(marks, phase, at)
  if (!result.ok) {
    logError('main:perfStartup', describeMarkError(result.error))
    return
  }
  marks = result.marks
  if (startupProfile().complete) writeStartupProfile()
}

/** This launch's profile so far. Complete once every phase has landed. */
export function startupProfile(): StartupProfile {
  return buildProfile(marks, {
    startedAt: LAUNCH_STARTED_AT,
    version: app.getVersion(),
    ...(eventsReplayed === undefined ? {} : { eventsReplayed })
  })
}

/** One line per launch, in the same voice as the other boot logs: total, replay size, and the
 *  three costliest phases — enough to know from `errors.log` alone whether a launch was slow. */
function logStartupSummary(profile: StartupProfile): void {
  const worst = [...profile.phases]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 3)
    .map((p) => `${p.phase} ${String(Math.round(p.durationMs))}ms`)
    .join(', ')
  const replayed =
    profile.eventsReplayed === undefined ? '' : `, ${String(profile.eventsReplayed)} events replayed`
  logInfo(
    `[everquest-companion] Startup ${String(Math.round(profile.totalMs))}ms` +
      `${replayed} (${worst}) — profile at ${profilePath()}`
  )
}

function profilePath(): string {
  return join(app.getPath('userData'), PROFILE_FILE)
}

/**
 * Persist the profile ATOMICALLY (temp file + rename), replacing the previous launch's —
 * one file, last launch only (plan P4/P6). Best effort: a profile that cannot be written is
 * never a reason to fail a launch, so every failure is logged and startup continues.
 *
 * Written once per launch, when the final phase lands. `flushStartupProfile` covers the launch
 * that quits before that, so a boot that died half-way still leaves evidence of how far it got.
 */
function writeStartupProfile(): void {
  const profile = startupProfile()
  if (profile.phases.length === 0) return
  profileWritten = true
  const path = profilePath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(tmp, JSON.stringify(profile, null, 2), 'utf8')
    renameSync(tmp, path)
    logStartupSummary(profile)
  } catch (err) {
    logError('main:perfStartup', { message: 'perf-startup.json write failed', err })
  }
}

/** Write an INCOMPLETE profile on the way out, if the launch never reached the last phase. */
export function flushStartupProfile(): void {
  if (!profileWritten) writeStartupProfile()
}

// ---------------------------------------------------------------------------- the sampler

let sampleTimer: ReturnType<typeof setInterval> | null = null
let lagTimer: ReturnType<typeof setInterval> | null = null
/** Drift samples for the CURRENT window; taken and cleared by each 2 s sample. */
let drifts: number[] = []
/** When the next lag tick is DUE. Its lateness is the measurement. */
let lagDueAt = 0

/**
 * The event-loop lag probe (plan P2). A 500 ms interval that measures its own lateness: the
 * event loop can only be late because something else was holding it, so the drift IS the block.
 *
 * Sub-millisecond scheduling noise is real (Windows' 15.6 ms timer quantum sits under all of
 * this), which is why the chip colours on a p95 rather than a max, and alerts only at 200 ms.
 */
function startLagProbe(): void {
  lagDueAt = performance.now() + PERF_LAG_PROBE_INTERVAL_MS
  lagTimer = setInterval(() => {
    const now = performance.now()
    drifts.push(Math.max(0, now - lagDueAt))
    lagDueAt = now + PERF_LAG_PROBE_INTERVAL_MS
  }, PERF_LAG_PROBE_INTERVAL_MS)
  lagTimer.unref()
}

/** One sample: fold Electron's per-process metrics, drain the drift window, push. */
function emitSample(): void {
  const metrics = app.getAppMetrics() as unknown as RawProcessMetric[]
  const byType = aggregateMetrics(metrics)
  const totals = totalsOf(byType)
  const lag = lagStats(drifts)
  drifts = []
  const sample: PerfSample = {
    ts: Date.now(),
    cpuPercent: totals.cpuPercent,
    memoryMb: totals.memoryMb,
    byType,
    lag
  }
  sendToMain(IPC.onPerfSample, sample)
}

/** Is the HUD's machinery running right now? (The gating tests' seam — and the IPC's guard.) */
export function perfSamplerRunning(): boolean {
  return sampleTimer !== null
}

/**
 * Start sampling. Idempotent. The DECISION to call this belongs to the caller (the composition
 * root at launch, the IPC handler on a toggle) because the pref lives in the store and this
 * module deliberately does not import it — one direction of dependency, no cycle.
 *
 * The first sample is emitted IMMEDIATELY so the chip appears the moment the switch is flipped
 * rather than up to two seconds later. Its `cpuPercent` covers the interval since Electron's
 * last internal metrics read, and its `lag` window is empty (`samples: 0`), which the chip
 * renders as "not measured yet" rather than as zero lag.
 */
export function startPerfSampler(): void {
  if (sampleTimer !== null) return
  drifts = []
  startLagProbe()
  emitSample()
  sampleTimer = setInterval(emitSample, PERF_SAMPLE_INTERVAL_MS)
  sampleTimer.unref()
  logInfo('[everquest-companion] perf HUD: sampler started (2s metrics, 500ms lag probe)')
}

/**
 * Stop sampling and tell the renderer, with a `null` push on the same channel — the chip is
 * hidden ENTIRELY when the HUD is off (plan P3), so it needs to hear "no more numbers" rather
 * than being left holding the last one it saw.
 */
export function stopPerfSampler(): void {
  const wasRunning = sampleTimer !== null
  if (sampleTimer) clearInterval(sampleTimer)
  if (lagTimer) clearInterval(lagTimer)
  sampleTimer = null
  lagTimer = null
  drifts = []
  if (wasRunning) sendToMain(IPC.onPerfSample, null)
}

/** Teardown from `window-all-closed`: stop the timers and make sure the launch left a profile. */
export function stopPerf(): void {
  stopPerfSampler()
  flushStartupProfile()
}
