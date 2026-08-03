// Persisted-settings schema migrations (src/main/storeMigrations.ts).
//
// The promise under test: a store file written by ANY past build of this app loads cleanly
// in the build running today, forever. That is a claim about files nobody can produce on
// demand — the first-build store shape has not existed since commit 40b274b — so the
// fixtures here are AUTHORED snapshots of the real historical shapes, read straight out of
// `git log src/main/store.ts`:
//
//   store-v1-first-build.json   commit 89ee0da: one top-level `progress` blob, `liveLoot`
//                               inside it, no characters, no version.
//   store-v1-pre-framework.json every build from 41831cc to the one before this framework:
//                               `byCharacter`, the flat Task-#52 `overlay`, alerts, prefs,
//                               update bookkeeping — and still no version.
//   store-v99-future.json       a store from a build that does not exist yet, carrying a key
//                               this build has never heard of (the downgrade case).
//
// No Electron, no log, no fixture *replay*: the runner is a pure function over plain objects
// and the file half takes a path, so this suite is as cheap and as unskippable as
// overlayLayout/updateCadence. The file-half tests use a throwaway temp dir.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  PRE_CHARACTER_PROGRESS_KEY,
  SCHEMA_VERSION_KEY,
  backupPathFor,
  migrateStoreData,
  migrateStoreFile,
  quarantinePathFor,
  readSchemaVersion,
  type Migration,
  type StoreData
} from '../src/main/storeMigrations'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const fixture = (name: string): StoreData => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

/** A scratch dir with the given files, cleaned up when `fn` returns. */
function inTempDir(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-store-migration-'))
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8')
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const STORE = 'everquest-companion-progress.json'

// ------------------------------------------------------------------ registry integrity

test('the chain is contiguous, ascending, and lands exactly on CURRENT_SCHEMA_VERSION', () => {
  // The invariant that makes "from any version" mean anything: no gaps (a file at vN must
  // find a step to N+1), no duplicates, and nothing beyond what the code claims to be.
  const tos = MIGRATIONS.map((m) => m.to)
  assert.deepEqual(tos, [...tos].sort((a, b) => a - b), 'steps must be declared in ascending order')
  assert.equal(new Set(tos).size, tos.length, 'two steps may never produce the same version')
  assert.deepEqual(
    tos,
    Array.from({ length: CURRENT_SCHEMA_VERSION - 1 }, (_, i) => i + 2),
    `the chain must cover every version from 2 to ${CURRENT_SCHEMA_VERSION} with no gaps`
  )
  for (const m of MIGRATIONS) assert.ok(m.describe.length > 0, `step ${m.to} must describe itself`)
})

test('migration 1 → 2 EXISTS — the framework ships exercised, not dormant', () => {
  assert.ok(CURRENT_SCHEMA_VERSION >= 2, 'v1 is the pre-framework floor; shipping must be past it')
  assert.ok(MIGRATIONS.some((m) => m.to === 2))
})

// ---------------------------------------------------------------- version detection

test('a store with no version is v1 — that is what every pre-framework build wrote', () => {
  assert.equal(readSchemaVersion({}), 1)
  assert.equal(readSchemaVersion(fixture('store-v1-first-build.json')), 1)
  assert.equal(readSchemaVersion(fixture('store-v1-pre-framework.json')), 1)
  // Garbage in the slot is not a version; falling back to 1 re-runs idempotent steps, which
  // is always safer than skipping steps we cannot prove ran.
  for (const junk of [null, undefined, '2', 2.5, 0, -3, {}, []]) {
    assert.equal(readSchemaVersion({ [SCHEMA_VERSION_KEY]: junk }), 1, `${JSON.stringify(junk)} is not a version`)
  }
  assert.equal(readSchemaVersion(fixture('store-v99-future.json')), 99)
})

// -------------------------------------------------------------- the golden migrations

test('the FIRST BUILD store (top-level progress, liveLoot) migrates to the current shape', () => {
  const before = fixture('store-v1-first-build.json')
  const { status, from, to, applied, data } = migrateStoreData(before)

  assert.equal(status, 'migrated')
  assert.equal(from, 1)
  assert.equal(to, CURRENT_SCHEMA_VERSION)
  assert.deepEqual(applied, [2])
  assert.equal(data[SCHEMA_VERSION_KEY], CURRENT_SCHEMA_VERSION)

  // `progress` → `byCharacter`: commit 41831cc re-keyed progress by character and never
  // migrated anyone. The quest completions survive — under a reserved id, because the
  // single-character era recorded no character to attribute them to and we never guess one.
  assert.equal('progress' in data, false, 'the dead top-level key is gone')
  const byCharacter = data['byCharacter'] as Record<string, StoreData>
  assert.deepEqual(Object.keys(byCharacter), [PRE_CHARACTER_PROGRESS_KEY])
  const recovered = byCharacter[PRE_CHARACTER_PROGRESS_KEY]
  assert.deepEqual(recovered['completedQuests'], ['Enchanter::Sky Ring of Fire', 'Enchanter::Sky Bracer'])
  assert.deepEqual(recovered['inventory'], { 'sky quest turn-in token': 3, 'ancient stone talisman': 1 })
  assert.deepEqual(recovered['inventorySource'], (before['progress'] as StoreData)['inventorySource'])
  // `liveLoot` became a replayed module in 40b274b — dead weight in the file ever since.
  assert.equal('liveLoot' in recovered, false)

  // The reserved id can never collide with a real one: character ids are `name_server`.
  assert.ok(PRE_CHARACTER_PROGRESS_KEY.includes(':'), 'reserved id must not look like name_server')

  // The input object is never mutated — the runner is pure.
  assert.ok('progress' in before, 'input untouched')
  assert.ok('liveLoot' in ((before['progress'] as StoreData) ?? {}), 'input untouched')
})

test('the PRE-FRAMEWORK store keeps every setting and folds the flat overlay into overlays.fight', () => {
  const before = fixture('store-v1-pre-framework.json')
  const { status, from, to, data } = migrateStoreData(before)

  assert.equal(status, 'migrated')
  assert.equal(from, 1)
  assert.equal(to, CURRENT_SCHEMA_VERSION)

  // Nothing the user configured may be lost by an upgrade. Identity-style: same values out.
  for (const key of [
    'activeLogPath',
    'eqInstallDir',
    'windowBounds',
    'alerts',
    'alertPrefs',
    'alertSoundMigration',
    'updateChannel',
    'updateLastCheckedAt'
  ]) {
    assert.deepEqual(data[key], before[key], `${key} must survive the migration untouched`)
  }

  // Task #54's per-kind overlay: the flat key moves into the 'fight' slot and disappears.
  assert.equal('overlay' in data, false)
  const overlays = data['overlays'] as Record<string, StoreData>
  assert.deepEqual(overlays['fight'], before['overlay'])
  assert.equal(overlays['overall'], undefined, 'other kinds stay unset and fall back to defaults')

  // A real character's progress keeps its identity; only the dead key leaves.
  const chars = data['byCharacter'] as Record<string, StoreData>
  assert.deepEqual(Object.keys(chars), ['fixture_freeport'])
  assert.equal('liveLoot' in chars['fixture_freeport'], false)
  assert.deepEqual(chars['fixture_freeport']['completedQuests'], ['Enchanter::Sky Bracer'])
  assert.equal(chars[PRE_CHARACTER_PROGRESS_KEY], undefined, 'no phantom character is invented')
})

test('a per-kind overlay written by a newer build is never clobbered by the legacy flat key', () => {
  const fightFromV54 = { open: false, locked: false, bgAlpha: 0.72, topN: 5, drill: null }
  const { data } = migrateStoreData({
    overlay: { open: true, locked: true, bgAlpha: 0.1, topN: 10, drill: null },
    overlays: { fight: fightFromV54 }
  })
  assert.deepEqual((data['overlays'] as StoreData)['fight'], fightFromV54)
  assert.equal('overlay' in data, false)
})

test('an EMPTY pre-framework store migrates to a valid current store, not to junk', () => {
  const { status, to, data } = migrateStoreData({})
  assert.equal(status, 'migrated')
  assert.equal(to, CURRENT_SCHEMA_VERSION)
  assert.deepEqual(data, { byCharacter: {}, [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION })
})

test('a legacy progress blob is not salvaged over real characters, and empty blobs just go', () => {
  // Real characters exist ⇒ the pre-character blob is superseded; keeping it would show up
  // as a second, un-selectable bucket of stale quest state.
  const withChars = migrateStoreData({
    progress: { inventory: { x: 1 }, completedQuests: ['a'] },
    byCharacter: { primitive_freeport: { inventory: {}, completedQuests: [] } }
  })
  assert.deepEqual(Object.keys(withChars.data['byCharacter'] as StoreData), ['primitive_freeport'])
  // An untouched default blob carries nothing worth reserving an id for.
  const empty = migrateStoreData({ progress: { inventory: {}, completedQuests: [], liveLoot: {} } })
  assert.deepEqual(empty.data['byCharacter'], {})
  assert.equal('progress' in empty.data, false)
})

test('malformed values never throw the chain — a hand-edited store still boots', () => {
  // Anything can be in this file: a user edits it, a disk lies, an old build wrote a
  // different type. The chain must degrade, never explode.
  for (const junk of [null, 42, 'nonsense', [], { nested: true }]) {
    const out = migrateStoreData({ progress: junk, byCharacter: junk, overlay: junk, overlays: junk })
    assert.equal(out.status, 'migrated', `${JSON.stringify(junk)} must not break the chain`)
    assert.equal(out.data[SCHEMA_VERSION_KEY], CURRENT_SCHEMA_VERSION)
  }
})

// ------------------------------------------------------------------------ idempotence

test('running the chain twice equals running it once, for every fixture', () => {
  for (const name of ['store-v1-first-build.json', 'store-v1-pre-framework.json']) {
    const once = migrateStoreData(fixture(name))
    const twice = migrateStoreData(once.data)
    assert.equal(twice.status, 'up-to-date', `${name}: a migrated store has nothing left to do`)
    assert.equal(twice.changed, false)
    assert.deepEqual(twice.data, once.data, `${name}: the second pass must be a no-op`)
  }
})

test('an already-current store is left exactly alone', () => {
  const current: StoreData = { [SCHEMA_VERSION_KEY]: CURRENT_SCHEMA_VERSION, byCharacter: {}, alerts: [] }
  const out = migrateStoreData(current)
  assert.equal(out.status, 'up-to-date')
  assert.equal(out.changed, false)
  assert.equal(out.data, current, 'not even a defensive clone — nothing ran')
})

// ------------------------------------------------------------------- downgrade guard

test('a store from a FUTURE build is never rewritten, reset, or versioned backwards', () => {
  const before = fixture('store-v99-future.json')
  const out = migrateStoreData(before)
  assert.equal(out.status, 'future')
  assert.equal(out.from, 99)
  assert.equal(out.to, 99, 'the version is never stamped down')
  assert.deepEqual(out.applied, [])
  assert.equal(out.changed, false)
  assert.deepEqual(out.data, before, 'the data comes back byte-identical')
  // The key this build has never heard of is still there — that is what makes running an
  // older build against a newer store recoverable instead of destructive.
  assert.deepEqual(out.data['aKeyFromTheFuture'], before['aKeyFromTheFuture'])
})

test('the future-store file path leaves the file untouched but takes a pristine backup', () => {
  const body = readFileSync(join(FIXTURES, 'store-v99-future.json'), 'utf8')
  inTempDir({ [STORE]: body }, (dir) => {
    const path = join(dir, STORE)
    const errors: string[] = []
    const out = migrateStoreFile(path, { error: (m) => errors.push(m) })

    assert.equal(out.status, 'future')
    assert.equal(out.wrote, false)
    assert.equal(readFileSync(path, 'utf8'), body, 'the newer store file is not modified')
    assert.equal(out.to, 99, `never stamped down to ${CURRENT_SCHEMA_VERSION}`)
    // Insurance: the old build is about to run against this file, so keep what it looked
    // like before it did.
    assert.equal(out.backupPath, backupPathFor(path, 99))
    assert.equal(readFileSync(out.backupPath!, 'utf8'), body)
    assert.equal(errors.length, 1, 'a downgrade is loud in errors.log, but never fatal')
    assert.match(errors[0], /v99/)
  })
})

// ------------------------------------------------------------------------- file half

test('a pre-framework file is migrated in place, with a byte-exact backup of the original', () => {
  const body = readFileSync(join(FIXTURES, 'store-v1-pre-framework.json'), 'utf8')
  inTempDir({ [STORE]: body }, (dir) => {
    const path = join(dir, STORE)
    const out = migrateStoreFile(path)

    assert.equal(out.status, 'migrated')
    assert.equal(out.wrote, true)
    assert.equal(out.fileMissing, false)
    assert.equal(out.backupPath, backupPathFor(path, 1))
    assert.equal(readFileSync(out.backupPath!, 'utf8'), body, 'the backup is the ORIGINAL bytes')

    const onDisk = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(onDisk[SCHEMA_VERSION_KEY], CURRENT_SCHEMA_VERSION)
    assert.deepEqual(onDisk, out.data, 'what we return is what we wrote')
    assert.equal('overlay' in onDisk, false)

    // Second launch: nothing to do, nothing written, and the pristine backup is NOT
    // overwritten with post-migration content.
    writeFileSync(out.backupPath!, body, 'utf8')
    const again = migrateStoreFile(path)
    assert.equal(again.status, 'up-to-date')
    assert.equal(again.wrote, false)
    assert.equal(readFileSync(backupPathFor(path, 1), 'utf8'), body)
  })
})

test('a backup already on disk is never overwritten (the pristine copy wins)', () => {
  const body = readFileSync(join(FIXTURES, 'store-v1-pre-framework.json'), 'utf8')
  inTempDir({ [STORE]: body, [`everquest-companion-progress.v1.backup.json`]: '{"pristine":true}' }, (dir) => {
    const path = join(dir, STORE)
    const out = migrateStoreFile(path)
    assert.equal(out.status, 'migrated')
    assert.equal(readFileSync(backupPathFor(path, 1), 'utf8'), '{"pristine":true}')
  })
})

test('a fresh install (no file) needs no migration and never creates one', () => {
  inTempDir({}, (dir) => {
    const path = join(dir, STORE)
    const out = migrateStoreFile(path)
    assert.equal(out.fileMissing, true)
    assert.equal(out.status, 'up-to-date')
    assert.equal(out.to, CURRENT_SCHEMA_VERSION, 'a brand-new store IS current — store.ts stamps it')
    assert.equal(out.wrote, false)
    assert.equal(existsSync(path), false, 'the migrator never creates the store file')
    assert.equal(existsSync(backupPathFor(path, 1)), false)
  })
})

test('a CORRUPT store file is quarantined instead of bricking every launch', () => {
  // conf leaves `clearInvalidConfig` false, so a truncated write (power loss mid-save)
  // throws on every read from then on — permanently, with no way out from inside the app.
  for (const bad of ['{"byCharacter": {', 'null', '[]', '"a string"', '']) {
    inTempDir({ [STORE]: bad }, (dir) => {
      const path = join(dir, STORE)
      const errors: string[] = []
      const out = migrateStoreFile(path, { error: (m) => errors.push(m) })

      assert.equal(out.quarantinedPath, quarantinePathFor(path))
      assert.equal(existsSync(path), false, 'the unreadable file is out of the way')
      assert.equal(readFileSync(out.quarantinedPath!, 'utf8'), bad, 'and kept, verbatim, for diagnosis')
      assert.equal(out.to, CURRENT_SCHEMA_VERSION, 'the app starts from defaults, at the current version')
      assert.equal(out.readError, undefined)
      assert.equal(errors.length, 1)
    })
  }
})

// ------------------------------------------------------------- long chains + failure
//
// The real registry is one step long today, so these drive the REAL runner with a
// substitute chain (its only test seam). They pin the behaviour a growing chain depends on
// before there is a chain to grow.

const step = (to: number, mark: string): Migration => ({
  to,
  describe: mark,
  migrate: (d) => ({ ...d, trail: [...((d['trail'] as string[]) ?? []), mark] })
})

test('a store from ANY past version enters the chain at its own version and runs forward', () => {
  const chain = [step(2, 'a'), step(3, 'b'), step(4, 'c')]
  // Absent version ⇒ 1 ⇒ the whole chain. This is the "going back indefinitely" case: a
  // file written years and many releases ago is not special-cased, it just starts at 1.
  const oldest = migrateStoreData({ byCharacter: {} }, { migrations: chain, target: 4 })
  assert.deepEqual(oldest.applied, [2, 3, 4])
  assert.deepEqual(oldest.data['trail'], ['a', 'b', 'c'])
  assert.equal(oldest.data[SCHEMA_VERSION_KEY], 4)
  // A store from the middle of history runs only the steps it has not seen — never twice.
  const middle = migrateStoreData({ [SCHEMA_VERSION_KEY]: 3 }, { migrations: chain, target: 4 })
  assert.deepEqual(middle.applied, [4])
  assert.deepEqual(middle.data['trail'], ['c'])
  // Declaration order is not execution order: `to` is.
  const shuffled = migrateStoreData({}, { migrations: [step(4, 'c'), step(2, 'a'), step(3, 'b')], target: 4 })
  assert.deepEqual(shuffled.data['trail'], ['a', 'b', 'c'])
})

test('a step that throws keeps what succeeded and leaves the rest for the next launch', () => {
  const chain: Migration[] = [
    step(2, 'a'),
    {
      to: 3,
      describe: 'throws halfway through mutating',
      migrate: (d) => {
        d['halfWritten'] = true
        throw new Error('disk went away')
      }
    },
    step(4, 'c')
  ]
  const out = migrateStoreData({ byCharacter: {} }, { migrations: chain, target: 4 })

  assert.equal(out.status, 'partial', 'a half-applied upgrade never claims success')
  assert.deepEqual(out.applied, [2], 'and never runs past the failure')
  assert.equal(out.to, 2, 'stamped at the last version that fully succeeded')
  assert.equal(out.data[SCHEMA_VERSION_KEY], 2)
  assert.equal(out.changed, true)
  assert.deepEqual(out.failed, { to: 3, error: 'disk went away' })
  assert.deepEqual(out.data['trail'], ['a'], 'the successful step is KEPT, not rolled back')
  // Each step mutates its own clone, so the torn write from the failed step cannot leak.
  assert.equal('halfWritten' in out.data, false)

  // Next launch: the survivor is not re-run, and the failing step is retried.
  const retry = migrateStoreData(out.data, { migrations: [step(2, 'a'), step(3, 'b'), step(4, 'c')], target: 4 })
  assert.deepEqual(retry.applied, [3, 4])
  assert.deepEqual(retry.data['trail'], ['a', 'b', 'c'])
})

test('a write failure is not stamped — the migration retries on the next launch', () => {
  // The store path is a DIRECTORY: readFileSync fails with EISDIR, not ENOENT, so this
  // exercises the "exists but unreadable" branch — nothing touched, nothing stamped.
  inTempDir({}, (dir) => {
    const errors: string[] = []
    const out = migrateStoreFile(dir, { error: (m) => errors.push(m) })
    assert.ok(out.readError, 'the failure is reported, not swallowed')
    assert.equal(out.wrote, false)
    assert.equal(out.fileMissing, false)
    assert.equal(errors.length, 1)
  })
})
