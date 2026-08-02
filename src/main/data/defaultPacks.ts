// defaultPacks.ts — the ONE voice pack the app ships with, defined once and shared by:
//   - scripts/fetch-packs.mts (dev: writes it into resources/soundpacks/ for a source
//     build), and
//   - src/main/provisionPacks.ts (runtime: silently installs it into
//     <userData>/soundpacks/ on startup when missing, so a CI-built installer — which
//     ships WITHOUT the gitignored audio — still has the sounds the seeded alerts need).
//
// WHY ONE PACK: the app used to self-provision the PeonPing og-packs `peon` +
// `sc_marine` packs and seed alerts against the generated `default` chime pack. Those
// read as robotic/joke defaults; the shipped default is now Alan Rickman — spoken-word
// lines that fit EverQuest's tone. The old packs are NOT deleted: they're still in the
// openpeon registry and installable from the in-app Sound Packs browser, and any pack
// already on disk keeps working (provisioning only ADDS what's missing).
//
// STABLE SOUND IDS: the pack is pinned to a release TAG, so its openpeon.json is
// immutable and the ids the shared CESP→manifest conversion derives (deriveSoundId:
// "<category-slug>-<file-slug>") are deterministic and identical whether the pack
// arrives via self-provisioning, `npm run fetch:packs`, or a user-initiated registry
// install. DEFAULT_ALERT_SOUNDS below are those derived ids; provisionPacks verifies
// they resolved after an install, so drift is caught in errors.log rather than silently
// muting an alert.

import type { RegistryPack } from '../../shared/types'

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
