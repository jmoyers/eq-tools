// MAP PACK RESOLUTION (src/main/maps/packs.ts) — the boundary between "1,900 files on disk"
// and "one MapData for this zone".
//
// This is the half of the map viewer that touches the filesystem, so it is also the half that
// can silently read the WRONG file: a mixed-case filename, a stem whose own last character is a
// digit, a zone the game's default set simply does not ship, an empty layer file, or a crafted
// zone name aimed at somewhere outside the pack directory. Every one of those is a measured
// property of the real corpus, and every one of them is asserted below against SYNTHETIC packs
// in a temp dir — hand-authored, because eqmaps.info publishes no license and this repo is
// public (docs/plans/map-viewer.md §9.1), and because 30 legible lines exercise the edge cases
// that 215 MB of real maps merely contain.
//
// No Electron: the roots are INJECTED (`MapLibraryOptions`, the imageCache.ts precedent), so
// this suite runs under plain `node --import tsx --test` and never skips.
//
// THE CROSS-PACK MERGE IS THE POINT (§6.3). Measured on the real corpus: the game's default set
// holds 285 label points across 58 files, brewall holds 26,607 across 562 — so labels must come
// from a brewall-style pack while geometry stays EQL-authoritative. And the fallthrough is
// mandatory in the other direction too: blackburrow, soldungb, hateplane and hole have NO
// default-set geometry at all, so a "default first" rule that did not fall through PER ZONE
// would render four zones the user actually plays as a blank canvas.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSafePackId } from '../src/main/security'
import {
  createMapLibrary,
  discoverPacks,
  resolveZoneLayers,
  splitMapFileName,
  type MapLibrary
} from '../src/main/maps/packs'

// --- the synthetic corpus ---------------------------------------------------

const GEOMETRY = ['L 0, 0, 0, 10, 0, 0, 0, 0, 0', 'L 10, 0, 0, 10, 10, 5, 0, 0, 255'].join('\r\n')

/** Files, relative to a pack dir, for the fixture below. `''` is a real zero-byte file. */
const DEFAULT_PACK: Record<string, string> = {
  // Mixed case, exactly like the real `Thurgadina1_1.txt` / `CSHome_1.txt`.
  'Befallen.txt': `${GEOMETRY}\r\nP 5, 5, 0, 0, 0, 0, 2, Default_Base_Point`,
  // The default set's label layers are nearly empty — 285 points across 58 files.
  'Befallen_1.txt': 'P 1, 1, 0, 0, 0, 0, 2, Sparse_Default_Label',
  // A stem whose OWN last character is a digit, plus its layer-1 sibling.
  'Thurgadina1.txt': GEOMETRY,
  'Thurgadina1_1.txt': 'P 2, 2, 0, 255, 0, 0, 3, to_Thurgadin',
  // Present but ZERO BYTES: resolution must fall through to a pack that has real geometry.
  'grobb.txt': ''
}

const BREWALL_PACK: Record<string, string> = {
  'befallen.txt': GEOMETRY,
  // 4.5% of real P records carry a comma INSIDE the label; one is here so search sees it whole.
  'befallen_1.txt': [
    'P -20, -20, 0, 255, 0, 0, 3, to_Commonlands',
    'P 12, 3, 4, 0, 127, 0, 2, Locked_Door_(Quests,Unpickable)',
    'P 4, 8, 1, 0, 0, 240, 1, GS:_Ruined_Wagon'
  ].join('\r\n'),
  // The legend, drawn far outside the map — credits + the height hint live here.
  'befallen_2.txt': [
    'P 2000, 4800, 0, 0, 0, 0, 2, Height_Filter:_25/25',
    'P 2000, 4700, 0, 0, 0, 0, 2, Original_Map:_Goodurden_<RoI>'
  ].join('\r\n'),
  // A real zero-byte layer file (`brewall\*_3.txt`) — a valid empty layer, not an error.
  'befallen_3.txt': '',
  // A zone the DEFAULT SET DOES NOT SHIP. blackburrow/soldungb/hateplane/hole are the real ones.
  'blackburrow.txt': GEOMETRY,
  'blackburrow_1.txt': 'P 7, 7, 0, 255, 0, 0, 3, to_Everfrost',
  'grobb.txt': GEOMETRY
}

const USER_PACK: Record<string, string> = {
  'befallen_1.txt': 'P 9, 9, 0, 0, 0, 0, 2, My_Own_Label'
}

interface Fixture {
  root: string
  eqRoot: string
  userPacksRoot: string
}

function writePack(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'eq-maps-'))
  const eqRoot = join(root, 'EverQuest Legends')
  const mapsDir = join(eqRoot, 'maps')
  writePack(mapsDir, DEFAULT_PACK)
  writePack(join(mapsDir, 'brewall'), BREWALL_PACK)
  // A directory whose name could not survive isSafePackId must not be listed as a pack.
  writePack(join(mapsDir, '.hidden'), { 'befallen.txt': GEOMETRY })
  const userPacksRoot = join(root, 'userData', 'mappacks')
  writePack(join(userPacksRoot, 'mypack'), USER_PACK)
  return { root, eqRoot, userPacksRoot }
}

/** A fixture + library pair, torn down after `fn`. */
function withLibrary(fn: (lib: MapLibrary, fx: Fixture) => void): void {
  const fx = makeFixture()
  try {
    fn(createMapLibrary({ eqRoot: fx.eqRoot, userPacksRoot: fx.userPacksRoot }), fx)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
  }
}

/** Every file under `dir`, as `relative path -> size:mtimeMs`. Used to prove read-only-ness. */
function treeSnapshot(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(out, treeSnapshot(join(dir, entry.name), rel))
    else {
      const s = statSync(join(dir, entry.name))
      out[rel] = `${s.size}:${s.mtimeMs}`
    }
  }
  return out
}

// --- filename splitting -----------------------------------------------------

test('splitMapFileName keys stems lowercase and never eats a stem s own trailing digit', () => {
  // Measured: `Thurgadina1_1.txt`, `CSHome_1.txt`, `Phinterior1a1_2.txt` are all real files.
  assert.deepEqual(splitMapFileName('Thurgadina1_1.txt'), { stem: 'thurgadina1', layer: 1 })
  assert.deepEqual(splitMapFileName('Thurgadina1.txt'), { stem: 'thurgadina1', layer: 0 })
  assert.deepEqual(splitMapFileName('CSHome_1.txt'), { stem: 'cshome', layer: 1 })
  assert.deepEqual(splitMapFileName('Phinterior1a1_2.txt'), { stem: 'phinterior1a1', layer: 2 })
  assert.deepEqual(splitMapFileName('airplane.txt'), { stem: 'airplane', layer: 0 })
  // Only _1/_2/_3 are layers — the client draws at most three custom layers.
  assert.deepEqual(splitMapFileName('zone_4.txt'), { stem: 'zone_4', layer: 0 })
  assert.deepEqual(splitMapFileName('zone_10.txt'), { stem: 'zone_10', layer: 0 })
  // Not a map file at all.
  assert.equal(splitMapFileName('readme.md'), null)
  assert.equal(splitMapFileName('_1.txt'), null)
})

// --- discovery --------------------------------------------------------------

test('discovery finds the game maps dir, its subdir packs and the userData packs', () => {
  withLibrary((lib, fx) => {
    const packs = discoverPacks({ eqRoot: fx.eqRoot, userPacksRoot: fx.userPacksRoot })
    assert.deepEqual(
      packs.map((p) => [p.pack.id, p.pack.origin]),
      [
        ['default', 'game'],
        ['brewall', 'game'],
        ['mypack', 'user']
      ]
    )
    // `.hidden` could never be addressed by a renderer pref (isSafePackId), so it is not listed.
    assert.equal(
      packs.find((p) => p.pack.id === '.hidden'),
      undefined
    )
    const brewall = packs.find((p) => p.pack.id === 'brewall')!
    assert.equal(brewall.pack.fileCount, Object.keys(BREWALL_PACK).length)
    assert.equal(brewall.pack.zoneCount, 3) // befallen, blackburrow, grobb
    // The renderer row never carries an absolute path.
    for (const info of lib.packs()) assert.equal('dir' in info, false)
    assert.deepEqual(
      lib.packs().map((p) => p.id),
      ['default', 'brewall', 'mypack']
    )
  })
})

test('zone listing is the union of every pack, ascending, and filterable to one pack', () => {
  withLibrary((lib) => {
    assert.deepEqual(lib.zones(), ['befallen', 'blackburrow', 'grobb', 'thurgadina1'])
    assert.deepEqual(lib.zones('brewall'), ['befallen', 'blackburrow', 'grobb'])
    assert.deepEqual(lib.zones('mypack'), ['befallen'])
    assert.deepEqual(lib.zones('nope'), [])
  })
})

// --- resolution -------------------------------------------------------------

test('a mixed-case filename resolves from a lowercase zone stem, keeping the real casing', () => {
  withLibrary((lib) => {
    const res = lib.get('befallen')
    assert.ok(res.ok)
    const base = res.data.sources.find((s) => s.layer === 0)!
    // The stem is keyed lowercase; the FILE is read under the name the pack actually uses.
    assert.equal(base.file, 'Befallen.txt')
    assert.equal(base.packId, 'default')
    // Digit-ending stems resolve the same way, both layers.
    const thurg = lib.get('thurgadina1')
    assert.ok(thurg.ok)
    assert.deepEqual(
      thurg.data.sources.map((s) => s.file),
      ['Thurgadina1.txt', 'Thurgadina1_1.txt']
    )
  })
})

test('geometry and labels are sourced from DIFFERENT packs and the merge is recorded', () => {
  withLibrary((lib) => {
    const res = lib.get('befallen')
    assert.ok(res.ok)
    const by = new Map(res.data.sources.map((s) => [s.layer, s.packId]))
    // Geometry: the game's own set is EQL-authoritative, so it wins layer 0.
    assert.equal(by.get(0), 'default')
    // Labels: the default set has 285 points corpus-wide against brewall's 26,607, so the
    // label layer defaults to the brewall-style pack — otherwise search is permanently empty.
    assert.equal(by.get(1), 'brewall')
    // The legend follows the labels: its credits describe whoever drew them.
    assert.equal(by.get(2), 'brewall')
    // Provenance is DATA, not a UI guess: every layer says which pack it came from.
    assert.deepEqual(
      [...by.keys()].sort(),
      [0, 1, 2, 3]
    )
    const labels = res.data.points.filter((p) => p.layer === 1).map((p) => p.display)
    assert.deepEqual(labels, ['to Commonlands', 'Locked Door (Quests,Unpickable)', 'GS: Ruined Wagon'])
    assert.equal(
      labels.includes('Sparse Default Label'),
      false,
      'the default pack label layer must not be merged in alongside brewall s'
    )
    // Base-layer points come with the geometry pack, so both packs contribute points.
    assert.ok(res.data.points.some((p) => p.display === 'Default Base Point'))
    // Mined from the legend the labels pack supplied.
    assert.deepEqual(res.data.heightHint, { low: 25, high: 25 })
    assert.deepEqual(res.data.credits, ['Original Map: Goodurden <RoI>'])
  })
})

test('a zone the default set does not ship resolves entirely from the pack that has it', () => {
  // The real ones: blackburrow, soldungb (Nagafen's Lair), hateplane, hole. A geometry rule of
  // "default first" that did not fall through PER ZONE renders these four blank.
  withLibrary((lib) => {
    const res = lib.get('blackburrow')
    assert.ok(res.ok)
    assert.deepEqual(res.data.sources, [
      { layer: 0, packId: 'brewall', file: 'blackburrow.txt' },
      { layer: 1, packId: 'brewall', file: 'blackburrow_1.txt' }
    ])
    assert.equal(res.data.lines.count, 2)
    assert.equal(res.data.points.length, 1)
  })
})

test('an empty layer file is skipped in favour of a pack that has real content', () => {
  withLibrary((lib) => {
    // `grobb.txt` exists in BOTH packs, but the default one is zero bytes.
    const res = lib.get('grobb')
    assert.ok(res.ok)
    assert.deepEqual(res.data.sources, [{ layer: 0, packId: 'brewall', file: 'grobb.txt' }])
    assert.equal(res.data.lines.count, 2)
  })
})

test('an empty layer file is a valid empty layer, never an error', () => {
  withLibrary((lib) => {
    const res = lib.get('befallen')
    assert.ok(res.ok)
    // `befallen_3.txt` is zero bytes and is still SOURCED — nothing threw, nothing was dropped
    // from the rest of the map, and `skipped` stays 0 because a blank file has no bad lines.
    assert.ok(res.data.sources.some((s) => s.layer === 3 && s.file === 'befallen_3.txt'))
    assert.equal(res.data.skipped, 0)
    // An explicitly preferred pack that has ONLY an empty file is honoured as an instruction.
    const grobb = lib.get('grobb', { geometry: 'default' })
    assert.ok(grobb.ok)
    assert.deepEqual(grobb.data.sources, [{ layer: 0, packId: 'default', file: 'grobb.txt' }])
    assert.equal(grobb.data.lines.count, 0)
  })
})

test('an explicit per-layer pack preference overrides the default order', () => {
  withLibrary((lib) => {
    const res = lib.get('befallen', { geometry: 'brewall', labels: 'default' })
    assert.ok(res.ok)
    const by = new Map(res.data.sources.map((s) => [s.layer, s.packId]))
    assert.equal(by.get(0), 'brewall')
    assert.equal(by.get(1), 'default')
    assert.deepEqual(
      res.data.points.filter((p) => p.layer === 1).map((p) => p.display),
      ['Sparse Default Label']
    )
    // A user-installed pack is selectable the same way.
    const mine = lib.get('befallen', { labels: 'mypack' })
    assert.ok(mine.ok)
    assert.deepEqual(
      mine.data.points.filter((p) => p.layer === 1).map((p) => p.display),
      ['My Own Label']
    )
  })
})

test('an unknown zone is a clean ok:false, not a throw', () => {
  withLibrary((lib) => {
    const res = lib.get('nosuchzone')
    assert.equal(res.ok, false)
    assert.match(res.ok ? '' : res.error, /nosuchzone/)
  })
})

// --- traversal --------------------------------------------------------------

test('traversal is rejected at the handler predicate and finds nothing if it ever got past', () => {
  // `maps:get`/`maps:search` validate `zone` and every packId with isSafePackId AT THE HANDLER
  // (src/main/ipc/maps.ts) — the same predicate `sounds:getData` uses for its packId. These are
  // the spellings that would otherwise reach a join() against a pack directory.
  const hostile = [
    '../../../Users/x/Documents/secret',
    '..\\..\\windows\\system32\\drivers\\etc\\hosts',
    '..',
    '.',
    '.hidden',
    'C:/Windows/System32/config/SAM',
    '//server/share/file',
    'zone\0name',
    'zone name',
    ''
  ]
  for (const id of hostile) assert.equal(isSafePackId(id), false, `must reject ${JSON.stringify(id)}`)
  // Every real stem and pack directory name passes unchanged — nothing here motivates widening.
  for (const ok of ['befallen', 'thurgadina1', 'poknowledge', 'newsebexp', 'cshome', 'brewall'])
    assert.equal(isSafePackId(ok), true, `must admit ${ok}`)

  // Defence in depth: the resolver is an INDEX lookup, not a path join on caller text, so even
  // an unvalidated traversal string resolves to no files at all.
  withLibrary((lib, fx) => {
    const packs = discoverPacks({ eqRoot: fx.eqRoot, userPacksRoot: fx.userPacksRoot })
    for (const id of hostile) assert.deepEqual(resolveZoneLayers(packs, id, {}), [])
    assert.equal(lib.get('../../../Users/x/Documents/secret').ok, false)
  })
})

test('nothing under the EQ root is ever written, created or touched', () => {
  // <eqRoot> is READ-ONLY by law: the game rewrites ~100 default maps on every launch and a
  // pack install would be clobbered anyway, so any future install goes to <userData>\mappacks.
  withLibrary((lib, fx) => {
    const before = treeSnapshot(fx.eqRoot)
    lib.packs()
    lib.zones()
    lib.get('befallen')
    lib.get('blackburrow', { geometry: 'brewall' })
    lib.search('commonlands')
    lib.refresh()
    assert.deepEqual(treeSnapshot(fx.eqRoot), before)
  })
})

// --- cache ------------------------------------------------------------------

test('a parsed zone is served from cache until refresh drops it', () => {
  withLibrary((lib) => {
    const first = lib.get('befallen')
    const second = lib.get('befallen')
    assert.ok(first.ok && second.ok)
    assert.equal(first.data, second.data, 'the second get must not re-parse')
    // A different pack preference is a different cache entry, not a stale hit.
    const other = lib.get('befallen', { labels: 'default' })
    assert.ok(other.ok)
    assert.notEqual(other.data, first.data)
    lib.refresh()
    const third = lib.get('befallen')
    assert.ok(third.ok)
    assert.notEqual(third.data, first.data)
  })
})

// --- search -----------------------------------------------------------------

test('search finds labels in one zone and across the corpus, comma-bearing ones included', () => {
  withLibrary((lib) => {
    assert.deepEqual(lib.search(''), [])
    assert.deepEqual(lib.search('   '), [])

    // In-zone: over the FULL parsed zone, so base-file points are searchable too.
    const inZone = lib.search('unpickable', { zone: 'befallen' })
    assert.equal(inZone.length, 1)
    assert.equal(inZone[0].point.display, 'Locked Door (Quests,Unpickable)')
    assert.equal(inZone[0].zone, 'befallen')
    assert.ok(lib.search('default base', { zone: 'befallen' }).length >= 1)

    // Corpus-wide: the label layers of every zone in every pack, resolved the same way.
    const corpus = lib.search('everfrost')
    assert.equal(corpus.length, 1)
    assert.equal(corpus[0].zone, 'blackburrow')
    assert.equal(corpus[0].point.display, 'to Everfrost')
    // Underscores are matched as spaces because `display` is what search sees.
    assert.ok(lib.search('ruined wagon').some((h) => h.point.display === 'GS: Ruined Wagon'))
    // The limit is honoured.
    assert.equal(lib.search('to', { limit: 1 }).length, 1)
  })
})

test('an in-zone search ranks over the SAME zone resolution get() returns for those prefs', () => {
  // In-zone search ranks over the FULL parsed zone, so it must parse that zone under the
  // CALLER'S prefs. Resolving it under defaults instead means that the moment a user overrides
  // the labels pack, the hit list ranks over labels that are not on the map they are looking at.
  withLibrary((lib) => {
    const prefs = { labels: 'mypack' }

    // Under DEFAULT prefs the label layer is brewall's: its labels rank, the user pack's do not.
    assert.equal(lib.search('unpickable', { zone: 'befallen' }).length, 1)
    assert.deepEqual(lib.search('my own', { zone: 'befallen' }), [])

    // Under the override it is exactly the other way round — and the hit is one of the very
    // point objects `get(zone, prefs)` hands the viewer, not a lookalike from another pack.
    const hits = lib.search('my own', { zone: 'befallen', prefs })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].point.display, 'My Own Label')
    const res = lib.get('befallen', prefs)
    assert.ok(res.ok)
    assert.ok(
      res.data.points.includes(hits[0].point),
      'the hit must be a point of the map get() resolves for these prefs'
    )
    // brewall's labels are not part of the zone under these prefs, so they cannot rank either.
    assert.deepEqual(lib.search('unpickable', { zone: 'befallen', prefs }), [])

    // The CORPUS index is deliberately default-prefs (one index, not one per preference), so it
    // is unaffected by the option — stated here so a future change to that is a failing test.
    assert.deepEqual(lib.search('my own', { prefs }), [])
  })
})
