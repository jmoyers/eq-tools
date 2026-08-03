// PURE label declutter for the map viewer (docs/plans/map-viewer.md §6.4). No React, no DOM, no
// measurement — so `tests/mapLabelLayout.test.mts` drives it under plain
// `node --import tsx --test`, and so the layout is a function of the view rather than of whatever
// the browser happened to lay out last frame.
//
// THE REPORTED BUG: at fit zoom a dense zone is a wall of overlapping text (the owner's example
// is 'The Ruins of Old Paineel'; `brewall\poknowledge_1.txt` is the measured worst case at 320
// labels). Every label drawn is every label unreadable.
//
// WHAT PRODUCTION MAP RENDERERS DO, AND WHICH FIVE PIECES OF IT FIT A SINGLE-CANVAS DOM-LABEL
// VIEWER. No dependency is added; these are the techniques, implemented small.
//
//   1. SCREEN-SPACE COLLISION BOXES + A GRID HASH — Mapbox/MapLibre `CollisionIndex`.
//      Each candidate gets an axis-aligned box in SCREEN pixels; the index buckets placed boxes
//      into fixed cells (Mapbox's GridIndex uses 30px cells) so a query touches a handful of
//      neighbours instead of every placed label. Query time stays near-constant as the map fills.
//      -> `CELL_PX`, `fits`/`insert` below.
//
//   2. PLACEMENT ORDER *IS* PRIORITY — Mapbox `symbol-sort-key`.
//      With overlap disabled, "features with lower sort keys have priority during placement":
//      the first symbol to claim the space keeps it, and everything that collides is dropped.
//      There is no second pass and no global optimum — greedy, one sweep, in rank order.
//      -> `labelRank`, and the single loop in `layoutLabels`.
//
//   3. THE RANK MUST BE STABLE ACROSS FRAMES — MapLibre `CrossTileSymbolIndex`.
//      MapLibre goes to real trouble to give the same symbol the same identity across tiles and
//      zooms, because a rank that shifts makes labels swap places while you pan. Our cheap
//      equivalent: the rank is computed from the POINT DATA ONLY (size class, label kind, then
//      the point's index in `MapData.points`) and never from its screen position, its distance
//      to the centre, or anything else the pointer can change. A one-pixel pan cannot reorder it.
//      -> `compareItems`.
//
//   4. A DROPPED LABEL BECOMES A DOT, NOT NOTHING — Google Maps' icon-without-text tier, and
//      Mapbox's `text-optional` (draw the icon even when the text does not fit). Google's own
//      cartography note is that icons carry enough meaning to place far more of them than labels.
//      Here the POI keeps a small dot, stays hoverable, and hover raises the full text — so
//      decluttering never destroys information, it defers it to a gesture.
//      -> `shown: false` slots still carry `px`/`py`; the layer draws them as dots.
//
//   5. ZOOM IS THE DENSITY CONTROL, NOT A RULE TABLE — Google Maps' LOD tiers, without the
//      tiers. Google publishes per-zoom rules ("apply labels in rank order until a threshold of
//      display area is used"); we get the same behaviour for free because the boxes are in
//      SCREEN space: zoom in and the same points separate, so the same greedy pass admits more
//      of them. No zoom breakpoints exist in this file, and none should be added.
//
// Deliberately NOT adopted: fade-in/out opacity transitions (MapLibre interpolates symbol
// opacity on the GPU; our labels are DOM and v1 wants no animation), and `text-variable-anchor`
// (retrying a label at 4-8 anchor offsets), which would help but multiplies the collision work
// and changes where a label sits relative to its point — worth a later look, not v1.
//
// COST: one sweep over the VISIBLE points (measured max 320 in a zone) per view change, which is
// the existing redraw cadence — pan/zoom set React state, they do not run a rAF loop.

import type { MapPoint } from '@shared/maps'

/**
 * Font size per text-size class. 3 = large (zone connections), 2 = medium (the default),
 * 1 = small (ground spawns) — the file's own three-way distinction, kept three-way.
 *
 * It lives here rather than in the layer because the box size is derived from it and the layout
 * must agree with what is actually rendered to the pixel.
 */
export const LABEL_FONT_PX: Record<1 | 2 | 3, number> = { 1: 10, 2: 12, 3: 14 }

/**
 * Grid cell for the collision index, in CSS pixels. Mapbox's GridIndex uses 30px cells; 32 is
 * the same size and a power of two, so the cell of a coordinate is a shift.
 */
const CELL_PX = 32

/**
 * Breathing room around every collision box, in CSS pixels per side. Mapbox's `text-padding`
 * defaults to 2 for the same reason: boxes that merely touch still read as collided text.
 */
const PAD_PX = 2

/**
 * Average glyph advance as a fraction of the font size, and the line box as a multiple of it.
 *
 * ESTIMATED, NOT MEASURED — deliberately. A real `measureText` would need a canvas context and
 * would make the layout impure, untestable under node, and dependent on font loading order. The
 * estimate is slightly generous for the app's UI font, so boxes are a little wide, which errs
 * toward dropping a borderline label rather than toward overlapping text.
 */
const CHAR_W = 0.55
const LINE_H = 1.25

/**
 * The POI taxonomy this ranking cares about, coarsened from Brewall's published label affixes
 * (§2.4) to the four groups that actually change what a lost player wants on screen.
 */
export type LabelKind = 'connection' | 'named' | 'service' | 'generic'

/** Lower is placed first. Wayfinding beats people beats services beats scenery. */
const KIND_RANK: Record<LabelKind, number> = { connection: 0, named: 1, service: 2, generic: 3 }
const KIND_COUNT = 4

/** `to_Highpass_Hold` — a zone connection. 584 of a 9,945-label sample carry the `to_` prefix. */
const CONNECTION_RE = /^to\s/i
/** `…_(Named)` / `…_(Hunter)` — a mob worth walking to. 1,885 `(Hunter)` in the same sample. */
const NAMED_RE = /\((named|hunter)\)\s*$/i
/** Bankers, merchants, guild masters, tradeskill containers, parcels — the service tier. */
const SERVICE_RE = /\b(merchant|banker|bank|parcel|guild\s*master|tradeskill|forge|cultural|\(gm\b)/i

/**
 * Classify a label from its DISPLAY text (underscores already spaces).
 *
 * Colour would be the other signal, and §2.4 is explicit that colour→category is a display
 * heuristic and never a contract — the default EQL set writes every point `0,0,0`. So the affixes
 * decide, and an unrecognised label is `generic`, never a guess.
 */
export function labelKind(display: string): LabelKind {
  if (CONNECTION_RE.test(display)) return 'connection'
  if (NAMED_RE.test(display)) return 'named'
  if (SERVICE_RE.test(display)) return 'service'
  return 'generic'
}

/**
 * The placement rank — Mapbox's `symbol-sort-key`, lower first.
 *
 * SIZE CLASS IS THE MAJOR KEY and the kind is the minor one, because the size class is the map
 * author's own statement of importance (3 is reserved for zone connections and region names).
 * The two agree far more often than not; where they disagree, the file wins.
 */
export function labelRank(p: MapPoint): number {
  return (3 - p.size) * KIND_COUNT + KIND_RANK[labelKind(p.display)]
}

/** The box a label would occupy, in CSS pixels. Centred on the point, like the rendered span. */
export function labelBox(p: MapPoint): { w: number; h: number } {
  const px = LABEL_FONT_PX[p.size]
  return { w: Math.max(px, p.display.length * px * CHAR_W), h: px * LINE_H }
}

/** One candidate label: a visible point, already projected. */
export interface LabelItem {
  /** Index into `MapData.points` — the React key, and the last, stable rank tiebreak. */
  index: number
  point: MapPoint
  /** Screen centre within the host, CSS pixels. */
  px: number
  py: number
  /** False ⇒ outside the active floor band: never placed as text, always a dot. */
  inBand: boolean
}

/** What the layer draws: the same points, each told whether its text won a slot. */
export interface LabelSlot extends LabelItem {
  /** The text box that was placed (or would have been), CSS pixels. */
  w: number
  h: number
  /** True ⇒ draw the label. False ⇒ draw the dot, and let hover raise the text. */
  shown: boolean
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The collision index: placed boxes bucketed by grid cell (technique 1). */
type Grid = Map<string, Box[]>

function cellKey(cx: number, cy: number): string {
  return `${String(cx)}:${String(cy)}`
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
}

/** Walk the cells a box touches. `visit` returning true stops the walk and is returned. */
function eachCell(box: Box, visit: (key: string) => boolean): boolean {
  const cx0 = Math.floor(box.x0 / CELL_PX)
  const cx1 = Math.floor(box.x1 / CELL_PX)
  const cy0 = Math.floor(box.y0 / CELL_PX)
  const cy1 = Math.floor(box.y1 / CELL_PX)
  for (let cx = cx0; cx <= cx1; cx += 1) {
    for (let cy = cy0; cy <= cy1; cy += 1) {
      if (visit(cellKey(cx, cy))) return true
    }
  }
  return false
}

function collides(grid: Grid, box: Box): boolean {
  return eachCell(box, (key) => (grid.get(key) ?? []).some((placed) => overlaps(placed, box)))
}

function insert(grid: Grid, box: Box): void {
  eachCell(box, (key) => {
    const bucket = grid.get(key)
    if (bucket) bucket.push(box)
    else grid.set(key, [box])
    return false
  })
}

/**
 * The total order placement walks (technique 3). Rank, then the point's own index — which is its
 * position in the map file, fixed for the lifetime of the loaded zone. Nothing screen-derived
 * enters this comparison, so panning cannot reshuffle which labels survive.
 */
function compareItems(a: LabelItem, b: LabelItem): number {
  return labelRank(a.point) - labelRank(b.point) || a.index - b.index
}

/** Tuning knobs. An object so the signature stays inside `max-params 4`. */
export interface LabelLayoutOpts {
  /** Padding per side around each collision box. Defaults to `PAD_PX`. */
  pad?: number
}

/**
 * Greedy screen-space declutter: place in rank order, keep the first claimant, drop the rest.
 *
 * Returns one slot per input, **in the input's order** — not in placement order. That matters:
 * the layer renders the array directly, and reordering the DOM on every pan would churn React's
 * keyed reconciliation for no visual gain.
 */
export function layoutLabels(
  items: readonly LabelItem[],
  opts: LabelLayoutOpts = {}
): LabelSlot[] {
  const pad = opts.pad ?? PAD_PX
  const grid: Grid = new Map()
  const slots = new Map<number, LabelSlot>()
  for (const item of [...items].sort(compareItems)) {
    const { w, h } = labelBox(item.point)
    const box: Box = {
      x0: item.px - w / 2 - pad,
      x1: item.px + w / 2 + pad,
      y0: item.py - h / 2 - pad,
      y1: item.py + h / 2 + pad
    }
    // Out-of-band points never compete and never BLOCK: they are dots, and dots may overlap.
    const shown = item.inBand && !collides(grid, box)
    if (shown) insert(grid, box)
    slots.set(item.index, { ...item, w, h, shown })
  }
  return items.map((item) => slots.get(item.index) ?? { ...item, w: 0, h: 0, shown: false })
}
