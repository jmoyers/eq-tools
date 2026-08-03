// Classic-EQ map-file parser (src/main/maps/parseMap.ts) — the whole boundary.
//
// WHY THIS BOUNDARY EXISTS. `<eqRoot>\maps` is 1,900 text files the app does not own, written
// by at least six different authors across two decades, and every one of them is a user-
// supplied pack as far as this code is concerned. The format has exactly two record shapes and
// four ways to get them subtly wrong — each of which corrupts data SILENTLY rather than
// throwing, which is precisely why they need a test instead of a code review:
//
//   * `split(',')[7]` truncates the label of 1,607 of 35,720 P records (4.5% of the entire
//     corpus) and the search box is none the wiser.
//   * Unioning the layer-2 legend into the bounds renders every affected map as a speck.
//   * One malformed line in a pack must never blank a zone.
//
// The fixture is HAND-AUTHORED (tests/fixtures/map-synthetic*.txt). No real map file, and no
// content copied from one, is committed: eqmaps.info publishes no license, no terms of use and
// no redistribution grant, and this repo is public. A ~25-line synthetic file also exercises
// every edge case more legibly than a 1.7 MB real one.
//
// Pure: no Electron, no network, no game directory. This suite NEVER skips (the
// security.test.mts / imageCache.test.mts precedent).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LEGEND_LAYER,
  buildMapData,
  parseMapText,
  type MapParseResult
} from '../src/main/maps/parseMap'
import type { MapData, MapLayer } from '../src/shared/maps'

const FIXTURES = join(import.meta.dirname, 'fixtures')

function fixture(layer: MapLayer): MapParseResult {
  const name = layer === 0 ? 'map-synthetic.txt' : `map-synthetic_${String(layer)}.txt`
  return parseMapText(readFileSync(join(FIXTURES, name), 'utf8'), layer)
}

/** The four synthetic layers, folded exactly as the resolution layer will fold them. */
function synthetic(): MapData {
  const parts = [fixture(0), fixture(1), fixture(2), fixture(3)]
  return buildMapData(parts, {
    zone: 'synthetic',
    sources: parts.map((p) => ({
      layer: p.layer,
      packId: 'test',
      file: p.layer === 0 ? 'map-synthetic.txt' : `map-synthetic_${String(p.layer)}.txt`
    }))
  })
}

// ---- §2.2 edge cases — every row of the table, each one measured ------------------------

test('§2.2 #1 a label containing commas survives whole, tail joined not truncated', () => {
  // MEASURED: 1,607 of 35,720 P records (4.5% of the whole corpus) contain a comma in the label.
  const base = fixture(0)
  const labels = base.points.map((p) => p.label)
  assert.deepEqual(labels, ['Zone_Center', 'to_Somewhere_(click,_then_wait)'])

  const labelled = fixture(1)
  assert.ok(labelled.points.some((p) => p.label === 'Guard_Malforn,_the_Unyielding'))

  // The failure mode this test exists for, spelled out: naive indexing keeps only the head.
  const raw = 'P 1, 2, 3, 0, 0, 0, 2, Locked_Door_(Quests,Unpickable)'
  const [only] = parseMapText(raw, 1).points
  assert.equal(only.label, 'Locked_Door_(Quests,Unpickable)')
  assert.notEqual(only.label, raw.split(',')[7])
})

test('§2.2 #1b a comma-bearing label keeps its interior spacing byte-for-byte', () => {
  // Fields are trimmed individually, but the label tail is joined from the RAW pieces — a
  // per-field trim would eat the space in "Caudyr, Beimeith" style credits.
  const [p] = parseMapText('P 0, 0, 0, 0, 0, 0, 2, Alpha, Beta,  Gamma', 2).points
  assert.equal(p.label, 'Alpha, Beta,  Gamma')
  assert.equal(p.display, 'Alpha, Beta,  Gamma')
})

test('§2.2 #2 a label containing literal spaces parses, and display is idempotent on it', () => {
  // MEASURED: 3 records corpus-wide carry a literal space instead of an underscore.
  const [spaced] = fixture(1).points
  assert.equal(spaced.label, 'Frostspire Hall')
  assert.equal(spaced.display, 'Frostspire Hall')

  // Underscore labels: `label` stays RAW (law 2 — canonicalize at boundaries, display raw)
  // and `display` is the reader-facing form.
  const gs = fixture(1).points.find((p) => p.label.startsWith('GS:'))
  assert.ok(gs)
  assert.equal(gs.label, 'GS:_Nightmare_Fungus')
  assert.equal(gs.display, 'GS: Nightmare Fungus')
})

test('§2.2 #3 a base file may contain P records — record type is never keyed off filename', () => {
  // MEASURED: 1,362 P records live in default-set BASE files; shadowhaven.txt alone has 144.
  const base = fixture(0)
  assert.equal(base.points.length, 2)
  assert.equal(base.lines.count, 4)
  for (const p of base.points) assert.equal(p.layer, 0)
})

test('§2.2 #4/#5 parsing is filename-agnostic — the layer is an argument, not an inference', () => {
  // MEASURED: mixed-case stems (Thurgadina1_1.txt, CSHome_1.txt) and stems ending in their own
  // digit (thurgadina1 + layer 1) exist. Resolution owns the regex; the parser is handed the
  // answer, so the same text yields identical records under any layer but that layer's tag.
  const text = 'P 5, 6, 7, 0, 0, 0, 2, Same_Text\nL 0, 0, 0, 1, 1, 1, 1, 2, 3'
  const asOne = parseMapText(text, 1)
  const asThree = parseMapText(text, 3)
  assert.deepEqual(
    { ...asOne, layer: 0, points: asOne.points.map((p) => ({ ...p, layer: 0 })) },
    { ...asThree, layer: 0, points: asThree.points.map((p) => ({ ...p, layer: 0 })) }
  )
  assert.equal(asOne.points[0].layer, 1)
  assert.equal(asThree.points[0].layer, 3)
})

test('§2.2 #6 a zero-byte layer file is a valid empty layer, not an error', () => {
  // MEASURED: brewall\*_3.txt is exactly one real file, 0 bytes, 0 records.
  const empty = fixture(3)
  assert.deepEqual(empty, {
    layer: 3,
    lines: { coords: [], rgb: [], count: 0 },
    points: [],
    skipped: 0
  })
  // And it folds in without disturbing anything.
  assert.equal(synthetic().skipped, 1)
})

test('§2.2 #7 blank lines are skipped and are NOT counted as failures', () => {
  // MEASURED: 0 blank lines mid-file, but every file ends with one — tolerating them is free.
  const only = parseMapText('\n\n   \n\r\n', 0)
  assert.equal(only.lines.count, 0)
  assert.equal(only.points.length, 0)
  assert.equal(only.skipped, 0)
  // The fixture carries one mid-file blank line in the base and one in the label layer.
  assert.equal(fixture(1).points.length, 3)
})

test('CRLF and LF parse identically — the corpus is 100% CRLF', () => {
  // MEASURED: 1,875 of the 1,900 files contain CRLF; not one is LF-only.
  const body = 'L 0, 0, 0, 1, 1, 1, 0, 0, 0\nP 2, 3, 4, 0, 0, 0, 2, A_Label\n'
  assert.deepEqual(parseMapText(body.replace(/\n/g, '\r\n'), 0), parseMapText(body, 0))
})

test('a malformed line is COUNTED and dropped — never thrown on', () => {
  // MEASURED: 0 malformed lines in the shipped corpus. This is entirely about a user-supplied
  // pack: one bad line must not blank a zone, so `skipped` makes it diagnosable instead of
  // mysterious.
  const base = fixture(0)
  assert.equal(base.skipped, 1) // the truncated 5-field `L` in the fixture
  assert.equal(base.lines.count, 4) // ...and the four good segments are untouched

  const messy = parseMapText(
    [
      'L 1, 2, 3, 4, 5, 6, 0, 0, 0', // good
      'L 1, 2, 3, 4, 5, 6, 0, 0', // 8 fields
      'L 1, 2, 3, 4, 5, 6, 0, 0, 0, 0', // 10 fields
      'L 1, 2, 3, 4, 5, six, 0, 0, 0', // non-numeric
      'L 1, 2, 3, 4, 5, , 0, 0, 0', // empty field — Number('') is 0, so this needs its own guard
      'P 1, 2, 3, 0, 0, 0, 2', // 7 fields, no label
      '# a comment nobody writes', // unknown record type
      'X 1, 2, 3', // unknown record type
      'P 1, 2, 3, 0, 0, 0, 2, Fine' // good
    ].join('\r\n'),
    0
  )
  assert.equal(messy.lines.count, 1)
  assert.equal(messy.points.length, 1)
  assert.equal(messy.skipped, 7)
})

test('an empty label is data, not a parse failure', () => {
  // MEASURED: exactly one such record exists — kael.txt:4050 ends with a bare trailing comma.
  const r = parseMapText('P -1012.7191, 187.3108, -159.9364,  0, 0, 0,  3,', 0)
  assert.equal(r.skipped, 0)
  assert.equal(r.points.length, 1)
  assert.equal(r.points[0].label, '')
  assert.equal(r.points[0].size, 3)
})

test('fields carry arbitrary surrounding whitespace and every one is trimmed', () => {
  // The default set writes double spaces ("0, 0, 0,  3,  Steaon_(Alchemy)"); Brewall writes one.
  const [p] = parseMapText('P   10 ,  20 ,  30 ,   255 ,  210 ,   0 ,   1 ,   Banker_Ex', 1).points
  assert.deepEqual(
    { x: p.x, y: p.y, z: p.z, r: p.r, g: p.g, b: p.b, size: p.size, label: p.label },
    { x: 10, y: 20, z: 30, r: 255, g: 210, b: 0, size: 1, label: 'Banker_Ex' }
  )
})

// ---- §2.3 layer semantics — the legend layer -------------------------------------------

test('bounds EXCLUDE layer 2 — the legend is drawn far outside the map', () => {
  // MEASURED, brewall\airplane: the map is x[-1367..1773] y[-1668..1737] and airplane_1 (the
  // labels) sits inside it at x[-1700..1414] y[-1612..1800], but airplane_2 (the legend) spans
  // x[-250..2330] y[-250..4800]. Unioning it makes the whole zone render as a speck.
  const data = synthetic()
  assert.deepEqual(data.bounds, {
    minX: -100,
    maxX: 100,
    minY: -50,
    maxY: 50,
    minZ: 0,
    maxZ: 10
  })

  // Proof the legend really is out of bounds: it reaches y = 2600, x = 400.
  const legend = fixture(LEGEND_LAYER)
  assert.ok(legend.points.some((p) => p.y === 2600))
  assert.ok(Math.max(...legend.lines.coords.filter((_, i) => i % 3 === 0)) === 400)

  // And that including it WOULD have wrecked the extent.
  const wrong = buildMapData([fixture(0), fixture(1), fixture(2)], { zone: 'x', sources: [] })
  assert.equal(wrong.bounds.maxY, 50)
  const naive = buildMapData(
    [fixture(0), fixture(1), { ...fixture(2), layer: 1 }],
    { zone: 'x', sources: [] }
  )
  assert.equal(naive.bounds.maxY, 2600)
})

test('bounds include POINTS, not just line endpoints', () => {
  // MEASURED: a Brewall _1 layer is 26,607 points against 2,204 segments corpus-wide, so
  // line-only bounds would ignore the label layer almost entirely.
  const pointsOnly = parseMapText('P -7, 900, 3, 0, 0, 0, 2, Far_Away', 1)
  const data = buildMapData([pointsOnly], { zone: 'x', sources: [] })
  assert.deepEqual(data.bounds, {
    minX: -7,
    maxX: -7,
    minY: 900,
    maxY: 900,
    minZ: 3,
    maxZ: 3
  })
})

test('bounds on an entirely empty zone are zeroed, not Infinity', () => {
  const data = buildMapData([parseMapText('', 0)], { zone: 'x', sources: [] })
  assert.deepEqual(data.bounds, { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 })
  assert.deepEqual(data.zLevels, [])
  assert.deepEqual(data.credits, [])
  assert.equal(data.heightHint, undefined)
})

test('layer 2 geometry is still CARRIED — excluded from extent, not from the payload', () => {
  // §2.3: the legend is OFF by default but toggleable, and MapLines.layer is what lets the
  // renderer toggle it without re-fetching. Dropping it here would make that impossible.
  const data = synthetic()
  assert.equal(data.lines.count, 6) // 4 base + 0 label + 2 legend
  assert.deepEqual([...data.lines.layer], [0, 0, 0, 0, 2, 2])
  assert.equal(data.points.length, 9) // 2 base + 3 label + 4 legend
})

test('heightHint is mined from layer 2 and only from layer 2', () => {
  // MEASURED: `Height_Filter:_N/M` appears in 51 of 577 Brewall _2 files; 25/25 is the mode (15×).
  assert.deepEqual(synthetic().heightHint, { low: 25, high: 25 })

  // The same label in a drawn layer is a POI, not a hint — the convention is legend-only.
  const misplaced = buildMapData([parseMapText('P 0,0,0,0,0,0,2,Height_Filter:_50/50', 1)], {
    zone: 'x',
    sources: []
  })
  assert.equal(misplaced.heightHint, undefined)

  // A trailing parenthetical qualifier is real and must not defeat the match.
  const qualified = buildMapData(
    [parseMapText('P 0,0,0,0,0,0,2,Height_Filter:_10/10_(in_Dwarf_Keep)', 2)],
    { zone: 'x', sources: [] }
  )
  assert.deepEqual(qualified.heightHint, { low: 10, high: 10 })

  // Asymmetric bands exist (one file: 50/25 in tunnels); first number is `low`.
  const asym = buildMapData([parseMapText('P 0,0,0,0,0,0,2,Height_Filter:_50/25', 2)], {
    zone: 'x',
    sources: []
  })
  assert.deepEqual(asym.heightHint, { low: 50, high: 25 })
})

test('credits are mined from layer 2 label points, deduped, in reader-facing form', () => {
  // MEASURED: the credit points are the ONLY attribution these packs ship — Original_Map: (~420),
  // Revised_Map: (343), http://www.eqmaps.info (568), Return_of_the_Exiled_(www...) (568).
  assert.deepEqual(synthetic().credits, [
    'Original Map: Synthetic Fixture',
    'http://example.invalid/maps'
  ])

  const shapes = buildMapData(
    [
      parseMapText(
        [
          'P 0,0,0,0,0,0,2,Original_Map:_Caudyr,_Beimeith,_&_Rorce',
          'P 0,0,0,0,0,0,2,Original__Map:_Typo_In_The_Real_Corpus',
          'P 0,0,0,0,0,0,2,Revised_Map:_Someone_(Server)',
          'P 0,0,0,0,0,0,2,Some_Guild_(www.example.invalid)',
          'P 0,0,0,0,0,0,2,Original_Map:_Caudyr,_Beimeith,_&_Rorce',
          'P 0,0,0,0,0,0,2,a_regular_legend_swatch'
        ].join('\n'),
        2
      )
    ],
    { zone: 'x', sources: [] }
  )
  assert.deepEqual(shapes.credits, [
    // A comma-bearing credit — the join-the-tail rule is what makes this one whole.
    'Original Map: Caudyr, Beimeith, & Rorce',
    'Original  Map: Typo In The Real Corpus',
    'Revised Map: Someone (Server)',
    'Some Guild (www.example.invalid)'
  ])
})

// ---- §8 z levels -----------------------------------------------------------------------

test('zLevels are the distinct min(z1,z2) per segment, ascending, excluding layer 2', () => {
  // min() rather than both endpoints is deliberate: a sloped segment spanning two floors would
  // otherwise smear the clusters. MEASURED: crystallos.txt alone yields 10,694 distinct values,
  // which is why grouping them into human "levels" is the height-filter wave's job, not this one.
  const data = synthetic()
  // The fixture's fourth segment runs z 10 -> 0, so min() must report 0 and not 10.
  assert.deepEqual(data.zLevels, [0, 10])

  const sloped = buildMapData(
    [
      parseMapText(
        ['L 0,0,40, 1,1,10, 0,0,0', 'L 0,0,30, 1,1,30, 0,0,0', 'L 0,0,10, 1,1,90, 0,0,0'].join(
          '\n'
        ),
        0
      )
    ],
    { zone: 'x', sources: [] }
  )
  assert.deepEqual(sloped.zLevels, [10, 30])

  // Points do not create floors — only geometry does.
  const pointy = buildMapData([parseMapText('P 0,0,777,0,0,0,2,High_Up', 1)], {
    zone: 'x',
    sources: []
  })
  assert.deepEqual(pointy.zLevels, [])
})

// ---- §3 columnar assembly --------------------------------------------------------------

test('lines are columnar and colour-bucketed, with one palette slot per distinct colour', () => {
  // MEASURED max is 19 distinct colours in one real file (buriedsea.txt) against 26,383
  // segments (everfrost.txt) — which is the entire argument for one Path2D per palette entry.
  const data = synthetic()
  assert.equal(data.lines.count, 6)
  assert.equal(data.lines.coords.length, 6 * 6)
  assert.equal(data.lines.colorIndex.length, 6)
  assert.equal(data.lines.layer.length, 6)
  // black (base), blue (base), red (legend) — blue is reused by the legend, not re-added.
  assert.deepEqual([...data.lines.palette], [0, 0, 0, 0, 0, 255, 255, 0, 0])
  assert.deepEqual([...data.lines.colorIndex], [0, 0, 1, 1, 2, 1])
  // First segment, verbatim from the fixture's first line.
  assert.deepEqual([...data.lines.coords.slice(0, 6)], [-100, -50, 0, 100, -50, 0])
})

test('colour channels are clamped to 0-255 and size to the 1..3 text class', () => {
  // MEASURED: every real record is already in range. This is the user-pack guard.
  const [p] = parseMapText('P 0, 0, 0, -20, 300, 127.6, 9, Odd', 1).points
  assert.deepEqual({ r: p.r, g: p.g, b: p.b, size: p.size }, { r: 0, g: 255, b: 128, size: 3 })
  const data = buildMapData([parseMapText('L 0,0,0, 1,1,1, -5, 999, 12', 0)], {
    zone: 'x',
    sources: []
  })
  assert.deepEqual([...data.lines.palette], [0, 255, 12])
})

test('the palette cannot overflow its Uint8Array index — 256 slots, then fold to slot 0', () => {
  // Headroom check, not a real case: the worst real file uses 19 colours. Geometry is never
  // dropped, because a wrongly-coloured stroke beats a missing wall.
  const lines: string[] = []
  for (let i = 0; i < 300; i += 1) {
    lines.push(`L 0,0,0, 1,1,1, ${String(i % 2)}, ${String((i >> 1) % 256)}, ${String(i)}`)
  }
  const data = buildMapData([parseMapText(lines.join('\n'), 0)], { zone: 'x', sources: [] })
  assert.equal(data.lines.count, 300)
  assert.equal(data.lines.palette.length, 256 * 3)
  assert.equal(data.lines.colorIndex[299], 0)
})

test('buildMapData folds layers in any order and sums skipped across all of them', () => {
  const parts = [fixture(2), fixture(3), fixture(0), fixture(1)]
  const data = buildMapData(parts, { zone: 'synthetic', sources: [] })
  assert.equal(data.skipped, 1)
  assert.equal(data.points.length, 9)
  assert.deepEqual(data.bounds, synthetic().bounds)
  assert.deepEqual(data.zLevels, synthetic().zLevels)
  assert.deepEqual(data.credits, synthetic().credits)
})

test('sources travel through untouched — the UI must be able to state each layer honestly', () => {
  // §6.3: geometry and labels routinely come from DIFFERENT packs, and silently merging two
  // packs while naming one is exactly the unlabelled inference the world-model laws forbid.
  const data = synthetic()
  assert.equal(data.zone, 'synthetic')
  assert.deepEqual(
    data.sources.map((s) => s.layer),
    [0, 1, 2, 3]
  )
  assert.equal(data.sources[1].file, 'map-synthetic_1.txt')
})
