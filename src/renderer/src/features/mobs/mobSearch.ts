// mobSearch.ts — fuzzy search over the COMMITTED mob catalog, in the renderer (Task #64).
//
// The catalog (`data/eqlegends/mobs.json`, 7,866 pages) is already bundled for main's
// `mobLookup`, and the renderer can ES-import the very same file. So "search every mob the game
// has" costs no IPC, no index build at startup, and works offline — the same local-first
// posture posky.json and quests.json set.
//
// SAME SCORER AS FIGHT SEARCH, deliberately: `shared/fuzzy.ts` is the extracted core of
// `main/combat/fightSearch.ts` (Task #61), so a typo'd query behaves identically in both boxes
// ("gohul knigt" finds the ghoul knights either way). One set of rules, one set of tests.
//
// HAYSTACK = name + zones. That is what a player types: either the thing ("ghoul knight") or
// where it lives ("lower guk"), usually a bit of both. The page TITLE is deliberately not in
// it — it is the name again, plus a disambiguating "(Lake Rathe)" the zone already supplies.
//
// PERFORMANCE. A linear scan, like fightSearch, and for the same reason. MEASURED over the REAL
// catalog (7,866 entries, throwaway probe, 2026-08-03), warm, per call:
//
//   "gohul knigt" 2.80 ms   "freprot" 3.62 ms   "lower guk" 2.76 ms   "a" 2.19 ms
//   "dragon slayer nothing" (0 hits) 3.45 ms
//
// — all of it inside a per-keystroke budget, and the box filters on a deferred value anyway, so
// an inverted index would be complexity bought with nothing. Tokens are built ONCE, LAZILY, on
// the first search (never at module load — the Mobs tab may never be opened this session). The
// catalog is immutable, so the token arrays live for the window's lifetime.

import type { MobEntry, MobKnowledge } from '@shared/types'
// RELATIVE, not `@shared/fuzzy`, and deliberately: this is a VALUE import, and the alias only
// exists inside the vite build. Spelling the path keeps this module importable by the node test
// runner (`tests/mobSearch.test.mts` scores the REAL 7,866-entry catalog), the same reason
// mobLookupLocal.ts is split out of mobLookup.ts. Type-only imports are erased, so they keep
// the alias. If a fourth file needs this, teach tsx the paths instead of spreading this.
import { scoreQuery, tokenize } from '../../../../shared/fuzzy'
import mobsJson from '../../data/eqlegends/mobs.json'

interface MobCatalog {
  scrapedAt: string
  source: string
  mobs: MobEntry[]
}

const catalog = mobsJson as unknown as MobCatalog

/** Every mob the committed catalog knows, in scrape order. */
export const MOB_CATALOG: MobEntry[] = catalog.mobs ?? []

/** One scored search hit. `entry` is the catalog row itself — the caller drills straight into it. */
export interface MobHit {
  entry: MobEntry
  score: number
}

/** How many hits the UI lists. A ranked list, not a page of 7,866. */
const DEFAULT_LIMIT = 60

/** Lazily-built token arrays, index-aligned with MOB_CATALOG. */
let HAYSTACKS: string[][] | null = null

function haystacks(): string[][] {
  if (HAYSTACKS) return HAYSTACKS
  HAYSTACKS = MOB_CATALOG.map((m) => {
    const zones = m.zones?.length ? ` ${m.zones.join(' ')}` : ''
    return tokenize(`${m.name}${zones}`)
  })
  return HAYSTACKS
}

/**
 * Search the catalog by name + zone.
 *
 * ORDER. Score desc, then DROP COUNT desc — with names as ambiguous as EQ's ("a bandit" is
 * nine pages), the row that can actually answer "what does it drop" is the more useful one —
 * then page title, so the ranking is fully deterministic and never depends on scrape order.
 *
 * An empty / whitespace-only query returns NO hits (not "everything"): the tab shows its browse
 * surfaces in that state, and returning the whole catalog would make the empty box the most
 * expensive keystroke of all.
 */
export function searchMobs(text: string, limit: number = DEFAULT_LIMIT): MobHit[] {
  const query = tokenize(text ?? '')
  if (query.length === 0) return []
  const hay = haystacks()
  const hits: MobHit[] = []
  for (let i = 0; i < MOB_CATALOG.length; i++) {
    const score = scoreQuery(query, hay[i])
    if (score == null) continue
    hits.push({ entry: MOB_CATALOG[i], score })
  }
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      (b.entry.drops?.length ?? 0) - (a.entry.drops?.length ?? 0) ||
      (a.entry.page < b.entry.page ? -1 : a.entry.page > b.entry.page ? 1 : 0)
  )
  return limit > 0 ? hits.slice(0, limit) : hits
}

/**
 * The catalog row as a knowledge record — the renderer's mirror of main's
 * `knowledgeFromCatalog`, over the identical JSON.
 *
 * COMPACT BY DESIGN, and honest about it: the catalog carries item NAMES only, so a per-drop
 * `rarity` is simply ABSENT here rather than invented. The live lookup is where one comes from,
 * and the page merges the two.
 */
export function knowledgeFromEntry(e: MobEntry): MobKnowledge {
  const out: MobKnowledge = { name: e.name, page: e.page, cached: true }
  if (e.level) out.levelText = e.level
  if (e.zones?.length) out.zone = e.zones.join(', ')
  if (e.drops?.length) out.dropsWiki = e.drops.map((item) => ({ item }))
  return out
}
