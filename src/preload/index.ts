import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { CharacterRef, LogLine, LootEvent, ProgressState } from '../shared/types'

export interface ReloadInventoryResult {
  ok: boolean
  error?: string
  path?: string
  loadedAt?: string
  progress?: ProgressState
}

const api = {
  getCharacter: (): Promise<CharacterRef | null> => ipcRenderer.invoke(IPC.getCharacter),
  getProgress: (): Promise<ProgressState> => ipcRenderer.invoke(IPC.getProgress),
  reloadInventory: (): Promise<ReloadInventoryResult> => ipcRenderer.invoke(IPC.reloadInventory),
  setQuestComplete: (questKey: string, complete: boolean): Promise<ProgressState> =>
    ipcRenderer.invoke(IPC.setQuestComplete, questKey, complete),
  resetLiveLoot: (): Promise<ProgressState> => ipcRenderer.invoke(IPC.resetLiveLoot),

  onLoot: (cb: (loot: LootEvent) => void): (() => void) => {
    const listener = (_e: unknown, loot: LootEvent): void => cb(loot)
    ipcRenderer.on(IPC.onLoot, listener)
    return () => ipcRenderer.removeListener(IPC.onLoot, listener)
  },
  onLine: (cb: (line: LogLine) => void): (() => void) => {
    const listener = (_e: unknown, line: LogLine): void => cb(line)
    ipcRenderer.on(IPC.onLine, listener)
    return () => ipcRenderer.removeListener(IPC.onLine, listener)
  }
}

export type EqApi = typeof api

contextBridge.exposeInMainWorld('eq', api)
