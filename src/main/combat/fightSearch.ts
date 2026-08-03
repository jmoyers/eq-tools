// fightSearch.ts — the PURE half of "search my fight history" (Task #61).
//
// Everything here is side-effect free and free of Electron/MUI/node imports, the same
// split src/shared/update.ts uses: the engine owns the corpus, this file owns the
// SCORING. That makes every fuzzy rule a plain unit test over authored summaries
// (tests/combatFightSearch.test.mts) instead of something you can only observe through a
// replay.
//
// WHAT THE CORPUS IS. `CombatEngine.history` is UNCAPPED — every finalized encounter of
// the session is retained with a memoized SegmentSummary (only the per-encounter timeline
// RINGS are capped, at TIMELINE_HISTORY_CAP=60, and zone sessions at 20). A full-log
// replay on the dev character holds ~1,400 of them. So "search goes back for all time"
// needs no new storage at all — it needs a scorer over the summaries that already exist.
//
// ---------------------------------------------------------------------------
// DECISION RECORD — why edit-distance fuzzy and NOT semantic embeddings.
//
// Semantic embeddings were considered for this and REJECTED. The corpus is not prose: it
// is short proper-noun strings — mob names ("a zol ghoul knight", "Baron Telyx V`Zher")
// and zone names ("Freeport", "East Commonlands"). The queries users type against that are
// TYPO'D LOOKUPS ("gohul knigt", "freprot"), not paraphrases, and character-level edit
// distance is strictly the better tool for those: an embedding of a misspelled proper noun
// lands nowhere near the correct one, because the misspelling changes the token
// segmentation rather than the meaning. Embeddings would also cost a model download and a
// per-fight vector index for a corpus that a linear scan clears in single-digit
// milliseconds, and this app is deliberately fully OFFLINE for its own data.
//
// REVISIT ONLY IF search ever spans PROSE — e.g. searching raw log-line content, chat, or
// free-text notes, where "the fight where the healer went down" has no lexical overlap
// with the text that would satisfy it. Nothing about the name+zone haystack qualifies.
// ---------------------------------------------------------------------------
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

/** Default number of hits returned. The UI shows a ranked list, not a page of 1,400. */
const DEFAULT_LIMIT = 50

// Per-token match scores, in strict descending order of confidence. The gaps are wide on
// purpose: an EXACT token match must always outrank a prefix, a prefix a substring, and any
// of those a typo correction, no matter how the mean across tokens shakes out.
const SCORE_EXACT = 1
const SCORE_PREFIX = 0.85
const SCORE_SUBSTRING = 0.7
/** Ceiling for a typo (edit-distance) match; scaled down by how many edits it took. */
const SCORE_FUZZY = 0.6

/**
 * SHORTEST token either side may be and still be eligible for a TYPO match. One edit on a
 * 2-letter token reaches most of the alphabet, so this is what stops "wan" from finding
 * every "an …" mob in the log — measured on the real names: without it, `wan gohl` returned
 * "an urd ghoul wizard" alongside the wan ghoul knight it was aimed at. BOTH sides are
 * checked, not just the query: the budget below keys on the LONGER token, so a 2-letter
 * haystack token would otherwise inherit a long query's generous budget.
 * Exact / prefix / substring matching is unaffected and still works at any length.
 */
const MIN_FUZZY_LEN = 3

/**
 * Edit budget for a typo match, keyed on the LONGER of the two tokens.
 *
 * Using the longer token (not the query's length) is load-bearing: "gohl" → "ghoul" is two
 * edits (transpose `oh`, insert `u`) and the query token is only 4 characters, so a
 * query-length budget would reject exactly the case the user asked for ("wan gohl" must
 * find "a wan ghoul knight"). Same for "freprot" → "freeport" (2 edits, 8 characters).
 */
function editBudget(longest: number): number {
  if (longest < 3) return 0
  if (longest < 5) return 1
  return 2
}

/** Lowercased alphanumeric tokens. EQ names carry backticks, apostrophes, `(3)` instance
 *  suffixes and `+N` others-suffixes; all of that is punctuation to a search box. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

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
 * Restricted Damerau-Levenshtein (optimal string alignment) distance, ABORTED once it
 * provably exceeds `max`. Returns `max + 1` for "further apart than we care about", so the
 * caller never pays for a full matrix on two unrelated words.
 *
 * "Restricted" = a transposed pair is one edit but may not be edited again afterwards. That
 * is the standard OSA variant and the right one here: it makes `gohul`→`ghoul` and
 * `freeprot`→`freeport` one edit each (the single most common real typo), and the cases
 * where it diverges from unrestricted Damerau need three-plus overlapping transpositions,
 * which are already past any budget below.
 */
export function damerauLevenshtein(a: string, b: string, max: number): number {
  const al = a.length
  const bl = b.length
  if (a === b) return 0
  if (Math.abs(al - bl) > max) return max + 1
  if (al === 0) return bl
  if (bl === 0) return al

  // Three rolling rows (prev-prev is what makes the transposition step possible).
  let prev2: number[] = []
  let prev: number[] = new Array(bl + 1)
  let cur: number[] = new Array(bl + 1)
  for (let j = 0; j <= bl; j++) prev[j] = j

  for (let i = 1; i <= al; i++) {
    cur[0] = i
    let rowMin = cur[0]
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
      if (
        i > 1 &&
        j > 1 &&
        ca === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        v = Math.min(v, prev2[j - 2] + 1)
      }
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    // Every remaining path goes through this row, so a row whose best cell already exceeds
    // the budget can never come back under it.
    if (rowMin > max) return max + 1
    const spare = prev2
    prev2 = prev
    prev = cur
    cur = spare.length === bl + 1 ? spare : new Array(bl + 1)
  }
  const d = prev[bl]
  return d > max ? max + 1 : d
}

/**
 * Best score for ONE query token against ONE haystack token. 0 means "no match at all",
 * which is what excludes a fight (see searchFights's coverage rule).
 */
function tokenScore(q: string, h: string): number {
  if (q === h) return SCORE_EXACT
  if (h.startsWith(q)) return SCORE_PREFIX
  if (h.includes(q)) return SCORE_SUBSTRING
  if (q.length < MIN_FUZZY_LEN || h.length < MIN_FUZZY_LEN) return 0
  const longest = Math.max(q.length, h.length)
  const budget = editBudget(longest)
  if (budget === 0) return 0
  const d = damerauLevenshtein(q, h, budget)
  if (d > budget) return 0
  // Length-normalized: the same number of edits is a weaker signal on a short token than
  // on a long one ("wan"→"can" is one edit across a third of the word).
  return SCORE_FUZZY * (1 - d / longest)
}

/**
 * Search finalized (and live) fight summaries by name + zone.
 *
 * SCORING. The query is tokenized; each query token takes its BEST score across the
 * fight's haystack tokens (exact > prefix > substring > bounded Damerau-Levenshtein). A
 * fight is EXCLUDED unless every query token matched something at > 0 — "gohul knigt" must
 * not surface every ghoul in the log just because one word landed. The fight's score is
 * the mean token score × coverage (matched query tokens ÷ query tokens; 1 for every hit
 * the exclusion rule lets through, kept in the formula so the two rules stay legible
 * together and a future partial-coverage mode is a one-line change).
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
    const hay = haystackTokens(summary)
    if (hay.length === 0) continue
    let sum = 0
    let matched = 0
    let excluded = false
    for (const q of query) {
      let best = 0
      for (const h of hay) {
        const s = tokenScore(q, h)
        if (s > best) {
          best = s
          if (best === SCORE_EXACT) break
        }
      }
      if (best === 0) {
        excluded = true
        break
      }
      sum += best
      matched++
    }
    if (excluded) continue
    const coverage = matched / query.length
    hits.push({ summary, score: (sum / query.length) * coverage })
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
