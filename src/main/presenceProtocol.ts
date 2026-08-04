// ============================================================================
// presenceProtocol.ts — the PURE half of "what is EverQuest doing right now?"
// ============================================================================
//
// The `src/main/security.ts` ↔ `src/main/windows.ts` split, applied to presence: everything
// here is a function of its arguments — the watcher's stdout line protocol, the "is this window
// EverQuest" predicate, the alt-tab debounce, and the gating matrix that decides whether the
// overlays hide and whether the 8 ms cursor stream runs.
//
// No Electron, no child process, no `fs`, no store. That is what lets `tests/presence.test.mts`
// pin the performance contract ("nothing runs when nothing is on", "the stream stops when EQ is
// unfocused") as ordinary unit tests that never skip, instead of as claims somebody re-measures
// by hand. `src/main/presence.ts` is the impure half that spawns the watcher and feeds these.

import type {
  CursorRingPrefs,
  OverlayAutoHidePrefs,
  PresenceState,
  ScreenRect
} from '../shared/presencePrefs'

// ---------------------------------------------------------------- the line protocol
//
// The watcher child prints one record per line to stdout, and ONLY when something changed:
//
//   F|<pid>|<x>|<y>|<w>|<h>|<exePath>|<title>   foreground window changed
//   R|<0|1>                                      EQ process existence changed (5 s cadence)
//   C|<0|1>                                      system cursor visibility changed
//   H                                            heartbeat — "still looping" (5 s cadence)
//
// `title` is last because it is the only field that may contain anything (including `|`); a
// Windows path cannot contain `|`, so every field before it is unambiguous.
//
// THE HEARTBEAT IS THE ONE UNCONDITIONAL LINE, and it is why it exists. Every other record is
// printed ONLY on a change, so a healthy watcher's steady state is total silence on the pipe —
// which is exactly what a WEDGED watcher looks like from the parent. Without an explicit
// liveness signal there is no observation that separates "nothing has happened" from "nothing
// will ever happen again", and the second one FREEZES the presence state: `eqFocused:true`
// outlives the alt-tab that should have cleared it and the ring keeps drawing over whatever the
// user switched to. One 1-byte line per 5 s on an otherwise idle pipe buys that distinction.

/** One decoded watcher record. */
export type PresenceRecord =
  | { t: 'fg'; pid: number; rect: ScreenRect; exePath: string; title: string }
  | { t: 'run'; running: boolean }
  | { t: 'cursor'; visible: boolean }
  | { t: 'beat' }

/** A finite integer from one protocol field, or null when the field is not one. */
function intField(s: string | undefined): number | null {
  if (s === undefined || s === '') return null
  const n = Number(s)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}

/** The `<0|1>` payload `R` and `C` share, or null when the field is not one. */
function boolField(s: string | undefined): boolean | null {
  const v = intField(s)
  return v === null ? null : v !== 0
}

/** The one record with a payload: `F|<pid>|<x>|<y>|<w>|<h>|<exePath>|<title>`. */
function parseForeground(parts: string[]): PresenceRecord | null {
  if (parts.length < 7) return null
  const [pid, x, y, w, h] = [1, 2, 3, 4, 5].map((i) => intField(parts[i]))
  if (pid === null || x === null || y === null || w === null || h === null) return null
  return {
    t: 'fg',
    pid,
    rect: { x, y, width: w, height: h },
    exePath: parts[6] ?? '',
    // The title is whatever remains — it is user/game-supplied text and may contain `|`.
    title: parts.slice(7).join('|')
  }
}

/**
 * Decode one stdout line. Returns null for anything that is not a well-formed record, which is
 * the only correct answer for a stream that can also carry a PowerShell warning, a stray blank
 * line, or a partially-flushed write — a malformed line must never move the state.
 */
export function parsePresenceLine(line: string): PresenceRecord | null {
  const trimmed = line.replace(/\r$/, '').trim()
  if (trimmed === '') return null
  const parts = trimmed.split('|')
  if (parts[0] === 'F') return parseForeground(parts)
  // The heartbeat carries no payload, so it is the whole line or it is not a heartbeat.
  if (trimmed === 'H') return { t: 'beat' }
  const flag = boolField(parts[1])
  if (parts[0] === 'R') return flag === null ? null : { t: 'run', running: flag }
  if (parts[0] === 'C') return flag === null ? null : { t: 'cursor', visible: flag }
  return null
}

// ------------------------------------------------------- is this window EverQuest?

/** `<root>\` — a separator-terminated prefix, so `…\EverQuest Legends2` never matches
 *  `…\EverQuest Legends`. Empty in, empty out (an unresolvable root disables path matching). */
export function eqRootPrefix(root: string): string {
  const trimmed = root.trim()
  if (!trimmed) return ''
  return trimmed.endsWith('\\') || trimmed.endsWith('/') ? trimmed : `${trimmed}\\`
}

/**
 * The image names the EverQuest CLIENT actually ships under. `eqgame.exe` has been the client
 * binary on every build from Titanium to Live, and it is the SAME name the watcher's own
 * "is the game running" scan keys on (`$p.ProcessName -eq 'eqgame'`) — one fact, one spelling.
 */
const EQ_CLIENT_EXES = new Set(['eqgame.exe'])

/** The last path segment of a Windows image path, lowercased. */
function exeBaseName(exePath: string): string {
  const p = exePath.trim().toLowerCase()
  const cut = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return cut === -1 ? p : p.slice(cut + 1)
}

/**
 * Does this title belong to the EverQuest CLIENT — as opposed to a window that merely mentions
 * the game? The client titles its window "EverQuest" (some builds append a server or character),
 * so the match is ANCHORED at the start and stops at a word boundary. `…includes('everquest')`
 * was the old test and it is the bug this predicate exists to not have: a browser tab reading
 * "EverQuest Wiki — Google Chrome" contains the substring in the middle, and so does a Discord
 * window sitting in an #everquest channel.
 */
function titleIsEqClient(title: string): boolean {
  return /^everquest\b/i.test(title.trim())
}

/**
 * Is the foreground window EverQuest?
 *
 * PRIMARY signal: the process image lives under the effective EQ install root
 * (`log/config.ts effectiveEqRoot()` — never a hardcoded Daybreak path). That is an identity,
 * not a guess, and it follows the user's Settings override for free.
 *
 * THE PATH, WHEN WE HAVE ONE, IS THE ANSWER — and this is the fix for a real, reported bug: the
 * cursor ring followed the pointer around the user's WEB BROWSER. The old predicate fell back to
 * "the title contains EverQuest" for EVERY window the root check declined, so any window of any
 * process — a browser on an EQ wiki, a chat client in an #everquest channel — was classified as
 * the game, took `eqFocused`, and handed the ring its own rectangle to draw in. A READABLE image
 * path is a positive answer to "whose window is this?", so once we have one the only thing that
 * can still make it EverQuest is the client's own image NAME. That keeps the case the fallback
 * was actually written for — a second install the app was never pointed at — while costing every
 * unrelated process its ability to impersonate the game by title.
 *
 * THE TITLE IS THE LAST RESORT, and only when the path is UNKNOWN (elevation, protected
 * processes: the watcher reports an empty path and there is nothing else to go on).
 *
 * (This app's own windows are titled "EQ Legends Companion" / "… Overlay" / "Cursor Ring" and
 * match none of it — and are classified by pid before they ever reach this predicate.)
 */
export function isEqWindow(w: { exePath: string; title: string }, eqRoot: string): boolean {
  const prefix = eqRootPrefix(eqRoot).toLowerCase()
  const exe = w.exePath.trim().toLowerCase()
  if (prefix && exe.startsWith(prefix)) return true
  if (exe) return EQ_CLIENT_EXES.has(exeBaseName(exe))
  return titleIsEqClient(w.title)
}

// ---------------------------------------------------------------- the focus debounce

/**
 * Alt-tab is not one transition, it is a burst of them: Windows briefly makes the task-switcher
 * (and sometimes the desktop shell) foreground on the way between two apps. Acting on the raw
 * signal would strobe every overlay off and back on. So the raw value must hold STILL for
 * `debounceMs` before it is committed.
 *
 * A state machine rather than a timer wrapper, so the decision is testable without clocks: the
 * caller supplies `now`, and re-runs the step when its own timer fires.
 */
export interface FocusDebounce {
  /** The value everyone downstream sees. */
  committed: boolean
  /** A different value we are waiting out, or null when the raw signal agrees with `committed`. */
  candidate: boolean | null
  /** When `candidate` was first observed. */
  since: number
}

export const FOCUS_DEBOUNCE_MS = 300

export function newFocusDebounce(committed = false): FocusDebounce {
  return { committed, candidate: null, since: 0 }
}

export interface FocusDebounceStep {
  state: FocusDebounce
  /** True exactly when `state.committed` differs from the input state's. */
  changed: boolean
  /** ms until this candidate would commit, or null when nothing is pending. */
  waitMs: number | null
}

/**
 * Fold one observation into the debounce. Idempotent for a steady signal (a repeated
 * observation that already matches `committed` clears any pending candidate and reports no
 * change), which is what makes it safe to call on every single watcher line.
 */
export function focusDebounceStep(
  state: FocusDebounce,
  observed: boolean,
  now: number,
  debounceMs = FOCUS_DEBOUNCE_MS
): FocusDebounceStep {
  if (observed === state.committed) {
    // The flap resolved back to where we already were: forget the candidate entirely.
    return { state: { ...state, candidate: null, since: 0 }, changed: false, waitMs: null }
  }
  const since = state.candidate === observed ? state.since : now
  if (now - since >= debounceMs) {
    return { state: { committed: observed, candidate: null, since: 0 }, changed: true, waitMs: null }
  }
  return {
    state: { ...state, candidate: observed, since },
    changed: false,
    waitMs: debounceMs - (now - since)
  }
}

// ------------------------------------------------------------------- the gating matrix

/**
 * Should the floating overlays be hidden right now? The two settings are independent and either
 * one can hide on its own — that is what "two toggles" means, and it is why this is not a
 * three-valued mode.
 *
 * With BOTH off this is always false: a user who wants none of it gets the pre-feature behavior
 * exactly, and (via `presenceNeeded`) never even starts the watcher.
 */
export function overlaysShouldHide(p: PresenceState, prefs: OverlayAutoHidePrefs): boolean {
  // NEVER HIDE ON A GUESS. Before the watcher's first line `eqRunning:false` means "we have not
  // looked yet", not "the game is closed" — and the child pays a one-time compile before it can
  // say otherwise. Acting on it would blink every overlay off at launch and back on a second
  // later on a machine where the game was running the whole time. Fail OPEN, always: the same
  // rule covers a watcher that died, which is why presence.ts resets this flag on exit.
  if (!p.observed) return false
  if (prefs.hideWhenNotRunning && !p.eqRunning) return true
  if (prefs.hideWhenUnfocused && !p.eqFocused) return true
  return false
}

/**
 * Should the cursor ring be on screen — and, identically, should main be streaming cursor
 * samples to it? ONE predicate for both, because "visible but not tracking" is a lagging ghost
 * ring and "tracking but not visible" is exactly the poll the performance contract exists to
 * avoid. Requires known bounds: the ring is sized and positioned to the EQ window, and there is
 * nowhere to put it until that window has been seen.
 *
 * A HIDDEN CURSOR IS NOT A CURSOR. EverQuest hides the pointer for the duration of mouselook and
 * re-centers it every frame, so `getCursorScreenPoint()` oscillates around a pointer that is not
 * on screen — the ring danced by itself. `cursorVisible` defaults true, so this narrows the
 * predicate only once the watcher has actually measured a hidden cursor.
 */
export function cursorRingActive(p: PresenceState, ring: CursorRingPrefs): boolean {
  return ring.enabled && p.eqFocused && p.cursorVisible && p.eqBounds !== null
}

// ------------------------------------------------------------------- watcher health
//
// THE STATE IS ONLY AS GOOD AS THE STREAM THAT FEEDS IT. `PresenceState` is a CACHE of the last
// thing the watcher said, and every consumer treats it as current fact — so a stream that stops
// does not make the app cautious, it makes the app confidently wrong. The reported failure is
// the ring: `cursorRingActive` needs `eqFocused && cursorVisible && eqBounds`, all three of
// which SURVIVE a dead pipe, so a watcher that stops mid-game leaves a halo chasing the pointer
// across whatever the user alt-tabs to.
//
// Two things can stop the stream, and they need different answers:
//
//   * the child EXITS — observable directly (`'exit'`), handled in presence.ts.
//   * the child WEDGES — alive, pid intact, loop not advancing. Only the HEARTBEAT's absence
//     reveals it, which is what these two functions decide.
//
// Both are decided here, purely, so `tests/presence.test.mts` can pin them with an injected
// clock instead of a real 30-second wait.

/** Heartbeat cadence inside the child. Rides the existing 5 s process-existence poll. */
export const WATCHER_HEARTBEAT_MS = 5_000

/**
 * How long a silent pipe is tolerated before the watcher is declared wedged.
 *
 * SIX missed heartbeats. Deliberately generous: the cost of being wrong in one direction is a
 * needless respawn (a one-second PowerShell compile nobody sees), and in the other it is the
 * ring drawing over the user's browser until they quit the app. It still has to be a multiple,
 * not a margin — a machine that is swapping, or a game that just grabbed every core for a zone
 * load, can starve a 150 ms loop for several seconds without anything being wrong with it.
 */
export const WATCHER_STALE_MS = 30_000

/**
 * Has the watcher gone quiet long enough to be presumed wedged? `lastSignalAt` is the timestamp
 * of the last thing the child said OR of the spawn itself — a child that has never spoken is
 * given exactly the same window as one that has stopped, which is correct: the one-time
 * `Add-Type` compile means silence right after a spawn is normal and silence forever is not.
 */
export function watcherIsStale(
  lastSignalAt: number,
  now: number,
  staleMs: number = WATCHER_STALE_MS
): boolean {
  return now - lastSignalAt >= staleMs
}

/**
 * The respawn schedule, in ms, indexed by how many times in a row we have had to do it.
 *
 * CAPPED, and capped low enough to still be a recovery. A watcher can fail for a reason that is
 * never going to clear on this machine — PowerShell removed by policy, an execution policy that
 * kills the child on sight — and an uncapped retry against that is a spawn storm. It can also
 * fail for a reason that clears on its own in a second, which is why the first retry is fast.
 * The counter resets the moment a child produces a record, so an app that runs for eight hours
 * with one hiccup at hour three retries at 1 s, not at 30.
 */
export const WATCHER_RESTART_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000]

/** The delay before restart attempt number `consecutiveFailures` (1-based); the last entry is
 *  the ceiling and every later failure sits on it. */
export function watcherRestartDelayMs(consecutiveFailures: number): number {
  const last = WATCHER_RESTART_BACKOFF_MS.length - 1
  const i = Number.isFinite(consecutiveFailures) ? Math.floor(consecutiveFailures) - 1 : 0
  return WATCHER_RESTART_BACKOFF_MS[Math.min(Math.max(i, 0), last)]
}
