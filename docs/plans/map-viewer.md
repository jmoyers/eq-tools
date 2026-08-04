# Map viewer — design

Status: DESIGN ONLY. Nothing in `src/` is modified by this document.
Scope: render classic-EQ-format zone maps (the game's own default set AND Brewall-style
packs), search points of interest by label, and auto-open the zone the log says you are in.

Every claim below is measured against the real game directory
(`C:\Users\Public\Daybreak Game Company\Installed Games\EverQuest Legends\maps`, read-only)
and the real log (86.6 MB, `eqlog_Primitive_freeport.txt`, read-only), or grounded in code as
it exists today. Numbers in this document are **counts I took**, not estimates.

---

## 0. The decisions

| # | Decision | Why |
|---|---|---|
| 1 | **No downloader in v1.** Maps come from `<eqRoot>\maps` and its pack subdirectories, which the game **already ships**. | Measured: 192 files / 133 zones in the default set, plus `maps\brewall\` with 1,708 files / 580 zones — already on disk. A downloader for content the user already has is pure risk (§9). |
| 2 | **Parsing lives in MAIN**; the renderer receives a columnar, pre-bucketed `MapData` over one `ipcMain.handle`. | Main owns `fs` and owns `effectiveEqRoot()`. The renderer has `contextIsolation` on and no Node. Non-negotiable given the trust boundary. |
| 3 | **Canvas 2D, not SVG.** | Measured max 26,383 line segments in one zone (`everfrost.txt`); p95 = 12,738. SVG means that many DOM nodes reconciled per pan frame. The combat timeline gets away with SVG only because it windows to a visible *time* range — a zoomed-out map has no such escape. |
| 4 | **Hybrid render**: geometry on canvas, the ~350 point labels as absolutely-positioned DOM. | Labels need hit-testing, tooltips, non-scaling text and search-jump focus. Measured max 316 points per zone — DOM is free at that scale. |
| 5 | **Zone long→short mapping is a HAND-AUTHORED, committed table.** | Measured: naive normalization resolves **7 of 51** real zone names from the live log. This is the feature's critical path (§5). |
| 6 | **Layer `_2` is a LEGEND, not map geometry** — off by default and **excluded from the bounds computation**. | Measured: `brewall\airplane_2.txt` spans y ∈ [-250, 4800] while the actual map is y ∈ [-1668, 1737]. Naively unioning it makes every map render as a speck. |
| 7 | **No player-position marker. Confirmed impossible.** | `Your Location` appears **0 times** in 86.6 MB of log. The log states the zone and nothing else positional (law 6 — say what the log cannot say). |
| 8 | **Height filter: manual z-slice, default OFF, last wave.** | The in-game filter is *player-relative*, and per #7 we have no player Z. A manual discrete-floor selector is the honest substitute (§8). |

---

## 1. Ground truth — what is actually on disk

`<eqRoot>\maps\` contains **1,900 `.txt` files** in two tiers:

| Tier | Path | Files | Distinct zones | Notes |
|---|---|---|---|---|
| Default (game-provided) | `maps\*.txt` | 192 | **133** | EQL-authored. The devs stated all zone maps ship in-game "very specifically created within EQL for accuracy". |
| Pack | `maps\brewall\*.txt` | 1,708 | **580** | Brewall's live-EQ pack, shipped alongside. |

Record composition, measured across the whole corpus:

| Set | Layer | Files | Total `L` | Total `P` | Max `L` in one file | Max `P` in one file |
|---|---|---|---|---|---|---|
| default | base | 133 | 864,466 | 1,362 | 26,383 | 144 |
| default | `_1` | 58 | 1,635 | 285 | 1,634 | 49 |
| default | `_2` | 1 | 284 | 71 | — | — |
| brewall | base | 568 | 2,022,372 | 30 | 20,653 | 6 |
| brewall | `_1` | 562 | 2,204 | 26,607 | 1,617 | 316 |
| brewall | `_2` | 577 | 353,866 | 7,365 | 816 | 55 |
| brewall | `_3` | 1 | 0 | 0 | — | — |

Base-file `L` distribution across all 701 base files: **p50 = 2,847, p90 = 9,040, p95 = 12,738, p99 = 19,701, max = 26,383.**

### Two findings that shape the whole feature

**(a) The default set has almost no labels; Brewall has all of them.**
Default `_1` layers hold **285 points total across 58 files**. Brewall `_1` layers hold **26,607
points across 562 files**. Requirement 2 — "search for NPCs / other objects within the map,
based on the map files' label data" — is **effectively a Brewall-pack feature.** The default
set gives accurate EQL geometry and near-zero POI data.

⇒ The viewer must merge **geometry from one pack and labels from another**, or at minimum make
the pack choice per-layer rather than global. Design accordingly (§6.3). This is not a nicety;
picking the default set alone makes the search box permanently empty.

**(b) Zone coverage barely overlaps in the direction you'd guess.**
Only **one** zone is default-only: `newsebexp` (New Sebilis Expedition — the EQL-new zone
Brewall has never seen). **448** zones are brewall-only (live-EQ content EQL doesn't have).
So Brewall is a near-superset for geometry, but the default set is the *authoritative* geometry
for EQL and the only source for EQL-new zones.

---

## 2. The map file format — precise specification

Two record types, and **only** two. Verified: no comments, no header, no other leading
character anywhere in 1,900 files.

```
L  x1, y1, z1, x2, y2, z2, r, g, b        (9 fields)
P  x,  y,  z,  r,  g,  b,  size, label    (8 fields)
```

- Type letter, then whitespace, then comma-separated fields. Whitespace around fields is
  arbitrary — the default set writes `0, 0, 0,  3,  Steaon_(Alchemy)` (double spaces), Brewall
  writes single. **Trim every field.**
- `r,g,b` are 0–255 integers. Coordinates are floats; the default set writes 4 decimal places,
  Brewall often 1.
- `size` on a `P` record is a **text size class, 1–3** (3 = large / zone connections, 2 = medium
  / default, 1 = small / ground spawns). It is not a radius.

### 2.1 Coordinate system

`/loc` prints **(North/South, West/East, Elevation)** — i.e. `loc = (Y, X, Z)` — and EQ's world
axes grow **larger to the West and South**. The map file stores `(-X, -Y, Z)` in X,Y,Z order.

Given a `/loc` reading of `(a, b, c)`:

```
mapX = -b      mapY = -a      mapZ = c        (Z is NEVER negated)
```

Worked check (Yther Ore's canonical example): `/loc` `(155, -411, 15)` → `P 411, -155, 15`. ✔

For **rendering**, `mapX` increases to the right and `mapY` increases upward, which is standard
Cartesian — so the canvas transform must **flip Y** (screen Y grows downward) and nothing else.
No negation happens at render time; the negation is already baked into the file.

Since we have no player position (§0 #7), this transform is **documentation only** in v1. It
becomes load-bearing only if a `/loc` pin is ever added (§13, deferred seam).

### 2.2 Parser edge cases — all measured, all mandatory

| # | Edge case | Measured incidence | Required handling |
|---|---|---|---|
| 1 | **Labels contain commas** | **1,607 of 35,720 P records (4.5%)** — e.g. `Locked_Door_(Quests,Unpickable)`, `Draton\`ra,_Master_of_the_Void` | Split into **at most 8 parts** (`split(',', 7)` semantics) and take the remainder as the label. `split(',')[7]` silently truncates 4.5% of every label in the corpus. |
| 2 | **Labels contain literal spaces** | 3 records (`to_Hills_of_Shade (click rubble)`, `Icewell Keep`, `The Great Divide`) | Do not assume underscore-only. Display transform is `label.replace(/_/g, ' ')`, which is idempotent on these. |
| 3 | **Base files contain `P` records** | 1,362 in the default set; `shadowhaven.txt` alone has 144 | Never key record type off filename. Parse both types from every file. |
| 4 | **Mixed-case filenames** | `Thurgadina1_1.txt`, `CSHome_1.txt`, `Phinterior1a1_2.txt`, … | Resolve case-insensitively (lowercase the stem for keying). |
| 5 | **Stems that end in a digit** | `Thurgadina1_1.txt` → stem `thurgadina1`, layer 1 | Layer regex is `/^(.*)_([123])$/` anchored at the end — it must not eat the stem's own trailing digit. |
| 6 | **Empty / zero-byte layer files** | `brewall\*_3.txt` (1 file, 0 records) | An empty file is a valid empty layer, not an error. |
| 7 | **Blank lines** | 0 observed, but cheap to tolerate | Skip lines that are empty after trim; skip any line whose first char is not `L`/`P`. |

A line that fails to parse should be **counted and dropped**, never thrown on — one malformed
line in a user-supplied pack must not blank the map. Surface the count as
`MapData.skipped` so a bad pack is diagnosable rather than mysterious.

### 2.3 Layer semantics

The in-game client draws the **base layer always**, plus **at most one** of `_1`/`_2`/`_3` at a
time (max 3 custom layers). Our viewer is not bound by that limit and should allow independent
toggles, with these defaults:

| File | Conventional content | Default |
|---|---|---|
| `zone.txt` | Zone geometry | **ON**, always |
| `zone_1.txt` | Labels / POIs — the search corpus | **ON** |
| `zone_2.txt` | **Legend + coordinate grid + credits.** Colour-key swatches drawn as short strokes at fixed off-map coordinates. | **OFF**, and excluded from bounds |
| `zone_3.txt` | Rare in Brewall (1 file, empty); Good's pack uses it heavily | ON if non-empty |

The `_2` exclusion is the single most important layer rule. Measured for `airplane`:

```
brewall\airplane.txt      x[-1367 .. 1773]   y[-1668 .. 1737]   ← the map
brewall\airplane_1.txt    x[-1700 .. 1414]   y[-1612 .. 1800]   ← labels, in-bounds
brewall\airplane_2.txt    x[ -250 .. 2330]   y[ -250 .. 4800]   ← legend, WAY out of bounds
```

`_2` also carries genuinely useful metadata worth mining rather than drawing:

- **Attribution** (must be preserved and surfaced — it is the only attribution signal Brewall
  ships): `Original_Map:_Goodurden_<RoI>`, `Revised_Map:_Brewall_Rainsinger_(Cazic-Thule)`,
  `http://www.eqmaps.info`.
- **A recommended height-filter band**: `Height_Filter:_25/25`. Present in **51 of 577** `_2`
  files; observed values 25/25 (15×), 50/50, 30/30, 20/20, 15/15. Use as the z-slice default
  when present (§8).

### 2.4 Brewall label + colour conventions (the POI taxonomy)

Documented at `eqmaps.info/eq-map-files/mapping-standards/` and confirmed against the corpus.
Category is encoded by **(rgb, size, label affix) jointly** — the mapping is *not* injective, so
a classifier must use all three.

Label affixes, with counts from a 9,945-label sample of `brewall\*_1.txt`:

| Affix | Meaning | Sample count |
|---|---|---|
| `to_…` | Zone connection | 584 |
| `GS:_…` | Ground spawn | 226 |
| `TRAP:_…` | Trap | 127 |
| `…_(Hunter)` | Hunter mob | 1,885 |
| `…_(Named)` | Named mob | 0 in sample (documented, rare) |
| `…_(GM <class>)` | Guild master | — |
| `…_(Cultural)` | Cultural forge | — |
| `…Merchant…` | Merchant | 138 |

Label colours (the filter legend):

| Category | rgb | | Category | rgb |
|---|---|---|---|---|
| Zone connection (size 3) | 255,0,0 | | Quest giver | 0,127,127 |
| Teleport / trap / secret door | 255,255,0 | | Raid giver | 0,240,240 |
| Geographic name | 255,255,255 | | Named / Hunter | 127,64,0 |
| General NPC / info | 0,0,0 | | Tradeskill container | 128,0,128 |
| Banker | 255,210,0 | | GM / informational NPC | 128,128,128 |
| Merchant | 0,127,0 | | Ground spawn (size 1) | 0,0,240 |
| Parcel / special currency | 0,255,0 | | | |

Line colours encode **elevation bands within a single file** (black = main level, warm =
above, cool = below), plus semantic strokes: zone lines 199,21,133; water 0,0,255; lava
255,0,0; doors 205,133,63; traps 255,255,0.

**Treat colour→category as a display heuristic, never as a contract.** Two documented numbering
schemes exist for the elevation bands, and the default EQL set does not follow Brewall's palette
at all (its base-file points are all `0,0,0`). The taxonomy drives an *optional filter chip row*,
not the data model.

---

## 3. Data model

New file `src/shared/maps.ts`. Types only — no runtime dependency on Electron or Node, so both
the main parser and the renderer import from here.

```ts
/** A zone's short name — the map-file stem, lowercased. 'airplane', 'befallen'. */
export type ZoneShort = string

/** Which layer a record came from. 0 = base file, 1..3 = the _N files. */
export type MapLayer = 0 | 1 | 2 | 3

/**
 * Line geometry in COLUMNAR, COLOUR-BUCKETED form.
 *
 * Columnar because a zone is up to 26,383 segments (measured, everfrost.txt) and an array of
 * 26k objects is both slow to structured-clone across IPC and slow to iterate per frame.
 * Colour-bucketed because the canvas renderer wants ONE Path2D per colour (≈10-20 strokes per
 * zone) instead of 26k individual strokes — and main can compute the buckets for free while it
 * is already walking the file.
 */
export interface MapLines {
  /** [x1,y1,z1,x2,y2,z2] × count, flattened. */
  coords: Float32Array
  /** Distinct colours, packed [r,g,b] × paletteSize. */
  palette: Uint8Array
  /** Palette index per segment; length === count. */
  colorIndex: Uint8Array
  /** Layer per segment; length === count. Lets the renderer toggle without re-fetching. */
  layer: Uint8Array
  count: number
}

/** One labelled point of interest. Small in every zone (measured max 316), so plain objects. */
export interface MapPoint {
  x: number
  y: number
  z: number
  /** 0-255 each. */
  r: number
  g: number
  b: number
  /** Text size class 1..3 (small / medium / large). NOT a radius. */
  size: 1 | 2 | 3
  /** RAW label, underscores intact, exactly as the file spells it (law 2 — display raw). */
  label: string
  /** `label.replace(/_/g,' ')` — what the user reads and what search matches against. */
  display: string
  layer: MapLayer
}

/** Axis-aligned extent in MAP coordinates. Computed EXCLUDING layer 2 (see §2.3). */
export interface MapBounds {
  minX: number; maxX: number
  minY: number; maxY: number
  minZ: number; maxZ: number
}

/** Everything the viewer needs for one zone, from one pack selection. */
export interface MapData {
  zone: ZoneShort
  /** Which pack each layer actually came from — layers may be sourced from DIFFERENT packs. */
  sources: { layer: MapLayer; packId: string; file: string }[]
  lines: MapLines
  points: MapPoint[]
  /** Bounds over layers 0/1/3 only. Never includes the legend layer. */
  bounds: MapBounds
  /** Distinct z values seen in geometry, ascending — the floor picker's input (§8). */
  zLevels: number[]
  /** `Height_Filter:_N/M` mined from layer 2 when present (51/577 Brewall files have one). */
  heightHint?: { low: number; high: number }
  /** Attribution mined from layer 2's credit points. Surfaced in the UI (§9). */
  credits: string[]
  /** Lines that failed to parse. Non-zero ⇒ a diagnosable bad pack, never a thrown error. */
  skipped: number
}
```

### 3.1 Pack model

```ts
/** An installed map pack — a directory of <zone>[_N].txt files. */
export interface MapPack {
  /** Stable id: 'default' for <eqRoot>\maps itself, else the lowercased subdir name. */
  id: string
  /** Display name — the subdir's real casing, or 'Game default maps'. */
  name: string
  /** Absolute directory. Main-side only; never sent to the renderer. */
  dir: string
  /** Where it came from. 'game' = shipped/inside the EQ dir; 'user' = installed by us. */
  origin: 'game' | 'user'
  /** Distinct zone stems this pack provides. */
  zoneCount: number
  /** Total .txt files. */
  fileCount: number
}

/** The renderer-visible pack row (no absolute path). */
export type MapPackInfo = Omit<MapPack, 'dir'>

/** Per-layer pack preference. Missing key ⇒ fall back to the resolution order. */
export interface MapPackPrefs {
  /** Pack for base geometry. */
  geometry?: string
  /** Pack for labels/POIs — usually a DIFFERENT pack (§1a). */
  labels?: string
}
```

---

## 4. Where parsing lives, and the IPC surface

### 4.1 Main, not renderer — and why there is no third option

`src/main/log/config.ts` is the single resolver for the game directory and its header states
the law: *"Do NOT hardcode the Daybreak path anywhere else — route through here."* The renderer
runs with `contextIsolation: true` and no Node integration (`src/main/windows.ts`,
`WEB_PREFERENCES()`), so it cannot `readFile` at all. Handing the renderer raw file text over
IPC and parsing there would mean shipping ~1.7 MB of string for `akanon.txt` and doing 24k
`split()` calls on the UI thread.

So: **main reads and parses; the renderer receives `MapData`.**

Payload cost, worst case (`everfrost.txt`, 26,383 segments):
`coords` 26,383 × 6 × 4 B = 633 KB, `colorIndex` + `layer` 26 KB each, palette negligible,
points ≤ 316 objects. ≈ **690 KB, once per zone change.** Electron's structured clone handles
`Float32Array`/`Uint8Array` natively and efficiently. A JSON array of 26k line objects would be
several megabytes of string and an order of magnitude slower — that is the reason for columnar.

The parse itself is a synchronous single pass over ≤ 1.9 MB of text. `parseInventory.ts` is the
precedent for a synchronous game-dir read; keep the **pure** parser (`text → MapData`) separate
from the **impure** file resolution, exactly as `parseInventoryText` / `loadInventory` split,
and as `security.ts` / `imageCache.ts` do. That split is what lets the unit test run with no
Electron and never skip.

Cache parsed `MapData` in a main-side `Map<string, MapData>` keyed by
`${packPrefs}|${zone}` with a small LRU cap (8 zones ≈ 5 MB worst case). Zone re-entry is
common; re-parsing 1.7 MB on every zone line is waste.

### 4.2 Channels

Added to `src/shared/ipc.ts` under a new `// ---- map viewer ----` banner, following the
existing `'<domain>:<verb>'` convention and the `on*` prefix for main→renderer pushes:

| Key | Channel | Direction | Signature |
|---|---|---|---|
| `mapsListPacks` | `maps:listPacks` | invoke | `() => Promise<MapPackListResult>` |
| `mapsListZones` | `maps:listZones` | invoke | `(packId?: string) => Promise<ZoneShort[]>` |
| `mapsGet` | `maps:get` | invoke | `(zone: ZoneShort, prefs?: MapPackPrefs) => Promise<MapGetResult>` |
| `mapsSearch` | `maps:search` | invoke | `(query: string, opts?: MapSearchOpts) => Promise<MapSearchHit[]>` |
| `onMapPacksChanged` | `maps:packsChanged` | push | `() => void` (fires after a rescan / install) |

```ts
export interface MapPackListResult {
  packs: MapPackInfo[]
  /** Absent EQ dir / absent maps dir — the UI shows a quiet empty state, not an error. */
  error?: string
}

export type MapGetResult =
  | { ok: true; data: MapData }
  | { ok: false; error: string }

export interface MapSearchOpts {
  /** Restrict to one zone. Omit for a corpus-wide search (§7.2). */
  zone?: ZoneShort
  limit?: number
}

export interface MapSearchHit {
  zone: ZoneShort
  point: MapPoint
  score: number
}
```

Handlers go in a new `src/main/ipc/maps.ts` registered from `registerIpc()` in
`src/main/ipc/index.ts` — one import, one call, matching the seven existing domains.

**Validation at the handler, not at the caller** (the stated law, and the `isSafePackId`
precedent in `src/main/ipc/sounds.ts:26`): both `zone` and every `packId` in `prefs` reach a
`join()`, so both are validated in the handler with the existing `isSafePackId` from
`src/main/security.ts` — its character allowlist `/^[A-Za-z0-9_][A-Za-z0-9._-]*$/` already
admits every real stem (`thurgadina1`, `poknowledge`, `newsebexp`) and rejects traversal. Reuse
it; do not write a second predicate. Add a `tests/security.test.mts` case if the map stems
motivate any widening — they do not.

Errors follow the established discriminated-result shape, never a throw across IPC.

### 4.3 Preload

`src/preload/index.ts` exposes flat methods under a `// ---- map viewer ----` banner (there is
no namespacing in `window.eq` and this feature must not introduce one):

```ts
listMapPacks: (): Promise<MapPackListResult> => ipcRenderer.invoke(IPC.mapsListPacks),
listMapZones: (packId?: string): Promise<ZoneShort[]> => ipcRenderer.invoke(IPC.mapsListZones, packId),
getMapData: (zone: string, prefs?: MapPackPrefs): Promise<MapGetResult> =>
  ipcRenderer.invoke(IPC.mapsGet, zone, prefs),
searchMapPoints: (q: string, opts?: MapSearchOpts): Promise<MapSearchHit[]> =>
  ipcRenderer.invoke(IPC.mapsSearch, q, opts),
onMapPacksChanged: (cb: () => void): (() => void) => { /* on + removeListener, returns unsub */ },
```

`src/preload/index.d.ts` needs **no edit** — it re-exports `typeof api`.

---

## 5. Zone resolution — the hard problem

### 5.1 The measurement

I extracted every distinct zone from the live log, applied the app's own `zoneTier().base`
normalization (strip `- Solo/Group N`, strip the `(Awakened|Adaptive|Fused|Refined)` tier
suffix), and got **51 distinct canonical long names**. I then tried the obvious normalization
— lowercase, strip non-letters — against the 581 map stems on disk:

> **naive hits: 7 / 51.**

The 44 misses are not near-misses. A representative sample:

| Log says | Map file is | Failure mode |
|---|---|---|
| `The Eastern Plains of Karana` | `eastkarana` | Full rewording. Note the mob catalog calls it `Eastern Karana` — a *third* spelling. |
| `The Plane of Sky` | `airplane` | No lexical relationship whatsoever. |
| `The City of Guk` | `guktop` / `gukbottom` | **One long name, two map files.** Ambiguous by construction. |
| `Neriak - Foreign Quarter` | `neriaka` | Ordinal encoded as a letter. |
| `North Freeport` | `freeportn` | Word order inverted. |
| `Nagafen's Lair` | `soldungb` | Lore name vs internal name. |
| `EverQuest Legends Tutorial` | ? | EQL-new; not in any live-EQ table. |
| `New Sebilis Expedition` | `newsebexp` | EQL-new; default set only. |

### 5.2 The decision: hand-authored, committed, and honest about gaps

**Do not scrape this at runtime, and do not try to compute it.**

- `eqlwiki.com/Zone_short_names` exists (120 rows, `Zone Name | Short Name | ID`, cleanly
  parseable via the MediaWiki API) — but it is **Live-EQ derived**. It carries `bazaar`,
  `arttest` and modern Freeport revamps EQL does not have, omits every EQL-new zone, and spells
  names the Live way, not the EQL way. It is a **seed, not a source of truth.**
- Every candidate machine-readable zone table (EQEmu, ProjectEQ, eqsage, eqadvancedmaps) is
  either unlicensed, GPL-3.0, or has no committed table at all. The EQEmu `zone` table is *not*
  in the repo — `utils/sql/peq-dump/` only ships a script that dumps from a live MySQL server.

The corpus is **51 zones observed, ~133 that could exist** (the default map set's size). That is
small enough to author by hand and verify row by row against the filenames actually on disk.

```ts
// src/shared/zones.ts  (NEW — pure, no deps, unit-tested)

export interface ZoneEntry {
  /** The map-file stem. Lowercase. MUST exist as <pack>\<short>.txt for at least one pack. */
  short: ZoneShort
  /** Canonical display name — the EQL long name as the log spells it. */
  long: string
  /**
   * Additional long names that resolve here: the Live-EQ spelling, the mob catalog's spelling,
   * historic names. Matched after the same normalization as `long`.
   */
  aliases?: string[]
}

/**
 * Long zone name -> map stem. HAND-AUTHORED and COMMITTED.
 *
 * Seeded from eqlwiki.com/Zone_short_names (Live-EQ, 120 rows) and then verified row by row
 * against the map filenames actually present in <eqRoot>\maps. It is NOT scraped at runtime:
 * the wiki table is Live-EQ derived, omits every EQL-new zone (newsebexp, the EQL tutorial),
 * and spells several zones differently from the way EQL's log does ("Eastern Karana" vs the
 * log's "The Eastern Plains of Karana").
 *
 * MEASURED: naive normalization resolves 7 of the 51 zone names in the real log. There is no
 * algorithm here to find — the mapping is arbitrary ("The Plane of Sky" -> "airplane").
 */
export const ZONES: readonly ZoneEntry[] = [ /* … */ ]

/** Fold a long name to a match key: lowercase, drop a leading article, collapse punctuation. */
export function zoneKey(long: string): string

/**
 * Resolve a long zone name to a map stem. Returns null when unknown — the caller shows the
 * manual zone picker rather than guessing (law 1: never silently guess).
 */
export function zoneShortName(long: string): ZoneShort | null
```

### 5.3 Resolution pipeline, and the two gaps it must own

```
log 'zone' event  →  CharacterSnap.zone (RAW long name, tier suffix intact)
                  →  zoneTier(zone).base        ← strips '- Solo/Group N' and '(Refined)'
                  →  zoneKey(base)              ← lowercase, drop leading 'the ', collapse punct
                  →  ZONES lookup               ← hand table + aliases
                  →  ZoneShort | null
                  →  resolveFiles(short, prefs) ← per-pack, per-layer, case-insensitive
                  →  MapData
```

Two blockers the design must handle rather than hope away:

1. **`zoneTier` is main-only.** It lives in `src/main/log/parseWorld.ts` and the renderer must
   not import from `src/main`. Since resolution happens in main (§4.1), this is fine as designed
   — `maps:get` should accept the **raw long name** as well as a short name, and do the whole
   pipeline main-side. Recommend the handler signature accept `{ zone: string }` and try
   short-name resolution first, then long-name resolution. Moving `zoneTier`/`TIER_LABELS` into
   `src/shared/` is a clean future seam (already named in `docs/plans/overview-tab.md` §6) but
   is **not** required here and should not be done by this feature.

2. **`The City of Guk` → two files.** `ZoneEntry` needs to express this. Recommend
   `short` stays single-valued and a sibling `variants?: { short: ZoneShort; label: string }[]`
   lets the UI offer "Upper Guk / Lower Guk" as a picker when the log cannot disambiguate.
   The log genuinely cannot tell them apart — say so, don't guess (law 6).

**A missing mapping is a first-class state, not an error.** Unknown zone ⇒ the viewer opens on
a zone picker with the search box focused, showing a quiet "We don't have a map name for
*&lt;zone&gt;* yet — pick one" line. Every unresolved zone should also be logged once via
`logError('main:maps', …)` so the table's gaps show up in `errors.log` and can be filled in a
follow-up commit rather than discovered by a user complaint.

---

## 6. Rendering

### 6.1 Canvas, and the measurement that decides it

| | SVG | Canvas 2D |
|---|---|---|
| DOM nodes for `everfrost.txt` | **26,383** | 1 |
| React reconciliation per pan frame | 26k elements | none |
| Draw calls per frame | 26k (browser-managed) | **~10–20** (one `Path2D` per palette entry) |
| Hit-testing | free, per element | manual (but only needed for ~316 points, which are DOM) |

The combat timeline (`features/combat/useTimelineViewport.ts`, `TimelineChart.tsx`) uses SVG and
that is right *for it*: it windows to the visible **time** range
(`tl.events.filter(e => e.t >= view.start && e.t <= view.end)`), so the node count stays in the
hundreds regardless of encounter length. A map has no equivalent — the fit-to-zone view shows
**every** segment by definition, and that view is the default. The windowing trick that makes
SVG viable there is unavailable here.

⇒ **Canvas 2D.** Zero ambiguity at these counts.

### 6.2 What to reuse from the timeline, and what not to

**Reuse the interaction model verbatim** — it is a solved problem in this repo and the
conventions are load-bearing:

- **State is the view window, projection is derived.** The timeline's `ViewWin {start, end}`
  becomes a 2-D `MapView { minX, minY, maxX, maxY }` (or centre+scale; either is fine, but pick
  one and derive both projections from it in a pure module).
- **Cursor-anchored zoom**: compute the cursor's fractional position in the window, scale the
  span, re-anchor. Same algebra, applied on both axes.
- **The wheel listener must be attached NATIVELY and non-passively** —
  `el.addEventListener('wheel', onWheel, { passive: false })`. React's `onWheel` is passive so
  `preventDefault()` is a no-op there. This is commented as load-bearing in
  `useTimelineViewport.ts:116-124`; the map viewer will hit the exact same trap.
- **Drag-pan against the drag-START window held in a ref**, not accumulated per move (no
  drift), with `setPointerCapture` / `releasePointerCapture`.
- **`Fit` is just "set the window to `bounds`"**, and a `useEffect` keyed on the zone re-fits.
- **`ResizeObserver`** for the container size, feeding a pure metrics function.
- `style={{ touchAction: 'none', cursor: … }}` on the surface.

**Do not reuse the SVG rendering itself.** Split the files the same way the timeline does —
pure geometry module → interaction hook → drawing → framed component — because that split is
what makes the geometry unit-testable.

Redraw must be **rAF-throttled**. `src/renderer/src/lib/rafThrottle.ts` exists in the working
tree for exactly this (see §11 note on concurrent work).

Also required, and easy to forget: **handle `devicePixelRatio`.** Size the backing store to
`clientWidth * dpr` and `ctx.scale(dpr, dpr)`, or every map is blurry on the user's display.

### 6.3 Layer sourcing — the cross-pack merge

Per §1a, geometry and labels usually want to come from *different* packs. `resolveFiles` should
work like this, per layer:

1. If `prefs` names a pack for that layer and it has the file → use it.
2. Else walk the packs in preference order (`default` first for geometry — it is EQL-accurate;
   `brewall` first for labels — it is the only source with meaningful label data) and take the
   first that has a **non-empty** file.
3. Record the outcome in `MapData.sources` so the UI can honestly state
   "Geometry: game default · Labels: brewall".

That last point matters: silently merging two packs and showing one pack's name would be exactly
the kind of unlabelled inference the world-model laws forbid.

### 6.4 Points layer

Render as absolutely-positioned DOM over the canvas, projected each frame:

- Font size from `MapPoint.size` (1/2/3 → small/medium/large), **not** scaled by zoom — labels
  should stay legible at every zoom, which is what the in-game map does.
- Colour from `r,g,b`, with a contrast-safe outline/halo (many labels are pure black `0,0,0`
  and the map background is dark in this app's theme — a raw black label is invisible). Use a
  `paint-order`-style text stroke or a subtle backing chip; do **not** recolour the label, since
  colour carries category meaning (§2.4).
- Cull to the visible window before projecting. At ≤316 points this is cheap either way, but it
  keeps the DOM small when zoomed in.
- Overlap suppression: at 316 labels in `poknowledge` the fit view is unreadable. Recommend a
  simple greedy declutter (skip a label whose box intersects an already-placed one, largest
  `size` first) with a "show all labels" toggle. This is a polish item — acceptable to land in
  the last wave.

---

## 7. Search

### 7.1 Scale — it's tiny

The entire corpus is **35,720 `P` records**; the largest single zone has **316**. There is no
indexing problem here. Per AGENTS.md's UI conventions, these surfaces are *render*-bound, not
compute-bound — no workers, no databases.

### 7.2 Two scopes, both cheap

- **In-zone search** (the requirement): filter `MapData.points` on `display`. Build the
  lowercased `searchKey` once per `MapData` change in a `useMemo`, filter on
  `useDeferredValue(query)`. This is the exact documented pattern in
  `src/renderer/src/lib/search.ts` and the `SoundPacksDialog.tsx` reference implementation.
  Selecting a hit pans/zooms the view to centre that point and flashes a marker.

- **Corpus-wide search** ("which zone is *Ambassador D'Vinn* in?") — a genuine bonus that falls
  out for free. 35,720 rows is smaller than the committed 7,866-mob catalog the app already
  searches. Build it **lazily in main on first call** (the `mobSearch.ts` `HAYSTACKS` precedent:
  never at module load), cache it, and invalidate on `maps:packsChanged`. This is what
  `maps:search` with no `zone` serves.

Use the existing fuzzy matcher — `scoreQuery(tokenize(q), hay)` from `src/shared/fuzzy.ts`,
which already returns `null` for "excluded" vs a score. Do not write a second matcher.

**Import discipline** for any pure module that gets a `node --import tsx --test` unit test: VALUE
imports must be **relative** (`../../shared/fuzzy`), not `@shared/*` — the alias exists only in
the Vite build. Type-only imports may keep the alias. Documented at `features/mobs/mobSearch.ts:33`.

---

## 8. Height (z) filtering — include, but honestly

**The in-game filter is player-relative**: "only display the number of units above (High) and
below (Low) the character", default 10/10. **We cannot do that** — `Your Location` appears 0
times in 86.6 MB of log (§0 #7). Implementing a "height filter" that silently centres on
something other than the player would be a lie.

Recommendation — **include, in the last wave, as a manual control**, and label it as such:

- Compute `MapData.zLevels` in main: the distinct `min(z1, z2)` of every segment, clustered.
  (Taking `min` rather than both endpoints is deliberate — sloped segments spanning two floors
  would otherwise smear the clusters. This is what nparse does.)
- UI is a **discrete floor stepper** over the clusters ("Level 3 of 7", ↑/↓), plus an "All
  levels" default. Discrete floors read far better in dungeons than a continuous band and avoid
  flicker.
- Seed the band width from `MapData.heightHint` when the pack provides one (`Height_Filter:_25/25`,
  present in 51/577 Brewall `_2` files), else the client default 10/10.
- Filtering is a **render-time predicate over the columnar arrays** — no re-fetch, no re-parse.
  That is precisely why `MapLines.coords` keeps z.

If the wave runs long, **cut this before cutting search or the zone table.** A map you can pan
and search is the product; z-slicing is depth.

---

## 9. Packs, licensing, and the downloader

### 9.1 The licensing finding

- **eqmaps.info (Brewall) publishes NO license.** No copyright notice, no terms of use, no
  redistribution grant, no attribution requirement, no donation link — verified across the map
  files page, the mapping-standards page, the about page and the home page. The only attribution
  signal Brewall ships is *inside the map data*, in the `_2` credit points (§2.3).
- `RedGuides/brewall-maps` and `RedGuides/goodurden-maps` (the community mirrors) both have
  `license: null` and publish **no release tags**.
- The **one** permissively-licensed pack is `crande25/eql-maps` — **CC0-1.0**, EQL-native
  geometry, *"Use them, host them, modify them, no attribution required."* It currently contains
  **one file** (New Sebilis).

**This repo is PUBLIC and ships a Windows installer. Do not bundle Brewall or Good's maps.**

### 9.2 Why the downloader is deferred, not designed-and-shipped

The requirement asked for an optional in-app map-pack downloader on the sound-pack pattern. The
measurement changes the calculus: **the game already ships both the default set and a full
Brewall pack** (1,708 files, 580 zones, on disk right now). A downloader would fetch, at
meaningful complexity and nonzero legal ambiguity, content the user already has.

So:

- **v1 ships local discovery only.** Enumerate `<eqRoot>\maps` and every immediate subdirectory
  that contains at least one `<stem>.txt`. Zero network, zero licensing burden, zero new
  provisioning code. The "Map packs" UI is a *list* of what was found, plus the per-layer
  preference control (§6.3) — not an installer.
- **Attribution is still surfaced.** Render `MapData.credits` (mined from `_2`) in the viewer's
  footer or an info popover. Brewall's only stated wish is that credit, and honouring it costs
  one line of UI.
- **The downloader is a named future seam, and it is cheap when wanted**, because the pack model
  (`MapPack`, `origin: 'game' | 'user'`) already admits a second root at
  `<userData>/mappacks/`. If it is ever built, the ground rules are already established:

  | Concern | What the existing pattern dictates |
  |---|---|
  | Etiquette (LAW) | Rate-limited, backoff on 429/5xx honouring `Retry-After`, re-runnable, idempotent — `src/main/provisionPacks.ts` (`MAX_ATTEMPTS 3`, `RETRY_BASE_MS 2000` doubling, `BETWEEN_PACKS_MS 1000`) is the reference. |
  | Idempotence | Lives in the *caller*, as with `provisionDefaultPacks()` — skip anything already installed, never re-download. |
  | Atomicity | Stage to `<dir>.installing`, then `renameSync`. `installPack()` in `src/main/packRegistry.ts`. A half-written pack must never shadow a good one. |
  | Path traversal | `safeJoin(root, rel)` on every archive entry; a violation deletes the stage dir and throws. |
  | Version signal | Upstream publishes no tags. The only machine-readable index is `eqmaps.info/wp-json/wp/v2/media` (filenames are self-versioning `<tag>-YYYYMMDD.zip`); `Last-Modified` on the zip is the fallback. |
  | Operational trap | eqmaps.info sits behind Mod_Security and returns **406** to non-browser User-Agents. |
  | Storage | `<userData>/mappacks/<id>/` — `app.getPath('userData')` so channel isolation applies automatically. |

  Note also that Brewall's own site advises against installing packs into the main `maps` folder
  ("every time EverQuest starts, it overwrites 100 zones with default maps"), which is a second
  reason for `<userData>` over the game dir: **we must never write into `<eqRoot>`.**

---

## 10. Renderer feature structure

```
src/renderer/src/features/maps/
  MapsView.tsx          default export; layout, zone resolution, pack prefs, empty states
  mapGeometry.ts        PURE: MapView window, fit(), project(), zoomAround(), cull   (node-tested)
  useMapViewport.ts     interaction: native non-passive wheel, drag-pan, fit, rAF redraw
  MapCanvas.tsx         the <canvas>: dpr sizing, per-palette Path2D batching, layer/z predicates
  MapLabels.tsx         the DOM point layer: projection, culling, declutter, tooltips
  MapSearch.tsx         the search box + hit list + jump-to
  MapToolbar.tsx        zoom/fit buttons, layer toggles, floor stepper, pack selector
  useMapData.ts         zone -> window.eq.getMapData, in-flight dedupe, LRU, hydration state
  mapSearchIndex.ts     PURE: searchKey build + filter over MapPoint[]               (node-tested)
```

Bound by the stated UI conventions:

- **MUI** like every sibling view (`Paper variant="outlined"`, `Stack`, `Chip`). The MUI-free
  rule applies only to the overlay bundle — this is a main-window tab.
- **State, never process.** Chips say `brewall`, `game default`, `labels: 316`, `no map`. No
  "loading map file from disk…" narration.
- **A growing list lives in a FIXED-height scroll box** — the search-hit list gets an explicit
  height and its own `overflow: 'auto'`; the canvas pane gets `flexGrow: 1` + `minHeight: 0`.
  This is the Task-#56 bug and the e2e harness measures it.
- **Lint budget, no new ratchet entries** (adding one is the integrator's call, never an
  executor's): `max-lines 400`, `max-lines-per-function 100`, `complexity 12`, `max-depth 3`,
  `max-params 4`. The nine-file split above is sized for those budgets; `MapCanvas` and
  `useMapViewport` are the two at risk — keep the pure math in `mapGeometry.ts`.
- **`data-testid` on every asserted node** (§12).

### What the viewer honestly can and cannot do

| Can | Cannot |
|---|---|
| Auto-open the **current zone's** map from the log | Show **where you are** in it — no positional line exists in the log (verified: 0 `Your Location` in 86.6 MB) |
| Search POI labels in-zone and corpus-wide | Show live mob positions, spawn timers, or anything not in the file |
| Toggle layers, pick per-layer packs, step floors | Follow the player's Z (that is what the in-game filter does; we have no Z) |
| State which pack each layer came from | — |

State the "cannot" column in the UI where a user would otherwise assume otherwise — a map with
no "you are here" dot should say so once, quietly, not leave the user hunting for it.

---

## 11. Wave plan

Disjoint file ownership per wave. Integrator commits per wave and runs the gauntlet between.
"Keep the tree buildable" is in force: create any file you import before writing the import.

> ⚠ **CONTENTION WARNING — read before dispatching.** At the time of writing, the working tree
> has **uncommitted concurrent work** touching `src/renderer/src/App.tsx`,
> `src/renderer/src/appViews.ts`, `src/renderer/src/components/NavDrawer.tsx`,
> `src/shared/combat.ts`, and adding `src/renderer/src/features/overview/`,
> `src/renderer/src/lib/rafThrottle.ts`, `src/renderer/src/lib/ChartTooltip.tsx`. Those are
> exactly the three shell files this feature must also edit. **Wave 3 must not start until the
> overview work is committed**, and its agent must re-read all three files immediately before
> each surgical edit. Waves 1 and 2 touch none of them and can start immediately.

### Wave 1 — two agents, fully parallel, pure, zero contention

**Agent 1A — the parser and the types.**
- Owns: `src/shared/maps.ts` (new), `src/main/maps/parseMap.ts` (new),
  `tests/mapParse.test.mts` (new), `tests/fixtures/map-synthetic*.txt` (new).
- Deliver the pure `parseMapText(text, layer): { lines, points, skipped }` and a
  `buildMapData(parts): MapData` that unions bounds **excluding layer 2**, computes `zLevels`,
  and mines `heightHint` + `credits` from layer 2.
- **Every §2.2 edge case is a required test case**, each with a one-line comment naming the
  measured incidence.
- **FIXTURE LICENSING — hand-author a synthetic fixture; do NOT commit a real map file.**
  Brewall publishes no license and this repo is public (§9.1). A ~25-line synthetic fixture
  covers every edge case more legibly than a real 1.7 MB file anyway: a comma-in-label point, a
  space-in-label point, a `P` record inside the base file, a mixed-case `_1`, an out-of-bounds
  `_2` legend block with a `Height_Filter:_25/25` and a credit line, a zero-byte `_3`, a blank
  line, and one malformed line to prove `skipped` counts rather than throws.
- Pure, no Electron, no network ⇒ this suite **never skips** (the `security.test.mts` /
  `imageCache.test.mts` precedent).

**Agent 1B — the zone table.**
- Owns: `src/shared/zones.ts` (new), `tests/zones.test.mts` (new).
- Hand-author `ZONES` covering **at minimum the 51 zones observed in the live log** (listed in
  §5.1's measurement — the agent gets the full list in its brief), extended toward the 133
  default-set stems. Seed from `eqlwiki.com/Zone_short_names` but **verify every row against a
  real filename**; flag any row whose `short` has no file on disk.
- Implement `zoneKey`, `zoneShortName`, and the `variants` handling for `The City of Guk`.
- Test: every entry's `short` is lowercase and matches `isSafePackId`'s allowlist; the article
  and punctuation folding is exercised; **an unknown name returns `null`, never a guess**;
  aliases resolve; no two entries collide on `zoneKey`.
- This agent must **not** import from `src/main` (`zoneTier` stays where it is).

### Wave 2 — two agents, parallel

**Agent 2A — main-side resolution + IPC.**
- Owns: `src/main/maps/packs.ts` (new), `src/main/maps/index.ts` (new),
  `src/main/ipc/maps.ts` (new), `src/main/ipc/index.ts` (one import + one call),
  `src/shared/ipc.ts` (one new banner), `src/preload/index.ts` (one new banner),
  `tests/mapPacks.test.mts` (new).
- Pack discovery under `effectiveEqRoot()` + `<userData>/mappacks`; case-insensitive stem
  resolution; the §6.3 per-layer cross-pack merge; the LRU parse cache; the lazy corpus search
  index; `isSafePackId` validation on `zone` and every `packId` **at the handler**.
- Keep the impure file layer thin and inject the roots so the test needs no Electron
  (`imageCache.ts`'s `ImageCacheOptions` precedent). Test against a temp dir of synthetic packs.
- **Never write to `<eqRoot>`.** Read-only, always.

**Agent 2B — the viewer core, against wave-1 types with a stub source.**
- Owns: `src/renderer/src/features/maps/mapGeometry.ts`, `useMapViewport.ts`, `MapCanvas.tsx`,
  `tests/mapGeometry.test.mts` (new).
- Pure geometry (fit, project, cursor-anchored zoom, cull) unit-tested; the interaction hook;
  the canvas with dpr sizing and per-palette `Path2D` batching.
- **The native non-passive wheel listener is a required detail** (§6.2) — call it out.
- Renders from a `MapData` prop, so it needs nothing from 2A to compile or to be tested.

### Wave 3 — one agent, AFTER the overview work is committed

- Owns: `src/renderer/src/appViews.ts`, `src/renderer/src/components/NavDrawer.tsx`,
  `src/renderer/src/App.tsx`, and the rest of `features/maps/` (`MapsView.tsx`, `useMapData.ts`,
  `MapLabels.tsx`, `MapSearch.tsx`, `MapToolbar.tsx`, `mapSearchIndex.ts`,
  `tests/mapSearchIndex.test.mts`).
- Add `'maps'` to `View` **and** `KNOWN_VIEWS` (missing the second silently bounces returning
  users to the default), a `MapIcon` nav row with `data-testid="nav-maps"`, and the
  `ViewContent` line.
- Wire the current zone: `useModule<CharacterSnap, CharacterDelta>('character', (s,d) => ({...s,...d}))`.
  Note this feature and the overview tab are the **first two consumers** of that module — no
  bespoke `map:getZone` channel.
- Auto-open on zone change; unknown zone ⇒ the picker empty state, never a guess.
- Persist pack prefs + last zone to `localStorage` under `eq.maps.*` (machine-local; do **not**
  add a `UI_PREF_SPECS` entry unless sharing is wanted).

### Wave 4 — optional, one agent

Height/floor filter (§8), label declutter (§6.4), legend panel + `credits` attribution (§9.2).
Cut order if time-pressed: declutter → legend → floors. Nothing here blocks the product.

**The downloader is NOT in this plan.** Revisit only if a user turns up without the bundled
`maps\brewall` directory — and re-measure before building it.

---

## 12. Verification

Per wave: `npm run typecheck` (node + web) → `npm run lint` (**green with ZERO new ratchet
entries**; check the true state with `EQ_LINT_NO_RATCHET=1 npx eslint .`) → `npm test` (full
golden-window suite) → `npm run test:e2e` when main or renderer changed.

New tests are direct children of `tests/` (the glob `tests/*.test.mts` is non-recursive),
`node:test` + `node:assert/strict`, flat top-level `test('sentence stating the invariant', …)`,
each file opening with a header comment explaining why the boundary exists.

No golden-window fixture is needed for any of this — the feature reads no log lines beyond the
`zone` event, which is already covered. **No regression gate is required**: nothing here touches
`CombatEngine`, so the damage-total tripwire is not in play.

### Unit coverage that must exist

| File | Must prove |
|---|---|
| `mapParse.test.mts` | Every §2.2 edge case; `skipped` counts instead of throwing; bounds exclude layer 2; `heightHint` + `credits` mined; `zLevels` uses `min(z1,z2)` |
| `zones.test.mts` | All 51 observed zones resolve; unknown ⇒ `null`; alias + article folding; no `zoneKey` collisions; every `short` passes `isSafePackId` |
| `mapPacks.test.mts` | Case-insensitive stem resolution; stems ending in digits; cross-pack per-layer merge picks the right file and records it in `sources`; traversal rejected; empty file ≠ error |
| `mapGeometry.test.mts` | Fit produces the exact bounds; cursor-anchored zoom keeps the anchor fixed; clamping; cull correctness |
| `mapSearchIndex.test.mts` | Underscore→space matching; comma-bearing labels are searchable in full; empty query returns `[]` |

### e2e (`tests/e2e/maps.e2e.mts`, wave 3)

Floors and identities only — frozen numbers rot. Assert: the nav row mounts the view; the canvas
element has non-zero size and a dpr-scaled backing store; when `CharacterSnap.zone` resolves,
the header states that zone and `sources` is non-empty; the search-hit list is a **bounded**
scroll box (`h <= 320 && scrollHeight >= clientHeight` — the Task-#56 law, measured); typing a
label prefix present in the loaded zone yields ≥1 hit; no renderer console errors.

Guard for the fresh-machine case: on a machine with **no** EQ install the view must show the
quiet empty state, not an error — `note()` and skip the zone assertions rather than failing.

---

## 13. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **Zone mapping is the critical path and has no algorithm** (7/51 naive hits) | **HIGH** — feature is inert without it | Wave 1B, hand-authored + committed + tested, seeded from eqlwiki, verified against real filenames. Unknown ⇒ picker, never a guess. Log gaps to `errors.log`. |
| `split(',')[7]` truncates 4.5% of all labels | **HIGH** — silently corrupts the search corpus | Required test case in wave 1A; the incidence (1,607/35,720) goes in the brief |
| Layer `_2` unioned into bounds ⇒ every map renders as a speck | **HIGH** — instantly visible, easily missed in review | Bounds exclude layer 2 by construction; wave-1A test asserts it with the measured `airplane` numbers |
| Choosing the default pack alone ⇒ permanently empty search | **HIGH** — silently defeats requirement 2 | Per-layer pack sourcing (§6.3); labels default to a Brewall-style pack; `sources` is surfaced |
| Shell-file collision with the in-flight overview work | **HIGH** — merge pain in `App.tsx`/`appViews.ts`/`NavDrawer.tsx` | Wave 3 gated on that work landing; re-read before each surgical edit |
| SVG chosen for 26k segments | MED — unusable pan/zoom | Decided: canvas. The measurement is in §6.1 so it is not re-litigated |
| React `onWheel` is passive ⇒ zoom silently scrolls the page | MED — costs an hour to rediscover | Native `addEventListener('wheel', …, {passive:false})`, called out in the wave-2B brief |
| Missing `devicePixelRatio` handling | MED — every map is blurry | Explicit in §6.2 and the 2B brief |
| Committing a real Brewall map as a test fixture | MED — unlicensed content in a PUBLIC repo | Hand-authored synthetic fixture (wave 1A). Non-negotiable |
| Writing into `<eqRoot>` | MED — corrupts the user's game install | Read-only by law; any future pack install goes to `<userData>/mappacks` |
| 690 KB IPC payload per zone change | LOW | Columnar typed arrays + main-side LRU; measured worst case, once per zone |
| 316 labels unreadable at fit zoom | LOW | Greedy declutter + "show all" toggle (wave 4) |
| Building a downloader for content the user already has | LOW–MED — wasted effort, real legal ambiguity | Deferred (§9.2). Re-measure before reviving |
| Renderer importing `zoneTier` from `src/main` | LOW | Resolution happens main-side; `maps:get` accepts the raw long name |
| New files needing ratchet entries | MED — the ratchet ONLY shrinks | Nine-file split sized for the budgets; executors must not add entries |
