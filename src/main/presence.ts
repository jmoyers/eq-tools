// ============================================================================
// presence.ts — the WATCHER: one long-running child, and the state it maintains.
// ============================================================================
//
// Two features need the same four facts — is EQ running, is EQ the foreground window, where is
// that window, and is the system cursor being drawn — so they are answered ONCE, here:
//
//   * overlay AUTO-HIDE (hide the floating meters when the game isn't running / isn't focused)
//   * the CURSOR RING (a halo drawn only over the EQ window, only while it is focused)
//
// THE COST MODEL IS THE DESIGN. Windows has no cross-process "foreground window changed" event
// an Electron main process can subscribe to without native code, so somebody has to poll. The
// naive shape — `exec('powershell …')` on a timer — spawns a PROCESS per sample, and a
// PowerShell cold start is ~100 ms of CPU. At any useful cadence that is a permanent tax on a
// machine that is also running a game.
//
// So: ONE long-running child. It is spawned lazily (only when a feature that needs it is
// switched on — see `presenceNeeded` in shared/presencePrefs.ts), it polls in-process at
// ~150 ms, and it prints a line ONLY when something CHANGES. Steady state is a sleeping process
// and an idle pipe — near-zero CPU on both sides, and Node does no work at all between
// transitions. It is killed the moment the last consumer goes away. Never spawned in e2e
// (`EQ_E2E=1`) or off Windows.
//
// THE PURE HALF — the stdout line protocol, the EQ-window predicate, the alt-tab debounce and
// the gating matrix — lives in `presenceProtocol.ts` (the security.ts ↔ windows.ts split), which
// is what `tests/presence.test.mts` drives with no Electron in sight. `presenceEffects.ts` is
// what ACTS on any of it; this file only knows facts.

import { spawn, type ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import { E2E } from './e2e'
import { logError, logInfo } from './errorLog'
import { effectiveEqRoot } from './log/config'
import {
  type PresenceRecord,
  WATCHER_HEARTBEAT_MS,
  WATCHER_STALE_MS,
  eqRootPrefix,
  focusDebounceStep,
  isEqWindow,
  newFocusDebounce,
  parsePresenceLine,
  watcherIsStale,
  watcherRestartDelayMs
} from './presenceProtocol'
import { INITIAL_PRESENCE } from '../shared/presencePrefs'
import type { PresenceState, ScreenRect } from '../shared/presencePrefs'

// ------------------------------------------------------------------ the watcher child itself

/**
 * The polling loop, as PowerShell. Sent to `powershell.exe -EncodedCommand` (base64 UTF-16LE)
 * rather than through a shell or stdin: no quoting rules apply to base64, so the script below
 * is the script that runs, byte for byte.
 *
 * Everything expensive happens once, before the loop: the P/Invoke surface is compiled by
 * `Add-Type` at startup (~1 s, paid a single time per app run) and process image paths are
 * memoized per pid. The loop itself is five user32 calls and a string compare.
 *
 * CURSOR VISIBILITY is one of those calls. `GetCursorInfo` reports the session-wide cursor, and
 * EverQuest hides it for the whole time the right button is held (mouselook) — during which it
 * also re-centers the pointer every frame, so an absolute cursor sample oscillates while nothing
 * is on screen to follow it. `CURSORINFO.flags` is a bit field, so the test is
 * `& CURSOR_SHOWING(0x1)`, not `!= 0`. A failed call answers "showing": the ring is a display
 * aid, and a watcher that cannot see the cursor must not be the reason it disappears.
 *
 * `$ErrorActionPreference` drops to SilentlyContinue after `Add-Type`, ON PURPOSE: reading
 * `.Path` on a protected process raises a non-terminating error every 5 s forever, and the
 * watcher's job is to answer best-effort, not to be right about processes it may not inspect.
 *
 * THE RUNNING POLL IS NAME-FIRST, PATH-SECOND — measured, not stylistic. `ProcessName` is
 * already in the snapshot `GetProcesses()` returns, while `MainModule.FileName` OPENS the
 * process and THROWS for every protected one; interleaving them meant a few hundred .NET
 * exceptions per poll on a normal desktop. Two separate passes make the common case (the game
 * is running, under its own name) cost one string compare per process, and the path scan — the
 * fallback for a client installed under a different exe name — runs only when the cheap pass
 * found nothing.
 */
function watcherScript(
  eqRootWithSep: string,
  runningPollMs: number,
  tickMs: number,
  parentPid: number
): string {
  // A single-quoted PowerShell literal: the only character that needs escaping is `'`, and a
  // Windows path cannot contain one. Doubling it keeps that true even for a pathological root.
  const rootLiteral = eqRootWithSep.replace(/'/g, "''")
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EqcWin {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
  public static int CursorShowing() {
    CURSORINFO ci = new CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci)) return 1;
    return (ci.flags & 0x1) != 0 ? 1 : 0;
  }
}
'@
$ErrorActionPreference = 'SilentlyContinue'
$root = '${rootLiteral}'
$parentPid = ${parentPid}
$cmp = [System.StringComparison]::OrdinalIgnoreCase
$paths = @{}
$lastFg = ''
$lastRun = -1
$lastCur = -1
$nextRun = [DateTime]::MinValue
while ($true) {
  $h = [EqcWin]::GetForegroundWindow()
  $fgPid = [uint32]0
  [void][EqcWin]::GetWindowThreadProcessId($h, [ref]$fgPid)
  $rect = New-Object EqcWin+RECT
  [void][EqcWin]::GetWindowRect($h, [ref]$rect)
  if (-not $paths.ContainsKey($fgPid)) {
    if ($paths.Count -gt 256) { $paths.Clear() }
    $proc = Get-Process -Id $fgPid
    $p = ''
    if ($proc -and $proc.Path) { $p = $proc.Path }
    $paths[$fgPid] = $p
  }
  $line = 'F|' + $fgPid + '|' + $rect.Left + '|' + $rect.Top + '|' + ($rect.Right - $rect.Left) + '|' + ($rect.Bottom - $rect.Top) + '|' + $paths[$fgPid] + '|' + [EqcWin]::Title($h)
  if ($line -ne $lastFg) { $lastFg = $line; [Console]::Out.WriteLine($line) }
  $cur = [EqcWin]::CursorShowing()
  if ($cur -ne $lastCur) { $lastCur = $cur; [Console]::Out.WriteLine('C|' + $cur) }
  $now = [DateTime]::UtcNow
  if ($now -ge $nextRun) {
    $nextRun = $now.AddMilliseconds(${runningPollMs})
    # SELF-REAP. Windows does not kill a child when its parent dies, so a main process that goes
    # away without running its quit path — a crash, or the Stop-Process -Force an integrator
    # reaches for — leaves this loop polling user32 forever with nobody reading the pipe. The
    # parent pid is baked in at spawn; when it stops existing, so do we.
    if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
    # The pid -> image-path memo is dropped on every beat rather than only when it grows past
    # 256 entries. Windows RECYCLES pids, and an entry that outlives its process is not stale
    # data, it is WRONG data: the browser that inherits a departed eqgame.exe's pid would be
    # handed eqgame's path and classified as the game. Five seconds bounds that window, and the
    # memo still absorbs the ~33 ticks between beats, which is all it was ever for.
    $paths.Clear()
    $running = 0
    $procs = [System.Diagnostics.Process]::GetProcesses()
    foreach ($p in $procs) { if ($p.ProcessName -eq 'eqgame') { $running = 1; break } }
    if ($running -eq 0 -and $root -ne '') {
      foreach ($p in $procs) {
        $ip = $p.MainModule.FileName
        if ($ip -and $ip.StartsWith($root, $cmp)) { $running = 1; break }
      }
    }
    foreach ($p in $procs) { $p.Dispose() }
    if ($running -ne $lastRun) { $lastRun = $running; [Console]::Out.WriteLine('R|' + $running) }
    # THE HEARTBEAT, and the only line printed unconditionally. Everything else is change-driven,
    # so a healthy idle watcher is indistinguishable from a wedged one on the pipe alone — see
    # presenceProtocol.ts's note. One byte per beat is what buys the parent that distinction.
    [Console]::Out.WriteLine('H')
  }
  Start-Sleep -Milliseconds ${tickMs}
}
`
}

/** Foreground sampling cadence inside the child. Fine enough that alt-tab feels instant,
 *  coarse enough that a sleeping PowerShell loop rounds to zero CPU. */
const TICK_MS = 150
/** Process-existence cadence. "Is the game running" changes twice a session. */
const RUNNING_POLL_MS = 5000

type Listener = (state: PresenceState) => void

/** stdin is 'ignore' (the script arrives base64 on the command line), stdout/stderr are pipes. */
type WatcherChild = ChildProcessByStdio<null, Readable, Readable>

const listeners = new Set<Listener>()
let child: WatcherChild | null = null
let stdoutTail = ''
let focus = newFocusDebounce(false)
let focusTimer: NodeJS.Timeout | null = null
let lastObservedFocus = false

// ---- watcher health (see presenceProtocol.ts's "watcher health" section for the WHY) --------
/** When the current child last said ANYTHING — seeded at spawn, so the one-time `Add-Type`
 *  compile is inside the first staleness window rather than a false positive against it. */
let lastSignalAt = 0
/** When the current child was spawned. Only a child that has outlived a full staleness window
 *  is allowed to forgive its predecessors' failures — see `noteSignal`. */
let childStartedAt = 0
/** Consecutive spawn/exit/wedge failures; indexes the backoff schedule. */
let restartFailures = 0
let restartTimer: NodeJS.Timeout | null = null
let staleTimer: NodeJS.Timeout | null = null

let state: PresenceState = INITIAL_PRESENCE

/** The presence facts as of the last watcher line. Defaults are "nothing seen yet". */
export function presenceSnapshot(): PresenceState {
  return state
}

function emit(): void {
  for (const cb of listeners) {
    try {
      cb(state)
    } catch (err) {
      // One bad subscriber must not stop the others (or kill the stdout pump).
      logError('main:presence', err)
    }
  }
}

/** Commit a new state object and notify, but ONLY when something actually differs. */
function update(next: Partial<PresenceState>): void {
  const merged: PresenceState = { ...state, ...next }
  const same =
    merged.observed === state.observed &&
    merged.eqRunning === state.eqRunning &&
    merged.eqFocused === state.eqFocused &&
    merged.cursorVisible === state.cursorVisible &&
    sameRect(merged.eqBounds, state.eqBounds)
  if (same) return
  state = merged
  emit()
}

function sameRect(a: ScreenRect | null, b: ScreenRect | null): boolean {
  if (a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Run the debounce for the current raw observation and schedule the wake-up that will commit it
 * if the signal holds. Called on every foreground line and from the timer it sets.
 */
function applyFocus(observed: boolean): void {
  lastObservedFocus = observed
  if (focusTimer) {
    clearTimeout(focusTimer)
    focusTimer = null
  }
  const step = focusDebounceStep(focus, observed, Date.now())
  focus = step.state
  if (step.changed) update({ eqFocused: focus.committed })
  else if (step.waitMs !== null) {
    focusTimer = setTimeout(() => {
      focusTimer = null
      applyFocus(lastObservedFocus)
    }, step.waitMs)
    // A watcher timer must never be the reason the app stays alive at quit.
    focusTimer.unref?.()
  }
}

/**
 * Fold one decoded record into the state.
 *
 * THE OWN-WINDOWS RULE lives here: a foreground window belonging to THIS process counts as
 * "EQ side". Every window this app creates (main, the five overlays, the ring) is owned by the
 * main process, so `pid === process.pid` identifies all of them at once — and that is what
 * makes "clicking your own overlay must not hide it" true by construction rather than by a list
 * of window handles somebody has to remember to extend.
 *
 * Bounds are updated ONLY for a genuine EQ window: our own windows are EQ-side for the FOCUS
 * question but they are not where the game is, and the ring must not jump onto them.
 */
function applyRecord(rec: PresenceRecord): void {
  // The heartbeat is LIVENESS, not an observation. It says the loop is turning, which is exactly
  // what `noteSignal` already recorded; it deliberately does not set `observed`, because a beat
  // is not a look at the world and must never be the reason auto-hide starts acting.
  if (rec.t === 'beat') return
  // ANY record means we have actually looked (the child emits an `F`, a `C` and an `R` on its
  // very first tick, in that order). Until then `observed:false` keeps auto-hide from acting on
  // a default that only looks like a fact — see `overlaysShouldHide`.
  if (rec.t === 'run') {
    update({ observed: true, eqRunning: rec.running })
    return
  }
  if (rec.t === 'cursor') {
    update({ observed: true, cursorVisible: rec.visible })
    return
  }
  const ours = rec.pid === process.pid
  const isEq = !ours && isEqWindow(rec, effectiveEqRoot())
  update(isEq ? { observed: true, eqBounds: rec.rect } : { observed: true })
  applyFocus(isEq || ours)
}

/**
 * Note that the child is alive and talking. Any well-formed record counts, including a bare
 * heartbeat — the watchdog's question is "is the loop turning", not "did the world change".
 *
 * IT IS ALSO WHERE THE BACKOFF DEBT IS FORGIVEN, and the condition is the load-bearing part: a
 * child clears the counter only once it has run a FULL staleness window without going quiet.
 * Resetting on the first record instead would make a watcher that dies right after its first
 * line retry at 1 s forever — a spawn storm dressed up as a recovery.
 */
function noteSignal(): void {
  const now = Date.now()
  lastSignalAt = now
  if (restartFailures > 0 && now - childStartedAt >= WATCHER_STALE_MS) restartFailures = 0
}

/** Split the stdout stream into lines, carrying the partial tail across chunks. */
function pumpStdout(chunk: string): void {
  stdoutTail += chunk
  const lines = stdoutTail.split('\n')
  stdoutTail = lines.pop() ?? ''
  for (const line of lines) {
    const rec = parsePresenceLine(line)
    if (!rec) continue
    noteSignal()
    applyRecord(rec)
  }
}

/**
 * Fall back to "nothing known" and tell everyone.
 *
 * THIS IS THE WHOLE SAFETY PROPERTY, so it is worth stating what `INITIAL_PRESENCE` buys: with
 * `eqFocused:false` and `eqBounds:null` the ring PARKS (`cursorRingActive` needs both), and with
 * `observed:false` auto-hide fails OPEN and un-hides the overlays (`overlaysShouldHide`'s first
 * line). A presence source that has stopped being trustworthy must take the features it drives
 * with it — a frozen `eqFocused:true` is what left a halo chasing the pointer across the user's
 * browser, and a frozen `eqRunning:false` would hide every overlay forever.
 */
function resetPresence(): void {
  if (focusTimer) {
    clearTimeout(focusTimer)
    focusTimer = null
  }
  focus = newFocusDebounce(false)
  lastObservedFocus = false
  stdoutTail = ''
  if (state === INITIAL_PRESENCE) return
  state = INITIAL_PRESENCE
  emit()
}

/**
 * Unhook a child so nothing it does on the way out can move any state or fire any handler.
 *
 * A RETIRED CHILD STILL NEEDS AN `'error'` SINK, on the process and on both pipes. `'error'` is
 * not an ordinary event: an EventEmitter with no listener for it THROWS the payload, so removing
 * the handlers wholesale converts a failed `kill()` or a post-mortem EPIPE from a log line into
 * an uncaught exception in the main process. These sinks are terminal on purpose — this child is
 * already on its way out, and there is nothing left to do about it but say so.
 */
function detach(c: WatcherChild): void {
  const sink = (what: string) => (err: unknown) =>
    logError('main:presence', { message: `retired watcher child (${what})`, err })
  c.stdout.removeAllListeners()
  c.stderr.removeAllListeners()
  c.removeAllListeners('exit')
  c.removeAllListeners('error')
  c.on('error', sink('process'))
  c.stdout.on('error', sink('stdout'))
  c.stderr.on('error', sink('stderr'))
}

function clearStaleWatchdog(): void {
  if (!staleTimer) return
  clearInterval(staleTimer)
  staleTimer = null
}

/**
 * THE STALENESS WATCHDOG — the half of the fix that a dead-child handler cannot cover.
 *
 * A child that EXITS announces itself. A child that WEDGES — alive, pid intact, loop not
 * advancing (a blocked handle, a suspended process, a pipe nobody drained) — announces nothing
 * at all, and the only evidence is the heartbeat that stopped arriving. So: check the clock, and
 * when the pipe has been silent past `WATCHER_STALE_MS`, treat the child as gone. Reset FIRST
 * (the state has been wrong for thirty seconds already and the respawn takes another second),
 * then kill and restart on the same backoff an exit uses.
 *
 * The interval exists only while a child does, and is unref'd: it can never be the reason the
 * app stays alive at quit.
 */
function armStaleWatchdog(): void {
  clearStaleWatchdog()
  staleTimer = setInterval(() => {
    const c = child
    if (!c || !watcherIsStale(lastSignalAt, Date.now())) return
    logError('main:presence', {
      message: 'presence watcher went silent; assuming it is wedged and restarting',
      silentMs: Date.now() - lastSignalAt
    })
    child = null
    clearStaleWatchdog()
    detach(c)
    c.kill()
    resetPresence()
    restartFailures++
    scheduleRestart()
  }, WATCHER_HEARTBEAT_MS)
  staleTimer.unref?.()
}

/**
 * Bring the watcher back after a failure, on a capped backoff.
 *
 * Not restarting at all was the old behavior and it is a silent, permanent feature outage: the
 * state reset made the app SAFE (overlays back, ring parked) but nothing ever looked at the game
 * again for the rest of the session. Both consumers are supposed to be always-on.
 *
 * The `listeners.size` check is what makes this respect the ref-count: a restart scheduled a
 * moment before the user turns the last feature off must not spawn a child nobody wants.
 */
function scheduleRestart(): void {
  if (restartTimer || listeners.size === 0) return
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (listeners.size === 0 || child) return
    startWatcher()
  }, watcherRestartDelayMs(restartFailures))
  restartTimer.unref?.()
}

/**
 * The one path off the child, for every way it can end: a clean exit, a crash, a spawn that
 * never happened, and the watchdog's kill. Idempotent by identity — `child !== proc` means this
 * one has already been retired (or replaced), so a late `'exit'` after an `'error'` is a no-op
 * rather than a second restart.
 */
function handleChildGone(proc: WatcherChild, code: number | null): void {
  if (child !== proc) return
  child = null
  clearStaleWatchdog()
  detach(proc)
  // An exit while consumers remain is a real failure (the script threw, or PowerShell is
  // missing). Report it, fall back to "nothing known", and try again on the backoff.
  if (listeners.size === 0) return
  logError('main:presence', { message: 'presence watcher exited unexpectedly', code })
  resetPresence()
  restartFailures++
  scheduleRestart()
}

/**
 * Strip PowerShell's CLIXML framing out of a stderr chunk.
 *
 * MEASURED, not defensive: a `-EncodedCommand` child writes a `#< CLIXML` preamble (and, when
 * anything touches the error stream, an `<Objs …>…</Objs>` envelope) to stderr on a perfectly
 * healthy run. Logging that verbatim would put a junk `[everquest-companion:error]` line in
 * errors.log every time the watcher starts — and errors.log is the FIRST place anyone looks
 * when something is weird, so filling it with noise from a component that is working is a real
 * cost. What remains after the framing is stripped is a genuine failure and is logged.
 */
function cleanWatcherStderr(text: string): string {
  return text
    .replace(/#<\s*CLIXML/g, '')
    .replace(/<Objs[\s\S]*?<\/Objs>/g, '')
    .replace(/<Objs[^>]*\/>/g, '')
    .trim()
}

function startWatcher(): void {
  if (child || E2E || process.platform !== 'win32') return
  const script = watcherScript(
    eqRootPrefix(effectiveEqRoot()),
    RUNNING_POLL_MS,
    TICK_MS,
    // Baked in so the child can reap ITSELF when this process dies without running its quit path
    // (a crash, or a force-kill of the tree). Windows orphans children rather than killing them.
    process.pid
  )
  let proc: WatcherChild
  try {
    proc = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (err) {
    logError('main:presence', { message: 'could not start the presence watcher', err })
    // A spawn that throws is as much a failure as one that exits, and it is the one most likely
    // to be transient (a momentarily unavailable powershell.exe). Back off and try again.
    restartFailures++
    scheduleRestart()
    return
  }
  child = proc
  childStartedAt = Date.now()
  // Seed the silence clock at the spawn, not at the first line: the child pays a one-time
  // `Add-Type` compile before it can say anything, and that quiet second is normal.
  lastSignalAt = childStartedAt
  logInfo('[everquest-companion] presence watcher started')
  stdoutTail = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', pumpStdout)
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (text: string) => {
    const message = cleanWatcherStderr(text)
    if (message) logError('main:presence', { stderr: message.slice(0, 500) })
  })
  proc.on('error', (err) => {
    logError('main:presence', err)
    handleChildGone(proc, null)
  })
  proc.on('exit', (code) => handleChildGone(proc, code))
  armStaleWatchdog()
}

function stopWatcher(): void {
  if (focusTimer) {
    clearTimeout(focusTimer)
    focusTimer = null
  }
  clearStaleWatchdog()
  if (restartTimer) {
    clearTimeout(restartTimer)
    restartTimer = null
  }
  // A deliberate stop is not a failure — the next start deserves a clean slate.
  restartFailures = 0
  const c = child
  child = null
  if (!c) return
  detach(c)
  c.kill()
  logInfo('[everquest-companion] presence watcher stopped')
  state = INITIAL_PRESENCE
  focus = newFocusDebounce(false)
  lastObservedFocus = false
  stdoutTail = ''
}

/**
 * Subscribe to presence. REF-COUNTED: the first subscriber starts the child, the last one to
 * unsubscribe kills it. That is the whole "lazy" contract — with the ring off and both
 * auto-hide switches at a state that needs no watcher, nothing is ever spawned.
 *
 * The callback fires on every CHANGE (never on a repeat), and once immediately with whatever is
 * already known, so a late subscriber needs no separate hydration path.
 */
export function subscribePresence(cb: Listener): () => void {
  listeners.add(cb)
  if (listeners.size === 1) startWatcher()
  cb(state)
  let released = false
  return () => {
    if (released) return
    released = true
    listeners.delete(cb)
    if (listeners.size === 0) stopWatcher()
  }
}

/** Tear the watcher down regardless of subscribers (app quit). */
export function stopPresence(): void {
  listeners.clear()
  stopWatcher()
}

/** TEST/diagnostic seam: is a watcher child alive right now? */
export function presenceWatcherRunning(): boolean {
  return child !== null
}
