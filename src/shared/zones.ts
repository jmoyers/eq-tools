// zones.ts — the ONE shared zone-knowledge artifact (map viewer wave 1B, docs/plans/map-viewer.md §5).
//
// Two independent naming authorities have to be joined here and neither can be computed from the
// other:
//
//   1. The LOG says a long name: `You have entered The Eastern Plains of Karana.`
//   2. The MAP FILES on disk are named by SHORT stem: `<eqRoot>\maps\eastkarana.txt`.
//   3. The MOB CATALOG (`renderer/src/data/eqlegends/mobs.json`, scraped from the wiki) uses a
//      THIRD spelling again: `Eastern Plains of Karana`, `Eastern Karana`, `East Karana` — all
//      three, in different rows, for one place.
//
// MEASURED (map-viewer.md §5.1, re-derived here 2026-08-03 against the live 86.6 MB log): naive
// normalization — lowercase, strip non-letters — resolves **7 of the 51** distinct zone names the
// log has printed. The misses are not near-misses: `The Plane of Sky` -> `airplane`,
// `Nagafen's Lair` -> `soldungb`, `North Freeport` -> `freportn`. THERE IS NO ALGORITHM HERE.
// So the table is hand-authored, committed, and tested.
//
// PROVENANCE OF EVERY ROW (what "verified" means below):
//   - `short` was checked to exist as `<stem>.txt` in the real map corpus — `<eqRoot>\maps`
//     (192 files / 133 stems) and `<eqRoot>\maps\brewall` (1,708 files / 580 stems). Rows whose
//     stem exists ONLY in the brewall pack are marked `// brewall only` — they still render (the
//     viewer merges per-layer across packs, §6.3), they just aren't in the game's own set.
//   - `name` for the 51 observed zones is the log's own spelling, verbatim. For the rest it is
//     seeded from eqlwiki.com/Zone_short_names (a Live-EQ table: it omits every EQL-new zone and
//     spells several zones the Live way) and corroborated against the catalog's zone strings.
//     A name EQL never prints is inert — `zoneShortName` just never sees it — so an
//     unconfirmed-but-plausible row costs nothing and a WRONG one costs a wrong map. When in
//     doubt the row was left OUT (see the TODOs at the bottom).
//   - `mobCatalogNames` was verified row by row by intersecting the mobs the log recorded SLAIN
//     inside that zone against the catalog rows carrying the candidate spelling. Evidence is
//     quoted beside each one. Nothing went in on a hunch.
//
// DELIBERATELY NOT IN THE TABLE: ambiguous long names. The catalog says `Freeport`, `Kaladim`,
// `Neriak`, `Qeynos` — each of which is 2-3 different map files. Resolving them would be a
// guess, so they resolve to `null` and the viewer shows its zone picker (world-model law 1).
//
// This module is PURE: no Node, no Electron, no renderer. Both main and the renderer import it.

import type { ZoneShort } from './maps'

/** One zone: what the log calls it, what its map file is called, and who else spells it how. */
export interface ZoneEntry {
  /** The map-file stem, lowercase. Exists as `<pack>\<short>.txt` for at least one pack. */
  short: ZoneShort
  /** Canonical display name — the EQL long name, as the log spells it where we have seen it. */
  name: string
  /**
   * Other long names that resolve here: the Live-EQ spelling, historic names, the catalog's.
   * Matched after the same `zoneKey` fold as `name`, so an alias that folds onto `name` is
   * redundant and is NOT listed (`Neriak Commons` folds onto `Neriak - Commons` already).
   */
  aliases?: string[]
  /**
   * Mob-catalog zone spellings that the `zoneKey` fold CANNOT reach from this zone's own name —
   * i.e. where the two sources use a different NAME, not a different spelling. See
   * `catalogZonesFor`. Present only where the mapping was verified against real data.
   */
  mobCatalogNames?: string[]
}

// ---- the fold ------------------------------------------------------------------------------
//
// THIS IS A MIRROR, ON PURPOSE. `src/renderer/src/features/mobs/mobZone.ts` shipped the identical
// fold first (Task #64) for the "what lives in this zone" join, and its header carries the full
// evidence for each rule. The two folds MUST NOT be able to disagree — a zone that resolves to a
// map here but to zero mobs there (or vice versa) would be a silent, invisible inconsistency —
// so the rules are duplicated verbatim and `tests/zones.test.mts` asserts parity against the real
// mobZone implementation on real log zone names.
//
// It is a mirror rather than an import because the dependency direction only works one way:
// `src/shared` may not import from `src/renderer`, and the renderer's copy is deliberately
// standalone (mobZone.ts:20-24). If a rule ever changes, change BOTH files and the parity test
// will catch it if you don't. The tier strips ultimately trace to `zoneTier()` in
// `src/main/log/parseWorld.ts`, which stays where it is (map-viewer.md §5.3 blocker 1).

/** ` - Solo` / ` - Group 2` and everything after it — instance selection, never part of a name. */
const SOLO_GROUP_RE = /\s*-\s*(Solo|Group)\b.*$/i
/** A trailing tier parenthetical, with or without the instance ordinal: ` 4 (Refined)`. */
const TIER_ORDINAL_RE = /\s+\d+\s*\([^)]*\)\s*$/
/** A bare trailing parenthetical: ` (Awakened)`, and the catalog's ` (Pre-Revamp)` / ` (37)`. */
const TIER_PAREN_RE = /\s+\([^)]*\)\s*$/
/** Runs of whitespace and hyphens, collapsed to one space. */
const SEPARATORS_RE = /[\s-]+/g
/** The one leading article EQ zone names use. */
const LEADING_ARTICLE_RE = /^the /

/**
 * Canonical key for a zone name, from ANY of the three sources. Case-insensitive, instance noise
 * stripped, leading article folded, separators normalized. Never throws; a nullish/blank name
 * folds to `''`.
 */
export function zoneKey(zone: string | undefined | null): string {
  return (zone ?? '')
    .replace(SOLO_GROUP_RE, '')
    .replace(TIER_ORDINAL_RE, '')
    .replace(TIER_PAREN_RE, '')
    .toLowerCase()
    .replace(SEPARATORS_RE, ' ')
    .trim()
    .replace(LEADING_ARTICLE_RE, '')
    .trim()
}

// ---- the table -----------------------------------------------------------------------------

/**
 * Long zone name -> map stem. HAND-AUTHORED and COMMITTED (map-viewer.md §5.2).
 *
 * Section 1 is the 51 distinct zone names the live log has actually printed; every one of them
 * resolves except the EQL-new tutorial (see the TODO below). Sections 2-4 extend toward the map
 * corpus with the classic / Kunark / Velious zones an EQL log could plausibly print next.
 */
export const ZONES: readonly ZoneEntry[] = [
  // --- 1. OBSERVED IN THE LIVE LOG (50 of the 51 canonical names resolve) ---
  { short: 'befallen', name: 'Befallen' },
  { short: 'blackburrow', name: 'Blackburrow' }, // brewall only
  { short: 'butcher', name: 'Butcherblock Mountains', mobCatalogNames: ['BBM'] },
  { short: 'ecommons', name: 'East Commonlands', mobCatalogNames: ['EC'] },
  { short: 'freporte', name: 'East Freeport', mobCatalogNames: ['EFP'] },
  { short: 'erudsxing', name: "Erud's Crossing" },
  { short: 'erudnext', name: 'Erudin' },
  { short: 'erudnint', name: 'Erudin Palace' },
  { short: 'everfrost', name: 'Everfrost Peaks' },
  { short: 'grobb', name: 'Grobb' },
  { short: 'highpass', name: 'Highpass Hold' },
  { short: 'innothule', name: 'Innothule Swamp' },
  { short: 'kithicor', name: 'Kithicor Forest' },
  { short: 'soldungb', name: "Nagafen's Lair" }, // brewall only
  { short: 'najena', name: 'Najena' },
  { short: 'nektulos', name: 'Nektulos Forest' },
  { short: 'neriakb', name: 'Neriak - Commons' },
  { short: 'neriaka', name: 'Neriak - Foreign Quarter' },
  { short: 'newsebexp', name: 'New Sebilis Expedition' }, // EQL-new; DEFAULT SET ONLY
  { short: 'freportn', name: 'North Freeport' },
  { short: 'kaladima', name: 'North Kaladim' },
  { short: 'qeynos2', name: 'North Qeynos' },
  { short: 'oggok', name: 'Oggok' },
  { short: 'paineel', name: 'Paineel' },
  // Two log names, ONE place: `Permafrost Keep` is the open zone (ice goblins, King Thex`Ka IV),
  // `The Permafrost Caverns - Solo N` its instance (ice giants, Lady Vox) — and entering the Keep
  // logs the achievement "The Permafrost Caverns Traveler". eqlwiki's table says
  // `Permafrost Keep | permafrost`; brewall's permafrost_1 labels carry both Lady Vox and the ice
  // goblins. Catalog spells the whole zone `Permafrost` (36 rows incl. Lady Vox, King Thex`Ka IV).
  {
    short: 'permafrost',
    name: 'Permafrost Keep',
    aliases: ['The Permafrost Caverns'],
    mobCatalogNames: ['Permafrost']
  },
  { short: 'qeytoqrg', name: 'Qeynos Hills' },
  { short: 'kaladimb', name: 'South Kaladim' },
  { short: 'qeynos', name: 'South Qeynos' },
  // Guk is TWO zones and the log names them separately (see the header note under DEVIATIONS in
  // tests). Upper: the log's `The City of Guk` killed froglok ton/gaz knights + froglok sentries;
  // catalog `Upper Guk` (51 rows) carries exactly those names, and brewall's guktop_1 labels are
  // froglok. Lower: `The Ruins of Old Guk` killed zol/wan/dar ghoul knights + a frenzied ghoul;
  // catalog `Lower Guk` (63 rows) and gukbottom_1's labels match.
  { short: 'guktop', name: 'The City of Guk', aliases: ['Upper Guk'], mobCatalogNames: ['Upper Guk'] },
  {
    short: 'eastkarana',
    name: 'The Eastern Plains of Karana',
    aliases: ['East Karana', 'Eastern Karana'],
    // Catalog uses all three; only `Eastern Plains of Karana` (79 rows) folds onto the log name.
    mobCatalogNames: ['East Karana', 'Eastern Karana', 'Eastern Karana (37)']
  },
  { short: 'feerrott', name: 'The Feerrott' },
  // eqlwiki's zone table: `Infected Paw | paw`. The log's Splitpaw kills (a Tesch Mas / Rosch Mas /
  // Lteth Mal Gnoll) are catalog `Splitpaw Lair` rows verbatim; brewall paw_1 labels `Splitpaw_Jail`.
  {
    short: 'paw',
    name: 'The Lair of the Splitpaw',
    aliases: ['Splitpaw Lair', 'Infected Paw'],
    mobCatalogNames: ['Splitpaw Lair', 'Infected Paw']
  },
  { short: 'lavastorm', name: 'The Lavastorm Mountains' },
  { short: 'nro', name: 'The Northern Desert of Ro', aliases: ['North Ro'], mobCatalogNames: ['North Ro'] },
  {
    short: 'northkarana',
    name: 'The Northern Plains of Karana',
    aliases: ['North Karana', 'Northern Karana'],
    // `Northern Plains of Karana` is 4 rows; `Northern Karana` alone is 54 more of the same zone.
    mobCatalogNames: ['North Karana', 'Northern Karana', 'Northern Karana (35)']
  },
  { short: 'oasis', name: 'The Oasis of Marr' },
  { short: 'oot', name: 'The Ocean of Tears' },
  { short: 'fearplane', name: 'The Plane of Fear' },
  { short: 'hateplane', name: 'The Plane of Hate' }, // brewall only (hateplaneb is the revamp)
  { short: 'airplane', name: 'The Plane of Sky' },
  { short: 'rathemtn', name: 'The Rathe Mountains', aliases: ['Mountains of Rathe'] },
  { short: 'gukbottom', name: 'The Ruins of Old Guk', aliases: ['Lower Guk'], mobCatalogNames: ['Lower Guk'] },
  // The log's Old Paineel kills (a rock golem, an elemental warrior, a ratman warrior, Slizik the
  // Mighty) are catalog `The Hole` rows verbatim; brewall hole_1 labels Elemental_Striker + a
  // ratman_inhabitant. eqlwiki: `The Ruins of Old Paineel | hole`.
  { short: 'hole', name: 'The Ruins of Old Paineel', aliases: ['The Hole'], mobCatalogNames: ['The Hole'] }, // brewall only
  {
    short: 'sro',
    name: 'The Southern Desert of Ro',
    aliases: ['South Ro'],
    mobCatalogNames: ['South Ro', 'Southern Ro']
  },
  {
    short: 'southkarana',
    name: 'The Southern Plains of Karana',
    aliases: ['South Karana', 'Southern Karana'],
    // `Southern Plains of Karana` is ONE row; `Southern Karana` is 53 more of the same zone.
    mobCatalogNames: ['South Karana', 'Southern Karana']
  },
  { short: 'soltemple', name: 'The Temple of Solusek Ro' },
  { short: 'tox', name: 'Toxxulia Forest' }, // classic stem; `toxxulia` is the Live revamp
  { short: 'commons', name: 'West Commonlands', mobCatalogNames: ['WC'] },
  { short: 'freportw', name: 'West Freeport', mobCatalogNames: ['WFP'] },

  // --- 2. CLASSIC, not yet observed. Names from eqlwiki's table, corroborated by the catalog. ---
  { short: 'akanon', name: "Ak'Anon" },
  { short: 'arena', name: 'The Arena' },
  { short: 'barter', name: 'The Barter Hall' },
  { short: 'bazaar', name: 'The Bazaar' },
  { short: 'cauldron', name: "Dagnor's Cauldron" },
  { short: 'cazicthule', name: 'Cazic-Thule' },
  { short: 'crushbone', name: 'Clan Crushbone', aliases: ['Crushbone'] },
  { short: 'felwithea', name: 'North Felwithe', aliases: ['Northern Felwithe'] },
  { short: 'felwitheb', name: 'South Felwithe', aliases: ['Southern Felwithe'] },
  { short: 'gfaydark', name: 'The Greater Faydark' },
  { short: 'guildlobby', name: 'The Guild Lobby' },
  { short: 'halas', name: 'Halas' },
  { short: 'highkeep', name: 'High Keep', aliases: ['HighKeep'] },
  { short: 'kedge', name: 'Kedge Keep' },
  { short: 'kerraridge', name: 'Kerra Isle', aliases: ['Kerra Island'] },
  { short: 'lakerathe', name: 'Lake Rathetear', aliases: ['Lake Rathe'] },
  { short: 'lfaydark', name: 'The Lesser Faydark' },
  { short: 'beholder', name: 'Gorge of King Xorbb', aliases: ["Beholder's Maze"] },
  { short: 'misty', name: 'Misty Thicket' }, // classic stem; `mistythicket` is the Live revamp
  { short: 'mistmoore', name: 'Castle Mistmoore', aliases: ['Mistmoore Castle'] },
  { short: 'neriakc', name: 'Neriak - Third Gate' },
  { short: 'neriakd', name: 'Neriak Palace' }, // brewall only
  { short: 'nexus', name: 'The Nexus' },
  { short: 'poknowledge', name: 'Plane of Knowledge' },
  { short: 'qcat', name: 'Qeynos Catacombs', aliases: ['Qeynos Aqueducts'] },
  { short: 'qrg', name: 'Surefall Glade' },
  { short: 'rivervale', name: 'Rivervale' },
  { short: 'runnyeye', name: 'Clan RunnyEye', aliases: ['Runnyeye Citadel'] }, // brewall only
  { short: 'soldunga', name: "Solusek's Eye" }, // brewall only
  { short: 'steamfont', name: 'Steamfont Mountains' }, // classic stem; `steamfontmts` is the revamp
  { short: 'stonebrunt', name: 'Stonebrunt Mountains' },
  { short: 'unrest', name: 'The Estate of Unrest', aliases: ['Unrest'] }, // brewall only
  { short: 'warrens', name: 'The Warrens' }, // brewall only
  { short: 'qey2hh1', name: 'The Western Plains of Karana', aliases: ['West Karana', 'Western Karana'] },

  // --- 3. KUNARK. Stems are brewall-only except where marked; names corroborated by the catalog. ---
  { short: 'burningwood', name: 'The Burning Wood', aliases: ['Burning Woods'] }, // in default set
  { short: 'cabeast', name: 'Cabilis East', aliases: ['East Cabilis'] }, // in default set
  { short: 'cabwest', name: 'Cabilis West', aliases: ['West Cabilis'] }, // in default set
  { short: 'chardok', name: 'Chardok' },
  { short: 'charasis', name: 'Howling Stones' },
  { short: 'citymist', name: 'City of Mist' },
  { short: 'dalnir', name: 'Crypt of Dalnir' },
  { short: 'dreadlands', name: 'The Dreadlands' }, // in default set
  { short: 'droga', name: 'Temple of Droga' },
  { short: 'emeraldjungle', name: 'The Emerald Jungle' }, // in default set
  { short: 'fieldofbone', name: 'The Field of Bone' }, // in default set
  { short: 'firiona', name: 'Firiona Vie' }, // in default set
  { short: 'frontiermtns', name: 'Frontier Mountains' },
  { short: 'kaesora', name: 'Kaesora' },
  { short: 'karnor', name: "Karnor's Castle" },
  { short: 'kurn', name: "Kurn's Tower" },
  { short: 'nurga', name: 'Mines of Nurga' },
  { short: 'overthere', name: 'The Overthere' }, // in default set
  { short: 'sebilis', name: 'Old Sebilis' },
  { short: 'skyfire', name: 'Skyfire Mountains' },
  { short: 'swampofnohope', name: 'The Swamp of No Hope' }, // in default set
  { short: 'timorous', name: 'Timorous Deep' }, // in default set
  { short: 'trakanon', name: "Trakanon's Teeth" },
  { short: 'veeshan', name: "Veeshan's Peak" },
  { short: 'warslikswood', name: "Warslik's Woods", aliases: ['Warsliks Woods'] },

  // --- 4. VELIOUS. Stems are brewall-only except where marked. ---
  { short: 'cobaltscar', name: 'Cobalt Scar' }, // in default set
  { short: 'crystal', name: 'Crystal Caverns' },
  { short: 'eastwastes', name: 'Eastern Wastes' },
  { short: 'frozenshadow', name: 'Tower of Frozen Shadow' },
  { short: 'greatdivide', name: 'The Great Divide' }, // in default set
  { short: 'growthplane', name: 'Plane of Growth' },
  { short: 'iceclad', name: 'Iceclad Ocean' },
  { short: 'kael', name: 'Kael Drakkel' }, // in default set
  { short: 'mischiefplane', name: 'Plane of Mischief' },
  { short: 'necropolis', name: 'Dragon Necropolis' },
  { short: 'sirens', name: "Siren's Grotto" },
  { short: 'skyshrine', name: 'Skyshrine' },
  { short: 'sleeper', name: "Sleeper's Tomb" },
  { short: 'templeveeshan', name: 'Temple of Veeshan' },
  { short: 'thurgadina', name: 'Thurgadin' }, // in default set
  { short: 'thurgadinb', name: 'Icewell Keep' }, // in default set
  { short: 'velketor', name: "Velketor's Labyrinth" },
  { short: 'wakening', name: 'The Wakening Land', aliases: ['Wakening Lands'] },
  { short: 'westwastes', name: 'Western Wastes' }
]

// TODO(zone table) — candidates deliberately LEFT OUT because they could not be verified:
//   - `EverQuest Legends Tutorial`: the one observed log zone with no stem. It is EQL-new content
//     (NPCs Doug / Dougina / "a rambunctious pet"), NOT Gloomingdeep, so `tutorial` / `tutoriala` /
//     `tutorialb` would all be a guess. Resolves to null -> the viewer's zone picker.
//   - `aviak` (Aviak Village), `erudsxing2` (Marauder's Mire), `nektropos`, `cshome` (Sunset Home):
//     on eqlwiki's table but with NO file in either pack, so nothing to point at.
//   - `oldkaesoraa`: in the default set, no long name in any source. EQL-new or a variant of Kaesora.
//   - The Live-EQ revamp stems the classic rows deliberately shadow — `northro`/`southro`,
//     `commonlands`, `freeporteast`/`freeportwest`/`freeport*`, `kithforest`, `befallenb`,
//     `oceanoftears`, `innothuleb`, `highpasskeep`, `hateplaneb`, `toxxulia`, `mistythicket`,
//     `steamfontmts`. Adding them would collide on `zoneKey` with the classic zone of the same
//     name; if EQL ever ships a revamp, that is a `variants` decision, not an alias.
//   - The Luclin+ stems in the default set (`sharvahl`, `paludal`, `dawnshroud`, `acrylia`,
//     `tenebrous`, `shadowhaven`, `hollowshade`, `echo`, `mesa`, `steppes`, `sunderock`,
//     `toskirakk`, `crystallos`, `discord`, `abysmal`, `ashengate`, `icefall`, `stonehive`,
//     `harbingers`, `hillsofshade`, `crescent`, `alkabormare`, `potranquility`, `guildhall`,
//     `neighborhood`, `oldkaesoraa`): EQ Legends is classic-era, so these names cannot appear in
//     its log. Left out on purpose rather than padded in.
//   - Catalog spellings that are AMBIGUOUS, so no `mobCatalogNames` row claims them: `Freeport`,
//     `Kaladim`, `Neriak`, `Qeynos`, `Felwithe`, `Various`, `Various Zones`,
//     `Most starting zones`, `West Freeport OR East Freeport`.

// ---- lookup --------------------------------------------------------------------------------

/**
 * `zoneKey` -> entry, over `name` AND every alias. Built LAZILY on first lookup, never at module
 * load (the mobSearch.ts posture): a session that never opens the map viewer pays nothing.
 * The table is immutable, so the index lives for the process's lifetime.
 */
let INDEX: Map<string, ZoneEntry> | null = null

function index(): Map<string, ZoneEntry> {
  if (INDEX) return INDEX
  const m = new Map<string, ZoneEntry>()
  for (const entry of ZONES) {
    for (const long of [entry.name, ...(entry.aliases ?? [])]) {
      const key = zoneKey(long)
      // First writer wins. `tests/zones.test.mts` proves there is never a second one, so this is
      // a belt-and-braces guard, not a policy.
      if (key !== '' && !m.has(key)) m.set(key, entry)
    }
  }
  INDEX = m
  return m
}

/**
 * The table row for a RAW zone name — pass `CharacterSnap.zone` unmodified, instance suffix and
 * all; folding is this function's job. `null` when the zone is not in the table.
 */
export function zoneEntryFor(raw: string | undefined | null): ZoneEntry | null {
  const key = zoneKey(raw)
  if (key === '') return null
  return index().get(key) ?? null
}

/**
 * Resolve a zone name to its map-file stem. Accepts a raw long name (`The Plane of Sky 1
 * (Awakened)`) or an alias.
 *
 * Returns `null` when unknown — the caller shows the manual zone picker rather than guessing
 * (world-model law 1: never silently guess), and should log the miss once so the table's gaps
 * turn up in `errors.log` instead of a user complaint (map-viewer.md §5.3).
 */
export function zoneShortName(raw: string | undefined | null): ZoneShort | null {
  return zoneEntryFor(raw)?.short ?? null
}

/**
 * The mob catalog's spellings for a log zone that its own name does NOT fold onto — the
 * knowledge half of the join `mobsInZone` cannot do with a string rule
 * (`renderer/src/features/mobs/mobZone.ts`, "WHAT IT DELIBERATELY DOES NOT DO").
 *
 * Returns `[]` for an unknown zone AND for the common case where the fold already suffices
 * (`Befallen`, `The Feerrott`) — in both cases there is nothing to add. A consumer therefore
 * UNIONS this with its own `zoneKey` match rather than replacing it:
 *
 *     const extra = catalogZonesFor(raw)
 *     rows = catalog.filter((m) => m.zones?.some((z) => zoneKey(z) === key || extra.includes(z)))
 *
 * Comparing with `zoneKey` on both sides is also safe and slightly wider (it folds the catalog's
 * ` (35)` / ` (37)` page-disambiguation suffixes onto their base spelling).
 */
export function catalogZonesFor(raw: string | undefined | null): string[] {
  const names = zoneEntryFor(raw)?.mobCatalogNames
  return names ? [...names] : []
}
