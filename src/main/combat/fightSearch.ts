// fightSearch.ts — the PURE half of "search my fight history" (Task #61).
//
// Everything here is side-effect free and free of Electron/MUI/node imports, the same
// split src/shared/update.ts uses: the engine owns the corpus, this file owns the
// SCORING. That makes every fuzzy rule a plain unit test over authored summaries
// (tests/combatFightSearch.test.mts) instead of something you can only observe through a
// replay.
//
// THE SCORER ITSELF NOW LIVES IN `src/shared/fuzzy.ts` (Task #64). It was extracted VERBATIM
// out of this file the moment the Mobs tab needed the identical rules over a different corpus
// (a 7,866-entry committed catalog, scored in the renderer with no IPC at all). Nothing about
// the ranking changed in the move — this file's golden tests are the regression gate for that,
// and `tokenize` / `damerauLevenshtein` are still re-exported from here so every caller and
// test that knew them by this name still does. What stays here is what is actually about
// FIGHTS: the haystack (name + zone), its memoization, and the tie-break order.
//
// WHAT THE CORPUS IS. `CombatEngine.history` is UNCAPPED — every finalized encounter of
// the session is retained with a memoized SegmentSummary (only the per-encounter timeline
// RINGS are capped, at TIMELINE_HISTORY_CAP=60, and zone sessions at 20). A full-log
// replay on the dev character holds ~1,400 of them. So "search goes back for all time"
// needs no new storage at all — it needs a scorer over the summaries that already exist.
//
// PERFORMANCE. A linear scan, no index structures. MEASURED against the REAL log
// (throwaway scripts/_probe, full-log replay, 2026-08-03) — the corpus is 2,080 fights,
// every one of them carrying its zone:
//
//   real 2,080 fights  "gohul knigt"  1.71 ms/call    "freprot"  0.86 ms    "a"  0.28 ms
//   synthetic 5,000    "gohul knigt"  4.21 ms warm, 7.66 ms on the first (cold) call
//   synthetic 5,000    "dragon slayer" (0 hits)       2.18 ms/call
//
// The synthetic 5k case is deliberately the WORST one: every fight is named "a zol ghoul
// knight (n)", so all 5,000 survive the coverage rule and all 5,000 get scored AND sorted.
// A real corpus rejects most fights on the first query token. Sub-10 ms at 5k either way,
// which is the per-keystroke budget, so an inverted index / trigram table would be
// complexity bought with nothing — revisit only if a measurement says otherwise. The only
// memoization is HAYSTACK_CACHE below, which is free: a finalized summary object is
// immutable, so its token array survives every keystroke.

import type { SegmentSummary } from '../../shared/combat'
import type { FightSearchHit, FightSearchResult } from '../../shared/combat'
import { scoreQuery, tokenize } from '../../shared/fuzzy'

// Re-exported so the scorer's two primitives keep answering to the names every existing
// caller and test (tests/combatFightSearch.test.mts) imports from here.
export { damerauLevenshtein, tokenize } from '../../shared/fuzzy'

/** Default number of hits returned. The UI shows a ranked list, not a page of 1,400. */
const DEFAULT_LIMIT = 50

interface Haystack {
  /** the exact strings this was built from, so a reused cache entry can be validated. */
  name: string
  zone: string
  tokens: string[]
}

/**
 * Token memoization. Keyed on the summary OBJECT: the engine memoizes a finalized
 * encounter's SegmentSummary at finalize time and never rebuilds it, so the identical
 * object comes back on every keystroke and its tokens are computed exactly once for the
 * life of the session. The live 'current' summary IS rebuilt per call, so it simply misses
 * the cache (one tokenize of one short string). A WeakMap keeps this from pinning any
 * summary alive.
 */
const HAYSTACK_CACHE = new WeakMap<SegmentSummary, Haystack>()

function haystackTokens(s: SegmentSummary): string[] {
  const name = s.name ?? ''
  const zone = s.zone ?? ''
  const hit = HAYSTACK_CACHE.get(s)
  // Validate before reuse: a summary object is immutable in practice, but the cache must
  // never be the reason a renamed fight keeps answering to its old name.
  if (hit && hit.name === name && hit.zone === zone) return hit.tokens
  const tokens = tokenize(zone ? `${name} ${zone}` : name)
  HAYSTACK_CACHE.set(s, { name, zone, tokens })
  return tokens
}

/**
 * Search finalized (and live) fight summaries by name + zone.
 *
 * SCORING is `shared/fuzzy.ts`'s `scoreQuery`: each query token takes its BEST score across
 * the fight's haystack tokens (exact > prefix > substring > bounded Damerau-Levenshtein), a
 * fight is EXCLUDED (null) unless every query token matched something, and the score is the
 * mean token score × coverage.
 *
 * ORDER. Score desc, then RECENCY (newer startTs first), then id — so the ranking is
 * fully deterministic and never depends on the corpus's arrival order.
 *
 * An empty / whitespace-only query returns NO hits (not "everything"): the UI shows its
 * ordinary browse list in that state, and returning the whole corpus would make the empty
 * box the most expensive keystroke of all.
 */
export function searchFights(
  summaries: SegmentSummary[],
  text: string,
  limit: number = DEFAULT_LIMIT
): FightSearchResult {
  const corpus = summaries.length
  const query = tokenize(text ?? '')
  if (query.length === 0) return { hits: [], corpus }

  const hits: FightSearchHit[] = []
  for (const summary of summaries) {
    const score = scoreQuery(query, haystackTokens(summary))
    if (score == null) continue
    hits.push({ summary, score })
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      b.summary.startTs - a.summary.startTs ||
      (a.summary.id < b.summary.id ? -1 : a.summary.id > b.summary.id ? 1 : 0)
  )
  const capped = limit > 0 ? hits.slice(0, limit) : hits
  return { hits: capped, corpus }
}
