// Store schema migration 4 → 5: the cursor ring + overlay auto-hide prefs blobs.
//
// A companion to `storeMigrations.test.mts`, which owns the framework itself (the chain's
// integrity, the file half, the failure/downgrade policy) and steps 1→4. That file is at the
// repo's 400-code-line factoring ceiling, so a new step gets its own file rather than a widened
// threshold — the same call `PreferencesView.tsx` makes when a section becomes its own factory.
//
// WHAT THIS STEP PROMISES. After it runs, `cursorRing` and `overlayAutoHide` are present and
// every value in them is one this build understands. It never invents intent: the ring ships
// OFF (it costs a window plus an 8 ms poll), only the uncontroversial half of auto-hide ships
// ON, and a value the user already set is repaired field by field rather than replaced.
//
// The clamps themselves belong to `shared/presencePrefs.ts` and are pinned in
// `presence.test.mts`; what is asserted here is that the MIGRATION runs them, and that it adds
// without editing anything the user already had.

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

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixture = (name: string): StoreData => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

const RING_DEFAULT = { enabled: false, sizePx: 44, thicknessPx: 4 }
const AUTOHIDE_DEFAULT = { hideWhenNotRunning: true, hideWhenUnfocused: false }

/** `store-v4-presence.json` — a fully-populated voice-era store (v0.2.0): characters, alerts
 *  with voice fields, a voice blob, per-kind overlay config with persisted bounds, an EQ-dir
 *  override and update bookkeeping. The file a real user upgrading into this build has. */
const V4 = 'store-v4-presence.json'

test('a v4 store gains both presence blobs at their defaults, and nothing else moves', () => {
  const before = fixture(V4)
  const { status, from, to, applied, data } = migrateStoreData(before)

  assert.equal(status, 'migrated')
  assert.equal(from, 4)
  assert.equal(to, CURRENT_SCHEMA_VERSION)
  assert.deepEqual(applied, [5], 'a v4 store runs exactly one step')

  assert.deepEqual(data['cursorRing'], RING_DEFAULT, 'the ring is OFF for an upgrading user')
  assert.deepEqual(data['overlayAutoHide'], AUTOHIDE_DEFAULT)

  // Everything the user already had is byte-identical: this step ADDS, it never edits.
  const untouched = ['byCharacter', 'activeLogPath', 'eqInstallDir', 'windowBounds', 'alerts',
    'alertPrefs', 'alertSoundMigration', 'voice', 'overlays', 'updateChannel', 'updateLastCheckedAt']
  for (const key of untouched) {
    assert.deepEqual(data[key], before[key], `${key} must come through untouched`)
  }
})

test('an EXISTING cursor-ring blob is repaired field by field, never replaced wholesale', () => {
  // The downgrade contract means ANY value can be in this key (a hand edit, a future build, a
  // share import). Out-of-range numbers CLAMP — the user asked for "as big as possible", and
  // answering with the default would discard their intent — while wrong-typed values fall back
  // to the documented default and `enabled` is never invented as true.
  const messy = { enabled: true, sizePx: 900, thicknessPx: 'fat' }
  const { data } = migrateStoreData({ [SCHEMA_VERSION_KEY]: 4, cursorRing: messy })
  assert.deepEqual(data['cursorRing'], { enabled: true, sizePx: 200, thicknessPx: 4 })

  // A stroke wider than the radius is a filled dot, not a ring.
  const fat = migrateStoreData({ [SCHEMA_VERSION_KEY]: 4, cursorRing: { sizePx: 20, thicknessPx: 12 } })
  assert.deepEqual(fat.data['cursorRing'], { enabled: false, sizePx: 20, thicknessPx: 10 })

  for (const junk of [null, 42, 'nonsense', [], { nested: true }]) {
    const out = migrateStoreData({ [SCHEMA_VERSION_KEY]: 4, cursorRing: junk })
    assert.deepEqual(out.data['cursorRing'], RING_DEFAULT, `${JSON.stringify(junk)} ⇒ defaults`)
  }
})

test('an EXISTING auto-hide blob keeps each switch the user set, and defaults the rest', () => {
  const { data } = migrateStoreData({
    [SCHEMA_VERSION_KEY]: 4,
    overlayAutoHide: { hideWhenNotRunning: false, hideWhenUnfocused: 'yes' }
  })
  assert.deepEqual(data['overlayAutoHide'], { hideWhenNotRunning: false, hideWhenUnfocused: false })

  for (const junk of [null, 0, 'nonsense', []]) {
    const out = migrateStoreData({ [SCHEMA_VERSION_KEY]: 4, overlayAutoHide: junk })
    assert.deepEqual(out.data['overlayAutoHide'], AUTOHIDE_DEFAULT)
  }
})

test('a store that already carries the blobs is not re-defaulted by a later run', () => {
  // Idempotence for the pair the whole feature reads: a user who turned the ring on and then
  // upgraded again must still have it on.
  const once = migrateStoreData(fixture(V4))
  const configured = { ...once.data, cursorRing: { enabled: true, sizePx: 60, thicknessPx: 5 } }
  const twice = migrateStoreData(configured)
  assert.equal(twice.status, 'up-to-date')
  assert.deepEqual(twice.data['cursorRing'], { enabled: true, sizePx: 60, thicknessPx: 5 })
})
