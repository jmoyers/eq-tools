// FIRST import on purpose: channel.ts picks this process's `userData` dir (prod / dev /
// e2e — Task #58) and runs the one-time state seed, before electron-store is constructed
// (module-level) further down this import list.
import { CHANNEL, USER_DATA } from './channel'
import { E2E } from './e2e'
import { app, shell, BrowserWindow, dialog, ipcMain, protocol, screen, session } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { errorLogPath, logError } from './errorLog'
import {
  characterId,
  listCharacters,
  parseLogName,
  resolveActiveCharacter,
  resolveEqDir
} from './log/config'
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
import { ItemTiersModule } from './modules/itemTiers'
import { AlertsModule } from './modules/alerts'
import { BuffsModule } from './modules/buffs'
import { EventFeedModule } from './modules/eventFeed'
import type { ModuleDelta } from './modules/types'
import { defaultOverlayBounds, overlayDefaultSize } from './overlayLayout'
import { getSoundData, listPacks } from './sounds'
import { lookupItem } from './itemLookup'
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
import { installImageCacheProtocol, registerImageCacheSchemes } from './imageCache'
import { allowedExternalUrl, isInternalPageUrl, isSafePackId } from './security'
import {
  applyShare,
  exportAlertsString,
  exportSettingsString,
  previewShare,
  shareFileName,
  type ShareSelection
} from './share'
import {
  deleteAlert,
  getActiveLogPath,
  getAlertPrefs,
  getAlerts,
  getEqInstallDir,
  getOverlayConfig,
  getProgress,
  getWindowBounds,
  resetAlerts,
  saveAlert,
  setActiveLogPath,
  setAlertPrefs,
  setEqInstallDir,
  setInventory,
  setOverlayConfig,
  setQuestComplete,
  setWindowBounds
} from './store'
import type {
  AlertDef,
  AlertPrefs,
  AlertsDelta,
  BuffsSnap,
  CharacterRef,
  EqConfig,
  FeedReport,
  OverlayConfig,
  OverlayKind,
  PackInstallProgress
} from '../shared/types'
import { OVERLAY_KINDS } from '../shared/types'

let mainWindow: BrowserWindow | null = null
// The floating overlays (Task #52; kinds in Task #54, more in Task #59): separate transparent,
// frameless, always-on-top windows created on demand — the damage meters, the healing meters and
// the event log. Any combination can be open at once. Null when that kind is closed. Built from
// OVERLAY_KINDS so adding a kind never means editing a literal here.
const overlayWindows = Object.fromEntries(OVERLAY_KINDS.map((k) => [k, null])) as Record<
  OverlayKind,
  BrowserWindow | null
>
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

// --- permanent image cache (eqimg://) ---
// Scheme privileges MUST be declared before the app's `ready` event, so this runs at module
// scope; the handler itself is installed in whenReady below. See imageCache.ts.
registerImageCacheSchemes(protocol)

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
  emitDelta: (delta: ModuleDelta) => {
    mainWindow?.webContents.send(IPC.onModuleDelta, delta)
    // Task #59: alert fires are ALSO event-log rows. Folding them here (rather than teaching
    // AlertsModule about the feed) keeps the alerts module untouched, and because eventFeed is
    // registered LAST the row it appends is picked up by the same flush pass.
    feedAlertDelta(delta)
    // The 'events' overlay is a second consumer of the module transport (it hydrates the
    // eventFeed module and rides its deltas), so deltas must reach that window too.
    const evOverlay = overlayWindows.events
    if (evOverlay && !evOverlay.isDestroyed()) evOverlay.webContents.send(IPC.onModuleDelta, delta)
  }
})
const lootModule = new LootModule()
const turnInsModule = new TurnInsModule()
const killsModule = new KillsModule()
const levelingModule = new LevelingModule()
const characterModule = new CharacterModule()
// Observed item levels (Task #60): character-scoped, epoch-aware per-item tier state folded
// from the merge lines, so an item window can show YOUR tier for an item you upgraded.
const itemTiersModule = new ItemTiersModule()
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
  console.log(`[everquest-companion] Message overlay: applied ${n} cast-message corrections over the wiki DB.`)
}
installSpellDb(spellDb)
console.log(`[everquest-companion] Spell DB: ${spellDb.spells.length} spells (${spellDb.castOnYou.size} unique cast-on-you msgs).`)
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
// The event-log feed (Task #59): the live "things worth noticing" ring behind the 'events'
// overlay — alert fires, NOTABLE loot, quest completions. It resolves loot notability through
// the SAME cache-first lookupItem the loot tab uses (which also warms the cache, so this
// replaces the old bare prefetch subscription below). Registered LAST so a row appended while
// an earlier module's delta is being emitted still flushes in that pass.
const eventFeedModule = new EventFeedModule({ lookupItem })

/** Fold an `alerts` module delta into the event feed (alert id → its display name). */
function feedAlertDelta(delta: ModuleDelta): void {
  if (delta.moduleId !== 'alerts') return
  const { fired } = delta.delta as AlertsDelta
  if (!fired?.length) return
  const defs = alertsModule.snapshot().state.defs
  for (const f of fired) {
    const def = defs.find((d) => d.id === f.alertId)
    eventFeedModule.noteAlertFire(def?.name ?? f.alertId, f.matchedText, f.ts)
  }
}
registry.register(lootModule)
registry.register(turnInsModule)
registry.register(killsModule)
registry.register(levelingModule)
registry.register(characterModule)
registry.register(itemTiersModule)
registry.register(alertsModule)
registry.register(buffsModule)
registry.register(eventFeedModule)
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
//
// Task #59 folded this INTO the event-feed module: its live-loot notability probe calls the
// same cache-first `lookupItem`, so the cache is warmed exactly as before with ONE request
// per item (the module also de-dupes concurrent probes of the same name, which the bare
// prefetch did not). A second subscription here would double-request every uncached loot.
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
      `[everquest-companion] Character epoch boundary detected at ${new Date(epochEv.ts).toISOString()} (official launch): resetting character-scoped modules. Everything before this belongs to a prior same-name character wiped at launch (see epochDetector.ts).`
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

// ---- Electron runtime trust boundary (webPreferences / navigation / permissions) ----
//
// ONE definition for EVERY window (main + all five overlays): a security posture that lives in
// two places drifts, and a window created with a forgotten flag is exactly the bug this
// section exists to prevent. Values are stated EXPLICITLY even where they match today's
// Electron default — a default is a decision someone else can change in a major bump, and
// `npm audit`-style reviews read this object, not Electron's changelog.
//
// WHY `sandbox: false` — MEASURED, not assumed. The two preloads are built by electron-vite
// from a two-entry rollup input (src/preload/{index,overlay}.ts) and both import the shared
// `src/shared/ipc.ts` channel registry, so rollup hoists it into
// `out/preload/chunks/ipc-<hash>.js` and each preload begins `require("./chunks/ipc-….js")`.
// A SANDBOXED preload's `require` is NOT Node's: it resolves `electron` plus a small
// polyfilled set (events/timers/url) and nothing else. Flipping this to `true` and running
// `npm run test:e2e` fails exactly there — the harness times out with no UI, and the e2e
// errors.log carries:
//
//   [main:preload-error] module not found: ./chunks/ipc-D4DrnWdv.js
//       at preloadRequire (node:electron/js2c/sandbox_bundle)
//
// i.e. `window.eq` is never installed and the app is silently dead. Nothing in the preloads
// themselves needs Node (they use exactly `contextBridge` + `ipcRenderer` — zero `process`,
// zero `fs`; `grep -c 'process\.' out/preload/index.js` is 0), so this is a PACKAGING blocker,
// not a design one: `sandbox: true` becomes available the moment each preload is emitted as
// ONE self-contained file. That is an electron.vite.config.ts change (a per-entry preload
// build, since rollup will always hoist a module shared by two entries into a chunk), owned
// outside this pass and written up as the top recommendation of the security report.
// `app.enableSandbox()` is blocked by the same finding, for the same reason.
//
// Until then the mitigations that actually matter without the OS sandbox are all on:
// contextIsolation (the preload's Node-capable context is unreachable from page JS), no
// nodeIntegration in any form, a deny-by-default navigation/window-open/webview policy
// (hardenWebContents), permissions denied wholesale (hardenSession), and a CSP with no
// script-src escape hatch in either page.
function WEB_PREFERENCES(preload: string): Electron.WebPreferences {
  return {
    preload,
    // The preload runs with Node available; page JS cannot see it or its globals.
    contextIsolation: true,
    // See the note above — the only reason this isn't `true`.
    sandbox: false,
    // No Node in the page, in workers, or in any sub-frame. All three are Electron defaults
    // today; all three are stated because flipping any one of them silently un-does
    // contextIsolation's value.
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    // Keep same-origin/CSP/mixed-content enforcement ON. Disabling it is how "just load this
    // one image from the wiki" turns into a renderer that can read any origin.
    webSecurity: true,
    allowRunningInsecureContent: false,
    // No experimental/unshipped Blink surface — this app renders its own bundle and nothing
    // else, so there is nothing to gain and an unaudited attack surface to lose.
    experimentalFeatures: false,
    enableBlinkFeatures: '',
    // `<webview>` is never used (hardenWebContents also denies every attach attempt).
    webviewTag: false,
    // The renderer has no <a href> to a local file and no reason to receive one by drop.
    // Chromium would otherwise NAVIGATE the window to a file dropped on it.
    navigateOnDragDrop: false,
    // Spellcheck downloads a dictionary from Google on first use; nothing here is prose input.
    spellcheck: false
  }
}

/**
 * Deny-by-default navigation policy for ONE webContents. Installed from the
 * `web-contents-created` catch-all below, so it covers the main window, every overlay window,
 * and any webContents a future feature creates — a per-window call site is exactly what gets
 * forgotten.
 *
 * Three doors, all shut:
 *   1. `will-navigate` — the app's own pages must never navigate away from the bundled
 *      files (or, in dev, off the electron-vite server's origin). A page that navigated
 *      elsewhere would keep this window's preload bridge — the ENTIRE `window.eq` IPC
 *      surface — and hand it to whatever loaded.
 *   2. `setWindowOpenHandler` — `window.open` / `<a target="_blank">` never opens an Electron
 *      window. An ALLOWLISTED https URL is handed to the user's default browser; anything
 *      else is dropped on the floor and logged. This is the door that matters most: the URLs
 *      reaching it are built from wiki page titles (see security.ts), and an unvalidated
 *      `shell.openExternal` would let one of them ask the OS to run `file:///…exe`.
 *   3. `will-attach-webview` — `<webview>` is disabled in webPreferences; this is the belt
 *      to that suspenders (and it strips node integration from the attach params first, so
 *      even a future deliberate webview can't be created Node-enabled by page markup).
 */
function hardenWebContents(wc: Electron.WebContents): void {
  const origins = {
    devServerUrl: process.env['ELECTRON_RENDERER_URL'],
    rendererDir: join(__dirname, '../renderer')
  }

  wc.on('will-navigate', (event, url) => {
    if (isInternalPageUrl(url, origins)) return
    event.preventDefault()
    logError('main:blocked-navigation', { url })
  })

  wc.setWindowOpenHandler((details) => {
    const safe = allowedExternalUrl(details.url)
    if (safe) void shell.openExternal(safe)
    else logError('main:blocked-window-open', { url: details.url })
    // NEVER 'allow': an Electron child window would inherit this app's preload.
    return { action: 'deny' }
  })

  wc.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    event.preventDefault()
    logError('main:blocked-webview', { src: params?.src })
  })
}

/**
 * Deny every web permission, for every window, forever.
 *
 * This app needs NONE of them: no camera, microphone, geolocation, notifications, clipboard
 * read, MIDI, HID/serial/USB, pointer lock, or media-key capture. The default handler grants
 * several of these to any page that asks, so the only correct answer for a UI that never asks
 * is a blanket no — a request arriving at all means something is wrong, hence the log line.
 *
 * `setPermissionCheckHandler` is the synchronous sibling (`navigator.permissions.query`,
 * and the gate some APIs consult without ever raising a request), and
 * `setDevicePermissionHandler` covers the device-picker path (WebHID/WebUSB/serial) which
 * does not go through the other two.
 */
function hardenSession(ses: Electron.Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    logError('main:denied-permission', { permission })
    callback(false)
  })
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
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
    webPreferences: WEB_PREFERENCES(join(__dirname, '../preload/index.js'))
  })

  // E2E: never show (and therefore never focus) the window — the harness drives it
  // entirely through the renderer's DOM while the user is playing.
  mainWindow.on('ready-to-show', () => {
    if (!E2E) mainWindow?.show()
  })

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
    for (const kind of OVERLAY_KINDS) {
      const w = overlayWindows[kind]
      if (w && !w.isDestroyed()) {
        w.removeAllListeners('closed')
        w.destroy()
        overlayWindows[kind] = null
      }
    }
  })

  // Navigation + window.open policy is installed for EVERY webContents by the
  // `web-contents-created` catch-all (hardenWebContents) — never per window, so a window
  // added later can't miss it.

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---- Floating overlay DPS meters (Task #52; two kinds in Task #54) ----
//
// Separate BrowserWindows that sit transparent + always-on-top over the game. EQ Legends runs
// windowed/borderless, where an always-on-top overlay composites fine (see AGENTS.md;
// fullscreen-EXCLUSIVE would defeat it, but that's not the default). No native helper app is
// needed — Electron's transparent/frameless + setAlwaysOnTop('screen-saver') +
// setIgnoreMouseEvents(forward) covers it.
//
// Three KINDS (Task #54; 'events' in Task #59), each an independent window with its own
// persisted config:
//   - 'fight'   : current-fight meter + FIGHT selector.
//   - 'overall' : zone meter + ZONE-session selector.
//   - 'events'  : the live event log (alerts / notable loot / quest completions).
// All can be open simultaneously. The overlay renderer reads its kind from the ?kind= query on
// its URL so a single overlay.html bundle serves every window.
//
// Two interaction modes per window, persisted in that kind's `locked`:
//   - interactive: normal focusable window, -webkit-app-region drag on the header, resize
//     edges, close/config controls + selector + drill-down visible.
//   - locked (click-through): mouse events pass through to the game via
//     setIgnoreMouseEvents(true, {forward:true}); the renderer's hover sensor toggles capture
//     back on so the hover-revealed pin stays clickable. Never steals focus. No drilling.

/** Apply the locked/interactive mouse + focus behavior to a kind's overlay window. */
function applyOverlayLocked(kind: OverlayKind, locked: boolean): void {
  const w = overlayWindows[kind]
  if (!w || w.isDestroyed()) return
  if (locked) {
    // Pass clicks through to the game; forward:true keeps mouse-move events so the
    // renderer's hover sensor can re-enable capture over the pin button.
    w.setIgnoreMouseEvents(true, { forward: true })
    w.setFocusable(false)
  } else {
    w.setIgnoreMouseEvents(false)
    w.setFocusable(true)
  }
}

/** Per-kind title (the OS window title; never user-visible on a frameless overlay, but it is
 *  what shows up in a window list / crash report). Partial + fallback so a new kind can't
 *  break the build here. */
const OVERLAY_TITLE: Partial<Record<OverlayKind, string>> = {
  fight: 'Fight Overlay',
  overall: 'Zone Overlay',
  events: 'Event Log Overlay',
  'heal-fight': 'Fight Healing Overlay',
  'heal-overall': 'Zone Healing Overlay'
}

function createOverlayWindow(kind: OverlayKind): void {
  const existing = overlayWindows[kind]
  if (existing && !existing.isDestroyed()) {
    if (!E2E) existing.show()
    return
  }
  const cfg = getOverlayConfig(kind)
  // Persisted bounds ALWAYS win; a first open is placed by the shared layout (bottom-right,
  // stacked per kind — overlayLayout.ts) so two overlays never open exactly on top of each other.
  const placed =
    cfg.bounds ??
    (() => {
      try {
        return defaultOverlayBounds(kind, screen.getPrimaryDisplay().workArea)
      } catch {
        return overlayDefaultSize(kind) // no display info (headless/e2e) — size only
      }
    })()
  const w = new BrowserWindow({
    ...placed,
    minWidth: 200,
    minHeight: 90,
    maxWidth: 720,
    maxHeight: 820,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    // Never take focus from the game when it appears (locked mode). We also avoid
    // adding it to the taskbar — it's an accessory of the main app.
    skipTaskbar: true,
    // …and out of ALT-TAB, which skipTaskbar alone does NOT do on Windows (it only
    // deletes the taskbar button). 'toolbar' sets WS_EX_TOOLWINDOW, the style Alt-Tab
    // (and Win+Tab) actually consults, so five open overlays don't turn window
    // switching into a lineup of accessories. NOT `parent: mainWindow` — an OWNED
    // window would also leave Alt-Tab but gets minimized with its owner, and hiding
    // the main app while playing must never take the overlays down with it.
    type: 'toolbar',
    // A transparent window can't have a native background; element rgba does the
    // translucency (per-element alpha beats window-level setOpacity).
    backgroundColor: '#00000000',
    hasShadow: false,
    title: OVERLAY_TITLE[kind],
    // Same hardened posture as the main window — one definition, every window (see
    // WEB_PREFERENCES). The overlay's preload is the LEANER bridge (preload/overlay.ts), but
    // its window-level privileges must not be a second, weaker opinion.
    webPreferences: WEB_PREFERENCES(join(__dirname, '../preload/overlay.js'))
  })
  overlayWindows[kind] = w

  // Always-on-top at the screen-saver level so it floats above ordinary windows
  // (and the borderless game). Re-assert after show for reliability on Windows.
  w.setAlwaysOnTop(true, 'screen-saver')

  const wc = w.webContents
  wc.on('preload-error', (_e, preloadPath, error) =>
    logError('overlay:preload-error', { preloadPath, error })
  )
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return
    logError('overlay:console', { level, message, source: `${sourceId}:${line}` })
  })

  // External links (the event log's wiki links, Task #59) open in the user's DEFAULT BROWSER —
  // the overlay window itself must NEVER navigate away from overlay.html. Both halves of that
  // are installed by the `web-contents-created` catch-all (hardenWebContents), which allows
  // only an ALLOWLISTED https host through to shell.openExternal; `<a target="_blank">` stays
  // the one link idiom across the app.

  w.on('ready-to-show', () => {
    // E2E: overlays stay hidden too (they're always-on-top — showing one would cover the game).
    if (E2E) return
    // showInactive so opening the overlay never steals focus from the game.
    w.showInactive()
    w.setAlwaysOnTop(true, 'screen-saver')
    applyOverlayLocked(kind, getOverlayConfig(kind).locked)
  })

  // Persist position + size so the overlay restores where the user left it.
  const saveOverlayBounds = (): void => {
    if (!w.isDestroyed()) setOverlayConfig(kind, { bounds: w.getBounds() })
  }
  w.on('moved', saveOverlayBounds)
  w.on('resized', saveOverlayBounds)

  w.on('closed', () => {
    overlayWindows[kind] = null
    setOverlayConfig(kind, { open: false })
    // Tell the main app so the TitleBar overlay menu reflects the closed state.
    mainWindow?.webContents.send(IPC.onOverlayState, { kind, open: false })
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void w.loadURL(`${rendererUrl}/overlay.html?kind=${kind}`)
  } else {
    void w.loadFile(join(__dirname, '../renderer/overlay.html'), { search: `kind=${kind}` })
  }
}

/** Open/close a kind's overlay and persist + broadcast its new open-state. Returns it. */
function setOverlayOpen(kind: OverlayKind, open: boolean): boolean {
  const w = overlayWindows[kind]
  if (open) {
    createOverlayWindow(kind)
  } else if (w && !w.isDestroyed()) {
    w.close() // 'closed' handler resets state + persists open:false + broadcasts
  }
  const isOpen = !!(overlayWindows[kind] && !overlayWindows[kind]!.isDestroyed())
  setOverlayConfig(kind, { open: isOpen })
  mainWindow?.webContents.send(IPC.onOverlayState, { kind, open: isOpen })
  return isOpen
}

/** Current open-state map across all overlay kinds (for the TitleBar menu). */
function overlayStateMap(): Record<OverlayKind, boolean> {
  const out = {} as Record<OverlayKind, boolean>
  for (const kind of OVERLAY_KINDS) {
    out[kind] = !!(overlayWindows[kind] && !overlayWindows[kind]!.isDestroyed())
  }
  return out
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
function buildEqConfig(): EqConfig {
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
async function applyEqDirChange(): Promise<EqConfig> {
  const config = buildEqConfig()
  // Refresh the character selector everywhere.
  const chars = listCharacters()
  mainWindow?.webContents.send(IPC.onEqConfigChanged, config)

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
    mainWindow?.webContents.send(IPC.onCharacter, null)
  }
  return config
}

/** Point the tailer + loot history at a character (used at startup and on switch). */
async function tailCharacter(ref: CharacterRef): Promise<void> {
  await tailer?.stop()
  tailer = null
  character = ref
  setActiveLogPath(ref.logPath)
  console.log(`[everquest-companion] Tailing ${ref.name}@${ref.server}: ${ref.logPath}`)

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
    `[everquest-companion] Loaded ${lootState.length} loot, ${turnInsModule.snapshot().state.length} turn-ins, ${
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
  tailer.on('error', (err) => console.error('[everquest-companion] tailer error', err))
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
    console.log(`[everquest-companion] Inventory auto-reloaded: ${res.path}`)
    mainWindow?.webContents.send(IPC.onInventoryReload, { path: res.path, loadedAt: res.loadedAt })
    mainWindow?.webContents.send(IPC.onProgress, getProgress(activeCharId()))
  })
  inventoryWatcher.on('error', (err) => console.error('[everquest-companion] inventory watch error', err))
}

async function startTailing(): Promise<void> {
  const ref = resolveInitialCharacter()
  if (!ref) {
    console.warn('[everquest-companion] No EQ log found; log tailing disabled.')
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

  // ---- EQ install-dir discovery + override (Settings gear) ----
  ipcMain.handle(IPC.getEqConfig, () => buildEqConfig())
  // Open the OS folder-picker rooted at the current effective dir; on a pick,
  // persist the override + re-scan/re-tail. Cancel leaves everything untouched.
  ipcMain.handle(IPC.pickEqDir, async () => {
    const current = resolveEqDir()
    const opts = {
      title: 'Select your EverQuest Legends install folder',
      defaultPath: existsSync(current.root) ? current.root : undefined,
      properties: ['openDirectory' as const]
    }
    // Parent the dialog to the main window (modal) when we have one.
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false as const, config: buildEqConfig() }
    }
    setEqInstallDir(res.filePaths[0])
    const config = await applyEqDirChange()
    return { ok: true as const, config }
  })
  // Set the override to an explicit dir (undefined/'' ⇒ revert to auto-detect).
  ipcMain.handle(IPC.setEqDir, async (_e, dir: string | undefined) => {
    setEqInstallDir(dir)
    return applyEqDirChange()
  })
  // Clear the override → auto-discovery.
  ipcMain.handle(IPC.resetEqDir, async () => {
    setEqInstallDir(undefined)
    return applyEqDirChange()
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
  // Fight-history search (Task #61). Read-only over the engine; `limit` is clamped here so a
  // renderer bug can't ask for an unbounded payload over IPC.
  ipcMain.handle(IPC.searchFights, (_e, text: unknown, limit: unknown) =>
    combat.searchFights(
      typeof text === 'string' ? text : '',
      typeof limit === 'number' && Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 500) : undefined
    )
  )

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
    // The alerts delta this flush emits is folded into the event feed by feedAlertDelta (the
    // registry host), so an app-signal fire (bossDefeat / questComplete) shows up in the
    // event log exactly like a main-side event/raw fire. eventFeed is registered after
    // alerts, so the resulting feed row rides out on this same flush.
    registry.flushNow()
  })
  // ---- event feed (Task #59): renderer-detected events ----
  // Only the renderer's posky/turn-in machinery can see a Sky quest complete, so it reports
  // completions here. Main owns the ring + ids; flushNow pushes the row straight out to the
  // 'events' overlay instead of waiting on the next log event / 1s tick.
  ipcMain.on(IPC.feedReport, (_e, report: FeedReport) => {
    if (!report?.title) return
    eventFeedModule.report(report)
    registry.flushNow()
  })
  ipcMain.handle(IPC.getAlertPrefs, () => getAlertPrefs())
  ipcMain.handle(IPC.setAlertPrefs, (_e, prefs: AlertPrefs) => setAlertPrefs(prefs))

  // ---- settings / alert sharing ("profiles" — src/shared/profiles.ts) ----
  // Export is a WHITELIST projection (buildSettingsBody): machine paths, window bounds and
  // caches cannot appear in a share string because nothing here ever reads one. Import is
  // ADDITIVE — previewShare plans, applyShare appends; nothing existing is replaced unless
  // the user ticks a scalar row (volume/mute/overlay/UI pref) in the preview.
  ipcMain.handle(IPC.shareExportSettings, (_e, ui: Record<string, string>) =>
    exportSettingsString(app.getVersion(), ui ?? {})
  )
  ipcMain.handle(IPC.shareExportAlerts, (_e, ids?: string[]) =>
    exportAlertsString(app.getVersion(), ids)
  )
  ipcMain.handle(IPC.shareSaveFile, async (_e, text: string, suggestedName: string) => {
    const opts = {
      title: 'Save share file',
      defaultPath: join(app.getPath('documents'), suggestedName || shareFileName('settings')),
      filters: [{ name: 'EQ Companion share', extensions: ['eqshare', 'txt'] }]
    }
    const res = mainWindow
      ? await dialog.showSaveDialog(mainWindow, opts)
      : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return { ok: false as const, canceled: true as const }
    try {
      // One line + a trailing newline: the file IS the paste-safe string, so a user can open
      // it in Notepad and copy it into chat without any conversion step.
      writeFileSync(res.filePath, `${text}\n`, 'utf8')
      return { ok: true as const, path: res.filePath }
    } catch (err) {
      logError('main:shareSaveFile', err)
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle(IPC.shareOpenFile, async (_e, ui: Record<string, string>) => {
    const opts = {
      title: 'Open a share file',
      properties: ['openFile' as const],
      filters: [
        { name: 'EQ Companion share', extensions: ['eqshare', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    }
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths.length) return null
    try {
      return previewShare(readFileSync(res.filePaths[0], 'utf8'), ui ?? {})
    } catch (err) {
      logError('main:shareOpenFile', err)
      return previewShare('', ui ?? {})
    }
  })
  ipcMain.handle(IPC.sharePreview, (_e, text: string, ui: Record<string, string>) =>
    previewShare(text ?? '', ui ?? {})
  )
  ipcMain.handle(
    IPC.shareApply,
    (_e, text: string, ui: Record<string, string>, selection?: ShareSelection) => {
      const result = applyShare(text ?? '', ui ?? {}, selection)
      // Keep the live evaluator in sync with any alerts the import appended.
      if (result.added > 0) alertsModule.setDefs(getAlerts())
      return result
    }
  )
  ipcMain.handle(IPC.listSoundPacks, () => listPacks())
  // packId names a DIRECTORY under the soundpack roots, so it is validated at the IPC
  // boundary (security.ts isSafePackId) rather than trusted because today's only caller
  // passes a listed pack's id. soundId is a KEY into that pack's manifest (never a path),
  // and sounds.ts already refuses a manifest entry that escapes the pack dir.
  ipcMain.handle(IPC.getSoundData, (_e, packId: string, soundId: string) =>
    isSafePackId(packId) ? getSoundData(packId, soundId) : null
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

  // ---- floating overlay DPS meters (Task #52; per-kind in Task #54) ----
  // Toggle a kind from the main app's TitleBar menu; returns the resulting open-state.
  ipcMain.handle(IPC.overlayToggle, (_e, kind: OverlayKind) => {
    const isOpen = !!(overlayWindows[kind] && !overlayWindows[kind]!.isDestroyed())
    return setOverlayOpen(kind, !isOpen)
  })
  ipcMain.handle(IPC.overlayGetState, () => overlayStateMap())
  ipcMain.handle(IPC.overlayGetConfig, (_e, kind: OverlayKind) => getOverlayConfig(kind))
  ipcMain.handle(IPC.overlaySetConfig, (_e, kind: OverlayKind, patch: Partial<OverlayConfig>) => {
    const next = setOverlayConfig(kind, patch ?? {})
    // Echo the merged config to that kind's overlay window so its UI stays in sync if the change
    // originated elsewhere (keeps the contract honest and cheap).
    overlayWindows[kind]?.webContents.send(IPC.onOverlayConfig, { kind, config: next })
    return next
  })
  // Locked (click-through) vs interactive. Persist + apply to the live window.
  ipcMain.on(IPC.overlaySetLocked, (_e, kind: OverlayKind, locked: boolean) => {
    setOverlayConfig(kind, { locked: !!locked })
    applyOverlayLocked(kind, !!locked)
  })
  // Fine-grained pass-through toggle from the overlay's hover sensor (locked mode).
  // forward:true so mouse-move keeps flowing and the sensor can flip capture back.
  ipcMain.on(IPC.overlaySetIgnoreMouse, (_e, kind: OverlayKind, ignore: boolean) => {
    const w = overlayWindows[kind]
    if (!w || w.isDestroyed()) return
    if (ignore) w.setIgnoreMouseEvents(true, { forward: true })
    else w.setIgnoreMouseEvents(false)
  })
  ipcMain.on(IPC.overlayClose, (_e, kind: OverlayKind) => setOverlayOpen(kind, false))

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
// The lock is PER CHANNEL, for free: Chromium keys it off the user-data dir, which
// channel.ts has already made distinct per channel — so the installed app and the dev
// app each hold their own lock and run side by side (Task #58).
// E2E: skip the lock entirely (never request it), so a headless test instance can run
// alongside the user's dev app instead of quitting — and can't steal its focus either.
const gotSingleInstanceLock = E2E || app.requestSingleInstanceLock()
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
    console.log(
      `[everquest-companion] Channel '${CHANNEL}' — userData ${USER_DATA}, error log ${errorLogPath()}`
    )
    registerIpc()
    // Trust boundary, installed BEFORE the first window exists: the catch-all fires for every
    // webContents this process will ever create (main window, each overlay, anything a future
    // feature adds), which is the only placement that can't be forgotten later.
    app.on('web-contents-created', (_e, wc) => hardenWebContents(wc))
    // Permissions are a SESSION property; every window here uses the default session (no
    // custom `partition` anywhere — the same fact that lets one eqimg:// handler serve them all).
    hardenSession(session.defaultSession)
    // Serve `eqimg://item/<id>` from <userData>/image-cache BEFORE any window loads a page
    // that can reference an item icon. One handler on the default session covers the main
    // window and every overlay (none of them use a custom partition).
    installImageCacheProtocol(protocol, {
      userData: USER_DATA,
      onError: (msg, err) => logError('main:imageCache', { message: msg, err })
    })
    createWindow()
    void startTailing()
    // Self-provision the shipped voice packs (Task #39): a CI-built installer ships
    // WITHOUT the gitignored peon/sc_marine packs, so a fresh install's seeded
    // charm-break alert would reference a missing sound. Download any missing default
    // pack in the background (non-blocking, silent — errors go to errors.log and retry
    // next launch). On success, tell the renderer the pack set changed so it re-lists +
    // invalidates its sound caches and the sound becomes usable live.
    // E2E: skip (fresh temp userData ⇒ it would re-download every pack, off-network noise).
    if (!E2E) {
      void provisionDefaultPacks()
        .then((n) => {
          if (n > 0) mainWindow?.webContents.send(IPC.onSoundPacksChanged)
        })
        .catch((err) => logError('main:provisionPacks', err))
    }
    // Auto-update (Task #27): checks GitHub Releases on the selected channel;
    // no-ops in dev. getMainWindow is lazy so status pushes hit the live window.
    initUpdater(() => mainWindow)

    // Restore any floating overlay (Task #52; per-kind in Task #54) that was open when the app
    // last quit. Deferred so the main window's did-finish-load sends its initial state first.
    for (const kind of OVERLAY_KINDS) {
      if (getOverlayConfig(kind).open) createOverlayWindow(kind)
    }

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
