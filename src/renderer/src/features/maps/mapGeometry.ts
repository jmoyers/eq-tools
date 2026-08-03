// PURE map-viewer geometry (docs/plans/map-viewer.md §6). No React, no DOM, no MUI — the whole
// point of this module is that `tests/mapGeometry.test.mts` can drive it under plain
// `node --import tsx --test` with nothing mounted, the way `timelineGeometry.ts` is driven.
// Only TYPE imports cross the `@shared/*` alias (which exists only in the Vite build); every
// value here is local.
//
// ONE STATE, BOTH PROJECTIONS DERIVED. The timeline stores a 1-D window `{start,end}` and
// derives `xOf`; the map stores `MapView {cx, cy, scale}` — the map coordinate under the centre
// of the viewport, plus CSS pixels per map unit — and derives everything else. Centre+scale
// rather than a rect because the scale is UNIFORM on both axes by construction: a rect window
// would silently stretch a zone whose aspect differs from the pane's, and a stretched map is a
// lie about distance. There is exactly one number that can zoom, so there is exactly one number
// to clamp.
//
// THE Y FLIP IS THE ONLY NEGATION AT RENDER TIME (§2.1). See `mapFromLoc` below for the file
// format's own negation, which is already baked into the bytes on disk.
//
// CULLING IS ALLOCATION-FREE. `cullSegments` walks the columnar Float32Array and writes segment
// INDICES into a caller-owned Uint32Array. At the measured worst case (26,383 segments in
// everfrost.txt) a per-segment object per frame would be 26k allocations at pointer rate; this
// is one buffer for the lifetime of the map.

import type { MapBounds, MapLines, MapPoint } from '@shared/maps'

// ---- the view -----------------------------------------------------------------------------

/** The measured drawing surface, in CSS pixels. */
export interface ViewportSize {
  w: number
  h: number
}

/**
 * The viewer's whole zoom/pan state.
 *
 * `cx,cy` are in MAP coordinates and sit at the centre of the viewport; `scale` is CSS pixels
 * per map unit and applies to both axes.
 */
export interface MapView {
  cx: number
  cy: number
  scale: number
}

/** An axis-aligned rectangle in MAP coordinates — the visible window, or a cull query. */
export interface ViewRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** A position on the drawing surface, in CSS pixels from its top-left. */
export interface ScreenPos {
  px: number
  py: number
}

/** A position in map coordinates. */
export interface MapPos {
  x: number
  y: number
}

/**
 * Which layers are drawn, indexed by `MapLayer` (0 = base, 1..3 = the `_N` files).
 *
 * A plain boolean array rather than a Set because it is read once per segment inside the cull
 * loop, 26k times a frame at worst.
 */
export type LayerMask = readonly boolean[]

/**
 * Layer 2 is the LEGEND — a colour key and credit block drawn at fixed off-map coordinates
 * (§2.3, measured: `brewall\airplane_2.txt` spans y[-250..4800] against a map of y[-1668..1737]).
 * It is real geometry the viewer may show on request, so it ships in `MapLines`; it is off here
 * because unioning it into the view makes the actual map a speck.
 */
export const DEFAULT_LAYERS: LayerMask = [true, true, false, true]

/** Breathing room around a fitted map, as a fraction of the pane. */
export const FIT_PAD = 0.04
/** Zoom per wheel notch / button click. Matches the timeline's feel (timelineGeometry.ZOOM_STEP). */
export const ZOOM_STEP = 1.35
/** Furthest zoom OUT, as a multiple of the fit scale — a quarter of fit. */
export const MIN_ZOOM = 0.25
/** Furthest zoom IN, as a multiple of the fit scale. */
export const MAX_ZOOM = 200

/**
 * A zone whose extent is zero on an axis (a one-segment pack, an empty map) would otherwise
 * divide by zero and fit at infinite scale. One map unit is the floor.
 */
const MIN_SPAN = 1

// ---- EQ coordinates (§2.1) ----------------------------------------------------------------

/**
 * A `/loc` reading as the game prints it: (North/South, West/East, Elevation).
 *
 * EQ's world axes grow larger to the WEST and to the SOUTH, so `/loc` is neither x-first nor
 * sign-aligned with the map file.
 */
export interface EqLoc {
  /** first number printed by /loc — North/South. */
  ns: number
  /** second number printed by /loc — West/East. */
  ew: number
  /** third number printed by /loc — elevation. NEVER negated. */
  z: number
}

/** A point in map-file coordinates. */
export interface MapCoord {
  x: number
  y: number
  z: number
}

/**
 * `/loc` → map-file coordinates: **mapX = -(W/E), mapY = -(N/S), mapZ = elevation.**
 *
 * Worked check, Yther Ore's canonical example: `/loc (155, -411, 15)` is written in a map file
 * as `P 411, -155, 15` — which is exactly this.
 *
 * This negation is already BAKED INTO THE FILE, so nothing at render time repeats it: in map
 * coordinates x grows to the right and y grows UP, which is plain Cartesian, and the only thing
 * `project` does is flip y for the screen's downward axis. v1 has no player marker to place
 * (`Your Location` appears 0 times in 86.6 MB of log — §0 #7), so this pair is the pinned
 * documentation of the convention and the seam a future `/loc` pin would use.
 */
export function mapFromLoc(loc: EqLoc): MapCoord {
  return { x: -loc.ew, y: -loc.ns, z: loc.z }
}

/** The exact inverse of `mapFromLoc` — map-file coordinates back to what `/loc` would print. */
export function locFromMap(p: MapCoord): EqLoc {
  return { ns: -p.y, ew: -p.x, z: p.z }
}

// ---- fit / project ------------------------------------------------------------------------

function spanOf(lo: number, hi: number): number {
  return Math.max(MIN_SPAN, hi - lo)
}

/**
 * The scale at which the whole zone fits the pane, with `pad` breathing room.
 *
 * `min` of the two axes (never `max`, never per-axis) is what keeps the scale uniform: the
 * tighter axis decides, and the looser one gets letterboxed.
 */
export function fitScale(bounds: MapBounds, vp: ViewportSize, pad = FIT_PAD): number {
  if (vp.w <= 0 || vp.h <= 0) return 1
  const sx = vp.w / spanOf(bounds.minX, bounds.maxX)
  const sy = vp.h / spanOf(bounds.minY, bounds.maxY)
  return Math.min(sx, sy) * (1 - pad)
}

/** The whole zone, centred in the pane. This is what `Fit` resets to and what a load starts at. */
export function fit(bounds: MapBounds, vp: ViewportSize, pad = FIT_PAD): MapView {
  return {
    cx: (bounds.minX + bounds.maxX) / 2,
    cy: (bounds.minY + bounds.maxY) / 2,
    scale: fitScale(bounds, vp, pad)
  }
}

/**
 * Map coordinate → CSS pixel on the surface.
 *
 * The `-` on y is the ONLY negation at render time: map y grows up, screen y grows down.
 */
export function project(view: MapView, vp: ViewportSize, p: MapPos): ScreenPos {
  return {
    px: vp.w / 2 + (p.x - view.cx) * view.scale,
    py: vp.h / 2 - (p.y - view.cy) * view.scale
  }
}

/** CSS pixel on the surface → map coordinate. The exact inverse of `project`. */
export function unproject(view: MapView, vp: ViewportSize, s: ScreenPos): MapPos {
  return {
    x: view.cx + (s.px - vp.w / 2) / view.scale,
    y: view.cy - (s.py - vp.h / 2) / view.scale
  }
}

/** The visible window in map coordinates — the cull query, and the label layer's clip. */
export function viewRect(view: MapView, vp: ViewportSize): ViewRect {
  const halfW = vp.w / (2 * view.scale)
  const halfH = vp.h / (2 * view.scale)
  return {
    minX: view.cx - halfW,
    maxX: view.cx + halfW,
    minY: view.cy - halfH,
    maxY: view.cy + halfH
  }
}

/** Grow a rect by `m` map units on every side — the label layer's overscan. */
export function expandRect(r: ViewRect, m: number): ViewRect {
  return { minX: r.minX - m, maxX: r.maxX + m, minY: r.minY - m, maxY: r.maxY + m }
}

// ---- clamping -----------------------------------------------------------------------------

function clampTo(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, Math.min(lo, hi)), Math.max(lo, hi))
}

/**
 * Zoom limits, expressed as multiples of THIS zone's fit scale rather than as absolute pixels
 * per unit — zones differ by three orders of magnitude in extent, so an absolute ceiling would
 * be unreachable in one zone and instant in another.
 */
export function clampScale(scale: number, bounds: MapBounds, vp: ViewportSize): number {
  const base = fitScale(bounds, vp)
  return clampTo(scale, base * MIN_ZOOM, base * MAX_ZOOM)
}

/**
 * The pan limit: **the centre of the viewport must stay inside the zone's bounds.**
 *
 * Stated that way rather than "the map must stay on screen" because it is one comparison per
 * axis and it degrades correctly at every zoom — fully zoomed out the whole zone is on screen
 * anyway and the clamp never bites; fully zoomed in you can reach any corner but can never fling
 * the map off into empty space and lose it.
 */
export function clampView(view: MapView, bounds: MapBounds, vp: ViewportSize): MapView {
  return {
    cx: clampTo(view.cx, bounds.minX, bounds.maxX),
    cy: clampTo(view.cy, bounds.minY, bounds.maxY),
    scale: clampScale(view.scale, bounds, vp)
  }
}

// ---- zoom / pan ---------------------------------------------------------------------------

/** Arguments to `zoomAround`. An object because five positional parameters exceed max-params 4. */
export interface ZoomArgs {
  view: MapView
  bounds: MapBounds
  vp: ViewportSize
  /** The surface pixel held fixed — the cursor, or the pane centre for the +/− buttons. */
  anchor: ScreenPos
  /** > 1 zooms IN (more pixels per map unit), < 1 zooms out. */
  factor: number
}

/**
 * Cursor-anchored zoom: the map coordinate under `anchor` is still under `anchor` afterwards.
 *
 * Same algebra as the timeline's `zoomAround`, applied on both axes: read the anchor's map
 * position at the OLD scale, then solve for the centre that puts it back at the same pixel at
 * the new one. The anchor invariant holds exactly whenever the result is not clamped — at the
 * pan limit the clamp wins, because a view that has drifted off the zone is the worse outcome.
 */
export function zoomAround(a: ZoomArgs): MapView {
  const at = unproject(a.view, a.vp, a.anchor)
  const scale = clampScale(a.view.scale * a.factor, a.bounds, a.vp)
  return clampView(
    {
      cx: at.x - (a.anchor.px - a.vp.w / 2) / scale,
      cy: at.y + (a.anchor.py - a.vp.h / 2) / scale,
      scale
    },
    a.bounds,
    a.vp
  )
}

/**
 * Pan by a pixel delta. `d` is the TOTAL delta from the drag's start against the drag's START
 * view (held in a ref by the hook), never an accumulation per move — that is what makes a drag
 * exactly reversible instead of drifting by a rounding error per event.
 *
 * Dragging right moves the map right, so the viewport centre moves LEFT in map coordinates;
 * dragging down moves the map down, so the centre moves UP — hence the y sign, which is the
 * screen flip again.
 */
export function panBy(view: MapView, bounds: MapBounds, vp: ViewportSize, d: ScreenPos): MapView {
  return clampView(
    { cx: view.cx - d.px / view.scale, cy: view.cy + d.py / view.scale, scale: view.scale },
    bounds,
    vp
  )
}

/** Is the view narrower than the whole zone — i.e. do the zoom-out / Fit controls do anything? */
export function isZoomedIn(view: MapView, bounds: MapBounds, vp: ViewportSize): boolean {
  return view.scale > fitScale(bounds, vp) * 1.001
}

// ---- culling ------------------------------------------------------------------------------

/**
 * Write the index of every possibly-visible segment into `out`; return how many were written.
 *
 * CONSERVATIVE BY DESIGN: the test is per-axis bounding-box overlap, so a long diagonal whose
 * box straddles the window but whose line does not is kept. That is four comparisons per
 * segment instead of a Liang-Barsky clip, it NEVER drops a segment the user should see, and the
 * canvas clips the few false keeps for free. Being wrong in the cheap direction is the whole
 * job of a cull.
 *
 * Nothing is allocated: `out` is the caller's buffer (sized `lines.count` once per map) and the
 * loop reads the columnar arrays directly. If `out` is short the walk stops — a truncated draw,
 * never an overrun.
 */
export function cullSegments(
  lines: MapLines,
  rect: ViewRect,
  layers: LayerMask,
  out: Uint32Array
): number {
  const { coords, layer, count } = lines
  let n = 0
  for (let i = 0; i < count; i += 1) {
    if (!layers[layer[i]]) continue
    const o = i * 6
    const x1 = coords[o]
    const x2 = coords[o + 3]
    if ((x1 < rect.minX && x2 < rect.minX) || (x1 > rect.maxX && x2 > rect.maxX)) continue
    const y1 = coords[o + 1]
    const y2 = coords[o + 4]
    if ((y1 < rect.minY && y2 < rect.minY) || (y1 > rect.maxY && y2 > rect.maxY)) continue
    if (n >= out.length) break
    out[n] = i
    n += 1
  }
  return n
}

/** A point that survived the cull, carrying its index in `MapData.points` as a stable React key. */
export interface VisiblePoint {
  point: MapPoint
  index: number
}

/**
 * The labels inside `rect` on a visible layer. Measured max is 316 points in one zone, so this
 * allocates freely — the cull here is about keeping the DOM small when zoomed in, not about
 * per-frame cost.
 */
export function visiblePoints(
  points: readonly MapPoint[],
  rect: ViewRect,
  layers: LayerMask
): VisiblePoint[] {
  const out: VisiblePoint[] = []
  points.forEach((point, index) => {
    if (!layers[point.layer]) return
    if (point.x < rect.minX || point.x > rect.maxX) return
    if (point.y < rect.minY || point.y > rect.maxY) return
    out.push({ point, index })
  })
  return out
}
