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
// Also pins the two behaviors migration depends on:
//   - provisioning is ADDITIVE (an already-installed pack ⇒ zero work, zero network);
//   - the old defaults (peon / sc_marine / default) are no longer provisioned, but nothing
//     removes them either.
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
  REQUIRED_SOUND_IDS,
  packRawBase
} from '../src/main/data/defaultPacks'
import { provisionDefaultPacks } from '../src/main/provisionPacks'

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
  // The dropped defaults are no longer provisioned (they stay installable from the registry).
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
