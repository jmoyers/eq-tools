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
//
// `title` is last because it is the only field that may contain anything (including `|`); a
// Windows path cannot contain `|`, so every field before it is unambiguous.

/** One decoded watcher record. */
export type PresenceRecord =
  | { t: 'fg'; pid: number; rect: ScreenRect; exePath: string; title: string }
  | { t: 'run'; running: boolean }
  | { t: 'cursor'; visible: boolean }

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
 * Is the foreground window EverQuest?
 *
 * PRIMARY signal: the process image lives under the effective EQ install root
 * (`log/config.ts effectiveEqRoot()` — never a hardcoded Daybreak path). That is an identity,
 * not a guess, and it follows the user's Settings override for free.
 *
 * FALLBACK: the window TITLE contains "EverQuest". Needed because a process's image path is not
 * always readable (elevation, protected processes) and because a user can run the client from a
 * second install the app has not been pointed at. It is deliberately a fallback, not a peer: it
 * is the weaker claim, and it can only ever fire when the path check has already declined.
 * (This app's own windows are titled "EQ Legends Companion" / "… Overlay" / "Cursor Ring" and
 * match neither — and are classified by pid before they ever reach this predicate.)
 */
export function isEqWindow(w: { exePath: string; title: string }, eqRoot: string): boolean {
  const prefix = eqRootPrefix(eqRoot).toLowerCase()
  const exe = w.exePath.trim().toLowerCase()
  if (prefix && exe.startsWith(prefix)) return true
  return w.title.toLowerCase().includes('everquest')
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
