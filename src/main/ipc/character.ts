// IPC: the active character, the EQ install dir, and the per-character progress/inventory
// state that hangs off both. One domain because they are one causal chain — changing the dir
// re-lists characters, which can re-tail, which re-keys progress.

import { dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { IPC } from '../../shared/ipc'
import { listCharacters, parseLogName, resolveEqDir } from '../log/config'
import { loadInventory } from '../inventory/parseInventory'
import {
  activeCharId,
  applyEqDirChange,
  buildEqConfig,
  getActiveCharacter,
  tailCharacter
} from '../session'
import { getProgress, setEqInstallDir, setInventory, setQuestComplete } from '../store'
import { getMainWindow, sendToMain } from '../windows'

export function registerCharacterIpc(): void {
  ipcMain.handle(IPC.getCharacter, () => getActiveCharacter())
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
    const mainWindow = getMainWindow()
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
    const res = loadInventory(getActiveCharacter()?.name)
    if (!res) return { ok: false as const, error: 'No *-Inventory.txt found in the EQ folder.' }
    setInventory(activeCharId(), res.counts, { path: res.path, loadedAt: res.loadedAt })
    const progress = getProgress(activeCharId())
    // Keep other views consistent (Plane of Sky derives held-item counts too).
    sendToMain(IPC.onProgress, progress)
    return { ok: true as const, path: res.path, loadedAt: res.loadedAt, progress }
  })
  ipcMain.handle(IPC.setQuestComplete, (_e, questKey: string, complete: boolean) => {
    const progress = setQuestComplete(activeCharId(), questKey, complete)
    // Push so a completion made in one view (or auto-completed from a turn-in)
    // reaches every other view without a refetch race.
    sendToMain(IPC.onProgress, progress)
    return progress
  })
}
