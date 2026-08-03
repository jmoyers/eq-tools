// Pure unit tests for the leveling charts' zone-band shaping
// (src/renderer/src/features/leveling/zoneBands.ts).
//
// No log, no fixture, no DOM — so this file never skips. It pins the four things the band
// strip can get quietly wrong:
//   1. the MERGE. 81 of the 344 real post-epoch zone intervals are under 60 s and most are
//      instance re-entry bounces of the SAME place; unmerged they are sub-pixel slivers
//      splitting one visit in two. A merge that stops folding instance suffixes silently
//      re-fragments the strip.
//   2. the CLIP. The still-open final interval has `zoneEnd === 0` — read literally that is
//      1970, which would draw the current zone as a band across the entire chart.
//   3. the PALETTE. A zone's color must be stable across sessions and identical whether the
//      caller holds the raw display name or the folded key (the strip has one, a stats row
//      has the other).
//   4. the SUB-PIXEL DROP, which is a DRAWING rule only: a dropped band is still in the
//      band list and still in every statistic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ZONE_PALETTE,
  bandRects,
  chartDomain,
  mergeZoneBands,
  zoneAt,
  zoneColor,
  zoneLegend,
  type ZoneColumns
} from '../src/renderer/src/features/leveling/zoneBands'
import { CHART_W, xOf } from '../src/renderer/src/features/leveling/levelChartGeometry'
import type { ProgressionSnap } from '../src/shared/progressionTypes'

const T0 = Date.parse('2026-08-02T12:00:00')
const M = 60_000
const H = 3_600_000

function cols(rows: [string, number, number][], lastTs: number): ZoneColumns {
  return {
    zoneStart: rows.map((r) => r[1]),
    zoneEnd: rows.map((r) => r[2]),
    zoneName: rows.map((r) => r[0]),
    lastTs
  }
}

function blankSnap(): ProgressionSnap {
  return {
    expTs: [], expPct: [], expFlag: [],
    killTs: [], killZone: [], killCredit: [],
    witnessTs: [],
    lootTs: [],
    zoneStart: [], zoneEnd: [], zoneName: [],
    levelTs: [], levelValue: [], aaGainTs: [], aaGainAmount: [],
    lastTs: 0, windowStart: 0, dropped: 0
  }
}

test('consecutive intervals of the same zone merge into one band', () => {
  const bands = mergeZoneBands(
    cols(
      [
        ['Befallen', T0, T0 + 30 * M],
        ['Befallen', T0 + 30 * M, T0 + 30 * M + 4000],
        ['Befallen', T0 + 30 * M + 4000, T0 + H],
        ["Nagafen's Lair", T0 + H, T0 + 2 * H]
      ],
      T0 + 2 * H
    ),
    T0,
    T0 + 2 * H
  )
  assert.equal(bands.length, 2, 'three Befallen bounces are ONE stay')
  assert.equal(bands[0].name, 'Befallen')
  assert.equal(bands[0].start, T0)
  assert.equal(bands[0].end, T0 + H, 'the merged band runs to the end of the last bounce')
  assert.equal(bands[1].end, T0 + 2 * H)
})

test('instance tier / solo-group noise folds to the same zone', () => {
  // Real log shapes: "The Ruins of Old Paineel - Solo 4 (Refined)", "The Plane of Hate - Solo".
  const bands = mergeZoneBands(
    cols(
      [
        ['The Plane of Hate', T0, T0 + 10 * M],
        ['The Plane of Hate - Solo', T0 + 10 * M, T0 + 20 * M],
        ['The Plane of Hate 2 (Awakened)', T0 + 20 * M, T0 + 30 * M]
      ],
      T0 + 30 * M
    ),
    T0,
    T0 + 30 * M
  )
  assert.equal(bands.length, 1, 'one place, re-entered twice')
  assert.equal(bands[0].name, 'The Plane of Hate', 'the RAW first-seen name is what displays')
})

test('a different zone between two visits does NOT merge them', () => {
  const bands = mergeZoneBands(
    cols(
      [
        ['Befallen', T0, T0 + 10 * M],
        ['The Commonlands', T0 + 10 * M, T0 + 11 * M],
        ['Befallen', T0 + 11 * M, T0 + 30 * M]
      ],
      T0 + 30 * M
    ),
    T0,
    T0 + 30 * M
  )
  assert.equal(bands.length, 3)
  assert.deepEqual(bands.map((b) => b.name), ['Befallen', 'The Commonlands', 'Befallen'])
})

test('the still-open final interval clamps to lastTs, then to the domain', () => {
  const open = cols([['Befallen', T0, 0]], T0 + 3 * H)
  assert.equal(mergeZoneBands(open, T0, T0 + 10 * H)[0].end, T0 + 3 * H, 'clamped to the last folded event')
  assert.equal(mergeZoneBands(open, T0, T0 + H)[0].end, T0 + H, 'and then to the visible domain')
})

test('intervals outside the domain are dropped and partial ones are clipped', () => {
  const c = cols(
    [
      ['Befallen', T0 - 5 * H, T0 - 4 * H],
      ['Najena', T0 - M, T0 + M],
      ['Guk', T0 + 5 * H, T0 + 6 * H]
    ],
    T0 + 6 * H
  )
  const bands = mergeZoneBands(c, T0, T0 + H)
  assert.equal(bands.length, 1, 'only the interval overlapping the domain survives')
  assert.equal(bands[0].name, 'Najena')
  assert.equal(bands[0].start, T0, 'the head is clipped to the domain, never drawn off-canvas')
  assert.equal(bands[0].end, T0 + M)
})

test('zoneColor is stable and agrees whichever spelling the caller holds', () => {
  const raw = "Nagafen's Lair"
  assert.equal(zoneColor(raw), zoneColor(raw), 'stable across calls')
  assert.equal(zoneColor(raw), zoneColor("NAGAFEN'S LAIR"), 'case-insensitive')
  assert.equal(zoneColor('The Plane of Hate'), zoneColor('The Plane of Hate - Solo'), 'instance noise folds')
  assert.equal(zoneColor(raw), zoneColor(mergeZoneBands(cols([[raw, T0, T0 + H]], T0 + H), T0, T0 + H)[0].key))
  for (const z of ['Befallen', 'Najena', 'Guk', 'The Plane of Sky', '']) {
    assert.ok(ZONE_PALETTE.includes(zoneColor(z)), `${z} lands inside the palette`)
  }
})

test('bandRects drops sub-pixel bands from the DRAWING only', () => {
  const scale = { t0: T0, t1: T0 + 24 * H, w: CHART_W, padX: 8 }
  // 24h across ~704 usable units ⇒ ~2 minutes per unit. A 20-second visit is sub-pixel.
  const bands = mergeZoneBands(
    cols(
      [
        ['Befallen', T0, T0 + 12 * H],
        ['Najena', T0 + 12 * H, T0 + 12 * H + 20_000],
        ['Guk', T0 + 12 * H + 20_000, T0 + 24 * H]
      ],
      T0 + 24 * H
    ),
    scale.t0,
    scale.t1
  )
  assert.equal(bands.length, 3, 'all three are in the DATA')
  const rects = bandRects(bands, scale)
  assert.deepEqual(rects.map((r) => r.name), ['Befallen', 'Guk'], 'the sliver is not drawn')
  assert.ok(Math.abs(rects[0].x - xOf(scale, T0)) < 1e-9, 'rect x is the chart mapping, not a second copy')
  assert.ok(rects[0].w > 300 && rects[1].w > 300)
  assert.equal(bandRects(bands, scale, 0).length, 3, 'the threshold is the only reason it went')
})

test('the legend ranks zones by dwell and counts the overflow', () => {
  const rows: [string, number, number][] = []
  // 10 distinct zones, each visited for (i+1) hours, interleaved so the merge cannot fold them.
  let t = T0
  for (let i = 0; i < 10; i++) {
    rows.push([`Zone ${i}`, t, t + (i + 1) * H])
    t += (i + 1) * H
  }
  const bands = mergeZoneBands(cols(rows, t), T0, t)
  const legend = zoneLegend(bands)
  assert.equal(legend.rows.length, 8)
  assert.equal(legend.more, 2, 'the two smallest are counted, never silently dropped')
  assert.equal(legend.rows[0].name, 'Zone 9', 'longest dwell first')
  assert.equal(legend.rows[0].ms, 10 * H)
  assert.equal(legend.rows[0].color, zoneColor('Zone 9'))
})

test('the legend sums every visit of a zone across the domain', () => {
  const bands = mergeZoneBands(
    cols(
      [
        ['Befallen', T0, T0 + H],
        ['Najena', T0 + H, T0 + 2 * H],
        ['Befallen', T0 + 2 * H, T0 + 4 * H]
      ],
      T0 + 4 * H
    ),
    T0,
    T0 + 4 * H
  )
  const legend = zoneLegend(bands)
  assert.equal(legend.rows[0].name, 'Befallen')
  assert.equal(legend.rows[0].ms, 3 * H, 'two visits, one row')
  assert.equal(legend.more, 0)
})

// zoneAt — the hover readout's zone. It reads the SAME merged list the strip draws, so the
// tooltip and the band under the cursor cannot disagree; and it returns null rather than a
// nearest-neighbour guess wherever the log does not say where you were (law 1).

test('zoneAt finds the covering band and respects half-open bounds', () => {
  const bands = mergeZoneBands(
    cols(
      [
        ['Befallen', T0, T0 + H],
        ["Nagafen's Lair", T0 + H, T0 + 2 * H]
      ],
      T0 + 2 * H
    ),
    T0,
    T0 + 2 * H
  )
  assert.equal(zoneAt(bands, T0 + 30 * M)?.name, 'Befallen', 'mid-band')
  assert.equal(zoneAt(bands, T0)?.name, 'Befallen', 'start is INSIDE the band')
  assert.equal(zoneAt(bands, T0 + H)?.name, "Nagafen's Lair", 'the boundary instant belongs to the NEW zone, not both')
  assert.equal(zoneAt(bands, T0 + 2 * H), null, 'the far end is exclusive')
  assert.equal(zoneAt(bands, T0 + 2 * H - 1)?.name, "Nagafen's Lair", 'one ms inside still hits')
})

test('zoneAt is null before the first band and inside a gap', () => {
  const bands = mergeZoneBands(
    cols(
      [
        ['Najena', T0 + H, T0 + 2 * H],
        ['Guk', T0 + 5 * H, T0 + 6 * H]
      ],
      T0 + 6 * H
    ),
    T0,
    T0 + 6 * H
  )
  assert.equal(zoneAt(bands, T0), null, 'pre-first-zone: the log has not said where you are')
  assert.equal(zoneAt(bands, T0 + 3 * H), null, 'a hole in the capped zone column is never filled in')
  assert.equal(zoneAt([], T0 + H), null, 'no bands at all')
})

test('zoneAt reports a merged instance bounce as its base zone', () => {
  // The strip draws ONE Plane of Hate band across all three intervals; the tooltip must say
  // the same thing at every instant inside it, including inside the instanced re-entry.
  const bands = mergeZoneBands(
    cols(
      [
        ['The Plane of Hate', T0, T0 + 10 * M],
        ['The Plane of Hate - Solo', T0 + 10 * M, T0 + 20 * M],
        ['The Plane of Hate 2 (Awakened)', T0 + 20 * M, T0 + 30 * M]
      ],
      T0 + 30 * M
    ),
    T0,
    T0 + 30 * M
  )
  assert.equal(bands.length, 1)
  for (const ts of [T0, T0 + 15 * M, T0 + 25 * M]) {
    assert.equal(zoneAt(bands, ts)?.name, 'The Plane of Hate', 'the raw first-seen spelling, everywhere in the stay')
    assert.equal(zoneColor(zoneAt(bands, ts)?.key ?? ''), zoneColor('The Plane of Hate'), "and the strip's own hue")
  }
})

test('zoneAt agrees with a linear scan over many bands (binary search sanity)', () => {
  const rows: [string, number, number][] = []
  let t = T0
  for (let i = 0; i < 40; i++) {
    rows.push([`Zone ${i}`, t, t + 10 * M])
    t += 10 * M
  }
  const bands = mergeZoneBands(cols(rows, t), T0, t)
  assert.equal(bands.length, 40)
  for (let ts = T0 - M; ts <= t + M; ts += 137_000) {
    const linear = bands.find((b) => ts >= b.start && ts < b.end) ?? null
    assert.equal(zoneAt(bands, ts), linear, `ts ${ts - T0}`)
  }
})

test('chartDomain spans every series and keeps the 4% trailing pad', () => {
  const snap = blankSnap()
  snap.expTs = [T0 + H, T0 + 5 * H]
  snap.zoneStart = [T0 + 2 * H]
  snap.lastTs = T0 + 5 * H
  const scale = chartDomain(snap, [T0, T0 + 3 * H])
  assert.ok(scale)
  assert.equal(scale.t0, T0, 'the earliest timestamp of ANY series opens the domain')
  const span = 5 * H
  assert.equal(scale.t1, T0 + span + span * 0.04, 'trailing pad preserved from the level chart')
  assert.equal(scale.w, CHART_W)
})

test('chartDomain is null when nothing has a timestamp at all', () => {
  assert.equal(chartDomain(blankSnap(), []), null)
  assert.equal(chartDomain(blankSnap(), [0]), null, 'a 0 ts means "unknown" everywhere in this app')
})
