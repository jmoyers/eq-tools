// Store schema migration 6 → 7: the performance-HUD switch (docs/plans/perf-profiling.md P5).
//
// A companion to `storeMigrations.test.mts` (the framework and steps 1→4),
// `storeMigrationsPresence.test.mts` (step 5) and `storeMigrationsTelemetry.test.mts` (step 6),
// for the same reason those are separate files: the first is at the repo's 400-code-line
// factoring ceiling, and the answer to that is a split, not a widened threshold.
//
// WHAT THIS STEP PROMISES. After it runs, `perfHud` is present and holds a boolean this build
// understands. ONE default, and it is a decision:
//
//   enabled: false   OFF. The switch is the only thing that creates the 2 s metrics poll and the
//                    500 ms event-loop probe, so a user who never opens Preferences → Performance
//                    pays literally nothing for the feature. A HUD is an instrument you reach
//                    for, not a tax on everyone who might one day want one.
//
// Nothing else about the feature is persisted, deliberately: the live samples are a two-minute
// ring in renderer memory and the startup profile is one disposable file rewritten every launch.
// The migration law is about the SETTINGS file loading cleanly in every future build, forever —
// paying that tax for disposable measurements would be wrong twice over (the telemetry ring made
// the same call for the same reason).
//
// The normalizer itself belongs to `shared/perf.ts` and is pinned in `perf.test.mts`; what is
// asserted here is that the MIGRATION runs it, and that it ADDS without editing anything the
// user already had.

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
import { DEFAULT_PERF_HUD_PREFS } from '../src/shared/perf'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string): StoreData => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

/** `store-v6-perf.json` — a fully-populated analytics-era store: characters, alerts with voice
 *  fields, a voice blob, per-kind overlay config, an EQ-dir override, the cursor ring on, both
 *  auto-hide switches set, and a user who has ANSWERED the analytics notice and turned it off.
 *  The file a real user upgrading into this wave has. */
const V6 = 'store-v6-perf.json'

test('a v6 store gains the perfHud blob at its default, and nothing else moves', () => {
  const before = fixture(V6)
  const { status, from, to, applied, data } = migrateStoreData(before)

  assert.equal(status, 'migrated')
  assert.equal(from, 6)
  assert.equal(to, CURRENT_SCHEMA_VERSION)
  assert.deepEqual(applied, [7], 'a v6 store runs exactly one step')

  assert.deepEqual(data['perfHud'], DEFAULT_PERF_HUD_PREFS)
  assert.deepEqual(data['perfHud'], { enabled: false })

  // Everything the user already had is byte-identical: this step ADDS, it never edits. The
  // analytics answer especially — an upgrade must never quietly re-enable something declined.
  const untouched = ['byCharacter', 'activeLogPath', 'eqInstallDir', 'windowBounds', 'alerts',
    'alertPrefs', 'alertSoundMigration', 'voice', 'overlays', 'updateChannel', 'updateLastCheckedAt',
    'cursorRing', 'overlayAutoHide', 'telemetry']
  for (const key of untouched) {
    assert.deepEqual(data[key], before[key], `${key} must come through untouched`)
  }
})

test('AN UPGRADING USER DOES NOT GET THE HUD SWITCHED ON FOR THEM', () => {
  // The one way this step could be wrong in a way nobody notices: deciding that someone who has
  // used the app for months would "probably like" a live meter, and starting two timers for
  // them. Off means off, on every path into this version.
  for (const name of ['store-v1-first-build.json', 'store-v1-pre-framework.json', 'store-v5-telemetry.json', V6]) {
    const { data } = migrateStoreData(fixture(name))
    assert.deepEqual(data['perfHud'], { enabled: false }, `${name}: the HUD stays off`)
  }
})

test('an EXISTING perfHud blob is repaired field by field, never replaced wholesale', () => {
  // The downgrade contract means ANY value can be in this key (a hand edit, a future build).
  // A user who turned it ON keeps it on.
  const on = migrateStoreData({ [SCHEMA_VERSION_KEY]: 6, perfHud: { enabled: true } })
  assert.deepEqual(on.data['perfHud'], { enabled: true })

  // A malformed value is the documented default, never coerced into a different intent: the
  // string 'true' does not become `true` and quietly start a sampler nobody asked for.
  for (const junk of [null, 42, 'nonsense', [], { enabled: 'true' }, { nested: true }]) {
    const out = migrateStoreData({ [SCHEMA_VERSION_KEY]: 6, perfHud: junk })
    assert.deepEqual(out.data['perfHud'], DEFAULT_PERF_HUD_PREFS, `${JSON.stringify(junk)} ⇒ off`)
  }
})

test('a store that already carries the blob is not re-defaulted by a later run', () => {
  const once = migrateStoreData(fixture(V6))
  const configured = { ...once.data, perfHud: { enabled: true } }
  const twice = migrateStoreData(configured)
  assert.equal(twice.status, 'up-to-date')
  assert.deepEqual(twice.data['perfHud'], { enabled: true }, 'the user’s ON survives every upgrade')
})

test('a v1 store walks the whole chain and lands with the blob present', () => {
  // The oldest file this app can be handed still arrives at a shape today's readers understand.
  const { status, from, to, applied, data } = migrateStoreData(fixture('store-v1-first-build.json'))
  assert.equal(status, 'migrated')
  assert.equal(from, 1)
  assert.equal(to, CURRENT_SCHEMA_VERSION)
  assert.ok(applied.includes(7), 'the perf step runs for a pre-framework store too')
  assert.deepEqual(data['perfHud'], DEFAULT_PERF_HUD_PREFS)
})
