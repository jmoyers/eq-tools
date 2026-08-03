// The map viewer's PURE geometry (src/renderer/src/features/maps/mapGeometry.ts) — the whole
// boundary between "the file says these coordinates" and "the user sees this pane".
//
// WHY THIS BOUNDARY EXISTS. Four things here are silently wrong rather than loudly broken, and
// each of them is a bug you can stare at for an hour:
//
//   * THE COORDINATE CONVENTION. `/loc` prints (North/South, West/East, Elevation) and EQ's
//     world grows larger to the WEST and SOUTH, so the map file stores (-EW, -NS, Z). Get a
//     sign wrong and the map is mirrored — which looks like a perfectly good map of a zone you
//     have never been to. It is pinned below by name.
//   * CURSOR-ANCHORED ZOOM. If the anchor drifts, zooming "walks" the map away from the cursor.
//     It still zooms, so nothing looks broken; it just feels wrong forever.
//   * THE CULL. Too eager and walls vanish at the edge of the pane; too lazy and the 26,383
//     segments of everfrost.txt are all drawn every frame.
//   * THE CLAMPS. Without them the map can be flung into empty space with no way back.
//
// Arithmetic only — no React, no DOM, no canvas, no fixture — so this suite NEVER skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LAYERS,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEP,
  clampView,
  cullSegments,
  expandRect,
  fit,
  fitScale,
  isZoomedIn,
  locFromMap,
  mapFromLoc,
  panBy,
  project,
  unproject,
  viewRect,
  visiblePoints,
  zoomAround,
  type LayerMask
} from '../src/renderer/src/features/maps/mapGeometry'
import type { MapBounds, MapLines, MapPoint } from '../src/shared/maps'

/** 200 wide × 100 tall, centred on the origin — the numbers stay checkable by hand. */
const BOUNDS: MapBounds = { minX: -100, maxX: 100, minY: -50, maxY: 50, minZ: 0, maxZ: 10 }
/** A square pane, so the fit is width-limited and the letterboxing is visible. */
const VP = { w: 400, h: 400 }
/** No breathing room, so `fit` lands on round numbers. */
const NOPAD = 0

function near(a: number, b: number, eps = 1e-9): void {
  assert.ok(Math.abs(a - b) <= eps, `${String(a)} !~= ${String(b)}`)
}

test('the EQ coordinate convention: /loc (N/S, W/E, Z) maps to file (-W/E, -N/S, Z), Z never negated', () => {
  // Yther Ore's canonical worked example, the one the format docs are checked against:
  // a /loc of (155, -411, 15) is written into a map file as `P 411, -155, 15`.
  assert.deepEqual(mapFromLoc({ ns: 155, ew: -411, z: 15 }), { x: 411, y: -155, z: 15 })
  // Elevation is the one field that passes through untouched, in both directions.
  assert.deepEqual(locFromMap({ x: 411, y: -155, z: 15 }), { ns: 155, ew: -411, z: 15 })
  // The pair is an exact round trip, so a future /loc pin cannot drift from the parser.
  const loc = { ns: -1234.5, ew: 678.25, z: -7.5 }
  assert.deepEqual(locFromMap(mapFromLoc(loc)), loc)
  // EQ grows WEST and SOUTH; the file grows east and north. Two positive /loc numbers are two
  // negative map numbers, and that single fact is what a mirrored map means.
  const nw = mapFromLoc({ ns: 100, ew: 200, z: 0 })
  assert.ok(nw.x < 0 && nw.y < 0)
})

test('fit centres the zone and letterboxes the loose axis — it never stretches to fill', () => {
  const view = fit(BOUNDS, VP, NOPAD)
  assert.deepEqual({ cx: view.cx, cy: view.cy }, { cx: 0, cy: 0 })
  // Width-limited: 400px / 200 map units = 2. The 100-unit height uses only 200 of 400px.
  near(view.scale, 2)
  near(fitScale(BOUNDS, VP, NOPAD), 2)

  // The exact bounds land on the exact edges of the tight axis...
  near(project(view, VP, { x: BOUNDS.minX, y: 0 }).px, 0)
  near(project(view, VP, { x: BOUNDS.maxX, y: 0 }).px, VP.w)
  // ...and are centred, not scaled, on the other.
  near(project(view, VP, { x: 0, y: BOUNDS.maxY }).py, 100)
  near(project(view, VP, { x: 0, y: BOUNDS.minY }).py, 300)

  // A fitted view is not "zoomed in" — the Fit / zoom-out controls have nothing to do.
  assert.equal(isZoomedIn(fit(BOUNDS, VP), BOUNDS, VP), false)
})

test('screen Y is flipped and nothing else is: project/unproject round-trip exactly', () => {
  const view = fit(BOUNDS, VP, NOPAD)
  // Map y grows UP, screen y grows DOWN — the higher point has the SMALLER py.
  assert.ok(project(view, VP, { x: 0, y: 40 }).py < project(view, VP, { x: 0, y: -40 }).py)
  // X is not flipped.
  assert.ok(project(view, VP, { x: -40, y: 0 }).px < project(view, VP, { x: 40, y: 0 }).px)

  const p = { x: -37.5, y: 21.25 }
  const back = unproject(view, VP, project(view, VP, p))
  near(back.x, p.x, 1e-6)
  near(back.y, p.y, 1e-6)

  // The visible rect is the pane, expressed in map units: 400px at 2px/unit = 200 units wide.
  const r = viewRect(view, VP)
  assert.deepEqual(r, { minX: -100, maxX: 100, minY: -100, maxY: 100 })
})

test('cursor-anchored zoom holds the map point under the cursor exactly where it was', () => {
  const view = fit(BOUNDS, VP, NOPAD)
  const anchor = { px: 300, py: 100 }
  const before = unproject(view, VP, anchor)

  const zoomed = zoomAround({ view, bounds: BOUNDS, vp: VP, anchor, factor: ZOOM_STEP })
  const after = unproject(zoomed, VP, anchor)
  near(after.x, before.x, 1e-6)
  near(after.y, before.y, 1e-6)
  near(zoomed.scale, 2 * ZOOM_STEP, 1e-9)

  // And it survives a run of notches, which is how a user actually zooms.
  let v = view
  for (let i = 0; i < 6; i += 1) v = zoomAround({ view: v, bounds: BOUNDS, vp: VP, anchor, factor: ZOOM_STEP })
  const held = unproject(v, VP, anchor)
  near(held.x, before.x, 1e-4)
  near(held.y, before.y, 1e-4)
  assert.equal(isZoomedIn(v, BOUNDS, VP), true)

  // Zooming back out by the same factor returns the same scale — the step is exactly invertible.
  const out = zoomAround({ view: zoomed, bounds: BOUNDS, vp: VP, anchor, factor: 1 / ZOOM_STEP })
  near(out.scale, 2, 1e-9)
})

test('the clamps: scale is bounded relative to fit, and the pane centre never leaves the zone', () => {
  const base = fitScale(BOUNDS, VP)
  const anchor = { px: VP.w / 2, py: VP.h / 2 }

  let inward = fit(BOUNDS, VP)
  for (let i = 0; i < 200; i += 1) {
    inward = zoomAround({ view: inward, bounds: BOUNDS, vp: VP, anchor, factor: ZOOM_STEP })
  }
  near(inward.scale, base * MAX_ZOOM, 1e-6)

  let outward = fit(BOUNDS, VP)
  for (let i = 0; i < 200; i += 1) {
    outward = zoomAround({ view: outward, bounds: BOUNDS, vp: VP, anchor, factor: 1 / ZOOM_STEP })
  }
  near(outward.scale, base * MIN_ZOOM, 1e-6)

  // Pan limit: the viewport centre is held inside the zone's extent, so the map is always
  // findable however hard it is flung.
  // Dragging LEFT and DOWN pushes the viewport centre east and north in map coordinates (the
  // screen flip again), and both runs stop at the zone's edge.
  const flung = panBy({ cx: 0, cy: 0, scale: 4 }, BOUNDS, VP, { px: -100000, py: 100000 })
  assert.deepEqual({ cx: flung.cx, cy: flung.cy }, { cx: BOUNDS.maxX, cy: BOUNDS.maxY })
  const other = panBy({ cx: 0, cy: 0, scale: 4 }, BOUNDS, VP, { px: 100000, py: -100000 })
  assert.deepEqual({ cx: other.cx, cy: other.cy }, { cx: BOUNDS.minX, cy: BOUNDS.minY })

  // A drag is stated as a TOTAL delta from the drag's start, so it is exactly reversible.
  const start = { cx: 10, cy: -5, scale: 4 }
  const moved = panBy(start, BOUNDS, VP, { px: 40, py: -20 })
  assert.deepEqual(moved, { cx: 0, cy: -10, scale: 4 })
  assert.deepEqual(panBy(start, BOUNDS, VP, { px: 0, py: 0 }), start)

  // clampView is the one place the limits live; it is idempotent.
  const c = clampView({ cx: 1e9, cy: -1e9, scale: 1e9 }, BOUNDS, VP)
  assert.deepEqual(clampView(c, BOUNDS, VP), c)
})

test('a degenerate zone (zero extent, unmeasured pane) fits at a finite scale instead of Infinity', () => {
  const flat: MapBounds = { minX: 5, maxX: 5, minY: 5, maxY: 5, minZ: 0, maxZ: 0 }
  const v = fit(flat, VP, NOPAD)
  assert.ok(Number.isFinite(v.scale) && v.scale > 0)
  assert.deepEqual({ cx: v.cx, cy: v.cy }, { cx: 5, cy: 5 })
  // Before the first ResizeObserver callback the pane is 0×0 — that must not be a division.
  assert.equal(fitScale(BOUNDS, { w: 0, h: 0 }), 1)
})

// ---- culling ------------------------------------------------------------------------------

interface Seg {
  x1: number
  y1: number
  x2: number
  y2: number
  layer: number
}

/** Hand-build the columnar shape the parser emits, so the cull is tested on the real layout. */
function linesOf(segs: Seg[]): MapLines {
  const coords = new Float32Array(segs.length * 6)
  const layer = new Uint8Array(segs.length)
  segs.forEach((s, i) => {
    coords.set([s.x1, s.y1, 0, s.x2, s.y2, 0], i * 6)
    layer[i] = s.layer
  })
  return {
    coords,
    palette: Uint8Array.from([0, 0, 0]),
    colorIndex: new Uint8Array(segs.length),
    layer,
    count: segs.length
  }
}

const RECT = { minX: -10, maxX: 10, minY: -10, maxY: 10 }
const ALL_LAYERS: LayerMask = [true, true, true, true]

const SEGS: Seg[] = [
  { x1: 0, y1: 0, x2: 5, y2: 5, layer: 0 }, // 0: wholly inside
  { x1: 500, y1: 500, x2: 510, y2: 510, layer: 0 }, // 1: far away
  { x1: -40, y1: 0, x2: 40, y2: 0, layer: 0 }, // 2: crosses the rect end to end
  { x1: 0, y1: 0, x2: 4, y2: 4, layer: 2 }, // 3: inside, but on the LEGEND layer
  { x1: -9, y1: -100, x2: 100, y2: -9, layer: 0 }, // 4: box overlaps, line misses (see below)
  { x1: 0, y1: 40, x2: 0, y2: 200, layer: 0 } // 5: above the rect on both endpoints
]

test('the cull keeps every segment that could be seen, drops the ones that provably cannot', () => {
  const lines = linesOf(SEGS)
  const out = new Uint32Array(lines.count)
  const n = cullSegments(lines, RECT, ALL_LAYERS, out)
  // 4 is the CONSERVATIVE keep: its bounding box straddles the rect, its line passes x≈99 at
  // y=-10 and never enters. Four comparisons per segment beat an exact clip, and the canvas
  // discards the handful of false keeps for free — a cull may never drop a visible wall.
  assert.deepEqual([...out.slice(0, n)], [0, 2, 3, 4])
})

test('the layer mask is applied inside the cull, so a hidden legend costs nothing to hide', () => {
  const lines = linesOf(SEGS)
  const out = new Uint32Array(lines.count)
  // DEFAULT_LAYERS has the legend (layer 2) off — measured reason: brewall\airplane_2.txt spans
  // y[-250..4800] against a map of y[-1668..1737].
  assert.equal(DEFAULT_LAYERS[2], false)
  const n = cullSegments(lines, RECT, DEFAULT_LAYERS, out)
  assert.deepEqual([...out.slice(0, n)], [0, 2, 4])
})

test('the cull writes into the CALLER’s buffer and truncates rather than overrunning it', () => {
  const lines = linesOf(SEGS)
  const small = new Uint32Array(2)
  assert.equal(cullSegments(lines, RECT, ALL_LAYERS, small), 2)
  assert.deepEqual([...small], [0, 2])
  // An empty map is an answer, not a crash.
  assert.equal(cullSegments(linesOf([]), RECT, ALL_LAYERS, new Uint32Array(0)), 0)
})

// ---- points -------------------------------------------------------------------------------

function pt(x: number, y: number, layer: MapPoint['layer'], label = 'a_b'): MapPoint {
  return { x, y, z: 0, r: 0, g: 0, b: 0, size: 2, label, display: label.replace(/_/g, ' '), layer }
}

test('visible points carry their ORIGINAL index, so a React key survives panning', () => {
  const points = [pt(0, 0, 0), pt(900, 900, 0), pt(5, -5, 1), pt(1, 1, 2)]
  const vis = visiblePoints(points, RECT, DEFAULT_LAYERS)
  // Index 1 is off-screen; index 3 is on the hidden legend layer.
  assert.deepEqual(
    vis.map((v) => v.index),
    [0, 2]
  )
  assert.equal(vis[0].point.display, 'a b')

  // Overscan is what stops a label popping out of existence when its anchor leaves the pane.
  const wide = visiblePoints(points, expandRect(RECT, 1000), DEFAULT_LAYERS)
  assert.deepEqual(
    wide.map((v) => v.index),
    [0, 1, 2]
  )
})
