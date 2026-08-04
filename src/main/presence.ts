// ============================================================================
// presence.ts — the WATCHER: one long-running child, and the state it maintains.
// ============================================================================
//
// Two features need the same three facts — is EQ running, is EQ the foreground window, and
// where is that window — so they are answered ONCE, here:
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
  eqRootPrefix,
  focusDebounceStep,
  isEqWindow,
  newFocusDebounce,
  parsePresenceLine
} from './presenceProtocol'
import type { PresenceState, ScreenRect } from '../shared/presencePrefs'

// ------------------------------------------------------------------ the watcher child itself

/**
 * The polling loop, as PowerShell. Sent to `powershell.exe -EncodedCommand` (base64 UTF-16LE)
 * rather than through a shell or stdin: no quoting rules apply to base64, so the script below
 * is the script that runs, byte for byte.
 *
 * Everything expensive happens once, before the loop: the P/Invoke surface is compiled by
 * `Add-Type` at startup (~1 s, paid a single time per app run) and process image paths are
 * memoized per pid. The loop itself is four user32 calls and a string compare.
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
function watcherScript(eqRootWithSep: string, runningPollMs: number, tickMs: number): string {
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
}
'@
$ErrorActionPreference = 'SilentlyContinue'
$root = '${rootLiteral}'
$cmp = [System.StringComparison]::OrdinalIgnoreCase
$paths = @{}
$lastFg = ''
$lastRun = -1
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
  $now = [DateTime]::UtcNow
  if ($now -ge $nextRun) {
    $nextRun = $now.AddMilliseconds(${runningPollMs})
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

let state: PresenceState = { observed: false, eqRunning: false, eqFocused: false, eqBounds: null }

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
  // ANY record means we have actually looked (the child emits both an `F` and an `R` on its
  // very first tick). Until then `observed:false` keeps auto-hide from acting on a default
  // that only looks like a fact — see `overlaysShouldHide`.
  if (rec.t === 'run') {
    update({ observed: true, eqRunning: rec.running })
    return
  }
  const ours = rec.pid === process.pid
  const isEq = !ours && isEqWindow(rec, effectiveEqRoot())
  update(isEq ? { observed: true, eqBounds: rec.rect } : { observed: true })
  applyFocus(isEq || ours)
}

/** Split the stdout stream into lines, carrying the partial tail across chunks. */
function pumpStdout(chunk: string): void {
  stdoutTail += chunk
  const lines = stdoutTail.split('\n')
  stdoutTail = lines.pop() ?? ''
  for (const line of lines) {
    const rec = parsePresenceLine(line)
    if (rec) applyRecord(rec)
  }
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
  const script = watcherScript(eqRootPrefix(effectiveEqRoot()), RUNNING_POLL_MS, TICK_MS)
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
    return
  }
  child = proc
  logInfo('[everquest-companion] presence watcher started')
  stdoutTail = ''
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', pumpStdout)
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (text: string) => {
    const message = cleanWatcherStderr(text)
    if (message) logError('main:presence', { stderr: message.slice(0, 500) })
  })
  proc.on('error', (err) => logError('main:presence', err))
  proc.on('exit', (code) => {
    child = null
    // An exit while consumers remain is a real failure (the script threw, or PowerShell is
    // missing). Report it and fall back to "nothing known" rather than freezing the last state
    // — a stuck `eqRunning:false` would hide every overlay forever.
    if (listeners.size > 0) {
      logError('main:presence', { message: 'presence watcher exited unexpectedly', code })
      state = { observed: false, eqRunning: false, eqFocused: false, eqBounds: null }
      focus = newFocusDebounce(false)
      emit()
    }
  })
}

function stopWatcher(): void {
  if (focusTimer) {
    clearTimeout(focusTimer)
    focusTimer = null
  }
  const c = child
  child = null
  if (!c) return
  c.stdout.removeAllListeners()
  c.stderr.removeAllListeners()
  c.removeAllListeners('exit')
  c.kill()
  logInfo('[everquest-companion] presence watcher stopped')
  state = { observed: false, eqRunning: false, eqFocused: false, eqBounds: null }
  focus = newFocusDebounce(false)
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
