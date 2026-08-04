// ============================================================================
// presenceEffects.ts — what the presence facts DO.
// ============================================================================
//
// `presence.ts` answers "is EQ running / focused / where". This file is the only place that
// acts on those answers, and it owns exactly two behaviors:
//
//   * OVERLAY AUTO-HIDE — hide/show the floating meters per the two independent settings.
//   * THE CURSOR RING — create, position, show/hide the ring window, and run the cursor stream.
//
// The split matters: the watcher stays a pure source (spawn, parse, debounce) that can be
// reasoned about and tested without windows, and every window side effect in the feature lives
// in one file you can read top to bottom.
//
// ================================= THE PERFORMANCE CONTRACT =================================
// The owner's gate was "it can't feel like it's lagging — performance thought through by
// default". Main's half of that is four rules, all enforced here:
//
//   1. NOTHING RUNS WHEN NOTHING IS ON. `presenceNeeded()` gates the watcher itself: with the
//      ring off and both auto-hide switches at a state that needs no watcher, no child process
//      exists, no interval exists, and this file's cost is a single subscription that was never
//      made. That is the default install.
//   2. THE 8 ms POLL IS THE NARROWEST GATE IN THE APP. It runs only while the ring is ENABLED
//      *and* EQ is FOCUSED *and* the SYSTEM CURSOR IS VISIBLE *and* the ring window exists.
//      Alt-tab out of the game — or hold right-click for mouselook, which hides the cursor — and
//      the interval is cleared, not skipped, cleared. The ring is parked with a single message on
//      the way out and reads nothing until it is active again, so a mouselook turn costs zero
//      `getCursorScreenPoint()` calls rather than one per tick of a pointer EverQuest is
//      re-centering every frame. `cursorStreamStats()` exists so that can be MEASURED rather
//      than asserted.
//   3. AN UNMOVED CURSOR SENDS NOTHING. The sample is compared against the last one sent and
//      dropped if identical, so a hand resting on the mouse costs one `getCursorScreenPoint()`
//      per tick and zero IPC. Reading a quest text with the ring on is free.
//   4. WINDOW GEOMETRY IS NEVER TOUCHED PER SAMPLE. The ring window is re-bounded only when the
//      EQ window actually moves; the per-sample work is two subtractions against a cached
//      origin. `setBounds()` at 125 Hz would be a window-manager round trip per frame.
//
// The renderer's half of the contract (coalesce to rAF, compositor-only transform, never queue)
// is in `src/renderer/src/overlay/cursorRing.ts`.

import { screen, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import { logError } from './errorLog'
import { presenceSnapshot, stopPresence, subscribePresence } from './presence'
import { cursorRingActive, overlaysShouldHide } from './presenceProtocol'
import { getCursorRing, getOverlayAutoHide } from './store'
import {
  createCursorRingWindow,
  destroyCursorRingWindow,
  getCursorRingWindow,
  setCursorRingBounds,
  setCursorRingVisible,
  setOverlaysHidden
} from './windows'
import { presenceNeeded } from '../shared/presencePrefs'
import type { CursorPoint, PresenceState, ScreenRect } from '../shared/presencePrefs'

/**
 * Cursor sampling period: ask for 8 ms, i.e. "as fast as the platform will give us".
 *
 * MEASURED (Electron 3x 30 s windows on this machine): a `setInterval(8)` in Electron's main
 * process actually fires ~64 times a second, not 125 — Windows' default 15.6 ms timer quantum
 * clamps it, and Chromium does not raise the system timer resolution for a main-process timer.
 * The number stays 8 anyway: it is a request for the platform's floor, and if a future Electron
 * (or a machine with a raised timer resolution) delivers more, the renderer already coalesces to
 * `requestAnimationFrame` and simply drops the surplus.
 *
 * ~64 Hz is at or above a 60 Hz display's frame rate, so the ring has a fresh point for every
 * composed frame there. On a 144 Hz panel some frames reuse the previous point — a sub-16 ms
 * lag on a HALO whose real cursor is drawn by Windows at full rate, which is the trade this
 * whole design makes on purpose (see the renderer file's rule 1).
 */
const CURSOR_POLL_MS = 8

/** Where a parked ring goes when the pointer leaves the EQ window (a half-ring clipped against
 *  the window edge reads as a bug; absence reads as "not over the game"). */
const PARKED: CursorPoint = { x: -9999, y: -9999 }

let unsubscribe: (() => void) | null = null
let pollTimer: NodeJS.Timeout | null = null
/** The ring window's top-left, cached so the hot path never calls `getBounds()`. */
let ringOrigin: ScreenRect | null = null
let lastSent: CursorPoint | null = null
let sends = 0
let samples = 0

/**
 * MEASUREMENT SEAM. `samples` counts `getCursorScreenPoint()` calls, `sends` counts IPC
 * messages actually pushed to the ring. `streaming` says whether the interval exists at all.
 *
 * This is how "the stream stops when EQ is unfocused" is proven rather than claimed: read it,
 * alt-tab away, read it again — `streaming` is false and `sends` has stopped advancing.
 */
export function cursorStreamStats(): {
  streaming: boolean
  samples: number
  sends: number
} {
  return { streaming: pollTimer !== null, samples, sends }
}

/** Push a point to the ring unless it is already the point the ring has. Unchanged ⇒ nothing to
 *  say: this is what makes a still mouse (and a parked one) free. */
function sendPoint(w: BrowserWindow, next: CursorPoint): void {
  if (lastSent?.x === next.x && lastSent.y === next.y) return
  lastSent = next
  sends++
  w.webContents.send(IPC.onCursorPoint, next)
}

/** One cursor sample: read the pointer, convert to the ring window's own CSS px, send if it
 *  moved. Kept tiny on purpose — this is the only code in the app that runs at 125 Hz. */
function sampleCursor(): void {
  const w = getCursorRingWindow()
  const origin = ringOrigin
  if (!w || w.isDestroyed() || !origin) return
  samples++
  const p = screen.getCursorScreenPoint()
  const x = p.x - origin.x
  const y = p.y - origin.y
  const inside = x >= 0 && y >= 0 && x <= origin.width && y <= origin.height
  sendPoint(w, inside ? { x, y } : PARKED)
}

/**
 * Park the ring because it is not active: one PARKED point, then silence.
 *
 * The ring window is hidden rather than destroyed, so without this it would carry the last point
 * it was told about — a stale halo for the frame between `showInactive()` and the first fresh
 * sample. Parking also settles the inside/outside question ONCE: while the ring is suppressed the
 * stream is stopped, so nothing re-evaluates the edge test against a pointer EverQuest is
 * re-centering, and a cursor sitting on the window border cannot flip the ring on and off.
 */
function parkRing(): void {
  const w = getCursorRingWindow()
  if (!w || w.isDestroyed()) return
  sendPoint(w, PARKED)
}

function startStream(): void {
  if (pollTimer) return
  lastSent = null
  pollTimer = setInterval(sampleCursor, CURSOR_POLL_MS)
  // A cursor poll must never be the reason the app stays alive at quit.
  pollTimer.unref?.()
}

/** Stop sampling. `lastSent` deliberately SURVIVES: the caller parks the ring next, and the
 *  dedup is what makes that park cost one message instead of one per presence transition. It is
 *  cleared by `startStream` (a fresh stream owes the renderer an unconditional first point) and
 *  by a bounds change (the point it holds describes the wrong origin). */
function stopStream(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

/** Fold the current presence + settings into the ring window's existence, bounds and stream. */
function applyRing(state: PresenceState): void {
  const ring = getCursorRing()
  if (!ring.enabled) {
    stopStream()
    ringOrigin = null
    destroyCursorRingWindow()
    return
  }
  const bounds = state.eqBounds
  if (!bounds) {
    // The ring is on, but the EQ window has never been seen this session — there is nowhere to
    // put it, and inventing a rectangle would put a halo over the desktop. (A watcher that DIES
    // lands here too, with a live ring window, so it parks like any other deactivation.)
    stopStream()
    setCursorRingVisible(false)
    parkRing()
    return
  }
  createCursorRingWindow(bounds)
  setCursorRingBounds(bounds)
  if (!sameRect(ringOrigin, bounds)) {
    ringOrigin = bounds
    // The window moved under the pointer, so the last sent point describes the wrong origin.
    lastSent = null
  }
  const active = cursorRingActive(state, ring)
  setCursorRingVisible(active)
  if (active) {
    startStream()
    return
  }
  // Order matters: stop sampling first, THEN park, so the park is the last word the ring hears.
  stopStream()
  parkRing()
}

function sameRect(a: ScreenRect | null, b: ScreenRect | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** The subscriber. Runs on every presence CHANGE (and once on subscribe). */
function onPresence(state: PresenceState): void {
  try {
    setOverlaysHidden(overlaysShouldHide(state, getOverlayAutoHide()))
    applyRing(state)
  } catch (err) {
    // A window that died between the check and the call must not kill the watcher pump.
    logError('main:presenceEffects', err)
  }
}

/**
 * Re-evaluate everything: whether the watcher is needed at all, and — if it is — what the
 * current facts imply. Called at startup and after every settings write, which is the ONLY way
 * either setting changes.
 *
 * Turning the last consumer off is the interesting path: it kills the child process, then
 * RESTORES the pre-feature world (overlays visible, ring gone) rather than freezing whatever
 * the last presence transition happened to leave behind. A user who switches auto-hide off
 * while their overlays are hidden must get them back immediately.
 */
export function refreshPresenceEffects(): void {
  const ring = getCursorRing()
  const needed = presenceNeeded(ring, getOverlayAutoHide())
  if (!needed) {
    unsubscribe?.()
    unsubscribe = null
    stopStream()
    ringOrigin = null
    destroyCursorRingWindow()
    setOverlaysHidden(false)
    return
  }
  // Push the (possibly resized) ring config to a live ring window so a Preferences slider
  // resizes the halo under the user's pointer instead of on the next restart.
  getCursorRingWindow()?.webContents.send(IPC.onCursorRingConfig, ring)
  if (!unsubscribe) {
    // subscribePresence fires the callback immediately with what is already known, so this
    // single call both starts the watcher and applies the current state.
    unsubscribe = subscribePresence(onPresence)
    return
  }
  onPresence(presenceSnapshot())
}

/** Start the presence-driven features. Called once from the composition root, after the
 *  windows exist. A no-op posture (both settings off) costs one store read. */
export function initPresenceEffects(): void {
  refreshPresenceEffects()
}

/** Full teardown (app quit). */
export function stopPresenceEffects(): void {
  unsubscribe?.()
  unsubscribe = null
  stopStream()
  ringOrigin = null
  destroyCursorRingWindow()
  stopPresence()
}
