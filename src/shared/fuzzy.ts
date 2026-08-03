// fuzzy.ts — the SCORER CORE behind every fuzzy search box in the app.
//
// Extracted verbatim from src/main/combat/fightSearch.ts (Task #61), which was the first
// surface to need it and is still the one whose golden tests pin its behaviour. It moved here
// the moment a SECOND surface needed the identical rules: the Mobs tab searches a 7,866-entry
// committed catalog CLIENT-side (renderer, no IPC), and "search behaves the same everywhere"
// has to be structurally true rather than a thing two copies happen to agree on today.
//
// `shared/` because both halves import it: main (fightSearch, over the engine's uncapped fight
// history) and the renderer (mobSearch, over mobs.json). Nothing here touches Electron, node,
// MUI or the DOM — it is pure functions over strings, which is also what makes every rule a
// plain unit test.
//
// ---------------------------------------------------------------------------
// DECISION RECORD — why edit-distance fuzzy and NOT semantic embeddings.
//
// Semantic embeddings were considered for this and REJECTED. The corpus is not prose: it is
// short proper-noun strings — mob names ("a zol ghoul knight", "Baron Telyx V`Zher") and zone
// names ("Freeport", "East Commonlands"). The queries users type against that are TYPO'D
// LOOKUPS ("gohul knigt", "freprot"), not paraphrases, and character-level edit distance is
// strictly the better tool for those: an embedding of a misspelled proper noun lands nowhere
// near the correct one, because the misspelling changes the token segmentation rather than the
// meaning. Embeddings would also cost a model download and a vector index for corpora that a
// linear scan clears in single-digit milliseconds, and this app is deliberately fully OFFLINE
// for its own data.
//
// REVISIT ONLY IF search ever spans PROSE — e.g. searching raw log-line content, chat, or
// free-text notes, where "the fight where the healer went down" has no lexical overlap with the
// text that would satisfy it. Neither the fight haystack nor the mob catalog qualifies.
// ---------------------------------------------------------------------------

// Per-token match scores, in strict descending order of confidence. The gaps are wide on
// purpose: an EXACT token match must always outrank a prefix, a prefix a substring, and any
// of those a typo correction, no matter how the mean across tokens shakes out.
export const SCORE_EXACT = 1
export const SCORE_PREFIX = 0.85
export const SCORE_SUBSTRING = 0.7
/** Ceiling for a typo (edit-distance) match; scaled down by how many edits it took. */
export const SCORE_FUZZY = 0.6

/**
 * SHORTEST token either side may be and still be eligible for a TYPO match. One edit on a
 * 2-letter token reaches most of the alphabet, so this is what stops "wan" from finding
 * every "an …" mob in the log — measured on the real names: without it, `wan gohl` returned
 * "an urd ghoul wizard" alongside the wan ghoul knight it was aimed at. BOTH sides are
 * checked, not just the query: the budget below keys on the LONGER token, so a 2-letter
 * haystack token would otherwise inherit a long query's generous budget.
 * Exact / prefix / substring matching is unaffected and still works at any length.
 */
export const MIN_FUZZY_LEN = 3

/**
 * Edit budget for a typo match, keyed on the LONGER of the two tokens.
 *
 * Using the longer token (not the query's length) is load-bearing: "gohl" → "ghoul" is two
 * edits (transpose `oh`, insert `u`) and the query token is only 4 characters, so a
 * query-length budget would reject exactly the case the user asked for ("wan gohl" must
 * find "a wan ghoul knight"). Same for "freprot" → "freeport" (2 edits, 8 characters).
 */
export function editBudget(longest: number): number {
  if (longest < 3) return 0
  if (longest < 5) return 1
  return 2
}

/** Lowercased alphanumeric tokens. EQ names carry backticks, apostrophes, `(3)` instance
 *  suffixes and `+N` others-suffixes; all of that is punctuation to a search box. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
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
 * which are already past any budget above.
 */
export function damerauLevenshtein(a: string, b: string, max: number): number {
  const trivial = trivialDistance(a, b, max)
  if (trivial !== null) return trivial

  const al = a.length
  const bl = b.length
  // Three rolling rows (prev-prev is what makes the transposition step possible).
  let prev2: number[] = []
  let prev: number[] = new Array<number>(bl + 1)
  let cur: number[] = new Array<number>(bl + 1)
  for (let j = 0; j <= bl; j++) prev[j] = j

  for (let i = 1; i <= al; i++) {
    cur[0] = i
    let rowMin = cur[0]
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= bl; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
      if (isTransposition(a, b, i, j)) v = Math.min(v, prev2[j - 2] + 1)
      cur[j] = v
      if (v < rowMin) rowMin = v
    }
    // Every remaining path goes through this row, so a row whose best cell already exceeds
    // the budget can never come back under it.
    if (rowMin > max) return max + 1
    const spare = prev2
    prev2 = prev
    prev = cur
    cur = spare.length === bl + 1 ? spare : new Array<number>(bl + 1)
  }
  const d = prev[bl]
  return d > max ? max + 1 : d
}

/**
 * The answers that need no matrix at all: identical strings, a length gap already past the
 * budget, and either side empty. `null` means "the matrix is required".
 */
function trivialDistance(a: string, b: string, max: number): number | null {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  return null
}

/**
 * True when cells (i,j) sit on a swapped pair — `a[i-2]a[i-1]` equals `b[j-1]b[j-2]` — which is
 * the OSA transposition step (one edit for the swap, and the pair may not be edited again).
 */
function isTransposition(a: string, b: string, i: number, j: number): boolean {
  return (
    i > 1 &&
    j > 1 &&
    a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
    a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
  )
}

/**
 * Best score for ONE query token against ONE haystack token. 0 means "no match at all",
 * which is what excludes a record (see scoreQuery's coverage rule).
 */
export function tokenScore(q: string, h: string): number {
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

/** Best score for one query token across a whole haystack. Short-circuits on an exact hit. */
export function bestTokenScore(q: string, hay: string[]): number {
  let best = 0
  for (const h of hay) {
    const s = tokenScore(q, h)
    if (s > best) {
      best = s
      if (best === SCORE_EXACT) break
    }
  }
  return best
}

/**
 * Score ONE record's haystack tokens against an already-tokenized query.
 * `null` = EXCLUDED, which is not the same as "scored 0".
 *
 * Each query token takes its BEST score across the haystack (exact > prefix > substring >
 * bounded Damerau-Levenshtein). A record is EXCLUDED unless every query token matched
 * something at > 0 — "gohul knigt" must not surface every ghoul in the corpus just because
 * one word landed. The score is the mean token score × coverage (matched query tokens ÷
 * query tokens; 1 for every hit the exclusion rule lets through, kept in the formula so the
 * two rules stay legible together and a future partial-coverage mode is a one-line change).
 */
export function scoreQuery(query: string[], hay: string[]): number | null {
  if (query.length === 0 || hay.length === 0) return null
  let sum = 0
  let matched = 0
  for (const q of query) {
    const best = bestTokenScore(q, hay)
    if (best === 0) return null
    sum += best
    matched++
  }
  const coverage = matched / query.length
  return (sum / query.length) * coverage
}
