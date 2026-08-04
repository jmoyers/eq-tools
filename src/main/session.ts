// ============================================================================
// session.ts — the ACTIVE CHARACTER's lifetime: resolve, replay, tail, switch, stop.
// ============================================================================
//
// One character is tracked at a time. Everything that changes when that choice changes lives
// here: which log is being read, the shared monotonic `seq` both feeders stamp events with,
// the byte-offset scan→tail handoff, the 1s wall-clock heartbeat, the inventory-file watcher,
// and the EQ-install-dir override that can invalidate all of it.
//
// pipeline.ts owns the world this feeds (bus, modules, combat engine); this module drives it.

import { watch, type FSWatcher } from 'chokidar'
import { existsSync } from 'fs'
import { IPC } from '../shared/ipc'
import { logConsoleError, logInfo, logWarn } from './errorLog'
import {
  characterId,
  listCharacters,
  parseLogName,
  resolveActiveCharacter,
  resolveEqDir
} from './log/config'
import { Tailer } from './log/Tailer'
import { parseEvent, parseLine } from './log/parser'
import { installCharacterName } from './log/rulesets'
import { scanLog } from './log/scanHistory'
import { saveUserOverlay } from './data/overlayPersistence'
import { findInventoryFile, loadInventory } from './inventory/parseInventory'
import {
  bus,
  buffsModule,
  characterModule,
  combat,
  epoch,
  killsModule,
  levelingModule,
  lootModule,
  registry,
  sessionDetector,
  turnInsModule
} from './pipeline'
import {
  getActiveLogPath,
  getEqInstallDir,
  getProgress,
  setActiveLogPath,
  setInventory
} from './store'
import { sendToMain } from './windows'
import type { CharacterRef, EqConfig } from '../shared/types'

let tailer: Tailer | null = null
let character: CharacterRef | null = null
let inventoryWatcher: FSWatcher | null = null
// Wall-clock heartbeat (Task #30): drives module onTick so real-time deadlines (the
// buffs 15s cast-landing timeout) fire even when the log is idle. Started once the
// live tail is running (never during replay), cleared on quit / character switch.
let tickTimer: ReturnType<typeof setInterval> | null = null
// The monotonic event seq shared by BOTH feeders (scan, then tail) — reset per character.
let seq = 0

/** The character currently being tailed, or null (no logs / dir moved out from under us). */
export function getActiveCharacter(): CharacterRef | null {
  return character
}

/** Store key for per-character state ('none' while nothing is tailed). */
export function activeCharId(): string {
  return character ? characterId(character) : 'none'
}

/**
 * FIX 4: throttle-emit a combat-activity ping to the renderer, at most once per
 * ~250ms. useCombat fetches a fresh snapshot on this event, so the meter updates
 * sub-second during a fight while idle polling stays cheap. A trailing timer
 * guarantees a final ping after a burst so the last hit isn't missed.
 */
const COMBAT_ACTIVITY_THROTTLE_MS = 250
let combatActivityLast = 0
let combatActivityTimer: ReturnType<typeof setTimeout> | null = null
function notifyCombatActivity(): void {
  const now = Date.now()
  const since = now - combatActivityLast
  if (since >= COMBAT_ACTIVITY_THROTTLE_MS) {
    combatActivityLast = now
    sendToMain(IPC.onCombatActivity)
    return
  }
  if (combatActivityTimer) return
  combatActivityTimer = setTimeout(() => {
    combatActivityTimer = null
    combatActivityLast = Date.now()
    sendToMain(IPC.onCombatActivity)
  }, COMBAT_ACTIVITY_THROTTLE_MS - since)
}

/** Resolve which character to track on launch: last selected, else most recent. */
function resolveInitialCharacter(): CharacterRef | null {
  const savedPath = getActiveLogPath()
  if (savedPath) {
    const ref = parseLogName(savedPath)
    if (ref) return ref
  }
  return resolveActiveCharacter()
}

/** Build the EqConfig payload the Settings UI reads (effective dir + how it resolved). */
export function buildEqConfig(): EqConfig {
  const r = resolveEqDir()
  return {
    root: r.root,
    logsDir: r.logsDir,
    source: r.source,
    characterCount: r.characterCount,
    overridden: getEqInstallDir() !== undefined
  }
}

/**
 * Apply a change to the effective EQ install dir (override set/cleared). Re-lists
 * characters and, if the currently-tailed character's log no longer exists under
 * the new dir, retails the most-recent character there (or clears if none). A
 * no-op re-tail is avoided when the active log is still valid, so a settings save
 * that didn't actually move the dir never disrupts an in-flight tail.
 */
export async function applyEqDirChange(): Promise<EqConfig> {
  const config = buildEqConfig()
  // Refresh the character selector everywhere.
  const chars = listCharacters()
  sendToMain(IPC.onEqConfigChanged, config)

  const activeStillValid = character != null && existsSync(character.logPath)
  if (activeStillValid) return config // don't disturb a healthy tail

  // The active log vanished (dir moved) or we had none: pick the best character
  // under the new dir and re-tail, or gracefully idle if the dir has no logs.
  const next = resolveActiveCharacter() ?? chars[0] ?? null
  if (next) {
    await tailCharacter(next)
  } else {
    // Fresh/empty dir: stop tailing and tell the renderer there's no character,
    // so views show the quiet empty state instead of stale data.
    await tailer?.stop()
    tailer = null
    if (tickTimer) clearInterval(tickTimer)
    tickTimer = null
    void inventoryWatcher?.close()
    inventoryWatcher = null
    character = null
    // No character ⇒ no self-`/who` row is identifiable. Clear the name rather than let a
    // stale one attribute the next log's rows to the character we just stopped tailing.
    installCharacterName(undefined)
    sendToMain(IPC.onCharacter, null)
  }
  return config
}

/**
 * Rebuild the canonical event stream for this character from scratch: one bus,
 * one seq counter, both feeders (scan + tail). Consumers stay subscribed (see
 * pipeline.ts); we reset() them so their state rebuilds from this scan. The
 * character module gets the new ref up front so its snapshot is correct
 * immediately (zone is folded from the log during the scan).
 */
function resetWorldFor(ref: CharacterRef): void {
  seq = 0
  registry.reset()
  epoch.reset()
  // The offline-gap detector is per-LOG state (a rolling window of recent timestamps + the
  // pending camp), so it resets alongside the epoch detector: a new character's first login
  // must not inherit the previous log's last-seen instant as its `fromTs`.
  sessionDetector.reset()
  characterModule.setCharacter(ref)
  // Tell the PARSER whose log this is (class-combo inference Wave 1). A `/who` prints every
  // stranger in the zone in the same grammar as the player's own row, so the self-`/who` rule
  // can only fire once it knows the name — and it must learn it here, before the scan replay,
  // never from a constant. Same injection path as installSpellDb.
  installCharacterName(ref.name)
  combat.reset()
  // Inject the player's own name (we know it from the ref) BEFORE the scan replay,
  // so incoming self-heals ("You healed <Name> for N") attribute from the first
  // line rather than waiting for the engine to learn the name mid-scan.
  combat.setPlayerName(ref.name)
}

/**
 * FIX 1: gapless handoff — start the tailer exactly where the scan stopped, so
 * lines the game appended during the (multi-second) scan are read, not dropped,
 * and none are re-read. The tailer is byte-level; we parse each raw line here
 * (continuing the shared seq) and emit onto the same bus with live:true.
 */
function startTailer(logPath: string, startOffset: number): void {
  tailer = new Tailer(logPath, { startOffset })
  tailer.on('line', (raw) => {
    const line = parseLine(raw)
    if (line) sendToMain(IPC.onLine, line)
    const ev = parseEvent(raw, seq)
    if (ev) {
      seq++
      bus.emit(ev, true)
    }
    notifyCombatActivity() // FIX 4: throttled push so the meter refreshes sub-second
  })
  tailer.on('error', (err) => logConsoleError('[everquest-companion] tailer error', err))
  void tailer.start()
}

/**
 * Start the wall-clock heartbeat now that the LIVE tail is running (the scan has
 * completed). registry.tick advances each module's onTick then flushes deltas only
 * when dirty — so an idle log still confirms a pending buff cast, and a stale cast
 * scanned from the log lands on the first tick (now ≫ its beganTs). Clear any prior
 * timer first (a character switch re-enters startTailing).
 */
function startHeartbeat(): void {
  if (tickTimer) clearInterval(tickTimer)
  let overlaySaveTick = 0
  tickTimer = setInterval(() => {
    registry.tick(Date.now())
    // Debounced overlay persistence (Task #36): the miner accretes from the live tail; snap
    // it to userData every ~60s so the user's learned messages survive a restart. Cheap —
    // overlaySnapshot() builds a small object; the write is best-effort.
    if (++overlaySaveTick >= 60) {
      overlaySaveTick = 0
      saveUserOverlay(buffsModule.overlaySnapshot())
    }
  }, 1000)
}

/** Point the tailer + loot history at a character (used at startup and on switch). */
export async function tailCharacter(ref: CharacterRef): Promise<void> {
  await tailer?.stop()
  tailer = null
  character = ref
  setActiveLogPath(ref.logPath)
  logInfo(`[everquest-companion] Tailing ${ref.name}@${ref.server}: ${ref.logPath}`)

  resetWorldFor(ref)

  // Scan the whole log first (live:false) so loot/kills/AA and the combat engine's
  // charm/encounter state reflect reality before the live tail takes over. Modules
  // fold silently during replay; no deltas push until the live tail runs.
  const scan = await scanLog(ref.logPath, bus, seq)
  seq = scan.seq
  combat.setLive()
  const lootState = lootModule.snapshot().state
  const killState = killsModule.snapshot().state
  const lvlState = levelingModule.snapshot().state
  logInfo(
    `[everquest-companion] Loaded ${lootState.length} loot, ${turnInsModule.snapshot().state.length} turn-ins, ${
      Object.keys(killState).length
    } mobs, ${lvlState.levels.length} level-ups, ${lvlState.aaGains.length} AA gains, ${lvlState.aaSpends.length} AA buys.`
  )

  startTailer(ref.logPath, scan.endOffset)
  startHeartbeat()

  // Watch this character's inventory export so a fresh /outputfile auto-reloads.
  startInventoryWatch(ref)

  // Push whatever the modules folded during replay (mainly the character module's
  // ref + zone) so first-paint snapshots are already current, then tell the
  // renderer the character's state was fully rebuilt so views remount/re-hydrate.
  registry.flushNow()
  sendToMain(IPC.onCharacter, character)
}

/**
 * Auto-reload the active character's `*-Inventory.txt` when it changes on disk.
 * EQ rewrites this file on `/outputfile inventory`; chokidar's change event
 * (debounced by awaitWriteFinish) triggers a reload + a push so InventoryView and
 * the Plane-of-Sky progress refresh without a manual click.
 */
function startInventoryWatch(ref: CharacterRef): void {
  void inventoryWatcher?.close()
  inventoryWatcher = null
  const invPath = findInventoryFile(ref.name)
  if (!invPath) return
  inventoryWatcher = watch(invPath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 }
  })
  inventoryWatcher.on('change', () => {
    // Guard against a stale watcher firing after a character switch.
    if (character?.logPath !== ref.logPath) return
    const res = loadInventory(character.name)
    if (!res) return
    setInventory(activeCharId(), res.counts, { path: res.path, loadedAt: res.loadedAt })
    logInfo(`[everquest-companion] Inventory auto-reloaded: ${res.path}`)
    sendToMain(IPC.onInventoryReload, { path: res.path, loadedAt: res.loadedAt })
    sendToMain(IPC.onProgress, getProgress(activeCharId()))
  })
  inventoryWatcher.on('error', (err) =>
    logConsoleError('[everquest-companion] inventory watch error', err)
  )
}

/** Startup entry point: resolve a character and tail it, or idle quietly if there is none. */
export async function startTailing(): Promise<void> {
  const ref = resolveInitialCharacter()
  if (!ref) {
    logWarn('[everquest-companion] No EQ log found; log tailing disabled.')
    return
  }
  await tailCharacter(ref)
}

/** Release the session's OS resources (tail, watcher, heartbeat) on the way out. */
export function stopSession(): void {
  void tailer?.stop()
  void inventoryWatcher?.close()
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
}
