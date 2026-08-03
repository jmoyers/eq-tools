// Pure unit tests for the DPS curve's hover geometry
// (src/renderer/src/features/combat/dpsChart.ts).
//
// No log, no fixture, no DOM — so this file never skips. It pins the things this hover can get
// quietly wrong, every one of them invisible until someone points at a tick and is told about a
// different one:
//   1. `tAtUserX` is the EXACT inverse of `xAtT`, the mapping the markers are placed with. If the
//      two drift, a marker hovered at its own pixel resolves to somebody else's instant.
//   2. `preserveAspectRatio="none"` means CSS px are NOT viewBox units on this chart — the whole
//      reason a raw `clientX - rect.left` is wrong here, and the reason a "5 px" grab radius has
//      to be converted rather than multiplied in.
//   3. The hover DOT reads the drawn polyline's own vertices, so it rides the line instead of
//      floating beside it — including at the clamped edges and on a one-bucket fight.
//   4. `placeMarkers` DROPS what scrolled out of a live window rather than clamping it to the
//      edge, so the hover population is exactly what the chart drew.
//   5. ONE TIME BASE: markers and curve share `{t0, t1}`. A marker at a bucket's centre lands on
//      that bucket's own drawn vertex, and a live window advances in WHOLE buckets — the two pins
//      for the reported jitter, where an exact-time marker mapping was scaled against a
//      wall-clock right edge while the curve only moved when a bucket completed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TimelineMarker, TimelineView } from '../src/shared/combat'
import type { DpsSeries } from '../src/renderer/src/features/combat/dashboardData'
import { dpsAt } from '../src/renderer/src/features/combat/dpsAt'
import {
  CHART_W,
  PAD_X,
  bucketCenterMs,
  buildDpsChart,
  curveYAtUserX,
  placeMarkers,
  pxToUser,
  tAtUserX,
  userToPx,
  xAtT,
  yAt,
  type DpsChart
} from '../src/renderer/src/features/combat/dpsChart'

const BUCKET = 1000

/** A DpsSeries carrying the given per-bucket OUTGOING rates and nothing else. */
function mkSeries(out: number[]): DpsSeries {
  return {
    bucketMs: BUCKET,
    smoothMs: 5 * BUCKET,
    n: out.length,
    you: Float64Array.from(out),
    pet: new Float64Array(out.length),
    inc: new Float64Array(out.length),
    peakOut: Math.max(0, ...out),
    hasPet: false,
    hasInc: false,
    hasAny: out.some((v) => v > 0),
    durationMs: out.length * BUCKET,
    estimated: false
  }
}

function mkChart(out: number[], live = false): DpsChart {
  const chart = buildDpsChart(mkSeries(out), live)
  assert.ok(chart, 'the fixture must produce a drawable chart')
  return chart
}

/** The polyline point string, back as numbers — the drawing, read as data. */
function parsePts(s: string): { x: number; y: number }[] {
  return s.split(' ').map((p) => {
    const [x, y] = p.split(',').map(Number)
    return { x, y }
  })
}

const RATES = [100, 400, 250, 900, 900, 50, 700, 300]

test('buildDpsChart publishes the index domain its polyline was actually drawn from', () => {
  const chart = mkChart(RATES)
  assert.equal(chart.i0, 0, 'a finalized fight draws from the first bucket')
  assert.equal(chart.count, RATES.length)
  assert.equal(parsePts(chart.outLine).length, chart.count, 'count must equal the vertices drawn')
})

test('a scrolling LIVE window reports the buckets it kept, not the ones it dropped', () => {
  // 200s of fight at 1s buckets: the live window shows the last 120.
  const chart = mkChart(new Array<number>(200).fill(500), true)
  assert.equal(chart.scrolling, true)
  assert.equal(chart.i0, 80, 'the first 80 buckets scrolled off the left edge')
  assert.equal(chart.count, 120)
  assert.equal(chart.t0, 80 * BUCKET, 'the window starts at the first bucket it draws')
  assert.equal(chart.t1, 200 * BUCKET, 'and ends at the END of the last one — both on the grid')
  assert.equal(parsePts(chart.outLine).length, chart.count)
})

test('tAtUserX is the exact inverse of xAtT — a marker resolves to its own instant', () => {
  const chart = mkChart(RATES)
  for (const t of [chart.t0, 1, 1000, 3333, 4999.5, chart.t1]) {
    assert.ok(Math.abs(tAtUserX(chart, xAtT(chart, t)) - t) < 1e-9, `round-trip must hold at t=${t}`)
  }
  // …and the other way round, over the drawn plot.
  for (const ux of [PAD_X, 100, 360.5, CHART_W - PAD_X]) {
    assert.ok(Math.abs(xAtT(chart, tAtUserX(chart, ux)) - ux) < 1e-9, `round-trip must hold at ux=${ux}`)
  }
})

test('the plot edges are the window edges, and both mappings clamp there', () => {
  const chart = mkChart(RATES)
  assert.equal(xAtT(chart, chart.t0), PAD_X)
  assert.ok(Math.abs(xAtT(chart, chart.t1) - (CHART_W - PAD_X)) < 1e-9)
  // Outside the pads there is no chart, so the cursor reads as the nearest edge rather than as a
  // time before the window started (which would let a tooltip quote a negative elapsed).
  assert.equal(tAtUserX(chart, 0), chart.t0)
  assert.equal(tAtUserX(chart, -500), chart.t0)
  assert.equal(tAtUserX(chart, CHART_W), chart.t1)
  assert.equal(tAtUserX(chart, 5000), chart.t1)
})

test('a scrolling window maps its own span, not the whole fight', () => {
  const chart = mkChart(new Array<number>(200).fill(500), true)
  assert.equal(tAtUserX(chart, PAD_X), 80 * BUCKET, 'the left pad is the oldest bucket still shown')
  assert.equal(tAtUserX(chart, CHART_W - PAD_X), chart.t1)
})

test('CSS px are NOT user units: the stretch factor is the card width', () => {
  // A dashboard card is narrower than the 720-unit viewBox, so one CSS px is MORE than one user
  // unit — the exact reason a raw clientX offset lands the cursor somewhere else on this chart.
  assert.equal(pxToUser(180, 360), CHART_W / 2)
  assert.equal(userToPx(CHART_W / 2, 360), 180)
  for (const [px, w] of [
    [37, 360],
    [200, 1024],
    [0, 480]
  ]) {
    assert.ok(Math.abs(userToPx(pxToUser(px, w), w) - px) < 1e-9, `px round-trip must hold (${px}@${w})`)
  }
  // Measured before layout ⇒ zero width. Both directions answer 0 rather than NaN/Infinity, which
  // would propagate into an SVG coordinate and blank the overlay.
  assert.equal(pxToUser(50, 0), 0)
  assert.equal(userToPx(50, 0), 0)
})

test('a grab radius in CSS px grows in user units as the card narrows', () => {
  // This is why the marker tolerance is converted rather than multiplied straight into ms: at 360
  // CSS px a 5px reach is 10 user units, and at 1440 it is 2.5. Multiplying the px constant by
  // ms-per-user-unit directly would silently make the tick harder to hit on a small window.
  assert.equal(pxToUser(5, 360), 10)
  assert.equal(pxToUser(5, 1440), 2.5)
})

test('the hover dot rides the DRAWN polyline, vertex for vertex', () => {
  const chart = mkChart(RATES)
  const pts = parsePts(chart.outLine)
  pts.forEach((p, k) => {
    assert.ok(
      Math.abs(curveYAtUserX(chart, mkSeries(RATES), p.x) - p.y) < 0.5,
      `vertex ${k} must sit on the line (got ${curveYAtUserX(chart, mkSeries(RATES), p.x)}, drawn ${p.y})`
    )
  })
})

test('between two vertices the dot follows the segment the SVG paints', () => {
  const chart = mkChart(RATES)
  const pts = parsePts(chart.outLine)
  const mid = (pts[0].x + pts[1].x) / 2
  assert.ok(
    Math.abs(curveYAtUserX(chart, mkSeries(RATES), mid) - (pts[0].y + pts[1].y) / 2) < 0.5,
    'the midpoint of a straight segment is the mean of its ends'
  )
  // The interpolation is for the DOT only — it is a position on a drawn line, never a rate. The
  // y it lands on is between two real bucket rates and equals neither.
  const yLow = yAt(chart.yMax, RATES[0])
  const yHigh = yAt(chart.yMax, RATES[1])
  const got = curveYAtUserX(chart, mkSeries(RATES), mid)
  assert.ok(got < yLow && got > yHigh, 'a rising segment puts the midpoint strictly between its ends')
})

test('the dot clamps to the end vertices outside the pads', () => {
  const chart = mkChart(RATES)
  const pts = parsePts(chart.outLine)
  const series = mkSeries(RATES)
  assert.ok(Math.abs(curveYAtUserX(chart, series, -20) - pts[0].y) < 0.5)
  assert.ok(Math.abs(curveYAtUserX(chart, series, CHART_W + 20) - pts[pts.length - 1].y) < 0.5)
})

test('a one-bucket fight is flat, not a divide-by-zero', () => {
  // buildDpsChart repeats the single bucket so the opening rate reads as a line; the dot must
  // answer that one rate everywhere instead of walking off the end of the series.
  const chart = mkChart([640])
  assert.equal(chart.count, 2)
  const series = mkSeries([640])
  for (const ux of [PAD_X, CHART_W / 2, CHART_W - PAD_X]) {
    assert.equal(curveYAtUserX(chart, series, ux), yAt(chart.yMax, 640))
  }
})

// ── placeMarkers ───────────────────────────────────────────────────────────────────

function mkView(markers: TimelineMarker[]): TimelineView {
  return {
    id: 'enc-1',
    name: 'a froglok tad',
    startTs: 0,
    durationMs: 200 * BUCKET,
    lanes: [],
    events: [],
    stanceSpans: [],
    markers,
    downsampled: false,
    rawCount: 0,
    totalCount: 0,
    truncated: false
  }
}

test('placeMarkers puts every marker on the mapping the hover reads back', () => {
  const chart = mkChart(RATES)
  const markers: TimelineMarker[] = [
    { t: 0, kind: 'stance', label: 'Berserker' },
    { t: 3200, kind: 'coat', label: 'Neurotoxic', detail: 'blade coat' },
    { t: 8000, kind: 'slow', label: 'a froglok tad' }
  ]
  const placed = placeMarkers(mkView(markers), chart)
  assert.equal(placed.length, 3)
  placed.forEach((p) => {
    assert.equal(p.x, xAtT(chart, p.m.t))
    assert.ok(Math.abs(tAtUserX(chart, p.x) - p.m.t) < 1e-9, 'a placed marker must hit-test back to itself')
  })
})

test('placeMarkers DROPS what scrolled out of a live window instead of clamping it', () => {
  // A coat from four minutes ago clamped to the left edge would read as if it had just gone on.
  const chart = mkChart(new Array<number>(200).fill(500), true)
  const placed = placeMarkers(
    mkView([
      { t: 5_000, kind: 'coat', label: 'Neurotoxic' },
      { t: 150_000, kind: 'slow', label: 'a froglok tad' }
    ]),
    chart
  )
  assert.deepEqual(
    placed.map((p) => p.m.label),
    ['a froglok tad']
  )
})

test('placeMarkers is empty when there is nothing drawn to place them on', () => {
  assert.deepEqual(placeMarkers(null, mkChart(RATES)), [])
  assert.deepEqual(placeMarkers(mkView([{ t: 1, kind: 'slow', label: 'x' }]), null), [])
})

// ── ONE TIME BASE ──────────────────────────────────────────────────────────────────
//
// The curve is drawn from BUCKETED samples; markers carry exact instants. They only agree if both
// are mapped through the same `{t0, t1}`, quantized to the same grid. These are the pins for that.

/** A live chart as the engine would drive it at wall-clock `durationMs`: `buildDpsSeries` ceil()s
 *  the bucket count, so the final bucket is always still filling — which is exactly the state the
 *  old wall-clock right edge re-scaled every marker against on every snapshot. */
function mkLiveChart(durationMs: number): DpsChart {
  const n = Math.ceil(durationMs / BUCKET)
  const chart = buildDpsChart({ ...mkSeries(new Array<number>(n).fill(500)), durationMs }, true)
  assert.ok(chart, 'the fixture must produce a drawable chart')
  return chart
}

test('a marker at a bucket centre lands exactly on that bucket own drawn vertex', () => {
  for (const chart of [mkChart(RATES), mkChart(new Array<number>(200).fill(500), true)]) {
    const pts = parsePts(chart.outLine)
    for (let k = 0; k < chart.count; k++) {
      const t = bucketCenterMs(chart, chart.i0 + k)
      const placed = placeMarkers(mkView([{ t, kind: 'coat', label: `b${k}` }]), chart)
      assert.equal(placed.length, 1, `bucket ${k}'s centre must be inside the drawn window`)
      // 0.05 is the polyline's own rounding (points are emitted at one decimal), nothing else.
      assert.ok(
        Math.abs(placed[0].x - pts[k].x) <= 0.05,
        `marker at bucket ${k} must sit on its vertex (${placed[0].x} vs drawn ${pts[k].x})`
      )
    }
  }
})

test('hovering a vertex reads back the bucket that vertex was drawn from', () => {
  // The other half of the same identity: the dot rides vertex k, so the tooltip's rate must be
  // bucket k's — not its neighbour's, which is what a half-bucket mapping error would print.
  const chart = mkChart(RATES)
  const series = mkSeries(RATES)
  parsePts(chart.outLine).forEach((p, k) => {
    assert.equal(dpsAt(series, tAtUserX(chart, p.x)).out, RATES[k], `vertex ${k} must read back as its own bucket`)
  })
})

test('the live window advances in WHOLE buckets — a marker cannot swim against the curve', () => {
  // THE reported bug. `TimelineView.durationMs` is wall clock (`max(lastTs, now) - start`) and the
  // snapshot cadence is ~1s but not exactly, so a right edge taken from it moved by an arbitrary
  // fraction of a bucket on every tick while the polyline only moved when a bucket COMPLETED.
  // Frames inside one bucket must therefore be identical, and crossing a boundary must move
  // everything by exactly one bucket width.
  const mk: TimelineMarker = { t: 150_500, kind: 'slow', label: 'a froglok tad' }
  const xs = [200_000, 200_400, 200_900, 201_000, 201_400].map((durationMs) => {
    const chart = mkLiveChart(durationMs)
    const placed = placeMarkers(mkView([mk]), chart)
    assert.equal(placed.length, 1, `the marker is still inside the window at ${durationMs}ms`)
    assert.ok(
      Math.abs(placed[0].x - xAtT(chart, bucketCenterMs(chart, 150))) < 1e-9,
      'and still on its own bucket, frame after frame'
    )
    return placed[0].x
  })
  const step = (CHART_W - 2 * PAD_X) / 120
  assert.ok(Math.abs(xs[0] - xs[1] - step) < 1e-9, 'crossing a bucket boundary steps by ONE bucket width')
  assert.equal(xs[1], xs[2], 'the wall clock advancing INSIDE a bucket must not move the marker at all')
  assert.equal(xs[2], xs[3], 'nor must the instant the still-filling bucket reaches its own end')
  assert.ok(Math.abs(xs[3] - xs[4] - step) < 1e-9, 'and the next crossing steps by exactly one more')
})

test('a marker that just landed in the still-filling bucket is drawn immediately', () => {
  // Quantizing the window must not cost a second of latency on the thing the tab exists to show.
  const chart = mkLiveChart(200_400)
  const placed = placeMarkers(mkView([{ t: 200_400, kind: 'slow', label: 'a froglok tad' }]), chart)
  assert.equal(placed.length, 1, 'a slow that landed this instant is on the chart now')
  assert.ok(placed[0].x <= CHART_W - PAD_X, 'inside the plot')
  assert.ok(placed[0].x > CHART_W - PAD_X - 12, 'and hard against the right edge')
})
