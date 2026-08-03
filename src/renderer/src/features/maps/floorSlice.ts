// PURE floor slicing for the map viewer (docs/plans/map-viewer.md §8). No React, no DOM — so
// `tests/mapFloorSlice.test.mts` drives it under plain `node --import tsx --test`.
//
// THE PROBLEM, MEASURED. `MapData.zLevels` is the DISTINCT `min(z1,z2)` of every segment, and it
// is not a list of floors: the default set's `crystallos.txt` yields **10,694 distinct values**
// over a 1,059-unit z-extent, `everfrost.txt` 3,494, `befallen.txt` 1,583. A picker over the raw
// set is not a picker. Clustering is mandatory, and the raw set is the only input we have.
//
// WHAT WE CANNOT DO, AND WILL NOT PRETEND TO. The in-game height filter is PLAYER-RELATIVE
// ("N units above and below your character", default 10/10). `Your Location` appears 0 times in
// 86.6 MB of log (§0 #7), so there is no character z to centre on and no honest auto-select. The
// control below is MANUAL and defaults to All. It never guesses which floor you are standing on.
//
// THE CLUSTERING — recursive balanced natural-break bisection.
//
//   Start with one run covering every z level. While there is a run taller than the target band
//   height and the cap allows, take the TALLEST such run and split it at the biggest gap that
//   lies inside the middle 60% of its height.
//
//   The centre window is the whole trick, and it was measured. Splitting at the globally largest
//   gap (plain single-linkage clustering) peels OUTLIERS: on the default `crystallos.txt` it
//   produced eleven slivers plus one band holding 6,737 of the 10,694 levels — the fat middle
//   never got cut, because the biggest gaps in a dungeon are always at its lonely extremes.
//   Requiring the cut to be roughly central makes each split halve a run while still landing on
//   a real void, which is what a floor boundary is. Same family as Jenks natural breaks, one
//   dimension and one greedy pass.
//
//   Gap-only splitting is likewise not enough on its own: crystallos' LARGEST internal gap is
//   7 units against a 1,059-unit extent (p50 = 1.0), so no gap threshold derived from the extent
//   splits it at all. Height drives the recursion; the gaps only choose WHERE each cut lands.
//
// MEASURED RESULTS (both packs, real files, `maxBands` 12):
//
//   default  crystallos 10,694 levels / 1,059 units -> 12 bands     everfrost 3,494 -> 12
//   brewall  crystallos    955 levels / 1,059 units -> 12 bands     hole ('The Ruins of Old
//   Paineel', brewall-only) 506 levels / 829 units -> 12 bands      paineel 121 -> 9
//   brewall  poknowledge 293 -> 9      airplane 72 levels / 4,687 units -> 8 (the Plane of Sky's
//   islands are genuinely separate floors and fall out of the gaps, not the cap)
//   brewall  befallen (hint 25/25) -> 3     guktop (45/20) -> 3     veksar (36/36) -> 4
//
// The hinted zones are the proof that `heightHint` is load-bearing rather than decorative: the
// same algorithm gives befallen 9 bands without its hint and 3 with it.

import type { MapHeightHint } from '@shared/maps'

/**
 * Hard cap on bands. A stepper is a list you step through, and past a dozen entries stepping is
 * worse than panning. It binds on the tall dungeons (crystallos, hole, everfrost) and never on
 * the hinted ones, which stop themselves at 3-4.
 */
export const MAX_BANDS = 12

/**
 * Default band height in world units when the pack ships no `Height_Filter`.
 *
 * The in-game client's own default is 10/10 — ten units above and below the player — so 20 is
 * that same band, re-centred on the map instead of on a character we cannot see.
 */
export const DEFAULT_BAND_HEIGHT = 20

/**
 * Floor on the band height. Below roughly this, "floors" are surface undulation and stairs, not
 * architecture — a band thinner than a player's own step height cannot be stood on.
 */
export const MIN_BAND_HEIGHT = 12

/**
 * Fraction of a run's height that a cut must fall inside, centred. 0.6 keeps every split within
 * the middle 60%, which is what stops the recursion from peeling outliers (see the header).
 */
const CENTRE_WINDOW = 0.6

/** One clustered floor. `lo`/`hi` are the REAL extremes of the z levels inside it, never padded. */
export interface FloorBand {
  lo: number
  hi: number
  /** How many distinct z levels landed here — a density signal, and never zero. */
  levels: number
}

/** Options for `floorBands`. An object because the tuning knobs outnumber `max-params 4`. */
export interface FloorSliceOpts {
  /** `Height_Filter:_N/M` mined from the pack's legend layer; `low + high` is the band height. */
  hint?: MapHeightHint
  /** Cap on the number of bands. Defaults to `MAX_BANDS`. */
  maxBands?: number
}

/** Half-open index range into `zLevels`, inclusive both ends. */
interface Run {
  lo: number
  hi: number
}

/**
 * The band height this zone should aim for.
 *
 * Three floors, whichever is largest: the pack's own recommendation (or the client default), the
 * height that would fit the whole zone in `maxBands`, and the "a floor is at least this thick"
 * minimum. Taking the max means the cap can never be exceeded by the target alone.
 */
function targetHeight(extent: number, opts: FloorSliceOpts, maxBands: number): number {
  const hinted = opts.hint ? opts.hint.low + opts.hint.high : DEFAULT_BAND_HEIGHT
  return Math.max(hinted, extent / maxBands, MIN_BAND_HEIGHT)
}

/**
 * Where to cut one run: the largest gap whose midpoint sits inside the run's centre window.
 *
 * Falls back to the gap nearest the run's height midpoint when the window holds none (a run
 * whose interior is perfectly uniform), and returns -1 only when there is nothing to cut.
 */
function splitAt(z: readonly number[], r: Run): number {
  const lo = z[r.lo]
  const hi = z[r.hi]
  const inset = ((1 - CENTRE_WINDOW) / 2) * (hi - lo)
  const mid = (lo + hi) / 2
  let best = -1
  let bestGap = 0
  let near = -1
  let nearDist = Infinity
  for (let i = r.lo + 1; i <= r.hi; i += 1) {
    const gap = z[i] - z[i - 1]
    if (gap <= 0) continue
    const centre = (z[i] + z[i - 1]) / 2
    const dist = Math.abs(centre - mid)
    if (dist < nearDist) {
      nearDist = dist
      near = i
    }
    if (centre >= lo + inset && centre <= hi - inset && gap > bestGap) {
      bestGap = gap
      best = i
    }
  }
  return best >= 0 ? best : near
}

/** The tallest run still above `target`, or -1 when every run is thin enough. */
function tallest(z: readonly number[], runs: readonly Run[], target: number): number {
  let best = -1
  let bestH = target
  for (let i = 0; i < runs.length; i += 1) {
    const h = z[runs[i].hi] - z[runs[i].lo]
    if (h > bestH) {
      bestH = h
      best = i
    }
  }
  return best
}

/**
 * Cluster the raw distinct z levels into floor bands, ascending.
 *
 * Total by construction: every input level lands in exactly one band, bands never overlap, and
 * an empty input yields an empty list (the caller then hides the control rather than showing a
 * one-entry stepper).
 */
export function floorBands(zLevels: readonly number[], opts: FloorSliceOpts = {}): FloorBand[] {
  if (zLevels.length === 0) return []
  const z = zLevels
  const maxBands = Math.max(1, opts.maxBands ?? MAX_BANDS)
  const target = targetHeight(z[z.length - 1] - z[0], opts, maxBands)
  let runs: Run[] = [{ lo: 0, hi: z.length - 1 }]
  while (runs.length < maxBands) {
    const pick = tallest(z, runs, target)
    if (pick < 0) break
    const at = splitAt(z, runs[pick])
    if (at < 0) break
    const r = runs[pick]
    runs = [...runs.slice(0, pick), { lo: r.lo, hi: at - 1 }, { lo: at, hi: r.hi }, ...runs.slice(pick + 1)]
  }
  return runs.map((r) => ({ lo: z[r.lo], hi: z[r.hi], levels: r.hi - r.lo + 1 }))
}

/**
 * The z window a band OWNS, which is wider than the levels it contains.
 *
 * Bands are built from the DRAWN layers' segment z values, so a label's z — or the legend layer's,
 * when it is switched on — can land in the empty space between two bands. Extending each band to
 * the midpoint of the void on either side (and to ±Infinity at the two ends) makes the predicate
 * TOTAL: every z belongs to exactly one band, and a value between floors joins the nearer one
 * rather than vanishing from every slice at once.
 */
export function bandRange(bands: readonly FloorBand[], index: number): { lo: number; hi: number } {
  const b = bands[index]
  if (!b) return { lo: -Infinity, hi: Infinity }
  const below = bands[index - 1]
  const above = bands[index + 1]
  return {
    lo: below ? (below.hi + b.lo) / 2 : -Infinity,
    hi: above ? (b.hi + above.lo) / 2 : Infinity
  }
}

/** Which band a z value belongs to — containment first, nearest neighbour otherwise. -1 if none. */
export function bandOfZ(bands: readonly FloorBand[], z: number): number {
  for (let i = 0; i < bands.length; i += 1) {
    const r = bandRange(bands, i)
    if (z >= r.lo && z <= r.hi) return i
  }
  return -1
}

/**
 * The z rule for a SEGMENT: `min(z1, z2)`, exactly what `computeZLevels` clustered on.
 *
 * Using both endpoints would put a ramp in two bands at once and smear every boundary; the
 * parser already made this choice and the slice has to make the same one or the bands would
 * describe a set the geometry is not filtered by.
 */
export function segmentZ(z1: number, z2: number): number {
  return Math.min(z1, z2)
}

/** Is `z` inside the active slice? `null` is "All levels", which is everything. */
export function inActiveBand(
  bands: readonly FloorBand[],
  active: number | null,
  z: number
): boolean {
  if (active == null || bands.length === 0) return true
  const r = bandRange(bands, active)
  return z >= r.lo && z <= r.hi
}

/** `-552 … -426` — the z extremes of a band, for the stepper's tooltip. Never invented units. */
export function bandLabel(b: FloorBand): string {
  return `${String(Math.round(b.lo))} … ${String(Math.round(b.hi))}`
}
