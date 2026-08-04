import Store from 'electron-store'
import { join } from 'path'
import { STORE_NAME, USER_DATA } from './channel'
import { logError, logInfo } from './errorLog'
import { CURRENT_SCHEMA_VERSION, migrateStoreFile } from './storeMigrations'
import type {
  AlertDef,
  AlertPrefs,
  HeldCounts,
  OverlayConfig,
  OverlayKind,
  ProgressState,
  UpdateChannel,
  VoicePrefs
} from '../shared/types'
import { normalizeVoicePrefs } from '../shared/speechText'
import type { ComboCorrection } from '../shared/classCombo'
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
  /**
   * Schema version of THIS file (src/main/storeMigrations.ts). Absent ⇒ pre-framework ⇒ 1.
   * Every persisted-shape change bumps CURRENT_SCHEMA_VERSION and ships a migration in the
   * same commit — that is the whole contract behind "upgrades are clean, indefinitely".
   */
  schemaVersion?: number
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
  /**
   * Epoch millis of the last COMPLETED update check (Task #60). Persisted so the
   * left-nav "checked 2h ago" line is TRUTHFUL after a relaunch instead of
   * resetting to "never" — with a 4h cadence, an in-memory-only stamp would read
   * "never" for the first minute of every single launch.
   */
  updateLastCheckedAt?: number
  /**
   * RETIRED flat overlay config (Task #52). Task #54 made the overlay per-kind; schema
   * migration 1→2 folds this into `overlays.fight` and deletes it. Declared, never read —
   * the name stays reserved so nothing reuses it with different meaning.
   */
  overlay?: OverlayConfig
  /** per-kind floating overlay configs (Task #54): 'fight' + 'overall' windows. */
  overlays?: Partial<Record<OverlayKind, OverlayConfig>>
  /**
   * Voice alerts / TTS preferences (docs/plans/voice-alerts.md §2). Written by schema
   * migration 3→4, so a v4 store always has it; the reader still defaults, because a
   * downgrade-then-upgrade can leave any key in any state.
   */
  voice?: VoicePrefs
}

/**
 * SCHEMA MIGRATION, before anything reads the store — and before electron-store is even
 * constructed, so no reader can observe a pre-migration shape. Order of the world at this
 * point: channel.ts already chose `userData` and ran its one-time `eq-tools` seed (it is
 * store.ts's own first import), so whatever file we find here is the one this build will
 * use, whichever build wrote it. Never throws; see storeMigrations.ts for the failure policy.
 */
const schemaMigration = migrateStoreFile(join(USER_DATA, `${STORE_NAME}.json`), {
  info: (message) => logInfo(`[everquest-companion] ${message}`),
  error: (message) => logError('main:storeSchema', message)
})

const store = new Store<StoreShape>({
  // File name follows the product (Task #58): `<userData>/everquest-companion-progress.json`.
  // The pre-rename `eq-tools-progress.json` is copied+renamed into this channel's userData
  // on its first launch — see channel.ts `seedFromLegacy`.
  name: STORE_NAME,
  defaults: { byCharacter: {}, activeLogPath: undefined, windowBounds: undefined }
})

// Stamp a store that the migrator could not stamp itself: a fresh install (no file existed,
// so electron-store just created one from `defaults`) or a quarantined corrupt file. Gated on
// `to === CURRENT`, which is FALSE for a partial migration (a failed step must run again next
// launch) and for a store from a newer build (never version a downgrade backwards), and on
// there being no read error (a file we could not read is a file we must not describe).
if (schemaMigration.to === CURRENT_SCHEMA_VERSION && !schemaMigration.readError) {
  try {
    if (store.get('schemaVersion') !== CURRENT_SCHEMA_VERSION) {
      store.set('schemaVersion', CURRENT_SCHEMA_VERSION)
    }
  } catch (err) {
    logError('main:storeSchema', err)
  }
}

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

// ----- Class-combo user corrections (docs/plans/class-combo-inference.md § 7) -----
//
// The ONLY durable combo state. Intervals are re-derived from the log on every replay; a
// correction is the one thing the log can never tell us again.
//
// KEYED BY TIME, NEVER BY INTERVAL ID. A correction recomputes every interval from scratch
// (a `/who` row typed later re-labels the past), so ids are recompute-unstable by design and
// an id-keyed correction would detach from the span it corrected on the very next fold.

/** This character's corrections, oldest first. Defaults on a missing key (downgrade-safe). */
export function getComboCorrections(charId: string): ComboCorrection[] {
  const list = getProgress(charId).combo?.corrections
  return Array.isArray(list) ? [...list] : []
}

/** Replace the whole correction list for a character. Returns what was stored. */
function saveComboCorrections(charId: string, corrections: ComboCorrection[]): ComboCorrection[] {
  const next = [...corrections].sort((a, b) => a.startTs - b.startTs || a.setAt - b.setAt)
  setProgress(charId, { ...getProgress(charId), combo: { corrections: next } })
  return next
}

/**
 * Record a correction, REPLACING any existing one with the same span. Same-span replace (rather
 * than append) is what makes "correct it, then correct it again" behave the way the user means:
 * two statements about one interval are one statement, the later one.
 */
export function setComboCorrection(charId: string, correction: ComboCorrection): ComboCorrection[] {
  const same = (c: ComboCorrection): boolean =>
    c.startTs === correction.startTs && c.endTs === correction.endTs
  return saveComboCorrections(charId, [...getComboCorrections(charId).filter((c) => !same(c)), correction])
}

/**
 * Drop every correction OVERLAPPING [startTs, endTs] — the "Reset to detected" action.
 * Overlap, not exact match, because the interval the user is looking at may have been split or
 * merged since the correction was written (that is the whole reason corrections are time-keyed).
 */
export function clearComboCorrections(
  charId: string,
  startTs: number,
  endTs: number | null
): ComboCorrection[] {
  const hi = endTs ?? Infinity
  return saveComboCorrections(
    charId,
    getComboCorrections(charId).filter((c) => (c.endTs ?? Infinity) < startTs || c.startTs > hi)
  )
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
  return v?.trim() ? v : undefined
}

/** Set (or clear, with undefined/'') the manual EQ install-dir override. */
export function setEqInstallDir(dir: string | undefined): void {
  if (dir?.trim()) store.set('eqInstallDir', dir)
  else store.delete('eqInstallDir')
}

// ----- Floating overlay DPS meter (Task #52; per-kind in Task #54) -----

/** Per-kind defaults. Sizes/positions live in overlayLayout.ts; `bounds` stays undefined here so
 *  a first open is placed by that layout and every later open uses what the user left. */
const DEFAULT_OVERLAY_CONFIG: Record<OverlayKind, OverlayConfig> = {
  fight: { open: false, locked: false, bgAlpha: 0.72, topN: 5, bounds: undefined, drill: null },
  overall: { open: false, locked: false, bgAlpha: 0.72, topN: 5, bounds: undefined, drill: null },
  // 'events' (Task #59): topN is the feed's visible-row budget rather than a bar count.
  events: { open: false, locked: false, bgAlpha: 0.72, topN: 10, bounds: undefined, drill: null },
  // The HEALING pair (Task #59). Same knobs as the damage meters — a solo player usually has a
  // single healer row, so 5 is plenty and the interesting depth is one drill down.
  'heal-fight': { open: false, locked: false, bgAlpha: 0.72, topN: 5, bounds: undefined, drill: null },
  'heal-overall': { open: false, locked: false, bgAlpha: 0.72, topN: 5, bounds: undefined, drill: null }
}

/** Read a kind's overlay config, filling missing fields with the kind's defaults.
 *  The pre-Task-#54 flat `overlay` key used to be folded into `overlays.fight` HERE, on every
 *  read; that fold is now schema migration 1→2 (storeMigrations.ts), which runs once at
 *  startup — an ad-hoc fixup in a hot read path is exactly what the chain replaces. */
export function getOverlayConfig(kind: OverlayKind): OverlayConfig {
  const all = store.get('overlays') ?? {}
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

/**
 * Last completed update check (epoch millis), or undefined if we have never
 * completed one. Read once at updater init so "checked …" survives a relaunch —
 * including the relaunch our OWN apply-on-quit performs (Task #60).
 */
export function getUpdateLastCheckedAt(): number | undefined {
  const ts = store.get('updateLastCheckedAt')
  return typeof ts === 'number' && ts > 0 ? ts : undefined
}

/** Stamp a completed check. Called on every available/not-available/error verdict. */
export function setUpdateLastCheckedAt(ts: number): void {
  store.set('updateLastCheckedAt', ts)
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

/**
 * Replace the whole alert list. Used by the ADDITIVE share-import path (src/main/share.ts),
 * which computes the merged list — existing entries untouched at the head, imports appended
 * — and writes it in one shot rather than N saveAlert() round-trips. Returns the list.
 */
export function saveAlerts(list: AlertDef[]): AlertDef[] {
  store.set('alerts', list)
  return list
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
    muted: prefs.muted
  }
  store.set('alertPrefs', next)
  return next
}

// ----- Voice alerts / TTS preferences (docs/plans/voice-alerts.md §2) -----
//
// Speech obeys the alert master switches ABOVE, not instead of them: a muted alerts module
// speaks nothing, whatever `voice.enabled` says. This blob only answers "with what voice, how
// fast, how loud" — and, with `enabled:false` by default, "not at all until you ask".

/**
 * The stored voice prefs, defaulted + clamped field by field. `normalizeVoicePrefs` takes
 * `unknown` on purpose: this key can hold anything a hand edit, a downgrade or a future build
 * left behind, and every reader in this file defaults rather than trusts (the downgrade
 * contract in storeMigrations.ts).
 */
export function getVoicePrefs(): VoicePrefs {
  return normalizeVoicePrefs(store.get('voice'))
}

/** Persist voice prefs. Re-clamped through the SAME normalizer the read uses — a renderer
 *  string is a renderer string, and the two can never disagree about what is valid. */
export function setVoicePrefs(prefs: VoicePrefs): VoicePrefs {
  const next = normalizeVoicePrefs(prefs)
  store.set('voice', next)
  return next
}
