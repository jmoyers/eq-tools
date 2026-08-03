// Classic-EQ map-file parser — the PURE half (docs/plans/map-viewer.md §2, §3).
//
// `<eqRoot>\maps` holds 1,900 `.txt` files in exactly two record shapes and nothing else
// (verified across the whole corpus: no comments, no header, no leading character other than
// `L` or `P`):
//
//     L  x1, y1, z1, x2, y2, z2, r, g, b        (9 fields)
//     P  x,  y,  z,  r,  g,  b,  size, label    (8 fields, label may itself contain commas)
//
// This module is deliberately file-system-free — `text -> MapData`, nothing else — mirroring
// the `parseInventoryText` / `loadInventory` split. That is what lets tests/mapParse.test.mts
// run under plain `node --import tsx --test` with no Electron and never skip. File RESOLUTION
// (which pack, which case, which `_N` sibling) lives in the pack module; this API takes the
// text and the layer number it came from.
//
// THE RULES THAT ARE EASY TO GET WRONG, all measured against the real corpus:
//
//   * A LABEL MAY CONTAIN COMMAS — 1,607 of 35,720 P records (4.5%). `split(',')[7]` silently
//     truncates every one of them. The tail is JOINED back, and it is joined from the RAW
//     fields (not per-field-trimmed ones) so interior spacing survives byte-for-byte.
//   * LAYER 2 IS A LEGEND, not geometry. It is drawn at fixed off-map coordinates and unioning
//     it into the bounds makes the actual map render as a speck. Measured, brewall\airplane:
//     the map is y[-1668..1737] while `airplane_2.txt` is y[-250..4800]. Excluded from
//     `bounds` and from `zLevels`; still carried in `MapLines` so the renderer can toggle it.
//   * A MALFORMED LINE IS COUNTED, NEVER THROWN ON. One bad line in a user-supplied pack must
//     not blank the map — `MapData.skipped` makes it diagnosable instead of mysterious.

import type {
  MapBounds,
  MapData,
  MapHeightHint,
  MapLayer,
  MapLines,
  MapPoint,
  MapSource,
  ZoneShort
} from '../../shared/maps'

/**
 * The legend layer. `zone_2.txt` conventionally holds the colour key, the coordinate grid and
 * the map's credits, all drawn well outside the zone's real extent (§2.3).
 */
export const LEGEND_LAYER: MapLayer = 2

/**
 * One layer's line geometry, accumulated as plain flat arrays.
 *
 * Not typed arrays yet: the record count is unknown until the file has been walked, and
 * growing a Float32Array means repeated reallocation. `buildMapData` does the one-shot
 * conversion (and the colour bucketing) once every layer is in hand.
 */
export interface MapRawLines {
  /** [x1,y1,z1,x2,y2,z2] × count, flattened. */
  coords: number[]
  /** [r,g,b] × count, flattened. */
  rgb: number[]
  count: number
}

/** What one map file yields. `layer` travels with it so `buildMapData` needs no side table. */
export interface MapParseResult {
  layer: MapLayer
  lines: MapRawLines
  points: MapPoint[]
  /** Lines that were dropped: wrong field count, non-numeric field, or an unknown record type. */
  skipped: number
}

/** The bits of `MapData` that resolution — not parsing — knows about. */
export interface MapBuildMeta {
  zone: ZoneShort
  sources: MapSource[]
}

// ---- field helpers ---------------------------------------------------------------------

/**
 * A numeric field, or null when it is absent or not a number.
 *
 * The empty-string guard is load-bearing: `Number('')` is 0, so without it a truncated line
 * like `L 1, 2, 3, 4, 5, 6, 0, 0,` would parse as a black segment instead of being counted
 * as malformed.
 */
function num(field: string): number | null {
  const t = field.trim()
  if (!t) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

/** Colour channels are documented 0-255 integers; clamp rather than trust a user pack. */
function byte(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)))
}

/**
 * `size` is a TEXT SIZE CLASS 1..3 (3 = large / zone connections, 2 = medium / default,
 * 1 = small / ground spawns), not a radius. Measured: every one of the 35,720 P records in
 * the corpus is exactly 1, 2 or 3. An out-of-range value is clamped to the nearest class
 * rather than dropping the point — losing a POI over a cosmetic field would be the worse bug.
 */
function sizeClass(v: number): 1 | 2 | 3 {
  const n = Math.round(v)
  if (n <= 1) return 1
  if (n >= 3) return 3
  return 2
}

function pushSegment(fields: string[], out: MapRawLines): boolean {
  if (fields.length !== 9) return false
  const v: number[] = []
  for (const f of fields) {
    const n = num(f)
    if (n === null) return false
    v.push(n)
  }
  out.coords.push(v[0], v[1], v[2], v[3], v[4], v[5])
  out.rgb.push(byte(v[6]), byte(v[7]), byte(v[8]))
  out.count += 1
  return true
}

/**
 * A `P` record. `fields` are the RAW comma-split pieces — everything from index 7 onward is
 * re-joined with commas, which is the whole fix for the 4.5% of labels that contain one.
 */
function parsePoint(fields: string[], layer: MapLayer): MapPoint | null {
  if (fields.length < 8) return null
  const v: number[] = []
  for (let i = 0; i < 7; i += 1) {
    const n = num(fields[i])
    if (n === null) return null
    v.push(n)
  }
  const label = fields.slice(7).join(',').trim()
  return {
    x: v[0],
    y: v[1],
    z: v[2],
    r: byte(v[3]),
    g: byte(v[4]),
    b: byte(v[5]),
    size: sizeClass(v[6]),
    label,
    display: label.replace(/_/g, ' '),
    layer
  }
}

// ---- the parser ------------------------------------------------------------------------

/**
 * Parse one map file's text. Never throws: an unparseable line increments `skipped`.
 *
 * Line endings: the corpus is 100% CRLF, but `split(/\r?\n/)` plus the per-line `trim()`
 * makes LF, CRLF and a stray trailing `\r` all equivalent.
 */
export function parseMapText(text: string, layer: MapLayer): MapParseResult {
  const lines: MapRawLines = { coords: [], rgb: [], count: 0 }
  const points: MapPoint[] = []
  let skipped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue // blank line — not a failure, nothing to count
    const fields = line.slice(1).split(',')
    if (line.startsWith('L')) {
      if (!pushSegment(fields, lines)) skipped += 1
    } else if (line.startsWith('P')) {
      const point = parsePoint(fields, layer)
      if (point) points.push(point)
      else skipped += 1
    } else {
      skipped += 1
    }
  }
  return { layer, lines, points, skipped }
}

// ---- assembly --------------------------------------------------------------------------

/** Colour-bucketing scratch state. Bundled so `paletteIndex` stays within max-params 4. */
interface PaletteBuilder {
  /** Packed 0xRRGGBB -> palette slot. */
  index: Map<number, number>
  /** [r,g,b] × slots, flattened. */
  rgb: number[]
}

/**
 * Palette slots are addressed by a Uint8Array, so there are at most 256 of them. Measured max
 * across all 1,900 files is 19 distinct colours in one file (buriedsea.txt), so the ceiling is
 * ~13× the worst real pack. Beyond it, a colour folds onto slot 0 — geometry is never dropped,
 * because a wrongly-coloured stroke is a far smaller lie than a missing wall.
 */
const PALETTE_MAX = 256

function paletteIndex(pal: PaletteBuilder, r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b
  const found = pal.index.get(key)
  if (found !== undefined) return found
  if (pal.index.size >= PALETTE_MAX) return 0
  const slot = pal.index.size
  pal.index.set(key, slot)
  pal.rgb.push(r, g, b)
  return slot
}

function buildLines(parts: readonly MapParseResult[]): MapLines {
  let count = 0
  for (const part of parts) count += part.lines.count
  const coords = new Float32Array(count * 6)
  const colorIndex = new Uint8Array(count)
  const layer = new Uint8Array(count)
  const pal: PaletteBuilder = { index: new Map(), rgb: [] }
  let seg = 0
  for (const part of parts) {
    coords.set(part.lines.coords, seg * 6)
    for (let i = 0; i < part.lines.count; i += 1) {
      const rgb = part.lines.rgb
      colorIndex[seg + i] = paletteIndex(pal, rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])
      layer[seg + i] = part.layer
    }
    seg += part.lines.count
  }
  return { coords, palette: Uint8Array.from(pal.rgb), colorIndex, layer, count }
}

function grow(b: MapBounds, x: number, y: number, z: number): void {
  b.minX = Math.min(b.minX, x)
  b.maxX = Math.max(b.maxX, x)
  b.minY = Math.min(b.minY, y)
  b.maxY = Math.max(b.maxY, y)
  b.minZ = Math.min(b.minZ, z)
  b.maxZ = Math.max(b.maxZ, z)
}

const EMPTY_BOUNDS: MapBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 }

/**
 * Union of every coordinate in `parts` — BOTH line endpoints and every point.
 *
 * Points must be included: a Brewall `_1` label layer holds 26,607 points against only 2,204
 * segments corpus-wide, so bounds computed from lines alone would ignore the label layer
 * almost entirely. Callers pass only the drawn layers; the legend never reaches here.
 */
function computeBounds(parts: readonly MapParseResult[]): MapBounds {
  const b: MapBounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity
  }
  let seen = false
  for (const part of parts) {
    const c = part.lines.coords
    // Stride 3, not 6: [x1,y1,z1,x2,y2,z2] means both endpoints fall out of one walk.
    for (let i = 0; i + 2 < c.length; i += 3) grow(b, c[i], c[i + 1], c[i + 2])
    for (const p of part.points) grow(b, p.x, p.y, p.z)
    seen ||= c.length > 0 || part.points.length > 0
  }
  return seen ? b : { ...EMPTY_BOUNDS }
}

/**
 * Distinct `min(z1, z2)` per segment, ascending — the floor picker's raw input (§8).
 *
 * `min` rather than both endpoints is deliberate: a sloped segment spanning two floors would
 * otherwise smear the clusters. This is the raw distinct set; grouping it into human "levels"
 * is the height-filter wave's job, and it needs it: measured, crystallos.txt alone yields
 * 10,694 distinct values.
 */
function computeZLevels(parts: readonly MapParseResult[]): number[] {
  const seen = new Set<number>()
  for (const part of parts) {
    const c = part.lines.coords
    for (let i = 0; i + 5 < c.length; i += 6) seen.add(Math.min(c[i + 2], c[i + 5]))
  }
  return [...seen].sort((a, b) => a - b)
}

function legendPoints(parts: readonly MapParseResult[]): MapPoint[] {
  return parts.filter((p) => p.layer === LEGEND_LAYER).flatMap((p) => p.points)
}

/**
 * `Height_Filter:_25/25` — present in 51 of 577 Brewall `_2` files. Observed values 25/25
 * (15×), 50/50, 30/30, 20/20, 15/15, and a handful with a trailing parenthetical qualifier
 * (`Height_Filter:_10/10_(in_Dwarf_Keep)`), which the anchored match simply ignores.
 *
 * Order note: the file writes `N/M` and 50 of the 51 observed bands are symmetric, so the
 * only file that could tell low from high is `Height_Filter:_50/25_(in_tunnels)`. We take the
 * first number as `low`. It seeds a slider default, nothing more.
 */
const HEIGHT_FILTER_RE = /^height_filter:_*(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/i

function mineHeightHint(parts: readonly MapParseResult[]): MapHeightHint | undefined {
  for (const p of legendPoints(parts)) {
    const m = HEIGHT_FILTER_RE.exec(p.label)
    if (m) return { low: Number(m[1]), high: Number(m[2]) }
  }
  return undefined
}

/**
 * Attribution, mined from the legend layer's label points — the ONLY attribution signal these
 * packs ship (eqmaps.info publishes no license, no terms and no stated attribution
 * requirement; the credit lives inside the map data). Measured shapes, corpus-wide:
 * `Original_Map:_…` (×~420), `Revised_Map:_…` (×343, including one `Original__Map:` typo that
 * the `\s+` tolerates), `http://www.eqmaps.info` (×568) and
 * `Return_of_the_Exiled_(www.roteguild.org)` (×568).
 *
 * Matched against `display`, so the strings are already reader-ready. Deduped, first-seen
 * order preserved.
 */
const CREDIT_RE = /^(?:original|revised)\s+map\s*:|^https?:\/\/|\bwww\./i

function mineCredits(parts: readonly MapParseResult[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of legendPoints(parts)) {
    if (!CREDIT_RE.test(p.display) || seen.has(p.display)) continue
    seen.add(p.display)
    out.push(p.display)
  }
  return out
}

/**
 * Fold every layer of one zone into the renderer-ready `MapData`.
 *
 * `parts` may arrive in any order and may be missing any layer; an empty layer file is a valid
 * empty layer, not an error (measured: `brewall\*_3.txt` is a real zero-byte file).
 */
export function buildMapData(parts: readonly MapParseResult[], meta: MapBuildMeta): MapData {
  // Layer 2 contributes GEOMETRY (the renderer may toggle the legend on) but never extent.
  const drawn = parts.filter((p) => p.layer !== LEGEND_LAYER)
  let skipped = 0
  for (const part of parts) skipped += part.skipped
  const heightHint = mineHeightHint(parts)
  return {
    zone: meta.zone,
    sources: meta.sources,
    lines: buildLines(parts),
    points: parts.flatMap((p) => p.points),
    bounds: computeBounds(drawn),
    zLevels: computeZLevels(drawn),
    ...(heightHint ? { heightHint } : {}),
    credits: mineCredits(parts),
    skipped
  }
}
