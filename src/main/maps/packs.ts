// Map-pack discovery, per-layer cross-pack resolution, and the parsed-zone cache
// (docs/plans/map-viewer.md §3.1, §4.1, §6.3, §7.2).
//
// THE SHAPE. This module is the IMPURE half of the map feature — it is the only thing that
// touches the filesystem — but every root it reads is INJECTED (`MapLibraryOptions`), exactly
// like `imageCache.ts`'s `ImageCacheOptions`. Nothing here imports `electron`, so
// tests/mapPacks.test.mts drives the whole surface against a temp dir of synthetic packs under
// plain `node --import tsx --test` and never skips. The Electron binding — `effectiveEqRoot()`,
// `app.getPath('userData')`, `logError` — lives one file over in `./index.ts`.
//
// <eqRoot> IS READ-ONLY, ALWAYS. Nothing in this file opens a handle for writing, creates a
// directory, or renames anything. Brewall's own site warns that EverQuest rewrites ~100 default
// maps on every launch, so a future pack INSTALL goes to `<userData>/mappacks` (already a
// discovered root below) and never into the game directory.
//
// WHAT MAKES THE RESOLUTION NON-TRIVIAL, all measured against the real 1,900-file corpus:
//
//   * FILENAMES ARE MIXED-CASE (`Thurgadina1_1.txt`, `CSHome_1.txt`, `Phinterior1a1_2.txt`) so
//     every stem is keyed lowercase, while the REAL casing is kept for the read — the game dir
//     is NTFS-insensitive, but the packs may be read off any filesystem.
//   * STEMS CAN END IN A DIGIT (`thurgadina1`). The layer suffix regex is anchored at the end
//     and admits only `_1`/`_2`/`_3`, so it can never eat the stem's own trailing digit.
//   * GEOMETRY AND LABELS COME FROM DIFFERENT PACKS. Measured: the game's default set holds
//     285 label points across 58 `_1` files; brewall holds 26,607 across 562. Picking one pack
//     for everything makes the search box permanently empty (default) or throws away the
//     EQL-authoritative geometry (brewall). So the pack choice is PER LAYER (§6.3), and the
//     outcome is recorded in `MapData.sources` — an unlabelled merge would be exactly the kind
//     of silent inference world-model law 1 forbids.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { scoreQuery, tokenize } from '../../shared/fuzzy'
import { isSafePackId } from '../security'
import { buildMapData, parseMapText, type MapParseResult } from './parseMap'
import type {
  MapData,
  MapGetResult,
  MapLayer,
  MapPack,
  MapPackInfo,
  MapPackPrefs,
  MapPoint,
  MapSearchHit,
  MapSearchOpts,
  MapSource,
  ZoneShort
} from '../../shared/maps'

/** `<eqRoot>\maps` — the game's own map directory, and the parent of every shipped pack. */
export const MAPS_SUBDIR = 'maps'

/** The pack id for `<eqRoot>\maps` itself. Reserved: no subdirectory may claim it. */
export const DEFAULT_PACK_ID = 'default'

/** Display name for that pack. The subdir packs use their real casing (`brewall`). */
export const DEFAULT_PACK_NAME = 'Game default maps'

/** `<userData>\mappacks` — where a future in-app installer would put a pack (§9.2). */
export const USER_PACKS_SUBDIR = 'mappacks'

/** Layers looked for on disk. 0 = `<zone>.txt`, 1..3 = `<zone>_N.txt`. */
const LAYERS: readonly MapLayer[] = [0, 1, 2, 3]

/**
 * Layers sourced from the LABELS pack rather than the geometry pack.
 *
 * 1 is the POI layer (the search corpus). 2 is the legend — the credits and the
 * `Height_Filter:` hint are authored by whoever drew the labels, so reading it from the
 * geometry pack would attribute one pack's map to another pack's author.
 */
const LABEL_LAYERS: readonly MapLayer[] = [1, 2]

/** How many parsed zones stay in memory. Worst case ~690 KB each (everfrost), so ~5 MB. */
const CACHE_MAX = 8

/** Hits returned when the caller names no limit, and the ceiling on what it may ask for. */
const DEFAULT_SEARCH_LIMIT = 60
const MAX_SEARCH_LIMIT = 500

// ---- indexing ---------------------------------------------------------------------------

/** One pack, plus its stem -> layer -> real filename index. `dir` never leaves main. */
export interface PackIndex {
  pack: MapPack
  /** lowercased stem -> layer -> the file's REAL name (casing preserved for the read). */
  files: Map<ZoneShort, Map<MapLayer, string>>
}

/**
 * Split `Thurgadina1_1.txt` into `{ stem: 'thurgadina1', layer: 1 }`.
 *
 * The regex is anchored at the end and admits only `_1`/`_2`/`_3` — the in-game client draws
 * the base layer plus at most one of three custom layers, and a looser `_(\d+)$` would turn
 * the stem's OWN trailing digit into a layer (`thurgadina1` -> stem `thurgadina`, layer 1),
 * silently merging two different maps. Returns null for anything that is not a `.txt`.
 */
export function splitMapFileName(name: string): { stem: ZoneShort; layer: MapLayer } | null {
  if (!/\.txt$/i.test(name)) return null
  const base = name.slice(0, -4).toLowerCase()
  if (!base) return null
  const m = /^(.*)_([123])$/.exec(base)
  if (!m) return { stem: base, layer: 0 }
  if (!m[1]) return null // `_1.txt` with no stem at all
  return { stem: m[1], layer: Number(m[2]) as MapLayer }
}

function listNames(dir: string): { files: string[]; dirs: string[] } {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    return {
      files: entries.filter((e) => e.isFile()).map((e) => e.name),
      dirs: entries.filter((e) => e.isDirectory()).map((e) => e.name)
    }
  } catch {
    // A missing/unreadable maps dir is the fresh-machine case, not an error (§5.3): the UI
    // shows a quiet empty state. The caller distinguishes "no packs" from "no EQ dir".
    return { files: [], dirs: [] }
  }
}

/** Index one directory as a pack. Null when it holds no `.txt` map file at all. */
export function indexPackDir(dir: string, pack: Omit<MapPack, 'zoneCount' | 'fileCount'>): PackIndex | null {
  const files = new Map<ZoneShort, Map<MapLayer, string>>()
  let fileCount = 0
  for (const name of listNames(dir).files) {
    const split = splitMapFileName(name)
    if (!split) continue
    fileCount += 1
    const byLayer = files.get(split.stem) ?? new Map<MapLayer, string>()
    // First spelling wins: on a case-sensitive filesystem a pack could ship both
    // `Befallen.txt` and `befallen.txt`, and picking deterministically beats picking last.
    if (!byLayer.has(split.layer)) byLayer.set(split.layer, name)
    files.set(split.stem, byLayer)
  }
  if (fileCount === 0) return null
  return { pack: { ...pack, zoneCount: files.size, fileCount }, files }
}

/** Where the packs live. Both roots are optional — a fresh machine has neither. */
export interface MapLibraryOptions {
  /** The EQ install root; packs are read from `<eqRoot>\maps` and its subdirectories. */
  readonly eqRoot?: string
  /** `<userData>\mappacks`; every immediate subdirectory is a user-installed pack. */
  readonly userPacksRoot?: string
  /** Override for tests; defaults to silence. Mirrors ImageCacheOptions.onError. */
  readonly onError?: (msg: string, err: unknown) => void
}

/** A user pack SHADOWS a game pack of the same id (the sounds.ts precedent), in place. */
function addPack(out: PackIndex[], pack: PackIndex): void {
  const at = out.findIndex((p) => p.pack.id === pack.pack.id)
  if (at >= 0) out[at] = pack
  else out.push(pack)
}

function addSubdirPacks(out: PackIndex[], root: string, origin: MapPack['origin']): void {
  for (const name of listNames(root).dirs) {
    const id = name.toLowerCase()
    // The id reaches `join()` from the renderer as a pack preference, so a directory whose
    // name could not survive `isSafePackId` is not addressable and is skipped rather than
    // listed-but-unusable. `default` is reserved for `<eqRoot>\maps` itself.
    if (id === DEFAULT_PACK_ID || !isSafePackId(id)) continue
    const idx = indexPackDir(join(root, name), { id, name, dir: join(root, name), origin })
    if (idx) addPack(out, idx)
  }
}

/**
 * Every pack on this machine, in RESOLUTION ORDER for geometry: `<eqRoot>\maps` first (it is
 * the EQL-authoritative geometry, and the only source for EQL-new zones like `newsebexp`),
 * then its subdirectories (`brewall`), then anything under `<userData>\mappacks`.
 */
export function discoverPacks(opts: MapLibraryOptions): PackIndex[] {
  const out: PackIndex[] = []
  if (opts.eqRoot) {
    const mapsDir = join(opts.eqRoot, MAPS_SUBDIR)
    const def = indexPackDir(mapsDir, {
      id: DEFAULT_PACK_ID,
      name: DEFAULT_PACK_NAME,
      dir: mapsDir,
      origin: 'game'
    })
    if (def) addPack(out, def)
    addSubdirPacks(out, mapsDir, 'game')
  }
  if (opts.userPacksRoot) addSubdirPacks(out, opts.userPacksRoot, 'user')
  return out
}

// ---- per-layer cross-pack resolution (§6.3) ----------------------------------------------

/** One resolved layer: which pack, which file, and the absolute path to read it from. */
export interface LayerPick extends MapSource {
  /** Absolute. Main-side only — `MapSource.file` (the basename) is what the renderer sees. */
  path: string
}

/**
 * Packs in preference order for one layer.
 *
 * Geometry keeps discovery order (game default first). LABELS INVERT IT: the default set holds
 * 285 label points to brewall's 26,607, so a label layer that preferred `default` would answer
 * "search this zone" with a near-empty list for every zone the default set covers. An explicit
 * preference from the renderer, when it names a pack that exists, always goes first.
 */
export function packOrder(packs: readonly PackIndex[], layer: MapLayer, prefs: MapPackPrefs): PackIndex[] {
  const labels = LABEL_LAYERS.includes(layer)
  const ordered = labels
    ? [...packs.filter((p) => p.pack.id !== DEFAULT_PACK_ID), ...packs.filter((p) => p.pack.id === DEFAULT_PACK_ID)]
    : [...packs]
  const wanted = labels ? prefs.labels : prefs.geometry
  const at = wanted ? ordered.findIndex((p) => p.pack.id === wanted) : -1
  if (at > 0) ordered.unshift(...ordered.splice(at, 1))
  return ordered
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * Pick the pack that supplies one layer of one zone, per §6.3:
 *   1. an explicitly preferred pack that HAS the file wins outright — even if it is empty,
 *      because "this pack, and I mean it" is an instruction, not a hint;
 *   2. otherwise the first pack in preference order with a NON-EMPTY file;
 *   3. otherwise the first pack that has the file at all — an empty layer file is a valid
 *      empty layer, never an error (measured: `brewall\*_3.txt` is a real zero-byte file).
 */
export function resolveLayer(
  packs: readonly PackIndex[],
  zone: ZoneShort,
  layer: MapLayer,
  prefs: MapPackPrefs
): LayerPick | null {
  const wanted = LABEL_LAYERS.includes(layer) ? prefs.labels : prefs.geometry
  let fallback: LayerPick | null = null
  for (const p of packOrder(packs, layer, prefs)) {
    const file = p.files.get(zone)?.get(layer)
    if (!file) continue
    const pick: LayerPick = { layer, packId: p.pack.id, file, path: join(p.pack.dir, file) }
    if (p.pack.id === wanted) return pick
    fallback ??= pick
    if (fileSize(pick.path) > 0) return pick
  }
  return fallback
}

/** Every layer this zone has anywhere, each attributed to the pack it actually came from. */
export function resolveZoneLayers(
  packs: readonly PackIndex[],
  zone: ZoneShort,
  prefs: MapPackPrefs
): LayerPick[] {
  const out: LayerPick[] = []
  for (const layer of LAYERS) {
    const pick = resolveLayer(packs, zone, layer, prefs)
    if (pick) out.push(pick)
  }
  return out
}

// ---- the library ------------------------------------------------------------------------

/** The read-only surface the IPC handlers call. One instance per set of roots. */
export interface MapLibrary {
  /** Installed packs, without their absolute directories. */
  packs: () => MapPackInfo[]
  /** Zone stems, ascending. Restricted to one pack when `packId` names one. */
  zones: (packId?: string) => ZoneShort[]
  /** Parse (or serve from cache) one zone under a per-layer pack preference. */
  get: (zone: ZoneShort, prefs?: MapPackPrefs) => MapGetResult
  /** Label search: in one zone, or across the whole corpus when `opts.zone` is absent. */
  search: (query: string, opts?: MapSearchOpts) => MapSearchHit[]
  /** Drop every cache and re-scan the roots (a pack was installed/removed). */
  refresh: () => void
}

/** A corpus-search row: the point, the zone it is in, and its pre-tokenized haystack. */
interface CorpusRow {
  zone: ZoneShort
  point: MapPoint
  hay: string[]
}

function prefsKey(zone: ZoneShort, prefs: MapPackPrefs): string {
  return `${prefs.geometry ?? ''}|${prefs.labels ?? ''}|${zone}`
}

function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), MAX_SEARCH_LIMIT)
}

function rank(rows: readonly CorpusRow[], query: string[], limit: number): MapSearchHit[] {
  const hits: MapSearchHit[] = []
  for (const row of rows) {
    const score = scoreQuery(query, row.hay)
    if (score != null) hits.push({ zone: row.zone, point: row.point, score })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

/**
 * Build a library over the given roots. Everything it caches — the pack scan, the parsed-zone
 * LRU, the corpus search index — lives in this closure, so `refresh()` and "throw the whole
 * library away when the EQ root changes" are the same cheap operation.
 */
export function createMapLibrary(opts: MapLibraryOptions): MapLibrary {
  const onError = opts.onError ?? ((): void => undefined)
  let scanned: PackIndex[] | null = null
  let corpus: CorpusRow[] | null = null
  // Insertion-ordered = LRU: a hit re-inserts at the end, eviction takes the first key.
  const cache = new Map<string, MapData>()

  const packs = (): PackIndex[] => (scanned ??= discoverPacks(opts))

  function readText(path: string): string | null {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      onError(`maps: could not read ${path}`, err)
      return null
    }
  }

  function parseLayer(pick: LayerPick): MapParseResult | null {
    const text = readText(pick.path)
    return text == null ? null : parseMapText(text, pick.layer)
  }

  function load(zone: ZoneShort, prefs: MapPackPrefs): MapData | null {
    const picks = resolveZoneLayers(packs(), zone, prefs)
    if (picks.length === 0) return null
    const parts: MapParseResult[] = []
    const sources: MapSource[] = []
    for (const pick of picks) {
      const part = parseLayer(pick)
      if (!part) continue // unreadable layer: drop it, keep the rest of the map
      parts.push(part)
      sources.push({ layer: pick.layer, packId: pick.packId, file: pick.file })
    }
    if (parts.length === 0) return null
    return buildMapData(parts, { zone, sources })
  }

  /**
   * The corpus index covers the LABEL LAYERS ONLY, and that is a measurement, not laziness:
   * the whole corpus is 215 MB of text (default 65 MB + brewall 150 MB) while its `_1` layers
   * are 2.2 MB and hold 26,892 of the 28,284 real POI records — 95%. Reading 215 MB on the
   * first keystroke to reach the remaining 1,392 base-file points would stall the main
   * process for seconds. In-zone search is unaffected: it runs over the FULL parsed `MapData`
   * for that zone, base-file points included.
   *
   * Built with DEFAULT prefs (the label order above), so it is one index rather than one per
   * pack preference. Lazy — never at module load, the mobSearch.ts HAYSTACKS precedent.
   */
  function corpusRows(): CorpusRow[] {
    if (corpus) return corpus
    const rows: CorpusRow[] = []
    const all = packs()
    const stems = new Set<ZoneShort>()
    for (const p of all) for (const stem of p.files.keys()) stems.add(stem)
    for (const zone of stems) {
      const pick = resolveLayer(all, zone, 1, {})
      const part = pick ? parseLayer(pick) : null
      if (!part) continue
      for (const point of part.points) rows.push({ zone, point, hay: tokenize(point.display) })
    }
    corpus = rows
    return rows
  }

  function inZone(zone: ZoneShort, query: string[], limit: number): MapSearchHit[] {
    const res = get(zone)
    if (!res.ok) return []
    return rank(
      res.data.points.map((point) => ({ zone, point, hay: tokenize(point.display) })),
      query,
      limit
    )
  }

  function get(zone: ZoneShort, prefs: MapPackPrefs = {}): MapGetResult {
    const key = prefsKey(zone, prefs)
    const hit = cache.get(key)
    if (hit) {
      cache.delete(key)
      cache.set(key, hit)
      return { ok: true, data: hit }
    }
    const data = load(zone, prefs)
    if (!data) return { ok: false, error: `no map files for zone '${zone}'` }
    cache.set(key, data)
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
    return { ok: true, data }
  }

  return {
    packs: () => packs().map(({ pack: { dir: _dir, ...info } }) => info),
    zones: (packId) => {
      const stems = new Set<ZoneShort>()
      for (const p of packs()) {
        if (packId && p.pack.id !== packId) continue
        for (const stem of p.files.keys()) stems.add(stem)
      }
      return [...stems].sort()
    },
    get,
    search: (query, searchOpts) => {
      const tokens = tokenize(query)
      if (tokens.length === 0) return []
      const limit = clampLimit(searchOpts?.limit)
      return searchOpts?.zone
        ? inZone(searchOpts.zone, tokens, limit)
        : rank(corpusRows(), tokens, limit)
    },
    refresh: () => {
      scanned = null
      corpus = null
      cache.clear()
    }
  }
}
