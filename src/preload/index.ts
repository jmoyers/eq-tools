import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AlertDef,
  AlertPrefs,
  AppFocus,
  CharacterRef,
  EqConfig,
  EqConfigResult,
  FeedReport,
  ItemKnowledge,
  LogLine,
  LootEvent,
  MobKnowledge,
  ModuleDelta,
  ModuleSnapshot,
  PackInstallProgress,
  PackMutationResult,
  PackPreviewList,
  ProgressState,
  RegistryListResult,
  SoundData,
  SoundPack,
  SpeechEngine,
  SpeechInstallProgress,
  SpeechInstallResult,
  SpeechSayRequest,
  SpeechSayResult,
  SpeechVoice,
  SpellCatalog,
  VoicePrefs
} from '../shared/types'
import type { CombatSnapshot, FightSearchResult, SnapshotOpts } from '../shared/combat'
import type { ClassAbbr, ComboDelta, ComboSnap } from '../shared/classCombo'
import type {
  MapGetResult,
  MapPackListResult,
  MapPackPrefs,
  MapSearchHit,
  MapSearchOpts,
  ZoneShort
} from '../shared/maps'
import type { OverlayKind, UpdateStatus } from '../shared/types'
// Presence-driven prefs live beside their normalizers, not in shared/types.ts — see the note at
// the bottom of that file.
import type { CursorRingPrefs, OverlayAutoHidePrefs } from '../shared/presencePrefs'
import type { ShareApplyResult, SharePreview } from '../shared/profiles'
import type {
  FeedbackDraft,
  FeedbackEnv,
  LogSliceMeta,
  SubmitErrorCode
} from '../shared/feedback'
// Usage analytics (docs/plans/usage-analytics.md). The event union is a SHARED contract — the
// renderer builds values of it, main re-validates them at the handler, and wave A2's Lambda
// validates them again on arrival, all from one definition.
import type {
  TelemetryEvent,
  TelemetryPayloadView,
  TelemetryPrefs
} from '../shared/telemetry'
// Performance profiling (docs/plans/perf-profiling.md). Same arrangement as presencePrefs: the
// shapes live beside their pure helpers in shared/perf.ts, not in types.ts, because
// storeMigrations.ts must reach the prefs normalizer from module scope.
import type { PerfHudPrefs, PerfSample, StartupProfile } from '../shared/perf'
import { perfBridge } from './perf'
// The DEV-ONLY triage surface (see the banner above its methods, below). Types only — the
// contract lives in src/shared so main, preload and the renderer name one definition.
import type {
  TriageAnalytics,
  TriageDetail,
  TriageDigest,
  TriageListQuery,
  TriageOpsState,
  TriagePatch,
  TriageResult,
  TriageRow,
  TriageSlice
} from '../shared/triage'

/** Reply of share:saveFile — the OS save dialog either wrote a file or was cancelled. */
export interface ShareSaveResult {
  ok: boolean
  path?: string
  canceled?: boolean
  error?: string
}

// ---- in-app feedback (Task #65) ----
//
// The WIRE contract (draft, env, limits, validators) lives in `src/shared/feedback.ts` — one
// definition for renderer, main and the ingest Lambda. What follows is the BRIDGE's own reply
// shapes, which are renderer-facing only and therefore declared here, exactly like
// `ShareSaveResult` above: main's `src/main/feedback/index.ts` names the same shapes on its own
// side of the boundary, and neither tsconfig lets the renderer import that file.

/** Reply of feedback:context — everything the dialog needs to render its header + gate Send. */
export interface FeedbackContext {
  env: FeedbackEnv
  /** false when this build has no `FEEDBACK_API_URL` compiled in (every build before wave F2).
   *  The dialog SAYS so rather than letting Send fail — see docs/plans/feedback-triage.md §6.2. */
  endpointConfigured: boolean
  /** Reports waiting in the offline queue. */
  queued: number
  /** Is there a character log to slice at all? */
  logAvailable: boolean
}

/**
 * Reply of feedback:buildSlice — the metadata plus a CAPPED preview. The gz BYTES never cross
 * IPC (§5.4): at most `PREVIEW_MAX_LINES` lines of text do, and `truncatedPreview` says when
 * that is less than the whole slice, which is what "Save a copy…" exists for.
 */
export type FeedbackSlicePreview = LogSliceMeta & {
  previewLines: string[]
  truncatedPreview: boolean
  /** The window ACTUALLY used, after any fit-driven halving — not necessarily the one asked for. */
  windowMinutes: number
}

/** Reply of feedback:submit. NEVER a rejection: a network failure resolves with `queued:true`. */
export type SubmitResult =
  | { ok: true; reportId: string; logUploaded: boolean }
  | {
      ok: false
      error: SubmitErrorCode
      message: string
      queued: boolean
      /** Set for `invalid_payload` so the dialog can focus the offending input. */
      field?: string
      /** Set for `quota_exceeded` — seconds until the daily counter rolls over. */
      retryAfterSec?: number
    }

/** Args of feedback:submit's second parameter — re-validated at the handler. */
export interface SubmitOpts {
  attachLog: boolean
  windowMinutes: number
}

export type { CharacterRef, EqConfig, EqConfigResult, LogLine, LootEvent, ProgressState }
export type { ModuleDelta, ModuleSnapshot }
export type { AlertDef, AlertPrefs, SoundData, SoundPack, SpellCatalog, ItemKnowledge, MobKnowledge }
export type {
  SpeechEngine,
  SpeechInstallProgress,
  SpeechInstallResult,
  SpeechSayRequest,
  SpeechSayResult,
  SpeechVoice,
  VoicePrefs
}
export type { PackInstallProgress, PackMutationResult, PackPreviewList, RegistryListResult }
export type { AppFocus, UpdateStatus }
export type { CursorRingPrefs, OverlayAutoHidePrefs }
export type { ShareApplyResult, SharePreview }
export type { FeedbackDraft, FeedbackEnv, LogSliceMeta, SubmitErrorCode }
export type { TelemetryEvent, TelemetryPayloadView, TelemetryPrefs }
export type { PerfHudPrefs, PerfSample, StartupProfile }
// Dev-only triage (above): re-exported for the same reason every other payload shape is — a
// renderer view names them without reaching across the tsconfig boundary into src/shared.
export type {
  TriageAnalytics,
  TriageDetail,
  TriageDigest,
  TriageListQuery,
  TriageOpsState,
  TriagePatch,
  TriageResult,
  TriageRow,
  TriageSlice
}
// The combo module rides the generic transport, so the renderer never names these on an API
// method — re-exported here for the same reason every other module payload is: so a view can
// say `useModule<ComboSnap, ComboDelta>('combo', …)` without reaching across the tsconfig
// boundary into src/shared itself.
export type { ClassAbbr, ComboDelta, ComboSnap }

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

/** A combo interval's time span. `endTs: null` = the open (current) interval. */
export interface ComboRange {
  startTs: number
  endTs: number | null
}

/** What the user says the loadout was over `[startTs, endTs]`. Re-validated in main. */
export interface ComboCorrectionInput extends ComboRange {
  classes: ClassAbbr[]
}

/** Both correction writes answer the same way; `error` is prose for the UI, never a code. */
export interface ComboWriteResult {
  ok: boolean
  error?: string
}

/** Payload the renderer sends over `error:report` (fire-and-forget). */
export interface RendererErrorReport {
  message: string
  stack?: string
  source: string
}

const api = {
  // The performance HUD's five methods (./perf.ts). Spread rather than inlined for file size
  // alone; on `window.eq` they are indistinguishable from every method written out below.
  ...perfBridge,

  /**
   * Is this the headless integration-test channel (`EQ_E2E=1`, src/main/e2e.ts)?
   *
   * A STATIC boolean, not a channel: the env var is decided before the process starts and can
   * never change, so an IPC round-trip would buy nothing and every consumer would have to be
   * async. The renderer has no `process` (nodeIntegration is off) — this is its only door to
   * the flag, and it exists because some renderer behavior is genuinely too intrusive for a
   * test that runs BESIDE the user's game: `lib/speech.ts` must not speak out loud during
   * `npm run test:e2e`. Read-only, and never a trust decision (main enforces its own e2e
   * behavior in main).
   */
  isE2E: process.env.EQ_E2E === '1',

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

  // ---- voice alerts / TTS (docs/plans/voice-alerts.md §3) ----
  // The 'system' tier needs NOTHING here: Chromium's `speechSynthesis` is already in the
  // renderer, so the free tier speaks without crossing this boundary at all. The three engine
  // calls below serve the DOWNLOADED (Kokoro) tier, whose model and wav cache live in main —
  // and every failure answers with a STATE ('engine-not-installed' / 'not-implemented' /
  // 'disabled') rather than throwing — which is what lets the renderer degrade any {ok:false}
  // to the system voice instead of going silent.
  /** Synthesize + cache one utterance; resolves to a playable url once an engine exists.
   *  Both fields are re-validated at the handler (they reach a cache key and a file name). */
  speechSay: (request: SpeechSayRequest): Promise<SpeechSayResult> =>
    ipcRenderer.invoke(IPC.speechSay, request),
  /** Voices the DOWNLOADED tier can speak with — empty until it is installed. System-tier
   *  voices come from the renderer's own `speechSynthesis.getVoices()`, never from here. */
  speechVoices: (): Promise<SpeechVoice[]> => ipcRenderer.invoke(IPC.speechVoices),
  /** Provision an engine tier (pinned release, sha256-verified, atomic, resumable). Resolves
   *  only when the ~120 MB download has FINISHED — subscribe below to render it meanwhile. */
  speechInstall: (engine: SpeechEngine): Promise<SpeechInstallResult> =>
    ipcRenderer.invoke(IPC.speechInstall, engine),
  /** Bytes `speechInstall` would download for a tier (0 for one that downloads nothing). Read
   *  from main's pinned asset table so the UI states the real price, never a copied number. */
  speechInstallSize: (engine: SpeechEngine): Promise<number> =>
    ipcRenderer.invoke(IPC.speechInstallSize, engine),
  /** Subscribe to install progress while `speechInstall` is outstanding. The terminal
   *  'done'/'failed' phase always matches the verdict that invoke resolves with. */
  onSpeechInstallProgress: (cb: (progress: SpeechInstallProgress) => void): (() => void) => {
    const listener = (_e: unknown, progress: SpeechInstallProgress): void => cb(progress)
    ipcRenderer.on(IPC.onSpeechInstallProgress, listener)
    return () => ipcRenderer.removeListener(IPC.onSpeechInstallProgress, listener)
  },
  /** Read the global voice prefs blob. REAL from day one — the store is main-owned. */
  getVoicePrefs: (): Promise<VoicePrefs> => ipcRenderer.invoke(IPC.voicePrefsGet),
  /** Persist the global voice prefs; resolves to what was actually stored (every field is
   *  re-clamped at the handler, so the reply may differ from what was sent). */
  setVoicePrefs: (prefs: VoicePrefs): Promise<VoicePrefs> =>
    ipcRenderer.invoke(IPC.voicePrefsSet, prefs),

  /** Item knowledge (Task #53): "what's this lore/quest item for" — local posky-first,
   *  then a cached, politely-throttled wiki lookup. Never rejects (degrades to a
   *  cached-negative/offline record that still carries local posky associations). */
  lookupItem: (name: string): Promise<ItemKnowledge> => ipcRenderer.invoke(IPC.itemsLookup, name),

  /** Mob knowledge (Task #63): "what does this thing drop" — your own loot history + the local
   *  quest catalog first, then a cached, politely-throttled wiki lookup. Never rejects. */
  lookupMob: (name: string): Promise<MobKnowledge> => ipcRenderer.invoke(IPC.mobsLookup, name),

  /** Report a renderer-detected event into the live event feed (Task #59) — today only quest
   *  completions, which only the renderer's posky/turn-in detector can see. Fire-and-forget;
   *  main owns the capped ring and pushes it on to the 'events' overlay. */
  reportFeedEvent: (report: FeedReport): void => ipcRenderer.send(IPC.feedReport, report),

  // ---- map viewer (docs/plans/map-viewer.md §4.3) ----
  // Main reads and parses `<eqRoot>\maps`; the renderer never sees a path. `zone` is a map-file
  // STEM ('airplane'), not the log's long name — fold that through `shared/zones.ts` first.
  /** The installed map packs. Empty list + `error` prose on a machine with no EQ maps dir. */
  listMapPacks: (): Promise<MapPackListResult> => ipcRenderer.invoke(IPC.mapsListPacks),
  /** Zone stems, ascending — across every pack, or within one when `packId` is given. */
  listMapZones: (packId?: string): Promise<ZoneShort[]> =>
    ipcRenderer.invoke(IPC.mapsListZones, packId),
  /** One zone's parsed map. `prefs` picks the pack PER LAYER (geometry and labels routinely
   *  come from different packs); what was actually used comes back in `data.sources`. */
  getMapData: (zone: string, prefs?: MapPackPrefs): Promise<MapGetResult> =>
    ipcRenderer.invoke(IPC.mapsGet, zone, prefs),
  /** Fuzzy label search: one zone (`opts.zone`) or the whole corpus. Same scorer as every
   *  other search box in the app (`shared/fuzzy.ts`). Empty query resolves to no hits.
   *  Pass the viewer's `opts.prefs` for an in-zone search so the hits rank over the SAME pack
   *  resolution `getMapData` drew; the corpus index is default-prefs by construction. */
  searchMapPoints: (q: string, opts?: MapSearchOpts): Promise<MapSearchHit[]> =>
    ipcRenderer.invoke(IPC.mapsSearch, q, opts),

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

  // ---- class-combo corrections (docs/plans/class-combo-inference.md § 5.3) ----
  // The combo READ path is the generic transport above — `useModule<ComboSnap, ComboDelta>`.
  // These two are the writes, and they are keyed by TIME because interval ids are
  // recompute-unstable: a correction has to survive the very recompute it triggers.
  /** "That span was these classes." 1–3 classes; every field re-validated in main. */
  setComboCorrection: (correction: ComboCorrectionInput): Promise<ComboWriteResult> =>
    ipcRenderer.invoke(IPC.comboSetCorrection, correction),
  /** "Reset to detected" — drop every correction overlapping this span. */
  clearComboCorrection: (range: ComboRange): Promise<ComboWriteResult> =>
    ipcRenderer.invoke(IPC.comboClearCorrection, range),

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
  /**
   * Deep link from another window (Task #64): an overlay row was clicked and main has already
   * raised + focused this window. App.tsx switches to the named view and hands the target down
   * (today: the mob to open). Main validates the `view` before forwarding.
   */
  onFocusView: (cb: (focus: AppFocus) => void): (() => void) => {
    const listener = (_e: unknown, focus: AppFocus): void => cb(focus)
    ipcRenderer.on(IPC.onFocusView, listener)
    return () => ipcRenderer.removeListener(IPC.onFocusView, listener)
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

  // ---- cursor ring + overlay auto-hide (presence-driven settings) ----
  // Both are main-owned store blobs, so Preferences has no other door. The setters take a
  // PARTIAL patch (each panel owns one field and must not clobber its siblings by
  // round-tripping a stale copy) and resolve to what was ACTUALLY stored — every field is
  // re-clamped at the handler, so a slider that asks for more than the cap visibly lands on it.
  /** The cursor-ring prefs: enabled + size + stroke width. */
  getCursorRing: (): Promise<CursorRingPrefs> => ipcRenderer.invoke(IPC.cursorRingGet),
  /** Merge-patch the cursor-ring prefs; the ring appears/resizes live. */
  setCursorRing: (patch: Partial<CursorRingPrefs>): Promise<CursorRingPrefs> =>
    ipcRenderer.invoke(IPC.cursorRingSet, patch),
  /** The overlay auto-hide prefs: hide when EQ isn't running / isn't focused. */
  getOverlayAutoHide: (): Promise<OverlayAutoHidePrefs> =>
    ipcRenderer.invoke(IPC.overlayAutoHideGet),
  /** Merge-patch the overlay auto-hide prefs; applies to the live overlays immediately. */
  setOverlayAutoHide: (patch: Partial<OverlayAutoHidePrefs>): Promise<OverlayAutoHidePrefs> =>
    ipcRenderer.invoke(IPC.overlayAutoHideSet, patch),

  // ---- clipboard ----
  /**
   * Put plain text on the OS clipboard; resolves to whether it was written.
   *
   * The renderer's own `navigator.clipboard.writeText` CANNOT do this here: it is gated on
   * Chromium's 'clipboard-sanitized-write' permission and this app denies every web permission
   * wholesale, so it rejects with `NotAllowedError: Write permission denied.` in every window.
   * Main's `clipboard` module is not a web API and needs no permission — see ipc/clipboard.ts,
   * which also validates the text (non-empty string, length cap).
   */
  writeClipboard: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.clipboardWrite, text),

  // ---- in-app feedback (Task #65; docs/plans/feedback-triage.md §4.3) ----
  // All four are PULLS — the dialog asks when it opens. There is deliberately no push channel:
  // a "queue changed" broadcast would be new surface for no benefit, since the only reader is a
  // dialog that has to re-open to show it anyway.
  /** The dialog's header context: versions, channel, queued count, and whether this build has
   *  an ingest endpoint compiled in at all (it does not, until wave F2 deploys). */
  getFeedbackContext: (): Promise<FeedbackContext> => ipcRenderer.invoke(IPC.feedbackContext),
  /** Build the scrubbed slice for a window (minutes) and return the counts + a CAPPED preview.
   *  `null` when no character log resolves or the window holds nothing. The gz bytes stay in
   *  main; only `PREVIEW_MAX_LINES` lines of text cross. `windowMinutes` is re-validated at the
   *  handler against LOG_WINDOW_CHOICES — never trusted because today's only caller is our UI. */
  buildFeedbackSlice: (windowMinutes: number): Promise<FeedbackSlicePreview | null> =>
    ipcRenderer.invoke(IPC.feedbackBuildSlice, windowMinutes),
  /** Write the COMPLETE slice to a user-chosen path via the OS save dialog — the escape hatch
   *  that makes "you can see exactly what is sent" literally true, not a claim about a preview. */
  saveFeedbackSlice: (windowMinutes: number): Promise<ShareSaveResult> =>
    ipcRenderer.invoke(IPC.feedbackSaveSlice, windowMinutes),
  /** Submit. NEVER rejects: a network failure resolves `{ok:false, queued:true}` and the report
   *  is retried later; a 4xx resolves `{ok:false, queued:false}` and is not retried. */
  submitFeedback: (draft: FeedbackDraft, opts: SubmitOpts): Promise<SubmitResult> =>
    ipcRenderer.invoke(IPC.feedbackSubmit, draft, opts),

  // ---- usage analytics (docs/plans/usage-analytics.md wave A1) ---------------------------
  //
  // THIS BUILD SENDS NOTHING. `TELEMETRY_API_URL` is '' and there is no fetch anywhere under
  // `src/main/telemetry/`, so every method below is local: the ring on disk, the prefs in the
  // settings store, and a viewer that shows you both.
  /**
   * Record one usage event. FIRE-AND-FORGET by design — nothing the user does may ever wait on
   * a counter, and nothing they do may ever fail because of one.
   *
   * The value is validated TWICE with the same shared function: here, so a mistake is caught
   * where it was made, and again in main at the handler, because the renderer is untrusted.
   * The event union has no free-text field, so this call cannot carry a name, a zone or a line
   * of log even by accident.
   */
  track: (event: TelemetryEvent): void => {
    try {
      ipcRenderer.send(IPC.telemetryTrack, event)
    } catch {
      // Analytics is the one feature that must never make noise when it fails.
    }
  },
  /** The persisted prefs: master switch, whether the first-run notice has been shown, and the
   *  rotatable anonymous id (null until the collector mints one). */
  getTelemetryPrefs: (): Promise<TelemetryPrefs> => ipcRenderer.invoke(IPC.telemetryPrefsGet),
  /** Flip the master switch. Turning it OFF drops the local buffer immediately. */
  setTelemetryEnabled: (enabled: boolean): Promise<TelemetryPrefs> =>
    ipcRenderer.invoke(IPC.telemetrySetEnabled, enabled),
  /** The first-run notice was answered — or dismissed, which KEEPS it on (that is what opt-out
   *  means). Either way `noticeShown` flips, so the modal is a once-ever event. */
  telemetryNoticeShown: (keepEnabled: boolean): Promise<TelemetryPrefs> =>
    ipcRenderer.invoke(IPC.telemetryNoticeShown, keepEnabled),
  /** New anonymous id + an emptied buffer. Severs the retention chain on purpose. */
  rotateAnalyticsId: (): Promise<TelemetryPrefs> => ipcRenderer.invoke(IPC.telemetryRotate),
  /** Everything the payload viewer shows: prefs, whether this build has an endpoint at all,
   *  the live buffer, and the last batch sent (permanently null while the build is dark). */
  getTelemetryPayload: (): Promise<TelemetryPayloadView> =>
    ipcRenderer.invoke(IPC.telemetryPayload),

  // ---- performance HUD + startup profile (docs/plans/perf-profiling.md) -------------------
  // Its five methods live in ./perf.ts and are spread in below — this file is at the 400-line
  // factoring ceiling, and a split is the answer to that rather than a widened threshold.

  // ---- feedback TRIAGE (DEV BUILDS ONLY — src/main/triage/**) ----------------------------
  //
  // ============================ THESE METHODS ARE DEV-ONLY. ==============================
  //
  // The handlers behind them are registered from `src/main/index.ts` ONLY when
  // `!app.isPackaged && !E2E`, via a dynamic import of a module that reaches `pg` and
  // `@aws-sdk/*` — devDependencies, which electron-builder never packages. In a shipped build
  // there are no handlers, so every one of these REJECTS with Electron's own
  // "No handler registered for 'triage:…'". That is the designed outcome, not a bug: the
  // bridge is a door, and in a packaged app there is nothing on the other side of it.
  //
  // The renderer half of this feature is compiled out entirely by the `__EQ_DEV_TOOLS__`
  // define (electron.vite.config.ts), so in practice nothing in a shipped build ever calls
  // them either. Two independent mechanisms, deliberately.
  //
  // Everything here reads the OWNER'S feedback backlog with the launching shell's AWS
  // credentials. Possession of those credentials is the access control.
  /** The filtered backlog. Every field of the query is re-validated at the handler. */
  triageList: (query: TriageListQuery): Promise<TriageResult<TriageRow[]>> =>
    ipcRenderer.invoke(IPC.triageList, query),
  /** One full record, incl. the contact and the S3-resolved `present`/`missing` log state. */
  triageDetail: (reportId: string): Promise<TriageResult<TriageDetail | null>> =>
    ipcRenderer.invoke(IPC.triageDetail, reportId),
  /** A report's log slice as CAPPED text. The gz bytes stay in main and on disk; the lines
   *  are rendered in a local window and go nowhere else (§10.3 — THE LAW). */
  triageSlice: (reportId: string): Promise<TriageResult<TriageSlice | null>> =>
    ipcRenderer.invoke(IPC.triageSlice, reportId),
  /** status / severity / cluster / dupe-of / note. `issueUrl` is not writable from here. */
  triagePatch: (reportId: string, patch: TriagePatch): Promise<TriageResult<void>> =>
    ipcRenderer.invoke(IPC.triagePatch, reportId, patch),
  /** §3.5 forget: delete the slice object and stamp the redaction, keep the report itself. */
  triageForget: (reportId: string): Promise<TriageResult<void>> =>
    ipcRenderer.invoke(IPC.triageForget, reportId),
  /** The kill switch + the block list. */
  triageOps: (): Promise<TriageResult<TriageOpsState>> => ipcRenderer.invoke(IPC.triageOps),
  /** Set the kill switch. POSITIVE polarity: `false` is what the CLI spells `closed on`. */
  triageSetAccepting: (accepting: boolean, message?: string): Promise<TriageResult<void>> =>
    ipcRenderer.invoke(IPC.triageSetAccepting, accepting, message),
  /** Block / unblock one install id. A block requires a reason; the profile records why. */
  triageSetBlocked: (
    installId: string,
    blocked: boolean,
    reason?: string
  ): Promise<TriageResult<void>> =>
    ipcRenderer.invoke(IPC.triageSetBlocked, installId, blocked, reason),
  /** The same markdown digest `triage-feedback digest` prints, plus its clusters. */
  triageDigest: (query: TriageListQuery): Promise<TriageResult<TriageDigest>> =>
    ipcRenderer.invoke(IPC.triageDigest, query),
  /** Usage analytics over the last `days` (one of TRIAGE_ANALYTICS_DAYS; omitted = the
   *  default window). `available:false` now means one thing only: the tables are not on the
   *  cluster. Tables that exist and are empty come back as honest zeros. */
  triageAnalytics: (days?: number): Promise<TriageResult<TriageAnalytics>> =>
    ipcRenderer.invoke(IPC.triageAnalytics, days),

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
