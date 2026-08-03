// updater.ts — auto-update via electron-updater (Task #27; UX rework in Task #55).
//
// Pulls releases from GitHub (owner/repo baked into electron-builder.yml's publish
// block). The release channel is NO LONGER user-selectable — it's read from the
// store so existing installs keep their feed, and new installs default to 'main':
//
//   'main'   → allowPrerelease=true, channel 'main'  — every push to main publishes
//              a `-main.<run>` prerelease.
//   'stable' → allowPrerelease=false, channel 'latest' — only tagged `v*` releases.
//
// Lifecycle: check once ~10s after launch (don't fight startup I/O), then every
// 30 min, plus on demand from Preferences (`update:checkNow`). autoDownload pulls
// available updates quietly in the background; the renderer gets an `update:status`
// push at each transition, can PULL the last status (`update:getStatus` — a view
// mounted after the transition would otherwise see nothing), and applies a ready
// update through `update:install` → quitAndInstall ("Relaunch to update").
//
// DEV GUARD: electron-updater throws ("app-update.yml not found") when the app is
// not packaged. We skip the machinery in that case (`npm run dev` stays quiet) but
// still answer the read/no-op IPCs so the Preferences UI renders identically.

import { app, ipcMain, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC } from '../shared/ipc'
import type { UpdateChannel, UpdateStatus } from '../shared/types'
import { getUpdateChannel } from './store'

const { autoUpdater } = electronUpdater

const STARTUP_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 30 * 60 * 1000

let intervalTimer: ReturnType<typeof setInterval> | null = null

/** The last status pushed — the single source of truth behind `update:getStatus`. */
let lastStatus: UpdateStatus = { state: 'idle' }
/** Epoch millis of the last COMPLETED check (available / not-available / error). */
let lastCheckedAt: number | undefined

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
 * push so we always target the current window (it can be recreated). The update
 * machinery is skipped (and logged) when the app isn't packaged; the IPC surface
 * stays registered so the renderer never has to special-case dev.
 */
export function initUpdater(getMainWindow: () => BrowserWindow | null): void {
  // Registered in dev too: Preferences shows the version + a (benign) status there.
  ipcMain.handle(IPC.getAppVersion, () => app.getVersion())
  ipcMain.handle(IPC.getUpdateStatus, () => lastStatus)

  if (!app.isPackaged) {
    ipcMain.handle(IPC.installUpdate, () => {})
    ipcMain.handle(IPC.checkForUpdates, () => lastStatus)
    console.log('[everquest-companion] Auto-update disabled (dev / not packaged).')
    return
  }

  /** Record + broadcast a status. `checkedAt` rides along on every push once known. */
  const push = (status: UpdateStatus): void => {
    lastStatus = lastCheckedAt ? { ...status, checkedAt: lastCheckedAt } : status
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.onUpdateStatus, lastStatus)
  }

  /** A check finished (whatever the verdict) — stamp the time, then push. */
  const checkDone = (status: UpdateStatus): void => {
    lastCheckedAt = Date.now()
    push(status)
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  applyChannel(getUpdateChannel())

  autoUpdater.on('checking-for-update', () => push({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    checkDone({ state: 'available', version: info?.version })
  )
  autoUpdater.on('update-not-available', () => checkDone({ state: 'idle' }))
  autoUpdater.on('download-progress', (p) =>
    // Carry the known version forward so the progress row can name the build.
    push({ state: 'downloading', percent: Math.round(p?.percent ?? 0), version: lastStatus.version })
  )
  autoUpdater.on('update-downloaded', (info) => push({ state: 'ready', version: info?.version }))
  autoUpdater.on('error', (err) =>
    checkDone({ state: 'error', message: err == null ? 'unknown error' : String(err.message ?? err) })
  )

  // renderer -> main: apply the downloaded update now. quitAndInstall(true, true) =
  // silent install + relaunch. (The second-instance lock in index.ts makes the
  // relaunch focus the fresh instance cleanly.)
  ipcMain.handle(IPC.installUpdate, () => {
    autoUpdater.quitAndInstall(true, true)
  })

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch((err) => {
      // Network hiccups are expected; surface as an error status but don't throw.
      checkDone({ state: 'error', message: String(err?.message ?? err) })
    })
  }

  // renderer -> main: explicit "Check for updates". A downloaded-and-waiting update
  // is terminal — re-checking would only knock the 'ready' state off the UI (the
  // cached download emits no fresh update-downloaded), so we leave it be.
  ipcMain.handle(IPC.checkForUpdates, async (): Promise<UpdateStatus> => {
    if (lastStatus.state === 'ready') return lastStatus
    push({ state: 'checking' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      checkDone({ state: 'error', message: String((err as Error)?.message ?? err) })
    }
    return lastStatus
  })

  setTimeout(check, STARTUP_DELAY_MS)
  intervalTimer = setInterval(check, CHECK_INTERVAL_MS)
  app.on('will-quit', () => {
    if (intervalTimer) clearInterval(intervalTimer)
  })
}
