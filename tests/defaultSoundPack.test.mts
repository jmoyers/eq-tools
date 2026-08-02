// DEFAULT SOUND PACK TEST — the shipped default is the Alan Rickman pack, and every
// soundId the shipped alert defs reference actually exists in that pack at its PINNED
// tag. This is the gate that keeps a fresh machine's first run audible: the seeded
// alerts (src/main/store.ts) and the suggested-alert templates
// (src/renderer/src/features/alerts/suggestions.ts) name derived ids, and a derivation
// drift or an upstream re-cut would silently mute them.
//
// Fixture: tests/fixtures/alan-rickman.openpeon.json is the VERBATIM CESP manifest from
// utensils/openpeon-alan-rickman-soundpack@v1.1.2 (the pinned tag we provision). Running
// the SHARED conversion over it reproduces exactly what installPack / provisionDefaultPacks
// / `npm run fetch:packs` write to disk — offline, no network in the test.
//
// Also pins:
//   - provisioning is ADDITIVE (an already-installed pack ⇒ zero work, zero network);
//   - the old defaults (peon / sc_marine / default) are no longer provisioned, and
//     provisioning never removes a pack that IS on disk;
//   - the one-time retired-pack → Alan Rickman alert migration (Task #57): the
//     synthesized `default` pack is gone, so its refs must land on real ids in the
//     pinned pack rather than going mute.
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cespToManifestSounds, deriveSoundId, type CespManifest } from '../src/main/sounds'
import {
  DEFAULT_ALERT_PACK_ID,
  DEFAULT_ALERT_SOUNDS,
  DEFAULT_PACK,
  DEFAULT_PACKS,
  DEFAULT_PACK_IDS,
  LEGACY_ALERT_PACK_IDS,
  REQUIRED_SOUND_IDS,
  migrateAlertSoundRef,
  migrateAlertSounds,
  packRawBase
} from '../src/main/data/defaultPacks'
import { provisionDefaultPacks } from '../src/main/provisionPacks'
import type { AlertDef } from '../src/shared/types'

const here = dirname(fileURLToPath(import.meta.url))

/** The pinned pack's CESP manifest, converted exactly the way every install path does. */
function installedSoundIds(): Set<string> {
  const cesp = JSON.parse(
    readFileSync(join(here, 'fixtures', 'alan-rickman.openpeon.json'), 'utf8')
  ) as CespManifest
  const taken = new Set<string>()
  return new Set(Object.keys(cespToManifestSounds(cesp, (c, f) => deriveSoundId(c, f, taken))))
}

test('Alan Rickman is the one and only self-provisioned default, pinned to a tag', () => {
  assert.deepEqual(DEFAULT_PACK_IDS, ['alan-rickman'], 'exactly one shipped default pack')
  assert.equal(DEFAULT_ALERT_PACK_ID, 'alan-rickman')
  assert.equal(DEFAULT_PACKS.length, 1)
  assert.equal(DEFAULT_PACK.source_repo, 'utensils/openpeon-alan-rickman-soundpack')
  // A pinned TAG (not a branch) is what makes the derived soundIds stable.
  assert.match(DEFAULT_PACK.source_ref, /^v\d+\.\d+\.\d+$/, 'source_ref is an immutable tag')
  assert.equal(
    packRawBase(DEFAULT_PACK),
    'https://raw.githubusercontent.com/utensils/openpeon-alan-rickman-soundpack/v1.1.2'
  )
  // The dropped defaults are no longer provisioned (peon/sc_marine stay installable from
  // the registry; the synthesized `default` pack no longer exists at all).
  for (const gone of ['peon', 'sc_marine', 'default']) {
    assert.equal(DEFAULT_PACK_IDS.includes(gone), false, `'${gone}' is no longer a shipped default`)
  }
})

test('every sound the shipped alert defs reference exists in the pinned pack', () => {
  const ids = installedSoundIds()
  assert.equal(ids.size, DEFAULT_PACK.sound_count, 'conversion yields the registry sound_count')

  // Seeded alerts (store.ts) + the suggested-alert templates (suggestions.ts, which
  // repeats these literals because the renderer can't import from src/main).
  const referenced = [
    ...REQUIRED_SOUND_IDS,
    'input-required-input-required-01', // wearsOff template
    'resource-limit-resource-limit-09', // fade template
    'task-acknowledge-task-acknowledge-05', // lands template
    'task-error-task-error-08' // illusion-fade suggestion
  ]
  for (const id of referenced) assert.equal(ids.has(id), true, `pack is missing '${id}'`)

  // The exact lines the user mapped by hand, kept as the shipped defaults.
  assert.equal(DEFAULT_ALERT_SOUNDS.charmBreak, 'input-required-input-required-02')
  assert.equal(DEFAULT_ALERT_SOUNDS.bossDefeat, 'task-complete-task-complete-07')
})

// ─── Retired-pack → Alan Rickman alert migration (Task #57) ────────────────────
//
// The synthesized `default` pack is DELETED, so any alert still pointing at it (or at
// the peon/sc_marine/bastion packs the app used to provision) would go silently mute.
// store.ts runs migrateAlertSounds() once per install; these pin the mapping AND the
// invariant that every rewritten id actually exists in the pinned pack.

/** Minimal AlertDef carrying just the sound ref under test. */
function defWith(packId: string, soundId: string): AlertDef {
  return {
    id: `t-${packId}-${soundId}`,
    name: 't',
    enabled: true,
    trigger: { type: 'event', kind: 'uncharm' },
    sound: { packId, soundId }
  }
}

test('migration rewrites every retired-pack sound onto a REAL Alan Rickman line', () => {
  const ids = installedSoundIds()
  // One id per legacy pack shape: the synthesized default's four bare ids, the curated
  // peon/sc_marine prefixes, and bastion's derived (single-digit) ids.
  const legacy: Array<[string, string]> = [
    ['default', 'victory'],
    ['default', 'warning'],
    ['default', 'chime'],
    ['default', 'horn'],
    ['peon', 'ready'],
    ['peon', 'need-doing'],
    ['peon', 'ack-okie'],
    ['peon', 'complete-work'],
    ['peon', 'error-ugh'],
    ['peon', 'input-hmm'],
    ['peon', 'limit-whynot'],
    ['peon', 'spam-notime'],
    ['sc_marine', 'start-pieceofme'],
    ['sc_marine', 'ack-gogogo'],
    ['sc_marine', 'complete-shoot'],
    ['bastion', 'task-complete-3'],
    ['bastion', 'session-end-1'],
    ['bastion', 'task-progress-5'],
    ['bastion', 'user-spam-2'],
    // An id we've never seen still resolves to a real, audible line.
    ['peon', 'who-knows-what-this-was']
  ]
  for (const [packId, soundId] of legacy) {
    const next = migrateAlertSoundRef({ packId, soundId })
    assert.equal(next.packId, DEFAULT_ALERT_PACK_ID, `${packId}/${soundId} → shipped pack`)
    assert.equal(ids.has(next.soundId), true, `${packId}/${soundId} → real id (${next.soundId})`)
  }
})

test('migration preserves intent per category and leaves non-legacy refs alone', () => {
  // A completion sting stays a completion line; an error stays an error; the old
  // charm-break "warning" tone lands on the charm-break line the seeds use.
  assert.equal(
    migrateAlertSoundRef({ packId: 'default', soundId: 'victory' }).soundId,
    DEFAULT_ALERT_SOUNDS.bossDefeat
  )
  assert.equal(
    migrateAlertSoundRef({ packId: 'default', soundId: 'warning' }).soundId,
    DEFAULT_ALERT_SOUNDS.charmBreak
  )
  assert.equal(
    migrateAlertSoundRef({ packId: 'peon', soundId: 'error-ugh' }).soundId,
    DEFAULT_ALERT_SOUNDS.illusionFade
  )
  assert.equal(
    migrateAlertSoundRef({ packId: 'bastion', soundId: 'resource-limit-4' }).soundId,
    DEFAULT_ALERT_SOUNDS.buffFade
  )

  // Already-shipped refs and third-party packs the user chose are untouched.
  const keep = { packId: DEFAULT_ALERT_PACK_ID, soundId: DEFAULT_ALERT_SOUNDS.questComplete }
  assert.deepEqual(migrateAlertSoundRef(keep), keep)
  const other = { packId: 'portal-turret', soundId: 'task-complete-task-complete-1' }
  assert.deepEqual(migrateAlertSoundRef(other), other)
  assert.equal(LEGACY_ALERT_PACK_IDS.includes('portal-turret'), false)
})

test('migrateAlertSounds is idempotent and reports whether anything moved', () => {
  const list = [defWith('default', 'chime'), defWith(DEFAULT_ALERT_PACK_ID, DEFAULT_ALERT_SOUNDS.bossDefeat)]
  const first = migrateAlertSounds(list)
  assert.equal(first.changed, 1, 'only the legacy def moves')
  assert.equal(first.alerts[1], list[1], 'an already-migrated def is the SAME object')
  // Everything else about the def survives (id/name/trigger/enabled).
  assert.deepEqual({ ...first.alerts[0], sound: undefined }, { ...list[0], sound: undefined })

  const second = migrateAlertSounds(first.alerts)
  assert.equal(second.changed, 0, 're-running changes nothing')
  assert.equal(second.alerts, first.alerts, 'no-op returns the same list (no store write)')

  // An empty list (a user who deleted every alert) is a clean no-op.
  assert.equal(migrateAlertSounds([]).changed, 0)
})

test('provisioning is additive: an installed pack means no work and no network', async () => {
  const done = await provisionDefaultPacks({
    packsRoot: join(here, 'fixtures', 'does-not-exist'),
    installedIds: new Set([DEFAULT_ALERT_PACK_ID])
  })
  assert.equal(done, 0, 'nothing to provision when the default pack is already installed')

  // Old packs on disk are irrelevant to the decision — and never removed by it.
  const withOldPacks = await provisionDefaultPacks({
    packsRoot: join(here, 'fixtures', 'does-not-exist'),
    installedIds: new Set(['peon', 'sc_marine', 'default', DEFAULT_ALERT_PACK_ID])
  })
  assert.equal(withOldPacks, 0)
})
