// ============================================================================
// windows.ts — every BrowserWindow this process creates, and the runtime policy
// applied to it.
// ============================================================================
//
// Two window populations live here because they share ONE security posture and are
// entangled at teardown (closing the main window destroys the overlays):
//
//   - the main app window (frameless, bounds persisted), and
//   - the floating overlays (one per OverlayKind, transparent + always-on-top).
//
// The module owns their handles. Nothing outside reaches for a BrowserWindow: callers
// push to the renderer through `sendToMain` / `getOverlayWindow`, which keeps the
// null-when-closed lifetime in exactly one place.
//
// `src/main/security.ts` is the PURE half of the trust boundary (URL/pack-id predicates,
// no Electron, pinned by tests/security.test.mts). This file is the half that has to talk
// to Electron: the shared webPreferences object and the per-webContents / per-session
// hardening that installs those predicates.

import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { E2E } from './e2e'
import { logError } from './errorLog'
import { defaultOverlayBounds, overlayDefaultSize } from './overlayLayout'
import { allowedExternalUrl, isInternalPageUrl } from './security'
import { getOverlayConfig, getWindowBounds, setOverlayConfig, setWindowBounds } from './store'
import { OVERLAY_KINDS, type OverlayKind } from '../shared/types'

let mainWindow: BrowserWindow | null = null
// The floating overlays (Task #52; kinds in Task #54, more in Task #59): separate transparent,
// frameless, always-on-top windows created on demand — the damage meters, the healing meters and
// the event log. Any combination can be open at once. Null when that kind is closed. Built from
// OVERLAY_KINDS so adding a kind never means editing a literal here.
const overlayWindows = Object.fromEntries(OVERLAY_KINDS.map((k) => [k, null])) as Record<
  OverlayKind,
  BrowserWindow | null
>

/** The main window while it exists (null before creation / after close). */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * Push to the main window's renderer, or do nothing if there isn't one. Every
 * `onX` broadcast in the main process goes through here, so "the window may not exist yet"
 * is answered once instead of at ~20 call sites.
 */
export function sendToMain(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args)
}

/** A kind's overlay window while it is open (null when closed). */
export function getOverlayWindow(kind: OverlayKind): BrowserWindow | null {
  return overlayWindows[kind]
}

/** Is this kind's overlay open — i.e. does a live, undestroyed window exist for it? */
export function isOverlayOpen(kind: OverlayKind): boolean {
  const w = overlayWindows[kind]
  return w !== null && !w.isDestroyed()
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
//
// Module-private on purpose: every window in this app is created in this file, so there is no
// legitimate caller elsewhere and "never inline a second opinion" is structural, not a note.
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
 * `web-contents-created` catch-all in index.ts, so it covers the main window, every overlay
 * window, and any webContents a future feature creates — a per-window call site is exactly
 * what gets forgotten.
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
export function hardenWebContents(wc: Electron.WebContents): void {
  const origins = {
    devServerUrl: process.env.ELECTRON_RENDERER_URL,
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
export function hardenSession(ses: Electron.Session): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    logError('main:denied-permission', { permission })
    callback(false)
  })
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
}

/**
 * Forward renderer console warnings/errors (level >= 2) into main stdout +
 * errors.log so agents reading the dev task output see renderer-side errors too.
 * level: 0=verbose 1=info 2=warning 3=error.
 *
 * Electron's `console-message` listener is five positional arguments wide; the four fields
 * are taken as a rest tuple so the callback stays inside the project's max-params ceiling.
 * `tag` is the errors.log source tag ('renderer:console' / 'overlay:console').
 */
function forwardConsoleMessages(wc: Electron.WebContents, tag: string): void {
  wc.on('console-message', (_e, ...rest) => {
    const [level, message, line, sourceId] = rest
    if (level < 2) return
    logError(tag, { level, message, source: `${sourceId}:${line}` })
  })
}

/**
 * webContents error capture for the MAIN window (Task #13). Each of these would otherwise
 * leave a blank window with no console trace. Log everything to errors.log + dev stdout, and
 * self-heal once where it's safe.
 */
function captureMainWindowErrors(wc: Electron.WebContents): void {
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
  // (Rest tuple for the same max-params reason as forwardConsoleMessages.)
  let didFailReloaded = false
  wc.on('did-fail-load', (_e, ...rest) => {
    const [errorCode, errorDescription, validatedURL, isMainFrame] = rest
    // errorCode -3 (ABORTED) is a benign navigation cancel; don't spam or retry.
    if (errorCode === -3) return
    logError('main:did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame })
    if (isMainFrame && !didFailReloaded && mainWindow && !mainWindow.isDestroyed()) {
      didFailReloaded = true
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        const url = process.env.ELECTRON_RENDERER_URL
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

  forwardConsoleMessages(wc, 'renderer:console')
}

export function createMainWindow(): void {
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
  captureMainWindowErrors(mainWindow.webContents)

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

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
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
export function applyOverlayLocked(kind: OverlayKind, locked: boolean): void {
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

/**
 * Where a kind's overlay opens. Persisted bounds ALWAYS win; a first open is placed by the
 * shared layout (bottom-right, stacked per kind — overlayLayout.ts) so two overlays never open
 * exactly on top of each other.
 */
function overlayPlacement(kind: OverlayKind) {
  const cfg = getOverlayConfig(kind)
  if (cfg.bounds) return cfg.bounds
  try {
    return defaultOverlayBounds(kind, screen.getPrimaryDisplay().workArea)
  } catch {
    return overlayDefaultSize(kind) // no display info (headless/e2e) — size only
  }
}

export function createOverlayWindow(kind: OverlayKind): void {
  const existing = overlayWindows[kind]
  if (existing && !existing.isDestroyed()) {
    if (!E2E) existing.show()
    return
  }
  const w = new BrowserWindow({
    ...overlayPlacement(kind),
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
  forwardConsoleMessages(wc, 'overlay:console')

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
    sendToMain(IPC.onOverlayState, { kind, open: false })
  })

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void w.loadURL(`${rendererUrl}/overlay.html?kind=${kind}`)
  } else {
    void w.loadFile(join(__dirname, '../renderer/overlay.html'), { search: `kind=${kind}` })
  }
}

/** Open/close a kind's overlay and persist + broadcast its new open-state. Returns it. */
export function setOverlayOpen(kind: OverlayKind, open: boolean): boolean {
  const w = overlayWindows[kind]
  if (open) {
    createOverlayWindow(kind)
  } else if (w && !w.isDestroyed()) {
    w.close() // 'closed' handler resets state + persists open:false + broadcasts
  }
  const isOpen = isOverlayOpen(kind)
  setOverlayConfig(kind, { open: isOpen })
  sendToMain(IPC.onOverlayState, { kind, open: isOpen })
  return isOpen
}

/** Current open-state map across all overlay kinds (for the TitleBar menu). */
export function overlayStateMap(): Record<OverlayKind, boolean> {
  const out = {} as Record<OverlayKind, boolean>
  for (const kind of OVERLAY_KINDS) {
    out[kind] = isOverlayOpen(kind)
  }
  return out
}
