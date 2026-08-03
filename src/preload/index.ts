import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AlertDef,
  AlertPrefs,
  CharacterRef,
  EqConfig,
  EqConfigResult,
  FeedReport,
  ItemKnowledge,
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
  SoundPack,
  SpellCatalog
} from '../shared/types'
import type { CombatSnapshot, FightSearchResult, SnapshotOpts } from '../shared/combat'
import type { OverlayKind, UpdateStatus } from '../shared/types'
import type { ShareApplyResult, SharePreview } from '../shared/profiles'

/** Reply of share:saveFile — the OS save dialog either wrote a file or was cancelled. */
export interface ShareSaveResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

export type { CharacterRef, EqConfig, EqConfigResult, LogLine, LootEvent, ProgressState }
export type { ModuleDelta, ModuleSnapshot }
export type { AlertDef, AlertPrefs, SoundData, SoundPack, SpellCatalog, ItemKnowledge }
export type { PackInstallProgress, PackMutationResult, PackPreviewList, RegistryListResult }
export type { UpdateStatus }
export type { ShareApplyResult, SharePreview }

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

  // ---- EQ install-dir discovery + override (Settings gear) ----
  /** Read the effective EQ config: install root, how it resolved, log count. */
  getEqConfig: (): Promise<EqConfig> => ipcRenderer.invoke(IPC.getEqConfig),
  /** Open the OS folder-picker; on a pick, persist the override + re-scan. */
  pickEqDir: (): Promise<EqConfigResult> => ipcRenderer.invoke(IPC.pickEqDir),
  /** Set the override to an explicit dir (undefined/'' reverts to auto-detect). */
  setEqDir: (dir: string | undefined): Promise<EqConfig> =>
    ipcRenderer.invoke(IPC.setEqDir, dir),
  /** Clear the override → revert to auto-discovery. Returns the re-resolved config. */
  resetEqDir: (): Promise<EqConfig> => ipcRenderer.invoke(IPC.resetEqDir),
  /** Subscribe to "effective EQ config changed" pushes (override applied/cleared). */
  onEqConfigChanged: (cb: (c: EqConfig) => void): (() => void) => {
    const listener = (_e: unknown, c: EqConfig): void => cb(c)
    ipcRenderer.on(IPC.onEqConfigChanged, listener)
    return () => ipcRenderer.removeListener(IPC.onEqConfigChanged, listener)
  },
  getProgress: (): Promise<ProgressState> => ipcRenderer.invoke(IPC.getProgress),
  reloadInventory: (): Promise<ReloadInventoryResult> => ipcRenderer.invoke(IPC.reloadInventory),
  setQuestComplete: (questKey: string, complete: boolean): Promise<ProgressState> =>
    ipcRenderer.invoke(IPC.setQuestComplete, questKey, complete),
  getCombatSnapshot: (opts: SnapshotOpts): Promise<CombatSnapshot> =>
    ipcRenderer.invoke(IPC.getCombatSnapshot, opts),
  /** Fuzzy-search the whole fight history + the live fight by name/zone (Task #61). An
   *  empty/whitespace query resolves to no hits (the UI shows its browse list instead). */
  searchFights: (text: string, limit?: number): Promise<FightSearchResult> =>
    ipcRenderer.invoke(IPC.searchFights, text, limit),

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
  /** Subscribe to "available sound packs changed" pushes (startup auto-provisioning). */
  onSoundPacksChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.onSoundPacksChanged, listener)
    return () => ipcRenderer.removeListener(IPC.onSoundPacksChanged, listener)
  },
  /** Suggested-alerts wizard (Task #38): the searchable spell catalog + live usage. */
  getSpellCatalog: (): Promise<SpellCatalog> => ipcRenderer.invoke(IPC.spellsCatalog),

  /** Item knowledge (Task #53): "what's this lore/quest item for" — local posky-first,
   *  then a cached, politely-throttled wiki lookup. Never rejects (degrades to a
   *  cached-negative/offline record that still carries local posky associations). */
  lookupItem: (name: string): Promise<ItemKnowledge> => ipcRenderer.invoke(IPC.itemsLookup, name),

  /** Report a renderer-detected event into the live event feed (Task #59) — today only quest
   *  completions, which only the renderer's posky/turn-in detector can see. Fire-and-forget;
   *  main owns the capped ring and pushes it on to the 'events' overlay. */
  reportFeedEvent: (report: FeedReport): void => ipcRenderer.send(IPC.feedReport, report),

  // ---- settings / alert sharing ("profiles" — src/shared/profiles.ts) ----
  // The renderer owns the localStorage half of a bundle, so it passes its whitelisted
  // pref map (`ui`) into every call and writes back whatever apply returns.
  /** Encode the GLOBAL settings bundle (whitelisted keys only) as one paste-safe line. */
  exportSettingsShare: (ui: Record<string, string>): Promise<string> =>
    ipcRenderer.invoke(IPC.shareExportSettings, ui),
  /** Encode one alert (`ids:[id]`) or every alert (`ids` omitted) as one paste-safe line. */
  exportAlertsShare: (ids?: string[]): Promise<string> =>
    ipcRenderer.invoke(IPC.shareExportAlerts, ids),
  /** Save an already-encoded share string to disk via the OS save dialog. */
  saveShareFile: (text: string, suggestedName: string): Promise<ShareSaveResult> =>
    ipcRenderer.invoke(IPC.shareSaveFile, text, suggestedName),
  /** Open a share file via the OS picker and preview it (null when the user cancels). */
  openShareFile: (ui: Record<string, string>): Promise<SharePreview | null> =>
    ipcRenderer.invoke(IPC.shareOpenFile, ui),
  /** Decode + plan a pasted string WITHOUT writing anything. Failures come back as prose. */
  previewShare: (text: string, ui: Record<string, string>): Promise<SharePreview> =>
    ipcRenderer.invoke(IPC.sharePreview, text, ui),
  /** Apply a previewed string additively; returns the localStorage writes to perform. */
  applyShare: (
    text: string,
    ui: Record<string, string>,
    selection?: { alertIds?: string[]; scalarIds?: string[] }
  ): Promise<ShareApplyResult> => ipcRenderer.invoke(IPC.shareApply, text, ui, selection),

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

  // ---- auto-update (Task #27; reworked in Task #55) ----
  /** Subscribe to update lifecycle pushes (checking/available/downloading/ready/error). */
  onUpdateStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: UpdateStatus): void => cb(s)
    ipcRenderer.on(IPC.onUpdateStatus, listener)
    return () => ipcRenderer.removeListener(IPC.onUpdateStatus, listener)
  },
  /** Pull the last update status (pushes only reach renderers mounted at the time). */
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.getUpdateStatus),
  /** Run an update check now; resolves to the resulting status (idle no-op in dev). */
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.checkForUpdates),
  /** Apply the downloaded update now (quit + install + relaunch). */
  installUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.installUpdate),
  /** The running app's version (app.getVersion()). */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.getAppVersion),

  // ---- floating overlay DPS meters (Task #52; per-kind in Task #54) ----
  /** Toggle a kind's overlay window; resolves to the resulting open-state. */
  toggleOverlay: (kind: OverlayKind): Promise<boolean> => ipcRenderer.invoke(IPC.overlayToggle, kind),
  /** Read the open-state map for all overlay kinds. */
  getOverlayState: (): Promise<Record<OverlayKind, boolean>> => ipcRenderer.invoke(IPC.overlayGetState),
  /** Subscribe to overlay open-state changes (so the TitleBar menu stays in sync). Payload {kind, open}. */
  onOverlayState: (cb: (s: { kind: OverlayKind; open: boolean }) => void): (() => void) => {
    const listener = (_e: unknown, s: { kind: OverlayKind; open: boolean }): void => cb(s)
    ipcRenderer.on(IPC.onOverlayState, listener)
    return () => ipcRenderer.removeListener(IPC.onOverlayState, listener)
  },

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
