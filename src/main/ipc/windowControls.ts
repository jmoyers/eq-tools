// IPC: everything the renderer says ABOUT WINDOWS — the frameless title-bar controls, the
// floating overlays' open/config/click-through state, the cross-window deep link, and the
// renderer's own error reports.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { E2E } from '../e2e'
import { logError } from '../errorLog'
import { getOverlayConfig, setOverlayConfig } from '../store'
import {
  applyOverlayLocked,
  getMainWindow,
  getOverlayWindow,
  isOverlayOpen,
  overlayStateMap,
  setOverlayOpen
} from '../windows'
import type { AppFocus, AppFocusView, OverlayConfig, OverlayKind } from '../../shared/types'

export function registerWindowIpc(): void {
  // ---- cross-window deep link (Task #64) ----
  // An overlay row says a thing happened; clicking it asks the APP to answer it properly. Main
  // is the only process that can raise a window it doesn't own, so the hop goes through here.
  //
  // The `view` is re-validated against the closed AppFocusView union rather than trusted
  // because today's only caller is the app's own overlay (the same rule `sounds:getData`'s
  // packId follows): a renderer telling another renderer where to navigate is a capability, and
  // its vocabulary is fixed here. `mob` is forwarded only when it is a non-empty string — it is
  // pure display/lookup text in the receiving view and never touches a path.
  //
  // E2E never shows a window (src/main/e2e.ts is the whole test mode), so the raise is skipped
  // there; the forward still happens, which is the half a test could observe.
  ipcMain.on(IPC.focusView, (_e, focus: AppFocus) => {
    const views: AppFocusView[] = ['mobs']
    if (!focus || !(views as string[]).includes(focus.view)) return
    const w = getMainWindow()
    if (!w || w.isDestroyed()) return
    if (!E2E) {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
    const mob = typeof focus.mob === 'string' && focus.mob.trim() ? focus.mob : undefined
    w.webContents.send(IPC.onFocusView, { view: focus.view, mob } satisfies AppFocus)
  })

  // ---- frameless window controls (Task #23) ----
  // The React title bar (App.tsx) drives the native window: these mirror the
  // OS min/max/close chrome we removed with `frame: false`. `ipcMain.on` matches
  // the preload's fire-and-forget `send`.
  ipcMain.on(IPC.windowMinimize, () => getMainWindow()?.minimize())
  ipcMain.on(IPC.windowToggleMaximize, () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(IPC.windowClose, () => getMainWindow()?.close())

  // ---- floating overlay DPS meters (Task #52; per-kind in Task #54) ----
  // Toggle a kind from the main app's TitleBar menu; returns the resulting open-state.
  ipcMain.handle(IPC.overlayToggle, (_e, kind: OverlayKind) =>
    setOverlayOpen(kind, !isOverlayOpen(kind))
  )
  ipcMain.handle(IPC.overlayGetState, () => overlayStateMap())
  ipcMain.handle(IPC.overlayGetConfig, (_e, kind: OverlayKind) => getOverlayConfig(kind))
  ipcMain.handle(IPC.overlaySetConfig, (_e, kind: OverlayKind, patch: Partial<OverlayConfig>) => {
    const next = setOverlayConfig(kind, patch ?? {})
    // Echo the merged config to that kind's overlay window so its UI stays in sync if the change
    // originated elsewhere (keeps the contract honest and cheap).
    getOverlayWindow(kind)?.webContents.send(IPC.onOverlayConfig, { kind, config: next })
    return next
  })
  // Locked (click-through) vs interactive. Persist + apply to the live window.
  ipcMain.on(IPC.overlaySetLocked, (_e, kind: OverlayKind, locked: boolean) => {
    setOverlayConfig(kind, { locked })
    applyOverlayLocked(kind, locked)
  })
  // Fine-grained pass-through toggle from the overlay's hover sensor (locked mode).
  // forward:true so mouse-move keeps flowing and the sensor can flip capture back.
  ipcMain.on(IPC.overlaySetIgnoreMouse, (_e, kind: OverlayKind, ignore: boolean) => {
    const w = getOverlayWindow(kind)
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
