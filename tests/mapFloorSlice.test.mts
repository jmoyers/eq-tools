// The map viewer's FLOOR SLICING (src/renderer/src/features/maps/floorSlice.ts) — the boundary
// between "the file lists these elevations" and "this dungeon has these floors".
//
// WHY THIS BOUNDARY EXISTS. `MapData.zLevels` is the distinct `min(z1,z2)` of every segment, and
// the default set's `crystallos.txt` yields 10,694 of them over 1,059 units. There is no floor
// list in any map file; the bands are INFERRED, and three ways of inferring them are silently
// wrong rather than loudly broken:
//
//   * PEELING OUTLIERS. Splitting at the globally largest gap — textbook single-linkage — puts
//     every cut at the zone's lonely extremes and leaves the fat middle whole. Measured on the
//     real crystallos: eleven slivers plus one band holding 6,737 of the 10,694 levels. It looks
//     like a working stepper right up until you use it. Pinned below by name.
//   * A NON-PARTITION. If bands overlap, or a level falls through the cracks, the render-time
//     predicate quietly shows or hides the same wall twice.
//   * IGNORING THE PACK'S OWN HINT. `Height_Filter:_25/25` is the mapmaker stating the band
//     height they drew for; it must actually change the answer.
//
// Arithmetic only — no React, no DOM, no map file — so this suite NEVER skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_BANDS,
  bandLabel,
  bandOfZ,
  bandRange,
  floorBands,
  inActiveBand,
  segmentZ
} from '../src/renderer/src/features/maps/floorSlice'

/** `n` levels spread evenly from `lo` to `hi` — a dense, gapless run, as a real dungeon is. */
function ramp(lo: number, hi: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1))
}

test('no z levels means no bands — the caller hides the control rather than showing one entry', () => {
  assert.deepEqual(floorBands([]), [])
})

test('a single elevation is one band covering exactly itself', () => {
  assert.deepEqual(floorBands([12]), [{ lo: 12, hi: 12, levels: 1 }])
})

test('two clusters separated by a void split into exactly those two clusters', () => {
  const bands = floorBands([...ramp(-100, -80, 20), ...ramp(180, 200, 20)])
  assert.equal(bands.length, 2)
  assert.deepEqual(
    bands.map((b) => [b.lo, b.hi, b.levels]),
    [
      [-100, -80, 20],
      [180, 200, 20]
    ]
  )
})

test("crystallos' 10,694 distinct levels collapse to the band cap, not to a picker", () => {
  // The real shape: a dense, essentially gapless ramp across a 1,059-unit z extent.
  const bands = floorBands(ramp(-552, 507, 10694))
  assert.equal(bands.length, MAX_BANDS)
  assert.equal(
    bands.reduce((n, b) => n + b.levels, 0),
    10694
  )
})

test('bands PARTITION the input: ascending, disjoint, and every level in exactly one', () => {
  const z = [...ramp(-300, -260, 400), ...ramp(-50, 120, 900), 700]
  const bands = floorBands(z)
  for (let i = 1; i < bands.length; i += 1) assert.ok(bands[i - 1].hi < bands[i].lo)
  assert.equal(
    bands.reduce((n, b) => n + b.levels, 0),
    z.length
  )
  for (const v of z) {
    const hits = bands.filter((b) => v >= b.lo && v <= b.hi)
    assert.equal(hits.length, 1, `z=${String(v)} landed in ${String(hits.length)} bands`)
  }
})

test('the fat middle gets cut — a dense core plus edge outliers does NOT peel slivers', () => {
  // The measured failure mode: single-linkage splitting at the largest gap put eleven cuts at
  // the extremes and left 63% of crystallos' levels in one band. Balanced bisection must not.
  const z = [-900, -880, -860, ...ramp(-400, 400, 4000), 860, 880, 900]
  const bands = floorBands(z)
  const biggest = Math.max(...bands.map((b) => b.levels))
  assert.ok(biggest < z.length / 2, `largest band holds ${String(biggest)} of ${String(z.length)}`)
})

test("the pack's Height_Filter hint widens the bands — befallen's 25/25 is load-bearing", () => {
  const z = ramp(-86, 0, 1583)
  const plain = floorBands(z)
  const hinted = floorBands(z, { hint: { low: 25, high: 25 } })
  assert.ok(hinted.length < plain.length, `${String(hinted.length)} !< ${String(plain.length)}`)
})

test('maxBands is honoured exactly — a caller can ask for a shorter stepper', () => {
  assert.equal(floorBands(ramp(0, 1000, 5000), { maxBands: 4 }).length, 4)
})

test('band ranges tile the whole axis, meeting at the midpoint of each void', () => {
  const bands = floorBands([...ramp(0, 10, 11), ...ramp(100, 110, 11)])
  assert.equal(bands.length, 2)
  assert.deepEqual(bandRange(bands, 0), { lo: -Infinity, hi: 55 })
  assert.deepEqual(bandRange(bands, 1), { lo: 55, hi: Infinity })
})

test('a z BETWEEN two floors joins the nearer one instead of vanishing from every slice', () => {
  const bands = floorBands([...ramp(0, 10, 11), ...ramp(100, 110, 11)])
  assert.equal(bandOfZ(bands, 10), 0)
  assert.equal(bandOfZ(bands, 40), 0)
  assert.equal(bandOfZ(bands, 90), 1)
  assert.equal(bandOfZ(bands, -9999), 0)
  assert.equal(bandOfZ(bands, 9999), 1)
})

test('All levels shows everything, and an empty band list can never hide anything', () => {
  const bands = floorBands([...ramp(0, 10, 11), ...ramp(100, 110, 11)])
  assert.equal(inActiveBand(bands, null, 5), true)
  assert.equal(inActiveBand(bands, null, 105), true)
  assert.equal(inActiveBand([], 0, 5), true)
  assert.equal(inActiveBand(bands, 0, 5), true)
  assert.equal(inActiveBand(bands, 0, 105), false)
  assert.equal(inActiveBand(bands, 1, 105), true)
})

test("a segment's floor is min(z1,z2) — the same rule the parser clustered on", () => {
  assert.equal(segmentZ(10, -4), -4)
  assert.equal(segmentZ(-4, 10), -4)
})

test('a band states its real z extremes and invents no units', () => {
  assert.equal(bandLabel({ lo: -552.4, hi: -426.2, levels: 85 }), '-552 … -426')
})
