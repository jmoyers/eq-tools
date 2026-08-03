// fuzzySearch — the shared scorer core (src/shared/fuzzy.ts) and the mob catalog search built
// on it (Task #64).
//
// WHY THIS FILE EXISTS. The scorer was EXTRACTED out of src/main/combat/fightSearch.ts, which
// already has a full golden suite (tests/combatFightSearch.test.mts) — and that suite, run
// unchanged against the refactored fightSearch, is the regression gate for the extraction
// itself. What it cannot pin is the scorer AS A SHARED CONTRACT: fight search only ever exercises
// the rules through fight summaries, so a future edit could quietly change what `scoreQuery`
// promises to its OTHER caller. These tests hold the primitives directly.
//
// The second half runs the REAL committed catalog (7,866 mob pages) through the renderer's
// searchMobs — the actual code the Mobs tab runs, not a re-implementation of it. Assertions are
// IDENTITIES and floors (AGENTS.md "Frozen numbers rot"): the catalog is re-scraped, so
// "exactly 9 ghoul knights" would rot the first time the wiki gains one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_FUZZY_LEN,
  SCORE_EXACT,
  SCORE_FUZZY,
  SCORE_PREFIX,
  SCORE_SUBSTRING,
  bestTokenScore,
  damerauLevenshtein,
  editBudget,
  scoreQuery,
  tokenScore,
  tokenize
} from '../src/shared/fuzzy'
import { MOB_CATALOG, knowledgeFromEntry, searchMobs } from '../src/renderer/src/features/mobs/mobSearch'

// ---------------------------------------------------------------------------
// 1. The primitives
// ---------------------------------------------------------------------------

test('U1: tokenize lowercases and drops every EQ punctuation glyph', () => {
  assert.deepEqual(tokenize('a zol ghoul knight'), ['a', 'zol', 'ghoul', 'knight'])
  // Backticks, apostrophes, instance suffixes and the '+N others' suffix are all punctuation.
  assert.deepEqual(tokenize('Baron Telyx V`Zher (3) +2'), ['baron', 'telyx', 'v', 'zher', '3', '2'])
  assert.deepEqual(tokenize('   '), [])
  assert.deepEqual(tokenize(''), [])
})

test('U2: damerauLevenshtein counts a TRANSPOSITION as one edit and aborts past the budget', () => {
  assert.equal(damerauLevenshtein('ghoul', 'ghoul', 2), 0)
  // The single most common real typo: two adjacent letters swapped.
  assert.equal(damerauLevenshtein('gohul', 'ghoul', 2), 1)
  assert.equal(damerauLevenshtein('freeprot', 'freeport', 2), 1)
  // "gohl" → "ghoul" is a transposition plus an insertion.
  assert.equal(damerauLevenshtein('gohl', 'ghoul', 2), 2)
  // Past the budget it returns max+1 rather than the true distance (the abort).
  assert.equal(damerauLevenshtein('dragon', 'ghoul', 2), 3)
  // A length gap wider than the budget can't be closed — rejected before any matrix work.
  assert.equal(damerauLevenshtein('a', 'abcdefgh', 2), 3)
})

test('U3: the edit budget keys on the LONGER token, in three bands', () => {
  assert.equal(editBudget(2), 0)
  assert.equal(editBudget(3), 1)
  assert.equal(editBudget(4), 1)
  assert.equal(editBudget(5), 2)
  assert.equal(editBudget(12), 2)
  // The load-bearing case: a 4-char query against a 5-char name gets the 5-char budget, which
  // is the only reason "gohl" can reach "ghoul" at all.
  assert.ok(tokenScore('gohl', 'ghoul') > 0)
})

test('U4: exact > prefix > substring > typo, and the gaps never invert', () => {
  assert.equal(tokenScore('ghoul', 'ghoul'), SCORE_EXACT)
  assert.equal(tokenScore('gho', 'ghoul'), SCORE_PREFIX)
  assert.equal(tokenScore('hou', 'ghoul'), SCORE_SUBSTRING)
  const typo = tokenScore('gohul', 'ghoul')
  assert.ok(typo > 0 && typo <= SCORE_FUZZY)
  assert.ok(SCORE_EXACT > SCORE_PREFIX)
  assert.ok(SCORE_PREFIX > SCORE_SUBSTRING)
  assert.ok(SCORE_SUBSTRING > SCORE_FUZZY)
  // A typo match is length-normalized: the same ONE edit is worth less on a short token.
  assert.ok(tokenScore('gohul', 'ghoul') < tokenScore('freeprot', 'freeport'))
})

test('U5: a token shorter than MIN_FUZZY_LEN is never TYPO-matched, on EITHER side', () => {
  assert.equal(MIN_FUZZY_LEN, 3)
  // "wan" vs "an": one edit apart, but the HAYSTACK token is 2 characters — no typo match.
  assert.equal(tokenScore('wan', 'an'), 0)
  // …and the same rule on the QUERY side ("an" vs "at": one edit, both too short).
  assert.equal(tokenScore('an', 'at'), 0)
  // Substring/prefix are unaffected at any length — "an" IS inside "wan".
  assert.equal(tokenScore('an', 'wander'), SCORE_SUBSTRING)
  assert.equal(tokenScore('wa', 'wander'), SCORE_PREFIX)
})

test('U6: bestTokenScore takes the best across the haystack and short-circuits on exact', () => {
  assert.equal(bestTokenScore('knight', ['a', 'zol', 'ghoul', 'knight']), SCORE_EXACT)
  assert.equal(bestTokenScore('kni', ['a', 'zol', 'ghoul', 'knight']), SCORE_PREFIX)
  assert.equal(bestTokenScore('dragon', ['a', 'zol', 'ghoul', 'knight']), 0)
})

test('U7: scoreQuery EXCLUDES (null) unless every query token matched something', () => {
  const hay = tokenize('a zol ghoul knight Lower Guk')
  assert.ok(scoreQuery(tokenize('ghoul knight'), hay) != null)
  // One word lands, the other doesn't — excluded, NOT scored low. That is the whole rule.
  assert.equal(scoreQuery(tokenize('ghoul dragon'), hay), null)
  // Exclusion is null; it is never confused with a zero score.
  assert.equal(scoreQuery([], hay), null)
  assert.equal(scoreQuery(tokenize('ghoul'), []), null)
})

test('U8: a full exact match scores 1, and more exact tokens never score lower', () => {
  const hay = tokenize('a zol ghoul knight Lower Guk')
  assert.equal(scoreQuery(tokenize('ghoul knight'), hay), 1)
  assert.equal(scoreQuery(tokenize('ghoul knight lower guk'), hay), 1)
  // A typo drags the mean below a clean match of the same query.
  assert.ok((scoreQuery(tokenize('gohul knight'), hay) as number) < 1)
})

test('U9: scoreQuery is deterministic — same inputs, byte-identical score', () => {
  const hay = tokenize('a zol ghoul knight Lower Guk')
  const q = tokenize('gohul knigt')
  const runs = new Set(Array.from({ length: 20 }, () => scoreQuery(q, hay)))
  assert.equal(runs.size, 1)
})

// ---------------------------------------------------------------------------
// 2. The mob catalog search (the real committed dataset)
// ---------------------------------------------------------------------------

test('M1: the committed catalog is present and substantial', () => {
  // A floor, never an equality: the catalog is re-scraped and grows.
  assert.ok(MOB_CATALOG.length > 5000, `catalog too small: ${MOB_CATALOG.length}`)
  for (const m of MOB_CATALOG.slice(0, 50)) {
    assert.equal(typeof m.page, 'string')
    assert.equal(typeof m.name, 'string')
  }
})

test('M2: an empty / whitespace query returns NOTHING (the tab browses instead)', () => {
  assert.deepEqual(searchMobs(''), [])
  assert.deepEqual(searchMobs('   '), [])
  assert.deepEqual(searchMobs('!!!'), [])
})

test('M3: a TYPO\'D query finds the ghoul knights — the user\'s own example', () => {
  const hits = searchMobs('gohul knigt')
  assert.ok(hits.length > 0, 'typo query found nothing')
  // Every hit is a ghoul knight; the coverage rule is what keeps plain ghouls out.
  for (const h of hits) {
    assert.match(h.entry.name.toLowerCase(), /ghoul knight/, `unexpected hit: ${h.entry.name}`)
  }
})

test('M4: the ZONE is searchable, and zone + name narrows', () => {
  const byZone = searchMobs('lower guk')
  assert.ok(byZone.length > 0)
  assert.ok(byZone.every((h) => (h.entry.zones ?? []).some((z) => /lower guk/i.test(z))))

  const both = searchMobs('ghoul knight lower guk')
  assert.ok(both.length > 0)
  for (const h of both) {
    assert.match(h.entry.name.toLowerCase(), /ghoul knight/)
    assert.ok((h.entry.zones ?? []).some((z) => /lower guk/i.test(z)))
  }
  // Narrower query, never MORE results than the loose one.
  assert.ok(both.length <= searchMobs('ghoul knight').length)
})

test('M5: results are ranked score-desc and fully deterministic', () => {
  const hits = searchMobs('ghoul knight')
  assert.ok(hits.length > 1)
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score)
  const again = searchMobs('ghoul knight')
  assert.deepEqual(
    again.map((h) => h.entry.page),
    hits.map((h) => h.entry.page)
  )
})

test('M6: an EXACT name outranks a mob that merely contains the words', () => {
  const hits = searchMobs('a dar ghoul knight')
  assert.ok(hits.length > 0)
  assert.equal(hits[0].entry.name.toLowerCase(), 'a dar ghoul knight')
})

test('M7: a query that matches nothing returns nothing (no near-miss padding)', () => {
  assert.deepEqual(searchMobs('zzzzqqqx'), [])
  // Every token must land: "ghoul" is real, the other word is not.
  assert.deepEqual(searchMobs('ghoul zzzzqqqx'), [])
})

test('M8: DUPLICATE NAMES stay distinct rows — that is why a hit carries its entry', () => {
  // "a bandit" is many different mobs in many zones with different drop tables. A search that
  // collapsed them would be lying about which one you clicked; the page a hit opens is pinned
  // by the entry, not re-resolved from the name.
  const hits = searchMobs('a bandit').filter((h) => h.entry.name.toLowerCase() === 'a bandit')
  assert.ok(hits.length > 1, 'expected several "a bandit" pages')
  assert.equal(new Set(hits.map((h) => h.entry.page)).size, hits.length)
})

test('M9: the result cap is honoured and never reorders the head', () => {
  const all = searchMobs('a', 0)
  const capped = searchMobs('a', 5)
  assert.ok(all.length > 5)
  assert.equal(capped.length, 5)
  assert.deepEqual(
    capped.map((h) => h.entry.page),
    all.slice(0, 5).map((h) => h.entry.page)
  )
})

test('M10: knowledgeFromEntry states only what the catalog said (law 1)', () => {
  const withDrops = MOB_CATALOG.find((m) => (m.drops?.length ?? 0) > 0)
  assert.ok(withDrops)
  const k = knowledgeFromEntry(withDrops!)
  assert.equal(k.page, withDrops!.page)
  assert.equal(k.cached, true)
  assert.equal(k.dropsWiki?.length, withDrops!.drops!.length)
  // The catalog carries NAMES only — a rarity we don't have is absent, never invented.
  for (const d of k.dropsWiki ?? []) assert.equal(d.rarity, undefined)

  const noDrops = MOB_CATALOG.find((m) => !m.drops || m.drops.length === 0)
  if (noDrops) {
    const empty = knowledgeFromEntry(noDrops)
    // Absent, not an empty array: "the page has no loot section" and "it lists zero items" are
    // different claims and this record makes neither of them up.
    assert.equal(empty.dropsWiki, undefined)
  }
})

test('M11: FAST — the whole catalog stays inside a per-keystroke budget', () => {
  searchMobs('warm the lazy haystack build')
  const t = performance.now()
  for (let i = 0; i < 10; i++) searchMobs('gohul knigt')
  const perCall = (performance.now() - t) / 10
  assert.ok(perCall < 40, `too slow: ${perCall.toFixed(2)} ms/call over ${MOB_CATALOG.length} mobs`)
})
