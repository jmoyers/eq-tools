// The zone table (src/shared/zones.ts) — the map viewer's critical path, and now the app's ONE
// shared zone-knowledge artifact.
//
// Why this boundary exists: three sources name the same place three different ways (the log, the
// map filenames on disk, the scraped mob catalog) and there is NO algorithm connecting them —
// MEASURED, naive normalization resolves 7 of the 51 zone names the live log has printed
// (docs/plans/map-viewer.md §5.1). Everything the table asserts is therefore hand-authored
// knowledge, and hand-authored knowledge rots silently unless something pins it. This file is
// that pin.
//
// Three properties it protects, in order of how expensive they are to rediscover:
//   1. `short` is a FILENAME COMPONENT that reaches `join()` in main. It must satisfy the same
//      character allowlist the IPC handler validates with (`isSafePackId`).
//   2. An unknown zone returns `null`, NEVER a nearest guess — the viewer opens its picker
//      instead of confidently drawing the wrong dungeon (world-model law 1).
//   3. `zoneKey` here and `zoneKey` in the renderer's mobZone.ts are the SAME fold. They are
//      deliberate copies (shared may not import renderer), so parity is asserted against the real
//      renderer implementation on real log zone names.
//
// No Electron, no network, no fixtures, no game directory ⇒ this suite never skips (the
// security.test.mts / imageCache.test.mts precedent). Disk verification of every `short` was done
// at authoring time against the real map corpus and is recorded in zones.ts's comments; it cannot
// be a test because CI has no EverQuest install.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ZONES, catalogZonesFor, zoneEntryFor, zoneKey, zoneShortName } from '../src/shared/zones'
// Tests may cross layers; the shipped modules may not. This is the ONLY place the two folds meet.
import { zoneKey as mobZoneKey } from '../src/renderer/src/features/mobs/mobZone'

/**
 * `isSafePackId`'s character allowlist, restated rather than imported: this file must not drag
 * `src/main/security.ts` (and Electron-adjacent main code) into a pure test, and `src/shared` may
 * not import from `src/main` at all. SOURCE OF TRUTH: `src/main/security.ts:196` —
 * `/^[A-Za-z0-9_][A-Za-z0-9._-]*$/` plus a 1..128 length bound. `src/main/ipc/maps.ts` (wave 2A)
 * validates the renderer-supplied zone with it before any `join()`, so a stem that fails here
 * would be a table row the IPC layer silently refuses.
 */
const SAFE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/**
 * Every distinct zone the live log has printed (86.6 MB, eqlog_Primitive_freeport.txt, re-derived
 * 2026-08-03), in its RAW form — instance tier suffixes intact where the log carries them, so the
 * fold is exercised end-to-end and not just on pre-cleaned names. `null` = deliberately unmapped.
 */
const OBSERVED: readonly (readonly [string, string | null])[] = [
  ['Befallen', 'befallen'],
  ['Befallen 4 (Refined)', 'befallen'],
  ['Blackburrow', 'blackburrow'],
  ['Butcherblock Mountains', 'butcher'],
  ['East Commonlands', 'ecommons'],
  ['East Freeport', 'freporte'],
  ["Erud's Crossing", 'erudsxing'],
  ['Erudin', 'erudnext'],
  ['Erudin Palace', 'erudnint'],
  // EQL-new content (its NPCs are Doug / Dougina, not Gloomingdeep's), so no live-EQ stem fits and
  // guessing `tutorial` would draw a map of somewhere else.
  ['EverQuest Legends Tutorial', null],
  ['Everfrost Peaks', 'everfrost'],
  ['Grobb', 'grobb'],
  ['Highpass Hold', 'highpass'],
  ['Innothule Swamp', 'innothule'],
  ['Kithicor Forest', 'kithicor'],
  ["Nagafen's Lair", 'soldungb'],
  ["Nagafen's Lair - Group 3 (Fused)", 'soldungb'],
  ["Nagafen's Lair - Solo", 'soldungb'],
  ["Nagafen's Lair - Solo 1 (Awakened)", 'soldungb'],
  ['Najena', 'najena'],
  ['Najena 4 (Refined)', 'najena'],
  ['Nektulos Forest', 'nektulos'],
  ['Neriak - Commons', 'neriakb'],
  ['Neriak - Foreign Quarter', 'neriaka'],
  ['New Sebilis Expedition', 'newsebexp'],
  ['North Freeport', 'freportn'],
  ['North Kaladim', 'kaladima'],
  ['North Qeynos', 'qeynos2'],
  ['Oggok', 'oggok'],
  ['Paineel', 'paineel'],
  ['Permafrost Keep', 'permafrost'],
  ['Qeynos Hills', 'qeytoqrg'],
  ['South Kaladim', 'kaladimb'],
  ['South Qeynos', 'qeynos'],
  ['The City of Guk', 'guktop'],
  ['The Eastern Plains of Karana', 'eastkarana'],
  ['The Feerrott', 'feerrott'],
  ['The Lair of the Splitpaw', 'paw'],
  ['The Lavastorm Mountains', 'lavastorm'],
  ['The Northern Desert of Ro', 'nro'],
  ['The Northern Plains of Karana', 'northkarana'],
  ['The Oasis of Marr', 'oasis'],
  ['The Ocean of Tears', 'oot'],
  ['The Permafrost Caverns - Solo', 'permafrost'],
  ['The Permafrost Caverns - Solo 4 (Refined)', 'permafrost'],
  ['The Plane of Fear', 'fearplane'],
  ['The Plane of Fear 2 (Adaptive)', 'fearplane'],
  ['The Plane of Hate', 'hateplane'],
  ['The Plane of Hate - Solo 3 (Fused)', 'hateplane'],
  ['The Plane of Sky', 'airplane'],
  ['The Plane of Sky 1 (Awakened)', 'airplane'],
  ['The Rathe Mountains', 'rathemtn'],
  ['The Ruins of Old Guk', 'gukbottom'],
  ['The Ruins of Old Guk 2 (Adaptive)', 'gukbottom'],
  ['The Ruins of Old Paineel', 'hole'],
  ['The Ruins of Old Paineel - Solo 4 (Refined)', 'hole'],
  ['The Southern Desert of Ro', 'sro'],
  ['The Southern Plains of Karana', 'southkarana'],
  ['The Temple of Solusek Ro', 'soltemple'],
  ['Toxxulia Forest', 'tox'],
  ['West Commonlands', 'commons'],
  ['West Freeport', 'freportw']
]

// ---- the table's own invariants -------------------------------------------------------------

test('every short is a lowercase stem the IPC allowlist would accept', () => {
  assert.ok(ZONES.length >= 100, 'the table should cover well past the 51 observed zones')
  for (const e of ZONES) {
    assert.equal(e.short, e.short.toLowerCase(), `${e.name}: short must be lowercase`)
    assert.ok(e.short.length > 0 && e.short.length <= 128, `${e.name}: implausible stem length`)
    assert.match(e.short, SAFE_ID_RE, `${e.name}: stem must satisfy isSafePackId's allowlist`)
    // The three traversal shapes the allowlist exists to refuse, spelled out so a future widening
    // of the table can never smuggle one in.
    assert.ok(!e.short.includes('..'), `${e.name}: stem must not contain ..`)
    assert.ok(!e.short.includes('/') && !e.short.includes('\\'), `${e.name}: stem must be one path segment`)
    assert.ok(!e.short.includes(':'), `${e.name}: stem must not contain a drive/ADS separator`)
  }
})

test('no two entries collide on zoneKey — one folded name, one place', () => {
  const seen = new Map<string, string>()
  for (const e of ZONES) {
    assert.ok(e.name.trim().length > 0, `${e.short}: name must not be blank`)
    for (const long of [e.name, ...(e.aliases ?? [])]) {
      const key = zoneKey(long)
      assert.notEqual(key, '', `${e.short}: "${long}" folds to nothing`)
      const prior = seen.get(key)
      assert.equal(prior, undefined, `"${long}" (${e.short}) collides with ${String(prior)} on key "${key}"`)
      seen.set(key, e.short)
    }
  }
})

test('aliases are never redundant — an alias that folds onto its own name is dead weight', () => {
  for (const e of ZONES) {
    const nameKey = zoneKey(e.name)
    for (const alias of e.aliases ?? []) {
      assert.notEqual(zoneKey(alias), nameKey, `${e.short}: alias "${alias}" folds onto its own name`)
    }
  }
})

test('mobCatalogNames only ever carry spellings the fold cannot already reach', () => {
  // The whole point of the field: if the catalog's spelling folds onto the zone's own name, the
  // string rule in mobsInZone already matches it and listing it here would be noise pretending to
  // be knowledge.
  for (const e of ZONES) {
    for (const cat of e.mobCatalogNames ?? []) {
      assert.ok(cat.trim().length > 0, `${e.short}: blank catalog name`)
      assert.notEqual(zoneKey(cat), zoneKey(e.name), `${e.short}: "${cat}" folds onto the zone's own name`)
    }
  }
})

// ---- the fold ---------------------------------------------------------------------------------

test('zoneKey folds the leading article, the separators and the instance tiers', () => {
  // Article (world-model law 2: strip leading a/an/the).
  assert.equal(zoneKey('The Feerrott'), 'feerrott')
  assert.equal(zoneKey('The Feerrott'), zoneKey('Feerrott'))
  // Case.
  assert.equal(zoneKey('THE PLANE OF SKY'), 'plane of sky')
  // Separator runs: hyphens and whitespace both collapse to one space.
  assert.equal(zoneKey('Neriak - Commons'), 'neriak commons')
  assert.equal(zoneKey('Cazic-Thule'), zoneKey('Cazic Thule'))
  assert.equal(zoneKey('Neriak   -   Third   Gate'), 'neriak third gate')
  // Instance noise, in every real shape the log writes.
  assert.equal(zoneKey('Najena 4 (Refined)'), 'najena')
  assert.equal(zoneKey('The Plane of Sky 1 (Awakened)'), 'plane of sky')
  assert.equal(zoneKey('The Plane of Hate - Solo'), 'plane of hate')
  assert.equal(zoneKey('The Ruins of Old Paineel - Solo 4 (Refined)'), 'ruins of old paineel')
  assert.equal(zoneKey("Nagafen's Lair - Group 3 (Fused)"), "nagafen's lair")
  // The catalog's page-disambiguation parenthetical folds the same way.
  assert.equal(zoneKey('Northern Karana (35)'), 'northern karana')
  // Nullish / blank never throws and never becomes a real key.
  assert.equal(zoneKey(''), '')
  assert.equal(zoneKey('   '), '')
  assert.equal(zoneKey(null), '')
  assert.equal(zoneKey(undefined), '')
})

test('the fold agrees with the mobs tab, name for name', () => {
  // Two hand-copied implementations of one rule set: this is the tripwire that keeps them from
  // drifting into a state where a zone has a map but no mob roster (or the reverse) for no
  // reason a user could ever discover. Real log spellings, one per fold rule plus two plain ones.
  const REAL = [
    'The Ruins of Old Paineel - Solo 4 (Refined)',
    'Neriak - Foreign Quarter',
    'Najena 4 (Refined)',
    'The Plane of Sky 1 (Awakened)',
    "Nagafen's Lair - Group 3 (Fused)",
    'The Oasis of Marr',
    'West Commonlands'
  ]
  for (const raw of REAL) assert.equal(zoneKey(raw), mobZoneKey(raw), `folds disagree on "${raw}"`)
  // Including the degenerate inputs, where a mismatch would be easiest to miss.
  for (const raw of ['', '   ', 'the ']) assert.equal(zoneKey(raw), mobZoneKey(raw))
})

// ---- resolution -------------------------------------------------------------------------------

test('every zone the live log has printed resolves to its map stem', () => {
  for (const [raw, expected] of OBSERVED) {
    assert.equal(zoneShortName(raw), expected, `"${raw}" resolved wrong`)
  }
  // 50 of the 51 canonical zone names, spelled 61 ways here because the instance-tier variants
  // are listed alongside their base name. Only the EQL-new tutorial is unmapped.
  const resolved = OBSERVED.filter(([, s]) => s !== null).length
  assert.equal(resolved, OBSERVED.length - 1, 'exactly one observed zone is deliberately unmapped')
  assert.ok(resolved >= 61, `expected the observed corpus to resolve, got ${String(resolved)}`)
  const stems = new Set(OBSERVED.map(([, s]) => s).filter((s): s is string => s !== null))
  assert.equal(stems.size, 49, 'the 50 resolvable log names cover 49 stems (permafrost carries two)')
})

test('an unknown zone returns null — never a nearest guess', () => {
  // Junk.
  assert.equal(zoneShortName('xyzzy'), null)
  assert.equal(zoneShortName(''), null)
  assert.equal(zoneShortName('   '), null)
  assert.equal(zoneShortName(null), null)
  assert.equal(zoneShortName(undefined), null)
  // Pseudo-zones the parser is supposed to reject upstream; if one leaks through it must not
  // resolve to anything.
  assert.equal(zoneShortName('an area where levitation effects do not function'), null)
  // AMBIGUOUS names — each of these is 2-3 different map files, so "close enough" would draw the
  // wrong place. The catalog really does spell zones this way, which is why they are called out.
  for (const ambiguous of ['Freeport', 'Kaladim', 'Neriak', 'Qeynos', 'Felwithe', 'Guk', 'Karana']) {
    assert.equal(zoneShortName(ambiguous), null, `"${ambiguous}" is ambiguous and must not resolve`)
  }
  // A substring of a real zone is not that zone.
  assert.equal(zoneShortName('Plane'), null)
  assert.equal(zoneShortName('The Plane'), null)
  assert.equal(zoneShortName('Old Guk'), null)
})

test('aliases resolve to the same stem as the canonical name', () => {
  assert.equal(zoneShortName('Upper Guk'), zoneShortName('The City of Guk'))
  assert.equal(zoneShortName('Lower Guk'), zoneShortName('The Ruins of Old Guk'))
  assert.equal(zoneShortName('The Hole'), 'hole')
  assert.equal(zoneShortName('Splitpaw Lair'), 'paw')
  assert.equal(zoneShortName('North Ro'), 'nro')
  assert.equal(zoneShortName('East Karana'), 'eastkarana')
  assert.equal(zoneShortName('West Karana'), 'qey2hh1')
  assert.equal(zoneShortName('Crushbone'), 'crushbone')
  // The two Guk files are DIFFERENT zones, and the log names them apart — so they must never
  // collapse onto one stem.
  assert.notEqual(zoneShortName('The City of Guk'), zoneShortName('The Ruins of Old Guk'))
})

test('zoneEntryFor hands back the display name, not just the stem', () => {
  const e = zoneEntryFor('The Plane of Sky 1 (Awakened)')
  assert.equal(e?.short, 'airplane')
  assert.equal(e?.name, 'The Plane of Sky')
  assert.equal(zoneEntryFor('nonesuch'), null)
})

// ---- the mob-catalog join ---------------------------------------------------------------------

test('catalogZonesFor returns the catalog spellings the fold cannot reach', () => {
  // Verified against the real catalog: `Upper Guk` is 51 rows (froglok ton/gaz knights — exactly
  // what the log recorded slain in The City of Guk) and `Lower Guk` is 63 (the ghoul knights of
  // The Ruins of Old Guk).
  assert.deepEqual(catalogZonesFor('The City of Guk'), ['Upper Guk'])
  assert.deepEqual(catalogZonesFor('The Ruins of Old Guk'), ['Lower Guk'])
  // One place, two log names, one catalog spelling (36 rows incl. Lady Vox and King Thex`Ka IV).
  assert.deepEqual(catalogZonesFor('Permafrost Keep'), ['Permafrost'])
  assert.deepEqual(catalogZonesFor('The Permafrost Caverns - Solo 2 (Adaptive)'), ['Permafrost'])
  // Splitpaw: the log's gnolls are `Splitpaw Lair` rows verbatim; `Infected Paw` is the same map
  // stem per eqlwiki's own zone table.
  assert.ok(catalogZonesFor('The Lair of the Splitpaw').includes('Splitpaw Lair'))
  assert.deepEqual(catalogZonesFor('The Ruins of Old Paineel'), ['The Hole'])
})

test('catalogZonesFor is empty when there is nothing to add, and never leaks the table', () => {
  // Unknown zone.
  assert.deepEqual(catalogZonesFor('xyzzy'), [])
  assert.deepEqual(catalogZonesFor(''), [])
  assert.deepEqual(catalogZonesFor(null), [])
  // Known zone whose own name already folds onto the catalog's spelling — the string rule in
  // mobsInZone handles it, so there is no knowledge to add and the honest answer is nothing.
  assert.deepEqual(catalogZonesFor('Befallen'), [])
  assert.deepEqual(catalogZonesFor('The Feerrott'), [])
  // The result is a copy: a caller that sorts or splices it must not corrupt the shared table.
  const first = catalogZonesFor('The City of Guk')
  first.push('Nowhere')
  assert.deepEqual(catalogZonesFor('The City of Guk'), ['Upper Guk'])
})
