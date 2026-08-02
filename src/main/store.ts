import Store from 'electron-store'
import type {
  AlertDef,
  AlertPrefs,
  HeldCounts,
  OverlayConfig,
  OverlayKind,
  ProgressState,
  UpdateChannel
} from '../shared/types'

const emptyProgress: ProgressState = {
  inventory: {},
  completedQuests: [],
  inventorySource: undefined
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

interface StoreShape {
  /** progress keyed by character id (name_server) */
  byCharacter: Record<string, ProgressState>
  /** last selected character's log path */
  activeLogPath?: string
  /**
   * Manual EQ install-dir override (Settings gear). When set + non-empty it wins
   * over auto-discovery; cleared/undefined ⇒ the app auto-detects the install.
   * See src/main/log/config.ts `resolveEqDir`.
   */
  eqInstallDir?: string
  /** last window position + size */
  windowBounds?: WindowBounds
  /** alerts extension: the user's alert definitions (Task #18) */
  alerts?: AlertDef[]
  /** alerts extension: global sound preferences */
  alertPrefs?: AlertPrefs
  /** auto-update release channel (Task #27): 'main' (bleeding edge) | 'stable' */
  updateChannel?: UpdateChannel
  /** floating overlay DPS meter config (Task #52) — LEGACY flat key, migrated into
   *  `overlays.fight` on first read (Task #54 made the overlay per-kind). */
  overlay?: OverlayConfig
  /** per-kind floating overlay configs (Task #54): 'fight' + 'overall' windows. */
  overlays?: Partial<Record<OverlayKind, OverlayConfig>>
}

const store = new Store<StoreShape>({
  name: 'eq-tools-progress',
  defaults: { byCharacter: {}, activeLogPath: undefined, windowBounds: undefined }
})

export function getWindowBounds(): WindowBounds | undefined {
  return store.get('windowBounds')
}

export function setWindowBounds(b: WindowBounds): void {
  store.set('windowBounds', b)
}

function allProgress(): Record<string, ProgressState> {
  return store.get('byCharacter', {})
}

export function getProgress(charId: string): ProgressState {
  return allProgress()[charId] ?? emptyProgress
}

function setProgress(charId: string, next: ProgressState): ProgressState {
  const all = allProgress()
  all[charId] = next
  store.set('byCharacter', all)
  return next
}

export function setInventory(
  charId: string,
  counts: HeldCounts,
  source: { path: string; loadedAt: string }
): ProgressState {
  return setProgress(charId, { ...getProgress(charId), inventory: counts, inventorySource: source })
}

export function setQuestComplete(charId: string, questKey: string, complete: boolean): ProgressState {
  const p = getProgress(charId)
  const set = new Set(p.completedQuests)
  if (complete) set.add(questKey)
  else set.delete(questKey)
  return setProgress(charId, { ...p, completedQuests: [...set] })
}

export function getActiveLogPath(): string | undefined {
  return store.get('activeLogPath')
}

export function setActiveLogPath(logPath: string): void {
  store.set('activeLogPath', logPath)
}

// ----- EQ install-dir override (auto-discovery override) -----

/**
 * The manual EQ install-dir override, or undefined when unset (⇒ auto-detect).
 * An empty/whitespace string is treated as unset so "clear the field" reverts to
 * auto-discovery. Consumed by src/main/log/config.ts `resolveEqDir`.
 */
export function getEqInstallDir(): string | undefined {
  const v = store.get('eqInstallDir')
  return v && v.trim() ? v : undefined
}

/** Set (or clear, with undefined/'') the manual EQ install-dir override. */
export function setEqInstallDir(dir: string | undefined): void {
  if (dir && dir.trim()) store.set('eqInstallDir', dir)
  else store.delete('eqInstallDir')
}

// ----- Floating overlay DPS meter (Task #52; per-kind in Task #54) -----

/** Per-kind defaults: the 'overall' window starts a touch taller (it holds a zone selector). */
const DEFAULT_OVERLAY_CONFIG: Record<OverlayKind, OverlayConfig> = {
  fight: { open: false, locked: false, bgAlpha: 0.72, topN: 5, bounds: undefined, drill: null },
  overall: { open: false, locked: false, bgAlpha: 0.72, topN: 5, bounds: undefined, drill: null }
}

/** Read a kind's overlay config, filling missing fields with the kind's defaults. Migrates the
 *  legacy flat `overlay` key into `overlays.fight` once (Task #54). */
export function getOverlayConfig(kind: OverlayKind): OverlayConfig {
  const all = store.get('overlays') ?? {}
  // One-time migration: fold a pre-Task-#54 flat overlay config into the 'fight' slot.
  const legacy = store.get('overlay')
  if (legacy && !all.fight) {
    all.fight = legacy
    store.set('overlays', all)
    store.delete('overlay')
  }
  return { ...DEFAULT_OVERLAY_CONFIG[kind], ...(all[kind] ?? {}) }
}

/** Merge-patch a kind's overlay config (only the provided keys change). Returns the merged value. */
export function setOverlayConfig(kind: OverlayKind, patch: Partial<OverlayConfig>): OverlayConfig {
  const next: OverlayConfig = { ...getOverlayConfig(kind), ...patch }
  // Clamp the numeric fields defensively (the slider / topN come from the renderer).
  next.bgAlpha = Math.max(0, Math.min(1, next.bgAlpha))
  next.topN = next.topN >= 10 ? 10 : 5
  // The drill is remembered UI state from the overlay renderer — normalize anything malformed
  // (and `undefined`) down to level 1 so the stored shape stays exactly `{entityId} | null`.
  next.drill = next.drill && typeof next.drill.entityId === 'string' ? { entityId: next.drill.entityId } : null
  const all = store.get('overlays') ?? {}
  all[kind] = next
  store.set('overlays', all)
  return next
}

// ----- Auto-update channel (Task #27) -----

/**
 * Default channel: 'main' — the bleeding-edge stream CI publishes on every push.
 *
 * Task #55 removed channel SELECTION from the UI (there is no setter and no IPC any
 * more); this read stays so an install that picked 'stable' before keeps its feed.
 */
export function getUpdateChannel(): UpdateChannel {
  const c = store.get('updateChannel')
  return c === 'stable' ? 'stable' : 'main'
}

// ----- Alerts extension (Task #18) -----

const DEFAULT_ALERT_PREFS: AlertPrefs = { globalVolume: 0.7, muted: false }

/**
 * Alerts seeded once, the first time the alerts store is empty. Kept minimal and
 * self-documenting: a charm-break warning (live 'uncharm' event) and a boss-defeat
 * fanfare (renderer app signal). A future agent adds more via saveAlert().
 */
const SEED_ALERTS: AlertDef[] = [
  {
    id: 'charm-break',
    name: 'Charm break',
    enabled: true,
    trigger: { type: 'event', kind: 'uncharm' },
    // peon "Me not that kind of orc!" — urgent/indignant, good attention-grab for
    // suddenly losing your charmed pet (Task #21; imported CC-BY-NC-4.0 peon pack).
    sound: { packId: 'peon', soundId: 'error-notthatorc' },
    note: 'Seeded default — fires when a charm spell wears off (you lose your pet).'
  },
  {
    id: 'boss-defeat',
    name: 'Raid target defeated',
    enabled: true,
    trigger: { type: 'app', signal: 'bossDefeat' },
    sound: { packId: 'default', soundId: 'victory' },
    note: 'Seeded default — fires the same moment boss confetti does.'
  },
  {
    id: 'quest-complete',
    name: 'Sky quest complete',
    enabled: true,
    // Fires the same instant a Plane of Sky quest auto-completes from a detected
    // turn-in (giver received every required item) — the renderer's questComplete
    // app signal, fired exactly where the quest-complete confetti + snackbar do
    // (Task #46). Never fires on load/hydration or manual checkbox completion.
    trigger: { type: 'app', signal: 'questComplete' },
    sound: { packId: 'default', soundId: 'victory' },
    note: 'Seeded default — fires the same moment a Sky quest turn-in celebration does.'
  }
]

/**
 * Return the stored alert list, seeding the defaults exactly once (when the key is
 * absent — an empty [] the user emptied intentionally is respected).
 */
export function getAlerts(): AlertDef[] {
  const existing = store.get('alerts')
  if (existing === undefined) {
    store.set('alerts', SEED_ALERTS)
    return SEED_ALERTS
  }
  return existing
}

/** Upsert an alert by id (insert if new, replace in place otherwise). Returns the list. */
export function saveAlert(def: AlertDef): AlertDef[] {
  const list = getAlerts()
  const idx = list.findIndex((a) => a.id === def.id)
  const next = idx >= 0 ? list.map((a) => (a.id === def.id ? def : a)) : [...list, def]
  store.set('alerts', next)
  return next
}

/** Delete an alert by id. Returns the remaining list. */
export function deleteAlert(id: string): AlertDef[] {
  const next = getAlerts().filter((a) => a.id !== id)
  store.set('alerts', next)
  return next
}

/** Restore the seeded built-in alert set, discarding any user edits (Task #22). */
export function resetAlerts(): AlertDef[] {
  const next = SEED_ALERTS.map((a) => ({ ...a }))
  store.set('alerts', next)
  return next
}

export function getAlertPrefs(): AlertPrefs {
  return { ...DEFAULT_ALERT_PREFS, ...(store.get('alertPrefs') ?? {}) }
}

export function setAlertPrefs(prefs: AlertPrefs): AlertPrefs {
  const next: AlertPrefs = {
    globalVolume: Math.max(0, Math.min(1, prefs.globalVolume)),
    muted: !!prefs.muted
  }
  store.set('alertPrefs', next)
  return next
}
