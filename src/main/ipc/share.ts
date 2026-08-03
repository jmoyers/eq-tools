// ---- settings / alert sharing ("profiles" — src/shared/profiles.ts) ----
// Export is a WHITELIST projection (buildSettingsBody): machine paths, window bounds and
// caches cannot appear in a share string because nothing here ever reads one. Import is
// ADDITIVE — previewShare plans, applyShare appends; nothing existing is replaced unless
// the user ticks a scalar row (volume/mute/overlay/UI pref) in the preview.

import { app, dialog, ipcMain } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { IPC } from '../../shared/ipc'
import { logError } from '../errorLog'
import { alertsModule } from '../pipeline'
import {
  applyShare,
  exportAlertsString,
  exportSettingsString,
  previewShare,
  shareFileName,
  type ShareSelection
} from '../share'
import { getAlerts } from '../store'
import { getMainWindow } from '../windows'

export function registerShareIpc(): void {
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
    const mainWindow = getMainWindow()
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
    const mainWindow = getMainWindow()
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
}
