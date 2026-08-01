import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  CharacterRef,
  KillCounts,
  LogLine,
  LootEvent,
  ProgressState,
  TurnInEvent
} from '../shared/types'

export type { CharacterRef, LogLine, LootEvent, ProgressState }

export interface ReloadInventoryResult {
  ok: boolean
  error?: string
  path?: string
  loadedAt?: string
  progress?: ProgressState
}

export interface SetCharacterResult {
  ok: boolean
  error?: string
  character?: CharacterRef
}

const api = {
  getCharacter: (): Promise<CharacterRef | null> => ipcRenderer.invoke(IPC.getCharacter),
  listCharacters: (): Promise<CharacterRef[]> => ipcRenderer.invoke(IPC.listCharacters),
  setCharacter: (logPath: string): Promise<SetCharacterResult> =>
    ipcRenderer.invoke(IPC.setCharacter, logPath),
  getProgress: (): Promise<ProgressState> => ipcRenderer.invoke(IPC.getProgress),
  reloadInventory: (): Promise<ReloadInventoryResult> => ipcRenderer.invoke(IPC.reloadInventory),
  setQuestComplete: (questKey: string, complete: boolean): Promise<ProgressState> =>
    ipcRenderer.invoke(IPC.setQuestComplete, questKey, complete),
  getLootHistory: (): Promise<LootEvent[]> => ipcRenderer.invoke(IPC.getLootHistory),
  getKills: (): Promise<KillCounts> => ipcRenderer.invoke(IPC.getKills),
  getTurnIns: (): Promise<TurnInEvent[]> => ipcRenderer.invoke(IPC.getTurnIns),

  onLoot: (cb: (loot: LootEvent) => void): (() => void) => {
    const listener = (_e: unknown, loot: LootEvent): void => cb(loot)
    ipcRenderer.on(IPC.onLoot, listener)
    return () => ipcRenderer.removeListener(IPC.onLoot, listener)
  },
  onTurnIn: (cb: (t: TurnInEvent) => void): (() => void) => {
    const listener = (_e: unknown, t: TurnInEvent): void => cb(t)
    ipcRenderer.on(IPC.onTurnIn, listener)
    return () => ipcRenderer.removeListener(IPC.onTurnIn, listener)
  },
  onLine: (cb: (line: LogLine) => void): (() => void) => {
    const listener = (_e: unknown, line: LogLine): void => cb(line)
    ipcRenderer.on(IPC.onLine, listener)
    return () => ipcRenderer.removeListener(IPC.onLine, listener)
  }
}

export type EqApi = typeof api

contextBridge.exposeInMainWorld('eq', api)
