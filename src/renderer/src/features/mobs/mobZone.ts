// mobZone.ts — "what lives WHERE I AM" (Task #64 browse rework).
//
// The Mobs tab's default surface answers the question you actually have when you open it while
// playing: not "what have I conned most" but "what is in this zone". That is a JOIN between one
// dirty string (the zone the log last printed) and 7,866 catalog rows whose `zones` come off the
// wiki — two independent naming authorities that agree most of the time and disagree in exactly
// three mechanical ways. This module is that join, and nothing else.
//
// THE FOLD, and why each rule exists (every one MEASURED against the real log + the committed
// catalog, 2026-08-03 — see the evidence beside each rule):
//
//   1. INSTANCE NOISE. EQ Legends encodes instance difficulty in the zone name. The main-side
//      source of truth is `zoneTier()` in `src/main/log/parseWorld.ts` (AGENTS.md, "Log-format
//      quick reference"): a trailing `(Awakened|Adaptive|Fused|Refined)` is d1–d4, and
//      `- Solo` / `- Group N` is further noise. Real log shapes, verbatim:
//        "Najena 4 (Refined)", "The Plane of Sky 1 (Awakened)",
//        "The Ruins of Old Paineel - Solo 4 (Refined)", "The Plane of Hate - Solo".
//      The catalog never carries any of it, so an un-stripped zone matches ZERO rows — the
//      instance of a zone has the same bestiary as the zone.
//      We RE-IMPLEMENT the three strips here rather than import them: this file is renderer-side
//      and node-testable (see mobSearch.ts:33 for the same reasoning about value imports), and
//      main's copy carries a tier NUMBER we have no use for. If the game adds a tier adjective,
//      the paren strip is shape-based and already covers it; parseWorld's TIER_ADJ table is the
//      one that would need teaching.
//
//   2. THE LEADING ARTICLE. The log says "The Oasis of Marr"; the catalog says "Oasis of Marr".
//      Folding it is load-bearing, not cosmetic — it is the difference between 0 and N rows for
//      "The Northern Desert of Ro" (25), "The Plane of Sky" (65), "The Rathe Mountains" (104),
//      "The Ocean of Tears" (76), "The Lavastorm Mountains" (31), "The Temple of Solusek Ro"
//      (28) and more. The catalog is not consistent WITH ITSELF either ("The Feerrott" 40 rows,
//      "Feerrott" 1), so the fold has to run on BOTH sides. Same rule as world-model law 2's
//      "strip leading a/an/the for boss matching".
//
//   3. SEPARATOR PUNCTUATION. Both sides spell the same zone with and without a hyphen:
//      log "Neriak - Commons" vs catalog "Neriak Commons" (88 rows), and inside the catalog
//      "Cazic Thule" vs "Cazic-Thule", "Neriak Foreign Quarter" vs "Neriak - Foreign Quarter".
//      Collapsing runs of whitespace/hyphens to one space merges exactly those pairs — a sweep
//      of all 192 catalog zones under this fold produces NO collision between two zones that
//      are genuinely different places.
//
// WHAT IT DELIBERATELY DOES NOT DO: alias unrelated names. "The Ruins of Old Guk" (log) and
// "Lower Guk"/"Upper Guk" (catalog), "The City of Guk", "The Lair of the Splitpaw" and
// "The Permafrost Caverns" fold cleanly and still miss, because the two sources use different
// NAMES for those places, not different spellings. A hand-written alias table is a knowledge
// artifact, not a string rule; until one exists those zones honestly show the empty state
// rather than a guessed roster (law 1 — never silently invent).

import type { MobEntry } from '@shared/types'

/** ` - Solo` / ` - Group 2` and everything after it — instance selection, never part of a name. */
const SOLO_GROUP_RE = /\s*-\s*(Solo|Group)\b.*$/i
/** A trailing tier parenthetical, with or without the instance ordinal: ` 4 (Refined)`. */
const TIER_ORDINAL_RE = /\s+\d+\s*\([^)]*\)\s*$/
/** A bare trailing parenthetical: ` (Awakened)`, and the catalog's ` (Pre-Revamp)` / ` (37)`. */
const TIER_PAREN_RE = /\s+\([^)]*\)\s*$/
/** Runs of whitespace and hyphens, collapsed to one space (rule 3). */
const SEPARATORS_RE = /[\s-]+/g
/** The one leading article EQ zone names use. */
const LEADING_ARTICLE_RE = /^the /

/**
 * Canonical key for a zone name, from EITHER source. Case-insensitive, instance noise stripped,
 * leading article folded, separators normalized. Never throws; a nullish/blank name folds to ''.
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

/**
 * The level to SORT by. The catalog states level exactly as the wiki page wrote it, which across
 * 7,866 rows is ~90 distinct shapes: "56", "9-12", "2 - 4", "~53", "<50", "50+", "35?",
 * "Unknown", "You can't consider that.", and 16 rows with no level at all. The only thing every
 * numeric shape shares is that its FIRST digit run is the low end of the level, so that is what
 * we read — a range sorts by where it starts, which is what a player scanning "what can I fight
 * here" wants. Anything with no digits at all is genuinely unknown and sorts LAST rather than
 * pretending to be level 0.
 */
function sortLevel(entry: MobEntry): number | null {
  const m = /\d+/.exec(entry.level ?? '')
  return m ? Number(m[0]) : null
}

/**
 * Every catalog mob whose home zone is `zoneRaw`, lowest level first.
 *
 * `zoneRaw` is the RAW display zone the character module carries (`CharacterSnap.zone`, set
 * verbatim from the `zone` log event) — instance suffixes, articles and all. Pass it unmodified;
 * folding is this function's job.
 *
 * ORDER: level ascending (unknown level last), then name, then page — fully deterministic and
 * independent of scrape order, the same posture mobSearch's ranking takes.
 * An unknown zone (blank) matches nothing rather than everything.
 */
export function mobsInZone(zoneRaw: string, catalog: MobEntry[]): MobEntry[] {
  const key = zoneKey(zoneRaw)
  if (key === '') return []
  const rows = catalog.filter((m) => m.zones?.some((z) => zoneKey(z) === key))
  return rows.sort((a, b) => {
    const la = sortLevel(a)
    const lb = sortLevel(b)
    if (la !== lb) {
      if (la == null) return 1
      if (lb == null) return -1
      return la - lb
    }
    const na = a.name.toLowerCase()
    const nb = b.name.toLowerCase()
    if (na !== nb) return na < nb ? -1 : 1
    return a.page < b.page ? -1 : a.page > b.page ? 1 : 0
  })
}
