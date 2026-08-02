import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { errorLogPath, logError } from './errorLog'
import { characterId, listCharacters, parseLogName, resolveActiveCharacter } from './log/config'
import { Tailer } from './log/Tailer'
import { parseEvent, parseLine } from './log/parser'
import { installSpellDb } from './log/rulesets'
import { loadSpellDb, applyOverlayCorrections, buildSpellCatalog } from './data/spellDb'
import { MessageOverlayMiner } from './data/messageOverlay'
import { baselineOverlay, loadUserOverlay, saveUserOverlay } from './data/overlayPersistence'
import { LogBus } from './log/bus'
import { EpochDetector } from './log/epochDetector'
import { scanLog } from './log/scanHistory'
import { CombatEngine } from './combat/engine'
import { findInventoryFile, loadInventory } from './inventory/parseInventory'
import { ModuleRegistry } from './modules/registry'
import { LootModule } from './modules/loot'
import { TurnInsModule } from './modules/turnins'
import { KillsModule } from './modules/kills'
import { LevelingModule } from './modules/leveling'
import { CharacterModule } from './modules/character'
import { AlertsModule } from './modules/alerts'
import { BuffsModule } from './modules/buffs'
import type { ModuleDelta } from './modules/types'
import { getSoundData, listPacks } from './sounds'
import { lookupItem, prefetchItem } from './itemLookup'
import { provisionDefaultPacks } from './provisionPacks'
import {
  fetchPackSounds,
  fetchPreviewSound,
  fetchRegistry,
  findRegistryPack,
  installPack,
  uninstallPack
} from './packRegistry'
import { initUpdater } from './updater'
import {
  deleteAlert,
  getActiveLogPath,
  getAlertPrefs,
  getAlerts,
  getOverlayConfig,
  getProgress,
  getWindowBounds,
  resetAlerts,
  saveAlert,
  setActiveLogPath,
  setAlertPrefs,
  setInventory,
  setOverlayConfig,
  setQuestComplete,
  setWindowBounds
} from './store'
import type {
  AlertDef,
  AlertPrefs,
  BuffsSnap,
  CharacterRef,
  OverlayConfig,
  PackInstallProgress
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
// The floating DPS-meter overlay (Task #52): a separate transparent, frameless,
// always-on-top window created on demand. Null when closed.
let overlayWindow: BrowserWindow | null = null
let tailer: Tailer | null = null
let character: CharacterRef | null = null
let inventoryWatcher: FSWatcher | null = null
// Wall-clock heartbeat (Task #30): drives module onTick so real-time deadlines (the
// buffs 15s cast-landing timeout) fire even when the log is idle. Started once the
// live tail is running (never during replay), cleared on quit / character switch.
let tickTimer: ReturnType<typeof setInterval> | null = null

// --- JS error capture harness (Task #13) ---
// Install process-level guards as early as possible so a crash during startup is
// logged instead of silently killing the app. In DEV we deliberately do NOT exit
// on uncaught errors: keeping the process alive lets watch-mode recover and keeps
// the window (and its ErrorBoundary) visible instead of leaving a blank shell.
process.on('uncaughtException', (err) => {
  logError('main:uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  logError('main:unhandledRejection', reason)
})

/**
 * Log-derived state for the active character, rebuilt on launch + appended live.
 * A single canonical LogEvent stream (bus) feeds every consumer: the module
 * registry folds it into each extension module, the combat engine folds it into
 * its state machine. Both feeders (scan + tail) share one monotonic seq counter,
 * owned here.
 */
const bus = new LogBus()
let seq = 0
const combat = new CombatEngine()
// Character-epoch detection (Task #49; anchor replaced in Task #50): the OFFICIAL LAUNCH
// (2026-07-28 00:00 local) is the boundary of a same-name+server character being WIPED +
// recreated at launch (they reuse the same log file — see epochDetector.ts's beta-wipe
// story). The first at/after-launch event hands a derived `epoch` event back onto the SAME
// bus (the Task #47 emitDerived path), which every character-scoped module resets on, so
// post-scan tallies (AA/loot/kills/turn-ins/quests) reflect ONLY the current character.
// Fires mid-replay during a rescan, so epochs apply historically for free; a live crossing
// works identically. (The old level-regression heuristic was removed — EQ Legends loadout
// swaps legitimately change level, so a level drop is NOT a reliable rebirth signal.)
const epoch = new EpochDetector()

// The extension framework. Modules own their slice of log-derived state and push
// deltas to the renderer over the generic `module:delta` channel. Registration
// order = bus delivery order.
const registry = new ModuleRegistry({
  emitDelta: (delta: ModuleDelta) => mainWindow?.webContents.send(IPC.onModuleDelta, delta)
})
const lootModule = new LootModule()
const turnInsModule = new TurnInsModule()
const killsModule = new KillsModule()
const levelingModule = new LevelingModule()
const characterModule = new CharacterModule()
// The alerts extension (Task #18): evaluates event/raw triggers on live events and
// pushes fired deltas over the standard module transport. Its defs are user prefs
// (owned by the store), loaded into the module here and re-synced on every save.
const alertsModule = new AlertsModule()
alertsModule.setDefs(getAlerts())
// Load the scraped spell DB (Task #34) and inject it into the parser config so the
// parser emits PRECISE message-driven buff events (buffApply/buffWearOff) — and give the
// same DB to the buffs module for authoritative durations + the self-heal-by-buff apply.
const spellDb = loadSpellDb()
// Effective DB = spells.json + observed-message overlay, overlay WINS (Task #36): fold the
// committed baseline + the user's persisted overlay into a miner, derive its verified /
// wiki-contradicting landing corrections, and apply them to the parser's cast-on-you table
// so a self-landing line the wiki got wrong or omitted (e.g. Symbol of Pinzarn's real
// message) is recognized. Done BEFORE installSpellDb so the parser uses the corrected DB.
{
  const seedMiner = new MessageOverlayMiner(spellDb.byKey)
  seedMiner.merge(baselineOverlay())
  seedMiner.merge(loadUserOverlay())
  const n = applyOverlayCorrections(spellDb, seedMiner.deriveLandingCorrections())
  console.log(`[eq-tools] Message overlay: applied ${n} cast-message corrections over the wiki DB.`)
}
installSpellDb(spellDb)
console.log(`[eq-tools] Spell DB: ${spellDb.spells.length} spells (${spellDb.castOnYou.size} unique cast-on-you msgs).`)
// The buffs extension (Task #19; message-driven model Task #34): tracks the player's own
// buffs from precise message applies + cast-timing mining, serving live actives + stats.
// Task #36: seed the observed-message overlay miner with the committed baseline + the user's
// persisted overlay so it starts warm; the user's overlay is re-saved (debounced) as the
// live log teaches it more.
const buffsModule = new BuffsModule(spellDb, [baselineOverlay(), loadUserOverlay()])
// DERIVED EVENTS (Task #47): the buffs module is the only authoritative source of the RESOLVED
// "wears off you / your pet" signal (the raw parser buffWearOff carries an ambiguous candidate
// list for the 123 shared-message families). Let it synthesize a `buffExpired { spell, target }`
// back onto the SAME bus so the alerts module (registered after buffs) can match one reliable
// kind for both sides. bus.emitDerived queues it until the current primary event finishes
// delivering — no re-entrancy, no feedback loop (buffs ignores buffExpired).
buffsModule.setDerivedEmitter((ev, live) => bus.emitDerived(ev, live))
registry.register(lootModule)
registry.register(turnInsModule)
registry.register(killsModule)
registry.register(levelingModule)
registry.register(characterModule)
registry.register(alertsModule)
registry.register(buffsModule)
// Subscribe consumers to the bus ONCE, at startup. The bus persists across
// character switches; on a switch we reset() each consumer rather than tearing
// down and re-subscribing (the old bus.clear() churned subscriptions and risked
// registration-order drift). Registry first, then combat — same order as before.
registry.attach(bus)
bus.subscribe((ev, live) => combat.ingestEvent(ev, live))
// Item-knowledge prefetch (Task #53): when a LIVE loot event arrives, warm the
// "what's this for" cache in the background (throttled by itemLookup's serialized queue
// + persistent cache) so the answer is ready by the time the user clicks the item. LIVE
// only — the historical scan (live:false) would otherwise fire thousands of lookups; the
// cache/local-posky path covers those instantly on demand.
bus.subscribe((ev, live) => {
  if (live && ev.kind === 'loot' && ev.item) prefetchItem(ev.item)
})
// Epoch detection subscription (Task #49; launch-anchored in Task #50). Runs LAST so it
// observes each event after the modules/combat have folded it, then at the first at/after-
// launch event queues a derived `epoch` event via emitDerived; the bus delivers that to
// EVERY listener (registry modules + combat) after the primary event finishes — the modules
// reset their live folded state on it. Ignore the derived epoch event itself here (the
// detector already ignores it internally too) so no feedback loop is possible, matching the
// buffs→buffExpired contract.
bus.subscribe((ev, live) => {
  if (ev.kind === 'epoch') return
  const epochEv = epoch.observe(ev)
  if (epochEv) {
    console.log(
      `[eq-tools] Character epoch boundary detected at ${new Date(epochEv.ts).toISOString()} (official launch): resetting character-scoped modules. Everything before this belongs to a prior same-name character wiped at launch (see epochDetector.ts).`
    )
    bus.emitDerived(epochEv, live)
    // A LIVE wipe (rare — deleting + recreating your character while the app tails) shrinks
    // every module's state, but module deltas are append/merge-only (a shrink can't be
    // expressed as a delta), so the renderer would keep the stale pre-epoch rows. Re-send
    // onCharacter so every useModule view RE-HYDRATES from the (now post-epoch) snapshots —
    // the same full-rebuild path a character switch uses. Deferred to a microtask so the
    // derived epoch event finishes draining to the modules (they reset) BEFORE the renderer
    // re-fetches their snapshots. During a rescan (live:false) the post-scan onCharacter send
    // in tailCharacter already covers this, so we only do it live.
    if (live) queueMicrotask(() => mainWindow?.webContents.send(IPC.onCharacter, character))
  }
})

function activeCharId(): string {
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
    mainWindow?.webContents.send(IPC.onCombatActivity)
    return
  }
  if (combatActivityTimer) return
  combatActivityTimer = setTimeout(() => {
    combatActivityTimer = null
    combatActivityLast = Date.now()
    mainWindow?.webContents.send(IPC.onCombatActivity)
  }, COMBAT_ACTIVITY_THROTTLE_MS - since)
}

function createWindow(): void {
  const bounds = getWindowBounds()
  mainWindow = new BrowserWindow({
    ...(bounds ?? { width: 1280, height: 860 }),
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Frameless (Task #23): the OS chrome is replaced by an in-app React title bar
    // (see App.tsx / TitleBar). Windows still gives us native resize edges and
    // native drag/double-click-maximize via -webkit-app-region on the bar. Keep
    // backgroundColor + min sizes + bounds so the rest of the window UX is intact.
    frame: false,
    title: 'EQ Legends Companion',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Frameless title bar (Task #23): push maximize state so the React max/restore
  // button can swap its icon. Sent on every transition + once at first paint.
  const pushMaximized = (): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.onWindowMaximized, mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', pushMaximized)
  mainWindow.on('unmaximize', pushMaximized)
  // Give the renderer its initial state once the page is ready to receive it.
  mainWindow.webContents.on('did-finish-load', pushMaximized)

  // --- webContents error capture (Task #13) ---
  // Each of these would otherwise leave a blank window with no console trace.
  // Log everything to errors.log + dev stdout, and self-heal once where it's safe.
  const wc = mainWindow.webContents

  // The renderer process died/crashed (OOM, GPU crash, killed). Log the reason,
  // then reload the window ONCE so a transient crash doesn't strand the user.
  let renderProcessReloaded = false
  wc.on('render-process-gone', (_e, details) => {
    logError('main:render-process-gone', details)
    if (!renderProcessReloaded && mainWindow && !mainWindow.isDestroyed()) {
      renderProcessReloaded = true
      logError('main:render-process-gone', 'reloading window once to recover')
      mainWindow.reload()
    }
  })

  // The page (or dev server) failed to load. Retry ONCE — most common in dev when
  // the window opens a beat before electron-vite's renderer server is ready.
  let didFailReloaded = false
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // errorCode -3 (ABORTED) is a benign navigation cancel; don't spam or retry.
    if (errorCode === -3) return
    logError('main:did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame })
    if (isMainFrame && !didFailReloaded && mainWindow && !mainWindow.isDestroyed()) {
      didFailReloaded = true
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        const url = process.env['ELECTRON_RENDERER_URL']
        if (url) void mainWindow.loadURL(url)
        else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
      }, 300)
    }
  })

  // A preload script threw while initializing (the contextBridge/api is then
  // missing — a classic invisible cause of a broken renderer).
  wc.on('preload-error', (_e, preloadPath, error) => {
    logError('main:preload-error', { preloadPath, error })
  })

  // Forward renderer console warnings/errors (level >= 2) into main stdout +
  // errors.log so agents reading the dev task output see renderer-side errors too.
  // level: 0=verbose 1=info 2=warning 3=error.
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return
    logError('renderer:console', { level, message, source: `${sourceId}:${line}` })
  })

  // Remember window position + size across restarts.
  const saveBounds = (): void => {
    if (mainWindow && !mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      setWindowBounds(mainWindow.getBounds())
    }
  }
  mainWindow.on('moved', saveBounds)
  mainWindow.on('resized', saveBounds)
  mainWindow.on('close', saveBounds)

  // The overlay (Task #52) is an accessory of the main window: tear it down when the
  // main window closes so it can't keep the app alive on its own. Its persisted
  // open-state is left intact (open:true) so the next launch restores it — we skip
  // the 'closed' handler that would otherwise flip open:false.
  mainWindow.on('close', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.removeAllListeners('closed')
      overlayWindow.destroy()
      overlayWindow = null
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- Floating overlay DPS meter (Task #52) ----
//
// A separate BrowserWindow that sits transparent + always-on-top over the game.
// EQ Legends runs windowed/borderless, where an always-on-top overlay composites
// fine (see AGENTS.md; fullscreen-EXCLUSIVE would defeat it, but that's not the
// default). No native helper app is needed — Electron's transparent/frameless +
// setAlwaysOnTop('screen-saver') + setIgnoreMouseEvents(forward) covers it.
//
// Two interaction modes, persisted in `overlay.locked`:
//   - interactive: normal focusable window, -webkit-app-region drag on the header,
//     resize edges, close/config controls visible.
//   - locked (click-through): mouse events pass through to the game via
//     setIgnoreMouseEvents(true, {forward:true}); the renderer's hover sensor toggles
//     capture back on (forward keeps mouse-move events flowing so hover still fires)
//     so the hover-revealed pin button stays clickable. Never steals focus.

/** Apply the locked/interactive mouse + focus behavior to the overlay window. */
function applyOverlayLocked(locked: boolean): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (locked) {
    // Pass clicks through to the game; forward:true keeps mouse-move events so the
    // renderer's hover sensor can re-enable capture over the pin button.
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    overlayWindow.setFocusable(false)
  } else {
    overlayWindow.setIgnoreMouseEvents(false)
    overlayWindow.setFocusable(true)
  }
}

function createOverlayWindow(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show()
    return
  }
  const cfg = getOverlayConfig()
  overlayWindow = new BrowserWindow({
    ...(cfg.bounds ?? { width: 320, height: 200 }),
    minWidth: 200,
    minHeight: 90,
    maxWidth: 640,
    maxHeight: 720,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    // Never take focus from the game when it appears (locked mode). We also avoid
    // adding it to the taskbar — it's an accessory of the main app.
    skipTaskbar: true,
    // A transparent window can't have a native background; element rgba does the
    // translucency (per-element alpha beats window-level setOpacity).
    backgroundColor: '#00000000',
    hasShadow: false,
    title: 'DPS Overlay',
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Always-on-top at the screen-saver level so it floats above ordinary windows
  // (and the borderless game). Re-assert after show for reliability on Windows.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')

  const wc = overlayWindow.webContents
  wc.on('preload-error', (_e, preloadPath, error) =>
    logError('overlay:preload-error', { preloadPath, error })
  )
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return
    logError('overlay:console', { level, message, source: `${sourceId}:${line}` })
  })

  overlayWindow.on('ready-to-show', () => {
    if (!overlayWindow) return
    // showInactive so opening the overlay never steals focus from the game.
    overlayWindow.showInactive()
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
    applyOverlayLocked(getOverlayConfig().locked)
  })

  // Persist position + size so the overlay restores where the user left it.
  const saveOverlayBounds = (): void => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      setOverlayConfig({ bounds: overlayWindow.getBounds() })
    }
  }
  overlayWindow.on('moved', saveOverlayBounds)
  overlayWindow.on('resized', saveOverlayBounds)

  overlayWindow.on('closed', () => {
    overlayWindow = null
    setOverlayConfig({ open: false })
    // Tell the main app so the TitleBar toggle reflects the closed state.
    mainWindow?.webContents.send(IPC.onOverlayState, false)
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void overlayWindow.loadURL(`${rendererUrl}/overlay.html`)
  } else {
    void overlayWindow.loadFile(join(__dirname, '../renderer/overlay.html'))
  }
}

/** Open/close the overlay and persist + broadcast the new open-state. Returns it. */
function setOverlayOpen(open: boolean): boolean {
  if (open) {
    createOverlayWindow()
  } else if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close() // 'closed' handler resets state + persists open:false
  }
  const isOpen = !!(overlayWindow && !overlayWindow.isDestroyed())
  setOverlayConfig({ open: isOpen })
  mainWindow?.webContents.send(IPC.onOverlayState, isOpen)
  return isOpen
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

/** Point the tailer + loot history at a character (used at startup and on switch). */
async function tailCharacter(ref: CharacterRef): Promise<void> {
  await tailer?.stop()
  tailer = null
  character = ref
  setActiveLogPath(ref.logPath)
  console.log(`[eq-tools] Tailing ${ref.name}@${ref.server}: ${ref.logPath}`)

  // Rebuild the canonical event stream for this character from scratch: one bus,
  // one seq counter, both feeders (scan + tail). Consumers stay subscribed (see
  // startup wiring); we reset() them so their state rebuilds from this scan. The
  // character module gets the new ref up front so its snapshot is correct
  // immediately (zone is folded from the log during the scan).
  seq = 0
  registry.reset()
  epoch.reset()
  characterModule.setCharacter(ref)
  combat.reset()
  // Inject the player's own name (we know it from the ref) BEFORE the scan replay,
  // so incoming self-heals ("You healed <Name> for N") attribute from the first
  // line rather than waiting for the engine to learn the name mid-scan.
  combat.setPlayerName(ref.name)

  // Scan the whole log first (live:false) so loot/kills/AA and the combat engine's
  // charm/encounter state reflect reality before the live tail takes over. Modules
  // fold silently during replay; no deltas push until the live tail runs.
  const scan = await scanLog(ref.logPath, bus, seq)
  seq = scan.seq
  combat.setLive()
  const lootState = lootModule.snapshot().state
  const killState = killsModule.snapshot().state
  const lvlState = levelingModule.snapshot().state
  console.log(
    `[eq-tools] Loaded ${lootState.length} loot, ${turnInsModule.snapshot().state.length} turn-ins, ${
      Object.keys(killState).length
    } mobs, ${lvlState.levels.length} level-ups, ${lvlState.aaGains.length} AA gains, ${lvlState.aaSpends.length} AA buys.`
  )

  // FIX 1: gapless handoff — start the tailer exactly where the scan stopped, so
  // lines the game appended during the (multi-second) scan are read, not dropped,
  // and none are re-read. The tailer is byte-level; we parse each raw line here
  // (continuing the shared seq) and emit onto the same bus with live:true.
  tailer = new Tailer(ref.logPath, { startOffset: scan.endOffset })
  tailer.on('line', (raw) => {
    const line = parseLine(raw)
    if (line) mainWindow?.webContents.send(IPC.onLine, line)
    const ev = parseEvent(raw, seq)
    if (ev) {
      seq++
      bus.emit(ev, true)
    }
    notifyCombatActivity() // FIX 4: throttled push so the meter refreshes sub-second
  })
  tailer.on('error', (err) => console.error('[eq-tools] tailer error', err))
  void tailer.start()

  // Start the wall-clock heartbeat now that the LIVE tail is running (the scan has
  // completed). registry.tick advances each module's onTick then flushes deltas only
  // when dirty — so an idle log still confirms a pending buff cast, and a stale cast
  // scanned from the log lands on the first tick (now ≫ its beganTs). Clear any prior
  // timer first (a character switch re-enters startTailing).
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

  // Watch this character's inventory export so a fresh /outputfile auto-reloads.
  startInventoryWatch(ref)

  // Push whatever the modules folded during replay (mainly the character module's
  // ref + zone) so first-paint snapshots are already current, then tell the
  // renderer the character's state was fully rebuilt so views remount/re-hydrate.
  registry.flushNow()
  mainWindow?.webContents.send(IPC.onCharacter, character)
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
    if (!character || character.logPath !== ref.logPath) return
    const res = loadInventory(character.name)
    if (!res) return
    setInventory(activeCharId(), res.counts, { path: res.path, loadedAt: res.loadedAt })
    console.log(`[eq-tools] Inventory auto-reloaded: ${res.path}`)
    mainWindow?.webContents.send(IPC.onInventoryReload, { path: res.path, loadedAt: res.loadedAt })
    mainWindow?.webContents.send(IPC.onProgress, getProgress(activeCharId()))
  })
  inventoryWatcher.on('error', (err) => console.error('[eq-tools] inventory watch error', err))
}

async function startTailing(): Promise<void> {
  const ref = resolveInitialCharacter()
  if (!ref) {
    console.warn('[eq-tools] No EQ log found; log tailing disabled.')
    return
  }
  await tailCharacter(ref)
}

function registerIpc(): void {
  ipcMain.handle(IPC.getCharacter, () => character)
  ipcMain.handle(IPC.listCharacters, () => listCharacters())
  ipcMain.handle(IPC.setCharacter, async (_e, logPath: string) => {
    const ref = listCharacters().find((c) => c.logPath === logPath) ?? parseLogName(logPath)
    if (!ref) return { ok: false as const, error: 'Character log not found.' }
    await tailCharacter(ref)
    return { ok: true as const, character: ref }
  })
  ipcMain.handle(IPC.getProgress, () => getProgress(activeCharId()))
  ipcMain.handle(IPC.reloadInventory, () => {
    const res = loadInventory(character?.name)
    if (!res) return { ok: false as const, error: 'No *-Inventory.txt found in the EQ folder.' }
    setInventory(activeCharId(), res.counts, { path: res.path, loadedAt: res.loadedAt })
    const progress = getProgress(activeCharId())
    // Keep other views consistent (Plane of Sky derives held-item counts too).
    mainWindow?.webContents.send(IPC.onProgress, progress)
    return { ok: true as const, path: res.path, loadedAt: res.loadedAt, progress }
  })
  ipcMain.handle(IPC.setQuestComplete, (_e, questKey: string, complete: boolean) => {
    const progress = setQuestComplete(activeCharId(), questKey, complete)
    // Push so a completion made in one view (or auto-completed from a turn-in)
    // reaches every other view without a refetch race.
    mainWindow?.webContents.send(IPC.onProgress, progress)
    return progress
  })
  // Generic module transport: one handler serves every registered module.
  ipcMain.handle(IPC.getModuleSnapshot, (_e, moduleId: string) => registry.snapshot(moduleId))
  ipcMain.handle(IPC.getCombatSnapshot, (_e, opts) => combat.snapshot(Date.now(), opts ?? {}))

  // ---- alerts extension (Task #18) ----
  ipcMain.handle(IPC.listAlerts, () => getAlerts())
  ipcMain.handle(IPC.saveAlert, (_e, def: AlertDef) => {
    const list = saveAlert(def)
    alertsModule.setDefs(list) // keep the live evaluator in sync
    return list
  })
  ipcMain.handle(IPC.deleteAlert, (_e, id: string) => {
    const list = deleteAlert(id)
    alertsModule.setDefs(list)
    return list
  })
  // test = return the def so the renderer plays its sound directly (no live fire).
  ipcMain.handle(IPC.testAlert, (_e, id: string) => getAlerts().find((a) => a.id === id) ?? null)
  // reset all alerts to the seeded built-in set (Task #22).
  ipcMain.handle(IPC.resetAlerts, () => {
    const list = resetAlerts()
    alertsModule.setDefs(list)
    return list
  })
  // renderer reports an 'app'-triggered fire (bossDefeat) so the module's recent-
  // fires history stays the single source of truth. We record it and flush so the
  // fire rides the same module:delta transport event/raw fires use (Task #22).
  ipcMain.on(IPC.appFired, (_e, payload: { alertId: string; context: string }) => {
    if (!payload?.alertId) return
    alertsModule.appFired(payload.alertId, payload.context ?? '')
    registry.flushNow()
  })
  ipcMain.handle(IPC.getAlertPrefs, () => getAlertPrefs())
  ipcMain.handle(IPC.setAlertPrefs, (_e, prefs: AlertPrefs) => setAlertPrefs(prefs))
  ipcMain.handle(IPC.listSoundPacks, () => listPacks())
  ipcMain.handle(IPC.getSoundData, (_e, packId: string, soundId: string) =>
    getSoundData(packId, soundId)
  )

  // ---- suggested-alerts wizard (Task #38) ----
  // Return the slim, searchable spell catalog: the effective DB (spells.json + overlay
  // corrections applied at startup) joined with live per-spell usage read straight off the
  // buffs module's snapshot stats (`n` = observed land→fade samples). Read-only w.r.t. the
  // buffs module — we never mutate it.
  ipcMain.handle(IPC.spellsCatalog, () => {
    const usage = new Map<string, number>()
    const lastSeen = new Map<string, number>()
    const snap = registry.get('buffs')?.snapshot()?.state as BuffsSnap | undefined
    if (snap)
      for (const [key, stat] of Object.entries(snap.stats)) {
        usage.set(key, stat.n)
        if (stat.lastSeenMs != null) lastSeen.set(key, stat.lastSeenMs)
      }
    return buildSpellCatalog(spellDb, usage, lastSeen)
  })

  // ---- item knowledge ("what's this lore/quest item for", Task #53) ----
  // Local posky-first, then a cached, politely-throttled wiki lookup. lookupItem never
  // rejects (degrades to a cached negative/offline record that still carries local posky
  // associations), so a failure here never leaves the renderer hanging.
  ipcMain.handle(IPC.itemsLookup, (_e, name: string) => lookupItem(name))

  // ---- sound-pack registry (openpeon.com integration, Task #29) ----
  ipcMain.handle(IPC.packsRegistry, (_e, force?: boolean) => fetchRegistry(force ?? false))
  ipcMain.handle(IPC.packsInstall, async (_e, name: string) => {
    const reg = await fetchRegistry(false)
    const pack = reg.packs.find((p) => p.name === name)
    if (!pack) return { ok: false as const, error: `pack '${name}' not in registry` }
    const emit = (p: PackInstallProgress): void => {
      mainWindow?.webContents.send(IPC.onPackProgress, p)
    }
    try {
      await installPack(pack, emit)
      return { ok: true as const }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError('main:packRegistry', { message: `install '${name}' failed`, err })
      emit({ name, phase: 'error', message })
      return { ok: false as const, error: message }
    }
  })
  ipcMain.handle(IPC.packsUninstall, (_e, name: string) => {
    const ok = uninstallPack(name)
    return ok ? { ok: true as const } : { ok: false as const, error: 'pack not found or not removable' }
  })
  // Preview a registry pack BEFORE install (Task #31): list its sounds / stream one.
  ipcMain.handle(IPC.packsPreviewList, async (_e, name: string) => {
    const pack = await findRegistryPack(name)
    if (!pack) return { sounds: [], error: `pack '${name}' not in registry` }
    return fetchPackSounds(pack)
  })
  ipcMain.handle(IPC.packsPreviewSound, async (_e, name: string, file: string) => {
    const pack = await findRegistryPack(name)
    if (!pack) return null
    return fetchPreviewSound(pack, file)
  })

  // ---- frameless window controls (Task #23) ----
  // The React title bar (App.tsx) drives the native window: these mirror the
  // OS min/max/close chrome we removed with `frame: false`. `ipcMain.on` matches
  // the preload's fire-and-forget `send`.
  ipcMain.on(IPC.windowMinimize, () => mainWindow?.minimize())
  ipcMain.on(IPC.windowToggleMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(IPC.windowClose, () => mainWindow?.close())

  // ---- floating overlay DPS meter (Task #52) ----
  // Toggle from the main app's TitleBar; returns the resulting open-state.
  ipcMain.handle(IPC.overlayToggle, () => {
    const isOpen = !!(overlayWindow && !overlayWindow.isDestroyed())
    return setOverlayOpen(!isOpen)
  })
  ipcMain.handle(IPC.overlayGetState, () => !!(overlayWindow && !overlayWindow.isDestroyed()))
  ipcMain.handle(IPC.overlayGetConfig, () => getOverlayConfig())
  ipcMain.handle(IPC.overlaySetConfig, (_e, patch: Partial<OverlayConfig>) => {
    const next = setOverlayConfig(patch ?? {})
    // Echo the merged config to the overlay so its UI stays in sync if the change
    // originated elsewhere (currently only the overlay writes, but this keeps the
    // contract honest and cheap).
    overlayWindow?.webContents.send(IPC.onOverlayConfig, next)
    return next
  })
  // Locked (click-through) vs interactive. Persist + apply to the live window.
  ipcMain.on(IPC.overlaySetLocked, (_e, locked: boolean) => {
    setOverlayConfig({ locked: !!locked })
    applyOverlayLocked(!!locked)
  })
  // Fine-grained pass-through toggle from the overlay's hover sensor (locked mode).
  // forward:true so mouse-move keeps flowing and the sensor can flip capture back.
  ipcMain.on(IPC.overlaySetIgnoreMouse, (_e, ignore: boolean) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    if (ignore) overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    else overlayWindow.setIgnoreMouseEvents(false)
  })
  ipcMain.on(IPC.overlayClose, () => setOverlayOpen(false))

  // Fire-and-forget renderer error reports (window.onerror / unhandledrejection /
  // React ErrorBoundary). `ipcMain.on` (not handle) matches the preload's `send`.
  ipcMain.on(IPC.reportError, (_e, report: { message: string; stack?: string; source: string }) => {
    const source = report?.source ? `renderer:${report.source}` : 'renderer:report'
    logError(source, { message: report?.message, stack: report?.stack })
  })
}

// Single-instance lock (Task #23): a second launch (e.g. re-running the installed
// app, or an auto-update restart) must not spin up a second window tailing the same
// log. If we don't get the lock, quit immediately; the primary instance receives a
// `second-instance` event and focuses/restores its existing window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    console.log(`[eq-tools] Error log: ${errorLogPath()}`)
    registerIpc()
    createWindow()
    void startTailing()
    // Self-provision the shipped voice packs (Task #39): a CI-built installer ships
    // WITHOUT the gitignored peon/sc_marine packs, so a fresh install's seeded
    // charm-break alert would reference a missing sound. Download any missing default
    // pack in the background (non-blocking, silent — errors go to errors.log and retry
    // next launch). On success, tell the renderer the pack set changed so it re-lists +
    // invalidates its sound caches and the sound becomes usable live.
    void provisionDefaultPacks()
      .then((n) => {
        if (n > 0) mainWindow?.webContents.send(IPC.onSoundPacksChanged)
      })
      .catch((err) => logError('main:provisionPacks', err))
    // Auto-update (Task #27): checks GitHub Releases on the selected channel;
    // no-ops in dev. getMainWindow is lazy so status pushes hit the live window.
    initUpdater(() => mainWindow)

    // Restore the floating overlay (Task #52) if it was open when the app last quit.
    // Deferred so the main window's did-finish-load can send its initial state first.
    if (getOverlayConfig().open) createOverlayWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  void tailer?.stop()
  void inventoryWatcher?.close()
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
  // Flush the learned message overlay one last time so the final session's observations
  // aren't lost between debounced saves (Task #36).
  saveUserOverlay(buffsModule.overlaySnapshot())
  if (process.platform !== 'darwin') app.quit()
})
