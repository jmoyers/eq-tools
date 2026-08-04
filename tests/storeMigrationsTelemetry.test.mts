// Store schema migration 5 → 6: the usage-analytics prefs blob.
//
// A companion to `storeMigrations.test.mts` (the framework itself, and steps 1→4) and
// `storeMigrationsPresence.test.mts` (step 5), for the same reason those two are separate files:
// the first is at the repo's 400-code-line factoring ceiling, and the answer to that is a split,
// not a widened threshold.
//
// WHAT THIS STEP PROMISES. After it runs, `telemetry` is present and every value in it is one
// this build understands. The DEFAULTS ARE THE POLICY and each is a decision worth pinning:
//
//   enabled: true       opt-OUT — the owner's call, taken over the integrator's opt-in
//                       recommendation and recorded in docs/plans/usage-analytics.md T1.
//   noticeShown: false  and this is what makes opt-out honest. It is a NETWORK GATE, not a UI
//                       flag: `telemetryFlushEnabled` requires it, so nothing can ever be
//                       transmitted before the first-run notice has rendered. An UPGRADING user
//                       has not been told either — so they get the notice too, which is why this
//                       step must not "helpfully" set it true for a store that already existed.
//   analyticsId: null   NOT minted here. This migration runs for every user, including one who
//                       opens Preferences and immediately switches the feature off; creating an
//                       identifier for them would be creating exactly what they declined.
//
// The normalizer itself belongs to `shared/telemetry.ts` and is pinned in
// `telemetryContract.test.mts`; what is asserted here is that the MIGRATION runs it, and that it
// ADDS without editing anything the user already had.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CURRENT_SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  migrateStoreData,
  type StoreData
} from '../src/main/storeMigrations'
import { DEFAULT_TELEMETRY_PREFS } from '../src/shared/telemetry'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string): StoreData => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

/** `store-v5-telemetry.json` — a fully-populated presence-era store: characters, alerts with
 *  voice fields, a voice blob, per-kind overlay config, an EQ-dir override, the cursor ring
 *  switched ON and both auto-hide switches set. The file a real user upgrading has. */
const V5 = 'store-v5-telemetry.json'
const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

test('a v5 store gains the telemetry blob at its defaults, and nothing else moves', () => {
  const before = fixture(V5)
  const { status, from, to, applied, data } = migrateStoreData(before)

  assert.equal(status, 'migrated')
  assert.equal(from, 5)
  assert.equal(to, CURRENT_SCHEMA_VERSION)
  assert.deepEqual(applied, [6], 'a v5 store runs exactly one step')

  assert.deepEqual(data['telemetry'], DEFAULT_TELEMETRY_PREFS)
  assert.deepEqual(data['telemetry'], { enabled: true, noticeShown: false, analyticsId: null })

  // Everything the user already had is byte-identical: this step ADDS, it never edits.
  const untouched = ['byCharacter', 'activeLogPath', 'eqInstallDir', 'windowBounds', 'alerts',
    'alertPrefs', 'alertSoundMigration', 'voice', 'overlays', 'updateChannel', 'updateLastCheckedAt',
    'cursorRing', 'overlayAutoHide']
  for (const key of untouched) {
    assert.deepEqual(data[key], before[key], `${key} must come through untouched`)
  }
})

test('AN UPGRADING USER IS STILL OWED THE NOTICE — noticeShown is never pre-set to true', () => {
  // The one way this step could quietly break the whole promise: deciding that someone who has
  // used the app for months has "already been told". They have not. `noticeShown:false` means
  // the modal renders once on their next launch, and the network gate stays shut until it has.
  for (const name of ['store-v1-first-build.json', 'store-v1-pre-framework.json', V5]) {
    const { data } = migrateStoreData(fixture(name))
    const prefs = data['telemetry'] as Record<string, unknown>
    assert.equal(prefs.noticeShown, false, `${name}: the notice has not been shown to this user`)
    assert.equal(prefs.analyticsId, null, `${name}: no identifier is minted by a migration`)
  }
})

test('an EXISTING telemetry blob is repaired field by field, never replaced wholesale', () => {
  // The downgrade contract means ANY value can be in this key (a hand edit, a future build).
  // A user who turned it OFF keeps it off; a malformed id is dropped rather than repaired into
  // something that is not a UUID (the collector then mints a fresh one).
  const { data } = migrateStoreData({
    [SCHEMA_VERSION_KEY]: 5,
    telemetry: { enabled: false, noticeShown: true, analyticsId: 'Primitive@freeport' }
  })
  assert.deepEqual(data['telemetry'], { enabled: false, noticeShown: true, analyticsId: null })

  // A real id survives untouched — rotation is the user's action, never a side effect.
  const kept = migrateStoreData({ [SCHEMA_VERSION_KEY]: 5, telemetry: { analyticsId: ID } })
  assert.deepEqual(kept.data['telemetry'], { enabled: true, noticeShown: false, analyticsId: ID })

  for (const junk of [null, 42, 'nonsense', [], { nested: true }]) {
    const out = migrateStoreData({ [SCHEMA_VERSION_KEY]: 5, telemetry: junk })
    assert.deepEqual(out.data['telemetry'], DEFAULT_TELEMETRY_PREFS, `${JSON.stringify(junk)} ⇒ defaults`)
  }
})

test('a store that already carries the blob is not re-defaulted by a later run', () => {
  // Idempotence for the pair that matters most: a user who turned it OFF and answered the
  // notice must still be off, and must not be asked again, after any number of upgrades.
  const once = migrateStoreData(fixture(V5))
  const configured = {
    ...once.data,
    telemetry: { enabled: false, noticeShown: true, analyticsId: ID }
  }
  const twice = migrateStoreData(configured)
  assert.equal(twice.status, 'up-to-date')
  assert.deepEqual(twice.data['telemetry'], { enabled: false, noticeShown: true, analyticsId: ID })
})

test('a v1 store walks the whole chain and lands with the blob present', () => {
  // The oldest file this app can be handed still arrives at a shape today's readers understand.
  const { status, from, to, applied, data } = migrateStoreData(fixture('store-v1-first-build.json'))
  assert.equal(status, 'migrated')
  assert.equal(from, 1)
  assert.equal(to, CURRENT_SCHEMA_VERSION)
  assert.ok(applied.includes(6), 'the telemetry step runs for a pre-framework store too')
  assert.deepEqual(data['telemetry'], DEFAULT_TELEMETRY_PREFS)
})
