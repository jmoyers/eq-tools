import Store from 'electron-store'
import type { AlertDef, AlertPrefs, HeldCounts, ProgressState, UpdateChannel } from '../shared/types'

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
  /** last window position + size */
  windowBounds?: WindowBounds
  /** alerts extension: the user's alert definitions (Task #18) */
  alerts?: AlertDef[]
  /** alerts extension: global sound preferences */
  alertPrefs?: AlertPrefs
  /** auto-update release channel (Task #27): 'main' (bleeding edge) | 'stable' */
  updateChannel?: UpdateChannel
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

// ----- Auto-update channel (Task #27) -----

/** Default channel: 'main' — the bleeding-edge stream CI publishes on every push. */
export function getUpdateChannel(): UpdateChannel {
  const c = store.get('updateChannel')
  return c === 'stable' ? 'stable' : 'main'
}

export function setUpdateChannel(channel: UpdateChannel): UpdateChannel {
  const next: UpdateChannel = channel === 'stable' ? 'stable' : 'main'
  store.set('updateChannel', next)
  return next
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
