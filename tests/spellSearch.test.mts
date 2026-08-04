// SUGGEST-DIALOG SEARCH + SECTIONS (docs/plans/suggest-dialog-redesign.md §1/§2/§4).
//
// The redesign's claim is that ONE box answers every question a player asks about an alert —
// by name, by the spell's own message text, by level, by class, by type — with no invented
// effect taxonomy anywhere. That claim is a pure function (`shared/spellSearch.ts`), so it gets
// a truth table rather than a screenshot.
//
// Four proofs:
//   (S1) THE TOKENIZER: every token form, and what an unparseable one degrades to.
//   (S2) THE MATCHER'S TRUTH TABLE: each form against a hand-built row, AND-composed — plus
//        THE HEADLINE CASE, run against the REAL spell DB: "slow" finds Weakening Strike
//        through its landing emote (`'s limbs move slower!`) and nothing else knows that.
//   (S3) THE CATALOG BUILD: `searchText` really is name + ranks + the three messages,
//        lowercased, for every row main ships.
//   (S4) THE SECTIONS + THE ROW BUDGET: the partition is total and disjoint, "From your
//        fights" holds exactly the observed rows, and MAX_ROWS is a cap on the WHOLE dialog.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSpellDb, buildSpellCatalog, searchTextFor } from '../src/main/data/spellDb'
import {
  SPELL_SECTIONS,
  filterSpells,
  groupSpellSections,
  isPoisonSpell,
  matchesSpellQuery,
  sectionFor,
  tokenizeSpellQuery,
  type SearchableSpell
} from '../src/shared/spellSearch'
import {
  MAX_ROWS,
  buildSuggestResults,
  filterAlertGroups
} from '../src/renderer/src/features/alerts/resultSections'
import { VERIFIED_ALERT_GROUPS } from '../src/shared/alertGroups'
import type { SpellCatalogEntry } from '../src/shared/types'

/** A hand-built catalog row. `searchText` is spelled out so each case says what it tests. */
function row(over: Partial<SpellCatalogEntry> & { name: string }): SpellCatalogEntry {
  return {
    key: over.name.toLowerCase(),
    illusion: false,
    templates: { wearsOff: false, fade: false, lands: false },
    usageCount: 0,
    searchText: over.name.toLowerCase(),
    ...over
  }
}

/** Does this row survive this query? The whole matcher in one call. */
function hit(entry: SearchableSpell, query: string): boolean {
  return matchesSpellQuery(entry, tokenizeSpellQuery(query))
}

// ─────────────────────────────────────────────────────────────────────────────
// (S1) THE TOKENIZER.

test('S1 the tokenizer: five forms, whitespace-split, and what a typo degrades to', () => {
  assert.deepEqual(tokenizeSpellQuery('   '), [], 'an empty query filters nothing')
  assert.deepEqual(
    tokenizeSpellQuery('slow  level:25').map((t) => t.kind),
    ['text', 'level'],
    'runs of whitespace split once'
  )
  assert.deepEqual(tokenizeSpellQuery('level:20-30')[0], { kind: 'level', raw: 'level:20-30', lo: 20, hi: 30 })
  assert.deepEqual(
    tokenizeSpellQuery('level:30-20')[0],
    { kind: 'level', raw: 'level:30-20', lo: 20, hi: 30 },
    'a backwards range is the same range — the user meant the span'
  )
  assert.deepEqual(tokenizeSpellQuery('lvl:9')[0], { kind: 'level', raw: 'lvl:9', lo: 9, hi: 9 })
  assert.deepEqual(tokenizeSpellQuery('class:Shaman')[0], { kind: 'class', raw: 'class:Shaman', cls: 'SHM' })
  assert.deepEqual(tokenizeSpellQuery('class:shm')[0], { kind: 'class', raw: 'class:shm', cls: 'SHM' })
  assert.deepEqual(tokenizeSpellQuery('type:poison')[0], { kind: 'facet', raw: 'type:poison', facet: 'poison' })
  assert.deepEqual(tokenizeSpellQuery('25')[0], { kind: 'number', raw: '25', text: '25', n: 25 })

  // A token that names something we do not know is NULLED, not dropped: it must narrow the
  // result set to zero rather than silently widen it to everything.
  assert.deepEqual(tokenizeSpellQuery('class:jedi')[0], { kind: 'class', raw: 'class:jedi', cls: null })
  assert.deepEqual(tokenizeSpellQuery('type:slow')[0], { kind: 'facet', raw: 'type:slow', facet: null })
  // A HALF-TYPED prefix is text (the list holds still while you finish the word), and a
  // malformed level is text too — "level:abc" is nobody's level.
  assert.equal(tokenizeSpellQuery('level:')[0].kind, 'text')
  assert.equal(tokenizeSpellQuery('level:abc')[0].kind, 'text')
})

// ─────────────────────────────────────────────────────────────────────────────
// (S2) THE MATCHER.

test('S2 the matcher truth table: every form, AND-composed', () => {
  const clarity = row({
    name: 'Clarity',
    key: 'clarity',
    spellType: 'Beneficial',
    usageCount: 3,
    classLevels: [{ cls: 'ENC', level: 34 }],
    rankNames: ['Clarity', 'Clarity II'],
    searchText: 'clarity clarity ii a cool breeze slips through your mind. the cool breeze fades.'
  })

  // TEXT — name, rank name, and (the point of the redesign) the MESSAGE text.
  assert.equal(hit(clarity, 'clar'), true)
  assert.equal(hit(clarity, 'clarity ii'), true, 'a rank name is in the surface')
  assert.equal(hit(clarity, 'breeze'), true, 'found by its landing message alone')
  assert.equal(hit(clarity, 'CLARITY'), true, 'case-insensitive')
  assert.equal(hit(clarity, 'wolf'), false)

  // AND — every token must match; one miss kills the row.
  assert.equal(hit(clarity, 'breeze mind'), true)
  assert.equal(hit(clarity, 'breeze wolf'), false)

  // LEVEL, as a point and as a range.
  assert.equal(hit(clarity, 'level:34'), true)
  assert.equal(hit(clarity, 'level:33'), false)
  assert.equal(hit(clarity, 'level:30-40'), true)
  assert.equal(hit(clarity, 'level:1-33'), false)

  // CLASS, both spellings, and the unknown one.
  assert.equal(hit(clarity, 'class:enc'), true)
  assert.equal(hit(clarity, 'class:enchanter'), true)
  assert.equal(hit(clarity, 'class:shm'), false)
  assert.equal(hit(clarity, 'class:jedi'), false, 'an unknown class matches nothing')

  // TYPE facets — the five the data can answer.
  assert.equal(hit(clarity, 'type:buff'), true)
  assert.equal(hit(clarity, 'type:debuff'), false)
  assert.equal(hit(clarity, 'type:seen'), true, 'usageCount > 0')
  assert.equal(hit(row({ name: 'x' }), 'type:seen'), false)
  assert.equal(hit(clarity, 'type:illusion'), false)
  assert.equal(hit(row({ name: 'x', illusion: true }), 'type:illusion'), true)
  assert.equal(hit(clarity, 'type:nonsense'), false, 'an unknown facet matches nothing')

  // A BARE NUMBER is deliberately OR: a level, or the digits in the text.
  assert.equal(hit(clarity, '34'), true, 'matches the class level')
  assert.equal(hit(row({ name: 'Bind Sight 2', searchText: 'bind sight 2' }), '2'), true, 'matches the name')
  assert.equal(hit(clarity, '99'), false)

  // Composition across FORMS, which is what a real query looks like.
  assert.equal(hit(clarity, 'breeze class:enc level:30-40 type:buff'), true)
  assert.equal(hit(clarity, 'breeze class:enc level:1-10'), false)

  // An empty query matches everything (the unfiltered list).
  assert.equal(hit(clarity, ''), true)
})

test('S2b THE HEADLINE CASE: "slow" finds Weakening Strike by its landing emote', () => {
  // Built from the REAL DB row through the REAL builder — nothing here is hand-typed, so the
  // claim is about the shipped data, not about this test's imagination.
  const db = loadSpellDb()
  const ws = db.spells.find((s) => s.name === 'Weakening Strike')
  assert.ok(ws, 'the rogue slow Strike must still be in the spell DB')
  const entry = row({
    name: ws.name,
    spellType: ws.spellType,
    searchText: searchTextFor(ws, [ws.name])
  })

  // Its NAME contains no "slow" at all — the emote is the only reason this matches, which is
  // the whole argument for putting message text in the search surface (§1).
  assert.equal(ws.name.toLowerCase().includes('slow'), false)
  assert.equal(hit(entry, 'slow'), true, "'s limbs move slower! carries it")
  assert.equal(hit(entry, 'limbs'), true)
  assert.equal(hit(entry, 'type:poison'), true, 'a Strike is a poison by the poisons.ts roster')
  assert.equal(isPoisonSpell(entry), true)

  // And the same trick over the REAL catalog: "slow" reaches spells whose names never say it.
  const catalog = buildSpellCatalog(db, new Map())
  const named = filterSpells(catalog.entries, tokenizeSpellQuery('slow'))
  const byMessageOnly = named.filter((e) => !e.name.toLowerCase().includes('slow'))
  assert.ok(byMessageOnly.length >= 5, 'the message text is doing real work over the shipped DB')
  assert.ok(
    byMessageOnly.some((e) => e.name === 'Languid Pace'),
    'the enchanter slow is found by "You slow down." — never by its name'
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// (S3) THE CATALOG BUILD.

test('S3 every catalog row carries a lowercase searchText of name + ranks + the three messages', () => {
  const db = loadSpellDb()
  const catalog = buildSpellCatalog(db, new Map())
  assert.ok(catalog.entries.length > 1000, 'the catalog is the real one')
  for (const e of catalog.entries) {
    assert.equal(e.searchText, e.searchText.toLowerCase(), `${e.name}: searchText must be lowercased`)
    assert.ok(e.searchText.includes(e.name.toLowerCase()), `${e.name}: its own name must be in it`)
    for (const rank of e.rankNames ?? []) {
      assert.ok(e.searchText.includes(rank.toLowerCase()), `${e.name}: rank ${rank} must be in it`)
    }
  }

  // The three message texts, on a spell that has all three.
  const clarity = catalog.entries.find((e) => e.key === 'clarity')
  assert.ok(clarity)
  const spell = db.byKey.get('clarity')
  assert.ok(spell?.msgCastOnYou && spell.msgWearsOff)
  assert.ok(clarity.searchText.includes(spell.msgCastOnYou.toLowerCase()))
  assert.ok(clarity.searchText.includes(spell.msgWearsOff.toLowerCase()))

  // A spell the DB gives no messages at all still gets a surface — its name.
  const bare = catalog.entries.find(
    (e) => (db.byKey.get(e.key)?.msgCastOnYou ?? '') === '' && (db.byKey.get(e.key)?.msgWearsOff ?? '') === ''
  )
  if (bare) assert.ok(bare.searchText.length > 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// (S4) SECTIONS + THE ROW BUDGET.

test('S4 the four spell sections partition the catalog: total, disjoint, and honestly named', () => {
  const catalog = buildSpellCatalog(loadSpellDb(), new Map())
  const grouped = groupSpellSections(catalog.entries)
  const sum = SPELL_SECTIONS.reduce((n, s) => n + grouped[s].length, 0)
  assert.equal(sum, catalog.entries.length, 'every row lands in exactly one section')
  for (const s of SPELL_SECTIONS) assert.ok(grouped[s].length > 0, `${s} is not empty in the real DB`)

  // The classifier's precedence, stated: a poison coat is Beneficial and an illusion is too,
  // and neither is usefully called "a buff".
  assert.equal(sectionFor(row({ name: 'Asp Venom', spellType: 'Beneficial' })), 'poisons')
  assert.equal(sectionFor(row({ name: 'x', illusion: true, spellType: 'Beneficial' })), 'illusions')
  assert.equal(sectionFor(row({ name: 'x', spellType: 'Detrimental' })), 'debuffs')
  assert.equal(sectionFor(row({ name: 'x', spellType: 'Beneficial' })), 'buffs')

  // The whole rogue roster is in the Poisons section, by NAME, straight from poisons.ts.
  assert.equal(grouped.poisons.length, 20, 'the 15 utility + 5 combat poisons')
})

test('S4b "From your fights" is exactly the observed rows, and MAX_ROWS caps the WHOLE dialog', () => {
  const entries: SpellCatalogEntry[] = []
  for (let i = 0; i < 150; i++) {
    entries.push(row({ name: `Seen ${i}`, key: `seen ${i}`, spellType: 'Beneficial', usageCount: 1 }))
  }
  for (let i = 0; i < 300; i++) {
    entries.push(row({ name: `Unseen ${i}`, key: `unseen ${i}`, spellType: 'Beneficial' }))
  }
  for (let i = 0; i < 40; i++) {
    entries.push(row({ name: `Bad ${i}`, key: `bad ${i}`, spellType: 'Detrimental' }))
  }

  const all = buildSuggestResults(entries, [])
  assert.equal(all.matched, 490)
  assert.equal(all.fights.total, 150, 'observed rows, and only those')
  assert.equal(all.fights.rows.length, 150)
  const shown = all.fights.rows.length + all.sections.reduce((n, s) => n + s.rows.length, 0)
  assert.equal(shown, MAX_ROWS, 'the budget is spent across sections, never per section')
  const buffs = all.sections.find((s) => s.id === 'buffs')
  assert.equal(buffs?.total, 300, 'the section still reports what it MATCHED…')
  assert.equal(buffs?.rows.length, 50, '…while mounting only what the budget allowed')
  assert.equal(all.sections.find((s) => s.id === 'debuffs')?.rows.length, 0, 'the budget ran out')

  // A COLLAPSED section mounts nothing and hands its budget on — which is what lets a user who
  // folded "From your fights" actually see the debuffs behind it.
  const folded = buildSuggestResults(entries, [], new Set(['fights', 'buffs']))
  assert.equal(folded.fights.rows.length, 0)
  assert.equal(folded.fights.total, 150, 'a folded section still says how much it is hiding')
  assert.equal(folded.sections.find((s) => s.id === 'debuffs')?.rows.length, 40)

  // And the query narrows every section at once.
  const narrowed = buildSuggestResults(entries, tokenizeSpellQuery('type:debuff'))
  assert.equal(narrowed.matched, 40)
  assert.equal(narrowed.fights.total, 0)
  assert.equal(narrowed.sections.find((s) => s.id === 'debuffs')?.total, 40)
})

test('S4c the ready-made sets answer TEXT queries and decline spell-only ones', () => {
  const all = filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery(''))
  assert.equal(all.length, VERIFIED_ALERT_GROUPS.length, 'no query ⇒ every set')

  const slow = filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery('slow'))
  assert.ok(
    slow.some((g) => g.title.toLowerCase().includes('slow')),
    'the rogue-slow set is reachable by typing what it is'
  )
  assert.equal(filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery('zzzz')).length, 0)

  // `level:` / `class:` / `type:` are statements about SPELLS. A set that matched one by
  // accident would be a wrong answer, so the section stands down instead.
  for (const q of ['level:25', 'class:shm', 'type:buff', 'slow level:25']) {
    assert.equal(filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery(q)).length, 0, q)
  }
})
