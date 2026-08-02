// updater.ts — auto-update via electron-updater (Task #27).
//
// Pulls releases from GitHub (owner/repo baked into electron-builder.yml's publish
// block). Two channels, chosen by the user and persisted in electron-store:
//
//   'main'   → allowPrerelease=true, channel 'main'  — every push to main publishes
//              a `-main.<run>` prerelease; users on 'main' get the latest build.
//   'stable' → allowPrerelease=false, channel 'latest' — only tagged `v*` full
//              releases. This is the electron-updater default channel name.
//
// Lifecycle: check once ~10s after launch (don't fight startup I/O), then every
// 30 min. autoDownload downloads available updates in the background; the renderer
// gets a `update:status` push at each transition and, when ready, shows a Restart
// snackbar wired to the `update:install` IPC → quitAndInstall.
//
// DEV GUARD: electron-updater throws ("app-update.yml not found") when the app is
// not packaged. We skip all wiring in that case so `npm run dev` stays quiet.

import { app, ipcMain, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC } from '../shared/ipc'
import type { UpdateChannel, UpdateStatus } from '../shared/types'
import { getUpdateChannel, setUpdateChannel } from './store'

const { autoUpdater } = electronUpdater

const STARTUP_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 30 * 60 * 1000

let intervalTimer: ReturnType<typeof setInterval> | null = null

/** Map our channel choice onto electron-updater's channel + prerelease settings. */
function applyChannel(channel: UpdateChannel): void {
  if (channel === 'main') {
    autoUpdater.channel = 'main'
    autoUpdater.allowPrerelease = true
  } else {
    autoUpdater.channel = 'latest'
    autoUpdater.allowPrerelease = false
  }
}

/**
 * Initialize the auto-updater. `getMainWindow` is called lazily on each status
 * push so we always target the current window (it can be recreated). No-op (and
 * logs why) when the app isn't packaged.
 */
export function initUpdater(getMainWindow: () => BrowserWindow | null): void {
  // Channel read/select must work even in dev (the settings UI invokes them);
  // only the actual update machinery is gated on being packaged.
  ipcMain.handle(IPC.getUpdateChannel, () => getUpdateChannel())

  if (!app.isPackaged) {
    ipcMain.handle(IPC.setUpdateChannel, (_e, channel: UpdateChannel) => setUpdateChannel(channel))
    ipcMain.handle(IPC.installUpdate, () => {})
    console.log('[eq-tools] Auto-update disabled (dev / not packaged).')
    return
  }

  const push = (status: UpdateStatus): void => {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.onUpdateStatus, status)
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  applyChannel(getUpdateChannel())

  autoUpdater.on('checking-for-update', () => push({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    push({ state: 'available', version: info?.version })
  )
  autoUpdater.on('update-not-available', () => push({ state: 'idle' }))
  autoUpdater.on('download-progress', (p) =>
    push({ state: 'downloading', percent: Math.round(p?.percent ?? 0) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    push({ state: 'ready', version: info?.version })
  )
  autoUpdater.on('error', (err) =>
    push({ state: 'error', message: err == null ? 'unknown error' : String(err.message ?? err) })
  )

  // renderer -> main: apply the downloaded update now. quitAndInstall(true, true) =
  // silent install + relaunch. (The second-instance lock in index.ts makes the
  // relaunch focus the fresh instance cleanly.)
  ipcMain.handle(IPC.installUpdate, () => {
    autoUpdater.quitAndInstall(true, true)
  })

  // renderer <-> main: channel select (read is registered above, dev included).
  // Setting a channel re-checks so the switch takes effect immediately (e.g.
  // flipping to 'stable' finds the tagged release without waiting for the tick).
  ipcMain.handle(IPC.setUpdateChannel, (_e, channel: UpdateChannel) => {
    const next = setUpdateChannel(channel)
    applyChannel(next)
    void autoUpdater.checkForUpdates().catch((err) => {
      push({ state: 'error', message: String(err?.message ?? err) })
    })
    return next
  })

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch((err) => {
      // Network hiccups are expected; surface as an error status but don't throw.
      push({ state: 'error', message: String(err?.message ?? err) })
    })
  }

  setTimeout(check, STARTUP_DELAY_MS)
  intervalTimer = setInterval(check, CHECK_INTERVAL_MS)
  app.on('will-quit', () => {
    if (intervalTimer) clearInterval(intervalTimer)
  })
}
