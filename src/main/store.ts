import Store from 'electron-store'
import { STORE_NAME } from './channel'
import type {
  AlertDef,
  AlertPrefs,
  HeldCounts,
  OverlayConfig,
  OverlayKind,
  ProgressState,
  UpdateChannel
} from '../shared/types'
import {
  ALERT_SOUND_MIGRATION_VERSION,
  DEFAULT_ALERT_PACK_ID,
  DEFAULT_ALERT_SOUNDS,
  migrateAlertSounds
} from './data/defaultPacks'

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
  /**
   * Version stamp of the retired-pack → shipped-pack alert sound migration
   * (Task #57). Absent ⇒ never migrated; see migrateStoredAlertSounds().
   */
  alertSoundMigration?: number
  /** auto-update release channel (Task #27): 'main' (bleeding edge) | 'stable' */
  updateChannel?: UpdateChannel
  /** floating overlay DPS meter config (Task #52) — LEGACY flat key, migrated into
   *  `overlays.fight` on first read (Task #54 made the overlay per-kind). */
  overlay?: OverlayConfig
  /** per-kind floating overlay configs (Task #54): 'fight' + 'overall' windows. */
  overlays?: Partial<Record<OverlayKind, OverlayConfig>>
}

const store = new Store<StoreShape>({
  // File name follows the product (Task #58): `<userData>/everquest-companion-progress.json`.
  // The pre-rename `eq-tools-progress.json` is copied+renamed into this channel's userData
  // on its first launch — see channel.ts `seedFromLegacy`.
  name: STORE_NAME,
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
    // "I find myself... requiring your attention." — the calm-but-pointed read lands
    // better than a joke sting for suddenly losing your charmed pet (Task #21).
    sound: { packId: DEFAULT_ALERT_PACK_ID, soundId: DEFAULT_ALERT_SOUNDS.charmBreak },
    note: 'Seeded default — fires when a charm spell wears off (you lose your pet).'
  },
  {
    id: 'boss-defeat',
    name: 'Raid target defeated',
    enabled: true,
    trigger: { type: 'app', signal: 'bossDefeat' },
    // "The matter is settled."
    sound: { packId: DEFAULT_ALERT_PACK_ID, soundId: DEFAULT_ALERT_SOUNDS.bossDefeat },
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
    // "It is done."
    sound: { packId: DEFAULT_ALERT_PACK_ID, soundId: DEFAULT_ALERT_SOUNDS.questComplete },
    note: 'Seeded default — fires the same moment a Sky quest turn-in celebration does.'
  }
]

/**
 * One-time migration (Task #57): alerts authored against a retired pack — the deleted
 * synthesized `default` pack, or the `peon`/`sc_marine`/`bastion` packs the app used to
 * provision — are re-pointed at the analogous Alan Rickman line (mapping +
 * rationale: src/main/data/defaultPacks.ts). Without it an upgrading user's alerts go
 * silently mute once those pack dirs are gone.
 *
 * Version-stamped and idempotent: it runs on the FIRST alert read after upgrading and
 * never again, so a user who reinstalls `peon` from the registry and re-points an alert
 * at it keeps that choice. Returns the (possibly rewritten) list.
 */
function migrateStoredAlertSounds(alerts: AlertDef[]): AlertDef[] {
  if ((store.get('alertSoundMigration') ?? 0) >= ALERT_SOUND_MIGRATION_VERSION) return alerts
  const { alerts: next, changed } = migrateAlertSounds(alerts)
  if (changed > 0) store.set('alerts', next)
  store.set('alertSoundMigration', ALERT_SOUND_MIGRATION_VERSION)
  return next
}

/**
 * Return the stored alert list, seeding the defaults exactly once (when the key is
 * absent — an empty [] the user emptied intentionally is respected). Existing lists
 * pass through the retired-pack sound migration on their first read after an upgrade.
 */
export function getAlerts(): AlertDef[] {
  const existing = store.get('alerts')
  if (existing === undefined) {
    store.set('alerts', SEED_ALERTS)
    // Seeds already reference the shipped pack; stamp so the migration never re-runs.
    store.set('alertSoundMigration', ALERT_SOUND_MIGRATION_VERSION)
    return SEED_ALERTS
  }
  return migrateStoredAlertSounds(existing)
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
