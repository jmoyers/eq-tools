// Pure unit tests for the leveling charts' shared geometry + lookups
// (src/renderer/src/features/leveling/levelChartGeometry.ts).
//
// No log, no fixture, no DOM — so this file never skips. It pins the three things a
// hover readout can get quietly wrong:
//   1. the X mapping is EXACTLY the arithmetic the charts already drew with (an
//      extraction that shifts pixels is a regression nobody sees until they hover);
//   2. `preserveAspectRatio="none"` means CSS px are NOT viewBox units — the whole
//      reason a raw clientX is wrong on these two charts;
//   3. the level at a cursor is a STEP lookup with an explicit "unknown" arm across a
//      class swap. The swap-gap arm has no `level` field at all (levelSeries.ts's world
//      model: the swap is never logged), so this suite proves the arm is reached rather
//      than trusting the type to be used.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHART_W,
  cumulativeAt,
  fmtDelta,
  levelAt,
  pxToUser,
  stepIndexAt,
  tOf,
  xOf,
  type ChartScale
} from '../src/renderer/src/features/leveling/levelChartGeometry'
import type { LevelSegment } from '../src/renderer/src/features/leveling/levelSeries'

const T0 = Date.parse('2026-07-28T12:00:00')
const H = 3_600_000

/** The AA chart's scale: domain = first..last point, pad 8, no trailing pad. */
const aaScale: ChartScale = { t0: T0, t1: T0 + 10 * H, w: CHART_W, padX: 8 }

test('xOf reproduces the inline arithmetic the charts drew with, endpoints included', () => {
  // The pre-extraction body, verbatim: pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2*pad).
  const legacy = (t: number): number =>
    8 + ((t - aaScale.t0) / Math.max(1, aaScale.t1 - aaScale.t0)) * (CHART_W - 16)
  for (const t of [T0, T0 + H, T0 + 5 * H, T0 + 9.5 * H, T0 + 10 * H]) {
    assert.equal(xOf(aaScale, t), legacy(t), `x(${t}) must not move`)
  }
  assert.equal(xOf(aaScale, T0), 8, 'the first point sits on the left pad')
  assert.equal(xOf(aaScale, T0 + 10 * H), CHART_W - 8, 'the last point sits on the right pad')
})

test('a degenerate (zero-width) domain does not divide by zero', () => {
  const flat: ChartScale = { t0: T0, t1: T0, w: CHART_W, padX: 8 }
  assert.equal(xOf(flat, T0), 8)
  assert.ok(Number.isFinite(xOf(flat, T0 + 1)), 'still finite one ms past a flat domain')
})

test('tOf is the exact inverse of xOf, in both directions', () => {
  const scale: ChartScale = { t0: T0, t1: T0 + 37 * H, w: CHART_W, padX: 8 }
  for (const t of [T0, T0 + 1234, T0 + 11 * H, T0 + 37 * H]) {
    assert.ok(Math.abs(tOf(scale, xOf(scale, t)) - t) < 1e-6, `round-trip ts ${t}`)
  }
  for (const ux of [8, 100, 360, CHART_W - 8]) {
    assert.ok(Math.abs(xOf(scale, tOf(scale, ux)) - ux) < 1e-9, `round-trip user-x ${ux}`)
  }
})

test('tOf clamps nothing — it reports the time OFF the plot honestly', () => {
  // Callers decide what to do outside the pads; the mapping itself must stay linear so a
  // hover 3px into the left pad does not silently snap to the first sample.
  assert.ok(tOf(aaScale, 0) < aaScale.t0, 'left of the pad is before the domain')
  assert.ok(tOf(aaScale, CHART_W) > aaScale.t1, 'right of the pad is after the domain')
})

test('pxToUser undoes the stretched viewBox (X is not 1:1 on these charts)', () => {
  // A 1440-px-wide element renders the 720-unit viewBox at 2x horizontally.
  assert.equal(pxToUser(0, 1440), 0)
  assert.equal(pxToUser(1440, 1440), CHART_W)
  assert.equal(pxToUser(720, 1440), CHART_W / 2)
  // A NARROWER element compresses instead — the same px is further right in user units.
  assert.equal(pxToUser(180, 360), CHART_W / 2)
  assert.ok(pxToUser(100, 360) > pxToUser(100, 1440), 'narrower element ⇒ more user units per px')
  // Degenerate rect (unmeasured element) must not produce NaN/Infinity.
  assert.equal(pxToUser(50, 0), 0)
})

test('pxToUser composed with tOf lands a cursor on the right sample', () => {
  const rectW = 1440
  // Cursor exactly on the last AA point: user x = 712 ⇒ css x = 712/720 * 1440.
  const cssX = (xOf(aaScale, aaScale.t1) / CHART_W) * rectW
  const ts = tOf(aaScale, pxToUser(cssX, rectW))
  assert.ok(Math.abs(ts - aaScale.t1) < 1, 'cursor over the final point resolves to its time')
})

// ---------------------------------------------------------------------------
// levelAt — the honesty arms
// ---------------------------------------------------------------------------

/** Two loadouts: 10→12 over three dings, then a swap down to 5 and one more ding. */
const segments: LevelSegment[] = [
  {
    points: [
      { ts: T0, level: 10 },
      { ts: T0 + 2 * H, level: 11 },
      { ts: T0 + 5 * H, level: 12 }
    ],
    afterSwap: false
  },
  {
    points: [
      { ts: T0 + 20 * H, level: 5 },
      { ts: T0 + 21 * H, level: 6 }
    ],
    afterSwap: true
  }
]

test('levelAt before the first ding refuses to name a level', () => {
  const r = levelAt(segments, T0 - 1)
  assert.equal(r.kind, 'before-first')
  assert.equal(levelAt([], T0).kind, 'before-first', 'an empty series is also before-first')
})

test('levelAt inside a segment is a STEP: the level holds until the next ding', () => {
  for (const [ts, level] of [
    [T0, 10],
    [T0 + H, 10],
    [T0 + 2 * H - 1, 10],
    [T0 + 2 * H, 11],
    [T0 + 4 * H, 11]
  ] as const) {
    const r = levelAt(segments, ts)
    assert.equal(r.kind, 'level')
    if (r.kind !== 'level') return
    assert.equal(r.level, level, `level at +${(ts - T0) / H}h`)
  }
  const mid = levelAt(segments, T0 + H)
  assert.equal(mid.kind, 'level')
  if (mid.kind !== 'level') return
  assert.equal(mid.sinceTs, T0, 'sinceTs is the ding that put you here')
  assert.equal(mid.nextTs, T0 + 2 * H, 'nextTs is the ding that took you off it')
})

test('levelAt across an unlogged class swap returns the gap arm, with NO level', () => {
  // Anywhere from the last pre-swap ding up to the first post-swap ding.
  for (const ts of [T0 + 5 * H, T0 + 9 * H, T0 + 20 * H - 1]) {
    const r = levelAt(segments, ts)
    assert.equal(r.kind, 'swap-gap', `+${(ts - T0) / H}h is inside the swap gap`)
    if (r.kind !== 'swap-gap') return
    assert.equal(r.beforeLevel, 12)
    assert.equal(r.afterLevel, 5)
    assert.equal(r.gapMs, 15 * H)
    // The whole point of the discriminated union: there is nothing to render as "the level".
    assert.equal('level' in r, false, 'the swap-gap arm must not carry a level field')
  }
})

test('levelAt after the last ding is the CURRENT level (nextTs null), not a gap', () => {
  const r = levelAt(segments, T0 + 100 * H)
  assert.equal(r.kind, 'level')
  if (r.kind !== 'level') return
  assert.equal(r.level, 6)
  assert.equal(r.sinceTs, T0 + 21 * H)
  assert.equal(r.nextTs, null, 'null nextTs is what the tooltip reads as "current level"')
})

test('levelAt handles a single-point segment before a swap (gap opens immediately)', () => {
  const segs: LevelSegment[] = [
    { points: [{ ts: T0, level: 50 }], afterSwap: false },
    { points: [{ ts: T0 + 3 * H, level: 11 }], afterSwap: true }
  ]
  const r = levelAt(segs, T0 + H)
  assert.equal(r.kind, 'swap-gap')
  if (r.kind !== 'swap-gap') return
  assert.equal(r.beforeLevel, 50)
  assert.equal(r.afterLevel, 11)
})

// ---------------------------------------------------------------------------
// cumulativeAt / stepIndexAt
// ---------------------------------------------------------------------------

const aaPoints = [
  { ts: T0 + H, y: 4, nowHave: 4 },
  { ts: T0 + 2 * H, y: 9, nowHave: 9 },
  { ts: T0 + 6 * H, y: 13, nowHave: 2 }
]

test('cumulativeAt is a step lookup, never an interpolation', () => {
  assert.equal(cumulativeAt(aaPoints, T0), null, 'before the first gain there is no cumulative')
  assert.equal(cumulativeAt(aaPoints, T0 + H - 1), null)
  assert.equal(cumulativeAt(aaPoints, T0 + H), 4, 'the gain itself counts immediately')
  // Halfway between 9 and 13 an interpolation would say 11. The curve is a step: 9.
  assert.equal(cumulativeAt(aaPoints, T0 + 4 * H), 9)
  assert.equal(cumulativeAt(aaPoints, T0 + 6 * H), 13)
  assert.equal(cumulativeAt(aaPoints, T0 + 900 * H), 13, 'past the end it holds')
  assert.equal(cumulativeAt([], T0), null)
})

test('stepIndexAt binary-searches to the same answer as a linear scan', () => {
  const pts = Array.from({ length: 200 }, (_, i) => ({ ts: T0 + i * 1000 }))
  const linear = (ts: number): number => {
    let ans = -1
    for (const [i, p] of pts.entries()) if (p.ts <= ts) ans = i
    return ans
  }
  for (const ts of [T0 - 5, T0, T0 + 999, T0 + 1000, T0 + 77_500, T0 + 199_000, T0 + 1e6]) {
    assert.equal(stepIndexAt(pts, ts), linear(ts), `step index at ${ts}`)
  }
})

test('fmtDelta keeps the leveling view’s existing duration shapes', () => {
  assert.equal(fmtDelta(0), '—')
  assert.equal(fmtDelta(-1), '—')
  assert.equal(fmtDelta(90_000), '2m')
  assert.equal(fmtDelta(3 * H), '3.0h')
  assert.equal(fmtDelta(47 * H), '47.0h')
  assert.equal(fmtDelta(72 * H), '3.0d')
})
