// Presence watcher + the two features it drives (src/main/presence.ts,
// src/shared/presencePrefs.ts).
//
// Everything asserted here is PURE: the stdout line protocol, the "is this window EverQuest"
// predicate, the alt-tab debounce, and the gating matrix that decides whether the overlays hide
// and whether the 8 ms cursor stream runs. No Electron, no child process, no game — so this
// suite is as cheap and as unskippable as overlayLayout/storeMigrations.
//
// THE GATING MATRIX IS THE PERFORMANCE CONTRACT, in test form. "Nothing runs when nothing is
// on" and "the stream stops when EQ is unfocused" are the owner's explicit requirements; they
// are decided by two exported predicates, so they are pinned here rather than measured by hand
// on every change.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FOCUS_DEBOUNCE_MS,
  cursorRingActive,
  eqRootPrefix,
  focusDebounceStep,
  isEqWindow,
  newFocusDebounce,
  overlaysShouldHide,
  parsePresenceLine
} from '../src/main/presenceProtocol'
import {
  DEFAULT_CURSOR_RING,
  DEFAULT_OVERLAY_AUTO_HIDE,
  INITIAL_PRESENCE,
  normalizeCursorRing,
  normalizeOverlayAutoHide,
  presenceNeeded
} from '../src/shared/presencePrefs'
// PresenceState is NOT re-exported from shared/types.ts — see the note at its foot.
import type { PresenceState } from '../src/shared/presencePrefs'

const EQ_ROOT = 'C:\\Users\\Public\\Daybreak Game Company\\Installed Games\\EverQuest Legends'

// ------------------------------------------------------------------ the line protocol

test('a foreground record decodes into a pid, a rectangle, an image path and a title', () => {
  const rec = parsePresenceLine(`F|4321|100|50|1920|1080|${EQ_ROOT}\\eqgame.exe|EverQuest`)
  assert.deepEqual(rec, {
    t: 'fg',
    pid: 4321,
    rect: { x: 100, y: 50, width: 1920, height: 1080 },
    exePath: `${EQ_ROOT}\\eqgame.exe`,
    title: 'EverQuest'
  })
})

test('a title may contain the field separator — it is last for exactly that reason', () => {
  // A Windows path cannot contain `|`, so every field BEFORE the title is unambiguous and the
  // title is simply "the rest". A browser tab or a chat client will absolutely produce this.
  const rec = parsePresenceLine('F|7|0|0|800|600|C:\\x\\y.exe|Notes | Draft | 3')
  assert.equal(rec?.t, 'fg')
  assert.equal(rec.t === 'fg' ? rec.title : '', 'Notes | Draft | 3')
})

test('an empty image path and an empty title are ordinary — many windows have neither', () => {
  const rec = parsePresenceLine('F|9|0|0|10|10||')
  assert.deepEqual(rec, {
    t: 'fg',
    pid: 9,
    rect: { x: 0, y: 0, width: 10, height: 10 },
    exePath: '',
    title: ''
  })
})

test('negative coordinates survive — a window on a left/upper secondary monitor has them', () => {
  const rec = parsePresenceLine('F|9|-1920|-200|1920|1080|C:\\x.exe|EverQuest')
  assert.deepEqual(rec?.t === 'fg' ? rec.rect : null, {
    x: -1920,
    y: -200,
    width: 1920,
    height: 1080
  })
})

test('a running record decodes to a boolean, both ways', () => {
  assert.deepEqual(parsePresenceLine('R|1'), { t: 'run', running: true })
  assert.deepEqual(parsePresenceLine('R|0'), { t: 'run', running: false })
})

test('a cursor-visibility record decodes to a boolean, both ways', () => {
  assert.deepEqual(parsePresenceLine('C|1'), { t: 'cursor', visible: true })
  assert.deepEqual(parsePresenceLine('C|0'), { t: 'cursor', visible: false })
})

test('a trailing CR is stripped — the child writes Windows line endings', () => {
  assert.deepEqual(parsePresenceLine('R|1\r'), { t: 'run', running: true })
})

test('anything malformed decodes to null and can never move the state', () => {
  // The stream can also carry a PowerShell warning, a blank line, or a partially-flushed write.
  for (const junk of [
    '',
    '   ',
    'R',
    'R|',
    'R|yes',
    'C',
    'C|',
    'C|shown',
    'F',
    'F|1|2|3',
    'F|1|2|3|4|5',
    'F|x|0|0|10|10|C:\\a.exe|T',
    'F|1|0|0|10|1.5|C:\\a.exe|T',
    'At line:1 char:1',
    'X|1|2'
  ]) {
    assert.equal(parsePresenceLine(junk), null, `${JSON.stringify(junk)} must not decode`)
  }
})

// --------------------------------------------------------- is this window EverQuest?

test('the install root is matched with a trailing separator, so a sibling dir cannot match', () => {
  assert.equal(eqRootPrefix('C:\\Games\\EQ'), 'C:\\Games\\EQ\\')
  assert.equal(eqRootPrefix('C:\\Games\\EQ\\'), 'C:\\Games\\EQ\\')
  assert.equal(eqRootPrefix('   '), '', 'an unresolvable root disables path matching entirely')

  assert.equal(isEqWindow({ exePath: 'C:\\Games\\EQ\\eqgame.exe', title: 'x' }, 'C:\\Games\\EQ'), true)
  assert.equal(
    isEqWindow({ exePath: 'C:\\Games\\EQ2\\eq2.exe', title: 'x' }, 'C:\\Games\\EQ'),
    false,
    'EQ2 is a different game and a different directory'
  )
})

test('the path match is case-insensitive — Windows paths are, and the log is not the source', () => {
  assert.equal(isEqWindow({ exePath: 'c:\\games\\eq\\EQGAME.EXE', title: '' }, 'C:\\Games\\EQ'), true)
})

test('the TITLE is a fallback, not a peer: it only fires when the path did not', () => {
  // Needed because a process image path is not always readable (elevation/protection) and a
  // user can run a second install the app was never pointed at.
  assert.equal(isEqWindow({ exePath: '', title: 'EverQuest' }, EQ_ROOT), true)
  assert.equal(isEqWindow({ exePath: 'C:\\other\\x.exe', title: 'everquest legends' }, EQ_ROOT), true)
})

test("this app's own windows never look like EverQuest", () => {
  // The pid check in presence.ts is what actually classifies them, but the predicate must not
  // claim them either — the ring is positioned from an EQ match, and it must not jump onto an
  // overlay.
  for (const title of [
    'EQ Legends Companion',
    'Fight Overlay',
    'Zone Overlay',
    'Event Log Overlay',
    'Cursor Ring'
  ]) {
    assert.equal(isEqWindow({ exePath: 'C:\\app\\companion.exe', title }, EQ_ROOT), false, title)
  }
})

// ------------------------------------------------------------------- the focus debounce

test('a focus change must hold still for the debounce before it is committed', () => {
  let s = newFocusDebounce(false)
  const t0 = 1_000_000

  const early = focusDebounceStep(s, true, t0)
  assert.equal(early.changed, false, 'the very first observation never commits')
  assert.equal(early.waitMs, FOCUS_DEBOUNCE_MS)
  s = early.state

  const midway = focusDebounceStep(s, true, t0 + 200)
  assert.equal(midway.changed, false)
  assert.equal(midway.waitMs, 100, 'the wait counts from when the candidate FIRST appeared')
  s = midway.state

  const done = focusDebounceStep(s, true, t0 + FOCUS_DEBOUNCE_MS)
  assert.equal(done.changed, true)
  assert.equal(done.state.committed, true)
  assert.equal(done.waitMs, null)
})

test('ALT-TAB FLAP: a value that bounces back never commits, and leaves no residue', () => {
  // This is the whole reason the debounce exists. Windows makes the task switcher (and
  // sometimes the shell) foreground on the way between two apps; acting on the raw signal
  // strobes every overlay off and back on.
  let s = newFocusDebounce(true)
  const t0 = 5_000

  s = focusDebounceStep(s, false, t0).state // switcher grabs focus
  s = focusDebounceStep(s, false, t0 + 80).state
  const back = focusDebounceStep(s, true, t0 + 140) // …and EQ has it again
  assert.equal(back.changed, false, 'nothing was ever committed, so nothing changes back')
  assert.equal(back.state.committed, true)
  assert.deepEqual(
    { candidate: back.state.candidate, since: back.state.since },
    { candidate: null, since: 0 },
    'the abandoned candidate is forgotten, not left to commit later'
  )

  // And the very next observation after the flap must not inherit the old clock.
  const after = focusDebounceStep(back.state, false, t0 + 5_000)
  assert.equal(after.changed, false)
  assert.equal(after.waitMs, FOCUS_DEBOUNCE_MS)
})

test('a repeated steady observation is idempotent — it is called on every watcher line', () => {
  let s = newFocusDebounce(true)
  for (const t of [0, 10, 20, 30, 10_000]) {
    const step = focusDebounceStep(s, true, t)
    assert.equal(step.changed, false)
    assert.equal(step.waitMs, null)
    s = step.state
  }
  assert.equal(s.committed, true)
})

test('a signal that stays flipped commits exactly once, not on every later observation', () => {
  let s = newFocusDebounce(false)
  s = focusDebounceStep(s, true, 0).state
  const commit = focusDebounceStep(s, true, FOCUS_DEBOUNCE_MS)
  assert.equal(commit.changed, true)
  const after = focusDebounceStep(commit.state, true, FOCUS_DEBOUNCE_MS + 1)
  assert.equal(after.changed, false, 'committed is committed; it is not re-announced')
})

// -------------------------------------------------------------------- the gating matrix

/** A presence snapshot the watcher HAS reported (`observed`), unless a test says otherwise. */
const presence = (p: Partial<PresenceState> = {}): PresenceState => ({
  observed: true,
  eqRunning: false,
  eqFocused: false,
  eqBounds: null,
  cursorVisible: true,
  ...p
})

const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 }

test('with BOTH auto-hide switches off, overlays are never hidden — whatever EQ is doing', () => {
  const off = { hideWhenNotRunning: false, hideWhenUnfocused: false }
  for (const eqRunning of [false, true]) {
    for (const eqFocused of [false, true]) {
      assert.equal(overlaysShouldHide(presence({ eqRunning, eqFocused }), off), false)
    }
  }
})

test('each auto-hide switch hides on its own — they are independent, not a mode', () => {
  const notRunning = { hideWhenNotRunning: true, hideWhenUnfocused: false }
  assert.equal(overlaysShouldHide(presence({ eqRunning: false }), notRunning), true)
  assert.equal(
    overlaysShouldHide(presence({ eqRunning: true, eqFocused: false }), notRunning),
    false,
    'running but unfocused is NOT this switch’s business'
  )

  const unfocused = { hideWhenNotRunning: false, hideWhenUnfocused: true }
  assert.equal(overlaysShouldHide(presence({ eqRunning: true, eqFocused: false }), unfocused), true)
  assert.equal(overlaysShouldHide(presence({ eqRunning: true, eqFocused: true }), unfocused), false)
})

test('NOTHING IS HIDDEN BEFORE THE WATCHER HAS REPORTED — never act on a guess', () => {
  // The child pays a one-time compile before its first line. `eqRunning:false` in that gap means
  // "we have not looked", and hiding on it would blink every overlay off at launch and back on a
  // second later on a machine where the game was running the whole time. The same flag resets if
  // the watcher ever dies, so a dead watcher fails OPEN rather than hiding everything forever.
  const unobserved = INITIAL_PRESENCE
  for (const prefs of [
    DEFAULT_OVERLAY_AUTO_HIDE,
    { hideWhenNotRunning: true, hideWhenUnfocused: true }
  ]) {
    assert.equal(overlaysShouldHide(unobserved, prefs), false)
  }
})

test('the DEFAULT auto-hide posture: hidden with no game, visible the moment one exists', () => {
  const d = DEFAULT_OVERLAY_AUTO_HIDE
  assert.equal(overlaysShouldHide(presence(), d), true)
  assert.equal(overlaysShouldHide(presence({ eqRunning: true, eqFocused: false }), d), false)
  assert.equal(overlaysShouldHide(presence({ eqRunning: true, eqFocused: true }), d), false)
})

test('THE CURSOR STREAM RUNS ONLY WHEN ENABLED **AND** FOCUSED **AND** POSITIONED', () => {
  // The performance gate, stated as a truth table. Every false row is a row in which main runs
  // no 8 ms interval and sends nothing at all.
  const on = { ...DEFAULT_CURSOR_RING, enabled: true }
  assert.equal(cursorRingActive(presence({ eqFocused: true, eqBounds: BOUNDS }), on), true)

  assert.equal(
    cursorRingActive(presence({ eqRunning: true, eqFocused: true, eqBounds: BOUNDS }), DEFAULT_CURSOR_RING),
    false,
    'disabled ⇒ nothing, even with the game in front'
  )
  assert.equal(
    cursorRingActive(presence({ eqRunning: true, eqFocused: false, eqBounds: BOUNDS }), on),
    false,
    'ALT-TABBED AWAY ⇒ the stream stops'
  )
  assert.equal(
    cursorRingActive(presence({ eqFocused: true, eqBounds: null }), on),
    false,
    'no known EQ window ⇒ nowhere to draw, so nothing is drawn or streamed'
  )
})

test('MOUSELOOK: a hidden system cursor deactivates the ring, and showing it brings it back', () => {
  // EverQuest hides the pointer while the right button is held AND re-centers it every frame, so
  // an absolute sample oscillates around a cursor that is not on screen — the ring danced by
  // itself. There is nothing to halo, so there is nothing to draw and nothing to poll.
  const on = { ...DEFAULT_CURSOR_RING, enabled: true }
  const live = { eqRunning: true, eqFocused: true, eqBounds: BOUNDS }

  assert.equal(cursorRingActive(presence({ ...live, cursorVisible: false }), on), false)
  assert.equal(
    cursorRingActive(presence({ ...live, cursorVisible: true }), on),
    true,
    'releasing the button shows the cursor again, and the ring comes straight back'
  )
})

test('the cursor is presumed VISIBLE until the watcher says otherwise', () => {
  // The gap before the child's first line, and the reset after one that died. This signal can
  // only ever REMOVE the ring, so an unmeasured default must leave the prior behavior alone —
  // the ring then turns on the moment focus and bounds arrive, exactly as it did before.
  const on = { ...DEFAULT_CURSOR_RING, enabled: true }
  assert.equal(INITIAL_PRESENCE.cursorVisible, true)
  assert.equal(
    cursorRingActive({ ...INITIAL_PRESENCE, eqFocused: true, eqBounds: BOUNDS }, on),
    true
  )
})

// ------------------------------------------------------------- prefs: defaults + clamps

test('the shipped defaults are the zero-cost posture', () => {
  assert.deepEqual(DEFAULT_CURSOR_RING, { enabled: false, sizePx: 44, thicknessPx: 4 })
  assert.deepEqual(DEFAULT_OVERLAY_AUTO_HIDE, { hideWhenNotRunning: true, hideWhenUnfocused: false })
})

test('THE WATCHER IS NEEDED ONLY WHEN A FEATURE ASKS FOR IT', () => {
  const noHide = { hideWhenNotRunning: false, hideWhenUnfocused: false }
  assert.equal(
    presenceNeeded(DEFAULT_CURSOR_RING, noHide),
    false,
    'everything off ⇒ no child process is ever spawned'
  )
  assert.equal(presenceNeeded({ ...DEFAULT_CURSOR_RING, enabled: true }, noHide), true)
  assert.equal(presenceNeeded(DEFAULT_CURSOR_RING, { ...noHide, hideWhenNotRunning: true }), true)
  assert.equal(presenceNeeded(DEFAULT_CURSOR_RING, { ...noHide, hideWhenUnfocused: true }), true)
  // The default install DOES need it — auto-hide-when-not-running ships on.
  assert.equal(presenceNeeded(DEFAULT_CURSOR_RING, DEFAULT_OVERLAY_AUTO_HIDE), true)
})

test('ring prefs are clamped, rounded, and never silently re-intended', () => {
  assert.deepEqual(normalizeCursorRing({ enabled: true, sizePx: 43.6, thicknessPx: 3.2 }), {
    enabled: true,
    sizePx: 44,
    thicknessPx: 3
  })
  assert.equal(normalizeCursorRing({ sizePx: 5 }).sizePx, 20, 'below the floor clamps up')
  assert.equal(normalizeCursorRing({ sizePx: 5000 }).sizePx, 200, 'above the cap clamps down')
  assert.equal(normalizeCursorRing({ thicknessPx: 0 }).thicknessPx, 1)
  // A stroke wider than the radius is a filled dot, not a ring.
  assert.equal(normalizeCursorRing({ sizePx: 20, thicknessPx: 12 }).thicknessPx, 10)
  for (const junk of [undefined, null, 7, 'x', []]) {
    assert.deepEqual(normalizeCursorRing(junk), DEFAULT_CURSOR_RING)
  }
})

test('auto-hide prefs default per FIELD, so a half-written blob keeps the half it has', () => {
  assert.deepEqual(normalizeOverlayAutoHide({ hideWhenUnfocused: true }), {
    hideWhenNotRunning: true,
    hideWhenUnfocused: true
  })
  assert.deepEqual(normalizeOverlayAutoHide({ hideWhenNotRunning: false }), {
    hideWhenNotRunning: false,
    hideWhenUnfocused: false
  })
  for (const junk of [undefined, null, 0, 'x', []]) {
    assert.deepEqual(normalizeOverlayAutoHide(junk), DEFAULT_OVERLAY_AUTO_HIDE)
  }
})
