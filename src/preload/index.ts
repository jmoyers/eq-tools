import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AlertDef,
  AlertPrefs,
  CharacterRef,
  LogLine,
  LootEvent,
  ModuleDelta,
  ModuleSnapshot,
  PackInstallProgress,
  PackMutationResult,
  PackPreviewList,
  ProgressState,
  RegistryListResult,
  SoundData,
  SoundPack
} from '../shared/types'
import type { CombatSnapshot, SnapshotOpts } from '../shared/combat'
import type { UpdateChannel, UpdateStatus } from '../shared/types'

export type { CharacterRef, LogLine, LootEvent, ProgressState }
export type { ModuleDelta, ModuleSnapshot }
export type { AlertDef, AlertPrefs, SoundData, SoundPack }
export type { PackInstallProgress, PackMutationResult, PackPreviewList, RegistryListResult }
export type { UpdateChannel, UpdateStatus }

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

/** Payload of the inventory auto-reload push. */
export interface InventoryReloadEvent {
  path: string
  loadedAt: string
}

/** Payload the renderer sends over `error:report` (fire-and-forget). */
export interface RendererErrorReport {
  message: string
  stack?: string
  source: string
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
  getCombatSnapshot: (opts: SnapshotOpts): Promise<CombatSnapshot> =>
    ipcRenderer.invoke(IPC.getCombatSnapshot, opts),

  // ---- alerts extension (Task #18) ----
  listAlerts: (): Promise<AlertDef[]> => ipcRenderer.invoke(IPC.listAlerts),
  saveAlert: (def: AlertDef): Promise<AlertDef[]> => ipcRenderer.invoke(IPC.saveAlert, def),
  deleteAlert: (id: string): Promise<AlertDef[]> => ipcRenderer.invoke(IPC.deleteAlert, id),
  testAlert: (id: string): Promise<AlertDef | null> => ipcRenderer.invoke(IPC.testAlert, id),
  resetAlerts: (): Promise<AlertDef[]> => ipcRenderer.invoke(IPC.resetAlerts),
  /** Report a renderer-evaluated 'app' fire so main records it in history (fire-and-forget). */
  appFired: (alertId: string, context: string): void => {
    try {
      ipcRenderer.send(IPC.appFired, { alertId, context })
    } catch {
      // history is best-effort; a failed report just omits one recent-fire row.
    }
  },
  getAlertPrefs: (): Promise<AlertPrefs> => ipcRenderer.invoke(IPC.getAlertPrefs),
  setAlertPrefs: (prefs: AlertPrefs): Promise<AlertPrefs> =>
    ipcRenderer.invoke(IPC.setAlertPrefs, prefs),
  listSoundPacks: (): Promise<SoundPack[]> => ipcRenderer.invoke(IPC.listSoundPacks),
  getSoundData: (packId: string, soundId: string): Promise<SoundData | null> =>
    ipcRenderer.invoke(IPC.getSoundData, packId, soundId),

  // ---- sound-pack registry (openpeon.com integration, Task #29) ----
  /** List registry packs (installed-flag reconciled). `force` bypasses the 24h cache. */
  listRegistryPacks: (force?: boolean): Promise<RegistryListResult> =>
    ipcRenderer.invoke(IPC.packsRegistry, force ?? false),
  /** Install a pack by name; watch onPackProgress for per-phase progress. */
  installPack: (name: string): Promise<PackMutationResult> =>
    ipcRenderer.invoke(IPC.packsInstall, name),
  /** Uninstall a user-installed pack by name. */
  uninstallPack: (name: string): Promise<PackMutationResult> =>
    ipcRenderer.invoke(IPC.packsUninstall, name),
  /** Preview a registry pack's sounds BEFORE install (fetched off GitHub raw). */
  previewPackSounds: (name: string): Promise<PackPreviewList> =>
    ipcRenderer.invoke(IPC.packsPreviewList, name),
  /** Fetch one preview audio file's bytes for a registry pack (null on failure). */
  previewPackSound: (name: string, file: string): Promise<SoundData | null> =>
    ipcRenderer.invoke(IPC.packsPreviewSound, name, file),
  /** Subscribe to install progress pushes. */
  onPackProgress: (cb: (p: PackInstallProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: PackInstallProgress): void => cb(p)
    ipcRenderer.on(IPC.onPackProgress, listener)
    return () => ipcRenderer.removeListener(IPC.onPackProgress, listener)
  },

  // ---- generic module transport ----
  /** Full hydration snapshot for a module (null if the id is unknown). */
  getModuleSnapshot: <Snap>(moduleId: string): Promise<ModuleSnapshot<Snap> | null> =>
    ipcRenderer.invoke(IPC.getModuleSnapshot, moduleId),
  /** Subscribe to every `module:delta`; the hook filters by moduleId. */
  onModuleDelta: <Delta>(cb: (d: ModuleDelta<Delta>) => void): (() => void) => {
    const listener = (_e: unknown, d: ModuleDelta<Delta>): void => cb(d)
    ipcRenderer.on(IPC.onModuleDelta, listener)
    return () => ipcRenderer.removeListener(IPC.onModuleDelta, listener)
  },

  onProgress: (cb: (p: ProgressState) => void): (() => void) => {
    const listener = (_e: unknown, p: ProgressState): void => cb(p)
    ipcRenderer.on(IPC.onProgress, listener)
    return () => ipcRenderer.removeListener(IPC.onProgress, listener)
  },
  onInventoryReload: (cb: (e: InventoryReloadEvent) => void): (() => void) => {
    const listener = (_e: unknown, ev: InventoryReloadEvent): void => cb(ev)
    ipcRenderer.on(IPC.onInventoryReload, listener)
    return () => ipcRenderer.removeListener(IPC.onInventoryReload, listener)
  },
  onLine: (cb: (line: LogLine) => void): (() => void) => {
    const listener = (_e: unknown, line: LogLine): void => cb(line)
    ipcRenderer.on(IPC.onLine, listener)
    return () => ipcRenderer.removeListener(IPC.onLine, listener)
  },
  onCharacter: (cb: (c: CharacterRef | null) => void): (() => void) => {
    const listener = (_e: unknown, c: CharacterRef | null): void => cb(c)
    ipcRenderer.on(IPC.onCharacter, listener)
    return () => ipcRenderer.removeListener(IPC.onCharacter, listener)
  },
  onCombatActivity: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.onCombatActivity, listener)
    return () => ipcRenderer.removeListener(IPC.onCombatActivity, listener)
  },

  // ---- auto-update (Task #27) ----
  /** Subscribe to update lifecycle pushes (checking/available/downloading/ready/error). */
  onUpdateStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: UpdateStatus): void => cb(s)
    ipcRenderer.on(IPC.onUpdateStatus, listener)
    return () => ipcRenderer.removeListener(IPC.onUpdateStatus, listener)
  },
  /** Apply the downloaded update now (quit + install + relaunch). */
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.installUpdate),
  /** Read the current release channel. */
  getUpdateChannel: (): Promise<UpdateChannel> => ipcRenderer.invoke(IPC.getUpdateChannel),
  /** Select a release channel (re-checks immediately). Returns the applied channel. */
  setUpdateChannel: (channel: UpdateChannel): Promise<UpdateChannel> =>
    ipcRenderer.invoke(IPC.setUpdateChannel, channel),

  // ---- frameless window controls (Task #23) ----
  minimizeWindow: (): void => ipcRenderer.send(IPC.windowMinimize),
  toggleMaximizeWindow: (): void => ipcRenderer.send(IPC.windowToggleMaximize),
  closeWindow: (): void => ipcRenderer.send(IPC.windowClose),
  /** Subscribe to maximize/unmaximize so the title bar can swap the max/restore icon. */
  onWindowMaximized: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on(IPC.onWindowMaximized, listener)
    return () => ipcRenderer.removeListener(IPC.onWindowMaximized, listener)
  },

  /**
   * Fire-and-forget error report from the renderer (window.onerror,
   * unhandledrejection, React ErrorBoundary) → main → errors.log + dev stdout.
   * Never throws so a broken UI can always report why it broke.
   */
  reportError: (report: RendererErrorReport): void => {
    try {
      ipcRenderer.send(IPC.reportError, report)
    } catch {
      // If IPC itself is unavailable, the renderer console handler still logged.
    }
  }
}

export type EqApi = typeof api

contextBridge.exposeInMainWorld('eq', api)
