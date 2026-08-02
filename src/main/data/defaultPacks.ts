// defaultPacks.ts — the ONE voice pack the app ships with, defined once and shared by:
//   - scripts/fetch-packs.mts (dev: writes it into resources/soundpacks/ for a source
//     build), and
//   - src/main/provisionPacks.ts (runtime: silently installs it into
//     <userData>/soundpacks/ on startup when missing, so a CI-built installer — which
//     ships WITHOUT the gitignored audio — still has the sounds the seeded alerts need).
//
// WHY ONE PACK: the app used to self-provision the PeonPing og-packs `peon` +
// `sc_marine` packs and seed alerts against a synthesized `default` chime pack. Those
// read as robotic/joke defaults; the shipped default is now Alan Rickman — spoken-word
// lines that fit EverQuest's tone. The synthesized `default` pack is GONE (its
// generator + assets were deleted, Task #57); `peon`/`sc_marine` were never ours —
// they're still in the openpeon registry and installable from the in-app Sound Packs
// browser. Provisioning only ADDS what's missing and never removes a pack on disk.
//
// STABLE SOUND IDS: the pack is pinned to a release TAG, so its openpeon.json is
// immutable and the ids the shared CESP→manifest conversion derives (deriveSoundId:
// "<category-slug>-<file-slug>") are deterministic and identical whether the pack
// arrives via self-provisioning, `npm run fetch:packs`, or a user-initiated registry
// install. DEFAULT_ALERT_SOUNDS below are those derived ids; provisionPacks verifies
// they resolved after an install, so drift is caught in errors.log rather than silently
// muting an alert.

import type { AlertDef, AlertSoundRef, RegistryPack } from '../../shared/types'

/** The default pack's id (== registry name == install dir == manifest id). */
export const DEFAULT_ALERT_PACK_ID = 'alan-rickman'

/**
 * The registry entry we provision from, inlined so first run needs ZERO registry
 * requests (one tarball GET, at a pinned tag). Field-for-field the same shape the
 * openpeon index serves, so provisioning reuses the tested installPack path and
 * produces a byte-identical install to clicking "Install" in the Sound Packs dialog.
 */
export const DEFAULT_PACK: RegistryPack = {
  name: DEFAULT_ALERT_PACK_ID,
  display_name: 'Alan Rickman',
  source_repo: 'utensils/openpeon-alan-rickman-soundpack',
  source_ref: 'v1.1.2',
  source_path: '.',
  categories: [
    'input.required',
    'resource.limit',
    'session.start',
    'task.acknowledge',
    'task.complete',
    'task.error'
  ],
  sound_count: 60,
  total_size_bytes: 1964096,
  description:
    'Claudette notification sounds, voiced in the manner of the late Alan Rickman. Slow. Deliberate. Faintly amused.',
  license: 'CC-BY-4.0',
  version: '1.1.2'
}

/**
 * Sound ids the shipped alert defs reference (derived, see header). Split out so the
 * seeded alerts (src/main/store.ts) and the suggested-alert templates
 * (src/renderer/src/features/alerts/suggestions.ts — renderer, so it repeats the
 * literals) name the same lines, and so provisionPacks can verify them post-install.
 */
export const DEFAULT_ALERT_SOUNDS = {
  /** "I find myself... requiring your attention." — charm broke, you've lost your pet. */
  charmBreak: 'input-required-input-required-02',
  /** "The matter is settled." — raid target down. */
  bossDefeat: 'task-complete-task-complete-07',
  /** "It is done." — a Sky quest turn-in completed. */
  questComplete: 'task-complete-task-complete-01',
  /** "A moment of your time, if you'd be so kind." — a buff wore off you/your pet. */
  buffWearsOff: 'input-required-input-required-01',
  /** "That, as they say, is that." — a buff faded on your pet/target. */
  buffFade: 'resource-limit-resource-limit-09',
  /** "Consider this my opening move." — a debuff landed on a target. */
  debuffLands: 'task-acknowledge-task-acknowledge-05',
  /** "It has all gone rather pear-shaped." — your illusion dropped. */
  illusionFade: 'task-error-task-error-08'
} as const

/** Every sound id the shipped defaults depend on (verified after provisioning). */
export const REQUIRED_SOUND_IDS: string[] = [...new Set(Object.values(DEFAULT_ALERT_SOUNDS))]

/** The packs the app provisions on startup if missing (one, today). */
export const DEFAULT_PACKS: RegistryPack[] = [DEFAULT_PACK]

/** The pack ids the app ships with (and provisions on startup if missing). */
export const DEFAULT_PACK_IDS: string[] = DEFAULT_PACKS.map((p) => p.name)

// ---- Retired-pack → Alan Rickman alert migration (Task #57) --------------------
//
// Alerts persist a `{packId, soundId}` pair, so alerts authored before the default
// changed still point at packs the app no longer ships (`default`, which no longer
// EXISTS anywhere, plus the `peon` / `sc_marine` / `bastion` packs the app used to
// provision or that a user tried out). store.ts runs the rewrite below exactly once per
// install (version-stamped) so an upgrading user's existing alerts land on the shipped
// pack instead of silently going mute when the old dir is gone.
//
// The rewrite is pack-wide and one-way: any ref into a legacy pack becomes an
// alan-rickman ref. Those packs stay installable from the in-app registry browser — a
// user who reinstalls one can re-point any alert at it, and this migration never runs
// again to undo that.

/** Packs whose alert refs the one-time migration rewrites onto the shipped default. */
export const LEGACY_ALERT_PACK_IDS: string[] = ['default', 'peon', 'sc_marine', 'bastion']

/** Bumped when the mapping below changes in a way that should re-run for every user. */
export const ALERT_SOUND_MIGRATION_VERSION = 1

/**
 * CESP category → the Alan Rickman line a legacy sound in that category becomes.
 * Registry-derived ids are `<category-slug>-<file-slug>` (bastion: `task-complete-3`),
 * so the category is recoverable from the id itself and the replacement keeps the
 * alert's INTENT (a "complete" sting stays a completion line).
 */
const LEGACY_CATEGORY_SOUND: Record<string, string> = {
  'session-start': 'session-start-session-start-01', // "At your service."
  'session-end': DEFAULT_ALERT_SOUNDS.questComplete, // "It is done."
  'task-acknowledge': DEFAULT_ALERT_SOUNDS.debuffLands,
  'task-progress': DEFAULT_ALERT_SOUNDS.debuffLands,
  'task-complete': DEFAULT_ALERT_SOUNDS.bossDefeat,
  'task-error': DEFAULT_ALERT_SOUNDS.illusionFade,
  'input-required': DEFAULT_ALERT_SOUNDS.buffWearsOff,
  'resource-limit': DEFAULT_ALERT_SOUNDS.buffFade,
  'user-spam': 'input-required-input-required-10'
}

/**
 * The four ids of the deleted synthesized `default` pack, mapped by the ROLE each one
 * played in the old seeded/suggested alerts (they carried no category prefix at all):
 * the victory fanfare fired on a kill, the two-tone warning was the charm break.
 */
const LEGACY_DEFAULT_PACK_SOUND: Record<string, string> = {
  victory: DEFAULT_ALERT_SOUNDS.bossDefeat,
  warning: DEFAULT_ALERT_SOUNDS.charmBreak,
  chime: DEFAULT_ALERT_SOUNDS.buffWearsOff,
  horn: DEFAULT_ALERT_SOUNDS.buffFade
}

/** Curated `peon` / `sc_marine` id prefixes → CESP category. */
const LEGACY_PREFIX_CATEGORY: Array<[string, string]> = [
  ['session-start-', 'session-start'],
  ['session-end-', 'session-end'],
  ['task-acknowledge-', 'task-acknowledge'],
  ['task-progress-', 'task-progress'],
  ['task-complete-', 'task-complete'],
  ['task-error-', 'task-error'],
  ['input-required-', 'input-required'],
  ['resource-limit-', 'resource-limit'],
  ['user-spam-', 'user-spam'],
  ['start-', 'session-start'],
  ['ack-', 'task-acknowledge'],
  ['complete-', 'task-complete'],
  ['error-', 'task-error'],
  ['input-', 'input-required'],
  ['limit-', 'resource-limit'],
  ['spam-', 'user-spam']
]

/** Legacy ids with no prefix at all (peon's two session.start lines). */
const LEGACY_EXACT_CATEGORY: Record<string, string> = {
  ready: 'session-start',
  'need-doing': 'session-start'
}

/** Recover the CESP category a legacy soundId belonged to, or null if unrecognizable. */
function legacyCategory(soundId: string): string | null {
  const id = soundId.toLowerCase()
  if (LEGACY_EXACT_CATEGORY[id]) return LEGACY_EXACT_CATEGORY[id]
  for (const [prefix, category] of LEGACY_PREFIX_CATEGORY) {
    if (id.startsWith(prefix)) return category
  }
  return null
}

/**
 * Rewrite one alert sound ref onto the shipped pack when it points at a retired pack.
 * Refs already on `alan-rickman` (or on any other user-installed pack) are returned
 * unchanged — this only touches the ids in LEGACY_ALERT_PACK_IDS. An unrecognizable
 * legacy id falls back to the "needs your attention" line rather than staying mute.
 */
export function migrateAlertSoundRef(sound: AlertSoundRef): AlertSoundRef {
  if (!LEGACY_ALERT_PACK_IDS.includes(sound.packId)) return sound
  const byRole = LEGACY_DEFAULT_PACK_SOUND[sound.soundId.toLowerCase()]
  const category = legacyCategory(sound.soundId)
  const soundId =
    byRole ??
    (category ? LEGACY_CATEGORY_SOUND[category] : undefined) ??
    DEFAULT_ALERT_SOUNDS.buffWearsOff
  return { packId: DEFAULT_ALERT_PACK_ID, soundId }
}

/**
 * Apply migrateAlertSoundRef across an alert list. Returns the (possibly new) list plus
 * how many defs changed, so the caller can skip the store write when nothing moved.
 */
export function migrateAlertSounds(alerts: AlertDef[]): { alerts: AlertDef[]; changed: number } {
  let changed = 0
  const next = alerts.map((a) => {
    const sound = migrateAlertSoundRef(a.sound)
    if (sound.packId === a.sound.packId && sound.soundId === a.sound.soundId) return a
    changed++
    return { ...a, sound }
  })
  return { alerts: changed > 0 ? next : alerts, changed }
}

/**
 * raw.githubusercontent base for a pack's pinned release tree (no trailing slash).
 * Used by scripts/fetch-packs.mts to pull individual files; the in-app installer
 * fetches the release tarball instead (one request).
 */
export function packRawBase(pack: RegistryPack): string {
  const sub =
    pack.source_path && pack.source_path !== '.'
      ? pack.source_path.replace(/\\/g, '/').replace(/^\/|\/$/g, '')
      : ''
  const root = `https://raw.githubusercontent.com/${pack.source_repo}/${pack.source_ref}`
  return sub ? `${root}/${sub}` : root
}
