// POSKY DROPPERS — "which mob do I kill for this Plane of Sky quest item?"
//
// Goldens against the COMMITTED data, both halves: `data/eqlegends/posky.json` (95 quests) and
// `data/eqlegends/mobs.json` (7,866 mob pages). Nothing here is synthetic except the tiny
// hand-built catalogs that pin ordering and dedupe rules — the coverage, the boss identities and
// the false positive are all read off the real files, so a re-scrape that breaks the join breaks
// this suite.
//
// What it pins:
//   - a known Sky item names its boss, BY NAME (the whole point: posky's own `who` says "SL").
//   - the SKY GATE. `Bixie Stinger` is the item-name collision that motivated it: the
//     unrestricted reverse index answers with bixies in Kithicor Forest / Misty Thicket, which
//     are a different item entirely. Sky-restricted, it resolves to nothing — correct, and the
//     only item in the whole dataset the gate costs.
//   - layer 1 (an explicit dropper the scrape NAMES) outranks the index, and the nine strings
//     the scrape actually carries resolve to no mob at all — which is why layer 2 does the work.
//   - an item with no known dropper resolves EMPTY (law 1: never a guess).
//   - "+N more" overflow, and `itemCountKey` variant folding on the query side.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DROPPER_DISPLAY_CAP,
  buildDropperIndex,
  buildMobNameIndex,
  dropperDisplay,
  dropperFacts,
  dropperLabel,
  droppersFor,
  isSkyMob,
  mergeDroppers,
  skyDroppersFor,
  statedDroppers,
  type DropperMob
} from '../src/renderer/src/features/posky/poskyDroppers'
import mobsRaw from '../src/renderer/src/data/eqlegends/mobs.json' with { type: 'json' }
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { MobEntry, PoskyQuest } from '../src/shared/types'

const MOBS = (mobsRaw as { mobs: MobEntry[] }).mobs
const QUESTS = (poskyRaw as { quests: PoskyQuest[] }).quests

/** The unrestricted index — every mob in the game. Only the gate tests want this one. */
const FULL_INDEX = buildDropperIndex(MOBS)
const FULL_NAMES = buildMobNameIndex(MOBS)

const names = (ds: readonly DropperMob[]): string[] => ds.map((d) => d.name)

// =============================================================================
// 1. The join works: a Sky item names its boss
// =============================================================================

test('a known Sky quest item resolves the boss that drops it, by name', () => {
  // posky says who: ["SL"] / where: "Island 7". The catalog says the mob.
  assert.deepEqual(names(skyDroppersFor('Ceremonial Belt')), ['The Spiroc Lord'])
  // who: ["Gorga"] — an abbreviation of a name the catalog spells in full.
  assert.deepEqual(names(skyDroppersFor('Light Woolen Mask')), ['Gorgalosk'])
  // who: ["KoS"]
  assert.deepEqual(names(skyDroppersFor('Black Silk Cape')), ['Keeper of Souls'])
  // who: ["EoV"]
  assert.deepEqual(names(skyDroppersFor('Symbol of Veeshan')), ['Eye of Veeshan'])
})

test('an efreeti-chain item resolves EVERY boss that drops it, deterministically ordered', () => {
  // The multi-dropper case the display cap exists for. Sorted by name, case-folded, so scrape
  // order can never leak into the UI.
  assert.deepEqual(names(skyDroppersFor('Efreeti Mace')), [
    'Noble Dojorn',
    'Overseer of Air',
    'the Hand of Veeshan'
  ])
})

test('resolved droppers carry the level and zone the catalog states, verbatim', () => {
  const [dojorn] = skyDroppersFor('Efreeti War Maul')
  assert.equal(dojorn.name, 'Noble Dojorn')
  assert.equal(dojorn.page, 'Noble Dojorn')
  // A RANGE-ish string, not a number — passed through exactly as the page writes it.
  assert.equal(dojorn.level, '63+')
  assert.deepEqual(dojorn.zones, ['Plane of Sky'])
  assert.equal(dropperFacts(dojorn), 'Noble Dojorn · level 63+ · Plane of Sky')
})

// =============================================================================
// 2. The Sky gate — the false positive it exists to stop
// =============================================================================

test('isSkyMob matches the zone exactly — Skyfire/Skyshrine are NOT the Plane of Sky', () => {
  assert.equal(isSkyMob({ zones: ['Plane of Sky'] }), true)
  assert.equal(isSkyMob({ zones: ['plane of sky'] }), true) // case-folded
  assert.equal(isSkyMob({ zones: ['Skyfire Mountains'] }), false)
  assert.equal(isSkyMob({ zones: ['Skyshrine'] }), false)
  assert.equal(isSkyMob({ zones: [] }), false)
  assert.equal(isSkyMob({}), false)
})

test('Bixie Stinger: the unrestricted index answers with the WRONG item, the Sky gate refuses', () => {
  // Same name, different item. The catalog's hits are ordinary overworld bixies.
  const loose = droppersFor('Bixie Stinger', FULL_INDEX)
  assert.ok(loose.length > 0, 'the unrestricted index does resolve this name')
  assert.ok(
    loose.every((m) => !isSkyMob(m)),
    'and not one of its hits lives in the Plane of Sky'
  )
  // Sky-gated: nothing. The tracker shows posky's own "BZ" instead of a wrong mob.
  assert.deepEqual(skyDroppersFor('Bixie Stinger'), [])
})

test('the Sky gate costs exactly ONE distinct item across the whole dataset', () => {
  const items = new Set(QUESTS.flatMap((q) => q.items.map((i) => i.name)))
  const lost = [...items].filter(
    (n) => droppersFor(n, FULL_INDEX).length > 0 && skyDroppersFor(n).length === 0
  )
  assert.deepEqual(lost, ['Bixie Stinger'])
})

// =============================================================================
// 3. Layer 1 (the scrape's own naming) outranks layer 2, and today contributes nothing
// =============================================================================

test('none of the strings posky actually puts in `who` names a mob the catalog knows', () => {
  // Verbatim, all nine distinct values in the committed posky.json.
  const stated = ['Gorga', 'KoS', 'SL', 'BZ', 'SotS', 'EoV', 'PoS', 'Trash', 'random drop — any Plane of Sky mob']
  assert.deepEqual(statedDroppers(stated, FULL_NAMES), [])
  // So the reverse index is doing all of the work — sanity-check the same call end to end.
  assert.deepEqual(names(skyDroppersFor('Ceremonial Belt', ['SL'])), ['The Spiroc Lord'])
})

test('a `who` that DOES name a catalog mob resolves, and leads the merged list', () => {
  // The hook layer 1 exists for: a future scrape writing real names takes precedence.
  assert.deepEqual(names(statedDroppers(['Overseer of Air'], FULL_NAMES)), ['Overseer of Air'])
  // 'Efreeti Mace' indexes to Noble Dojorn / Overseer of Air / the Hand of Veeshan; naming the
  // Overseer pulls it to the FRONT and must not duplicate it.
  assert.deepEqual(names(skyDroppersFor('Efreeti Mace', ['Overseer of Air'])), [
    'Overseer of Air',
    'Noble Dojorn',
    'the Hand of Veeshan'
  ])
})

test('statedDroppers is case/whitespace tolerant and de-dupes repeats', () => {
  assert.deepEqual(names(statedDroppers(['  gorgalosk ', 'GORGALOSK'], FULL_NAMES)), ['Gorgalosk'])
  assert.deepEqual(statedDroppers(undefined, FULL_NAMES), [])
  assert.deepEqual(statedDroppers([], FULL_NAMES), [])
})

test('mergeDroppers keeps layer 1 first and de-dupes by page', () => {
  const a: DropperMob = { name: 'A', page: 'A', zones: ['Plane of Sky'] }
  const b: DropperMob = { name: 'B', page: 'B', zones: ['Plane of Sky'] }
  assert.deepEqual(names(mergeDroppers([b], [a, b])), ['B', 'A'])
  assert.deepEqual(names(mergeDroppers([], [a, b])), ['A', 'B'])
})

// =============================================================================
// 4. No dropper ⇒ nothing. Never a guess.
// =============================================================================

test('an item with no known dropper resolves EMPTY', () => {
  // Wind runes: posky itself calls them "random drop — any Plane of Sky mob". No kill target
  // exists, so none is invented. (All 15 runes behave the same way.)
  assert.deepEqual(skyDroppersFor('Wind Rune Meda'), [])
  assert.deepEqual(skyDroppersFor('Wind Rune Azia'), [])
  // No page in the whole 7,866-row catalog lists these.
  assert.deepEqual(skyDroppersFor('Azarack Blood'), [])
  assert.deepEqual(skyDroppersFor('Azarack Skin'), [])
  assert.deepEqual(skyDroppersFor('Large Sky Lapis'), [])
  // A name nothing in EverQuest has ever heard of.
  assert.deepEqual(skyDroppersFor('Sword of Nonexistence'), [])
  assert.deepEqual(skyDroppersFor(''), [])
})

// =============================================================================
// 5. Display: the cap, the "+N more" overflow, and query-side variant folding
// =============================================================================

test('itemCountKey variant folding: a `+N` upgrade resolves its BASE item dropper', () => {
  const base = skyDroppersFor('Sphinx Claw')
  assert.deepEqual(names(base), ['Sister of the Spire'])
  assert.deepEqual(names(skyDroppersFor('Sphinx Claw +1')), names(base))
  assert.deepEqual(names(skyDroppersFor('sphinx claw +12')), names(base))
  // The catalog itself carries zero `+N` drop names, so the folding is query-side only.
  assert.equal(
    MOBS.some((m) => (m.drops ?? []).some((d) => / \+\d+$/.test(d))),
    false
  )
})

test('more droppers than the cap fold into "+N more"', () => {
  // Four Sky mobs drop this one — the only item in the dataset that overflows a cap of 3.
  const four = skyDroppersFor('Crown Of Elemental Mastery')
  assert.equal(four.length, 4)
  const disp = dropperDisplay(four)
  assert.equal(disp.shown.length, DROPPER_DISPLAY_CAP)
  assert.equal(disp.more, 1)
  assert.equal(
    dropperLabel(four),
    'a fatestealer drake, a greater sphinx, a heartsbane drake +1 more'
  )
  // Under the cap: no overflow clause at all.
  assert.equal(dropperLabel(skyDroppersFor('Ceremonial Belt')), 'The Spiroc Lord')
  assert.equal(dropperLabel([]), '')
  // An explicit cap of 1 collapses the rest.
  assert.equal(dropperLabel(four, 1), 'a fatestealer drake +3 more')
})

// =============================================================================
// 6. Index construction rules (hand-built catalogs — ordering, dedupe, absent fields)
// =============================================================================

test('buildDropperIndex folds variants, sorts by name, and survives drop-less pages', () => {
  const mobs: MobEntry[] = [
    { page: 'Zeta', name: 'Zeta', zones: ['Plane of Sky'], drops: ['Widget'] },
    { page: 'Alpha', name: 'Alpha', zones: ['Plane of Sky'], drops: ['Widget +1', 'Gadget'] },
    { page: 'Empty', name: 'Empty', zones: ['Plane of Sky'] }
  ]
  const idx = buildDropperIndex(mobs)
  assert.deepEqual(names(droppersFor('Widget', idx)), ['Alpha', 'Zeta'])
  assert.deepEqual(names(droppersFor('Gadget', idx)), ['Alpha'])
  assert.deepEqual(droppersFor('Empty', idx), [])
  // `level` is ABSENT, not empty-string, when the page never stated one.
  assert.equal('level' in droppersFor('Gadget', idx)[0], false)
  assert.equal(dropperFacts(droppersFor('Gadget', idx)[0]), 'Alpha · Plane of Sky')
})

test('buildMobNameIndex keeps the FIRST page for a duplicated name (scrape order wins once)', () => {
  const idx = buildMobNameIndex([
    { page: 'a bandit (Qeynos Hills)', name: 'a bandit' },
    { page: 'a bandit (North Karana)', name: 'a bandit' }
  ])
  assert.equal(idx.get('a bandit')?.page, 'a bandit (Qeynos Hills)')
})

// =============================================================================
// 7. Coverage over the real tracker — floors, not frozen counts (a re-scrape may add rows)
// =============================================================================

test('the tracker resolves a kill target for the great majority of its items', () => {
  const items = [...new Set(QUESTS.flatMap((q) => q.items.map((i) => i.name)))]
  const resolved = items.filter((n) => skyDroppersFor(n).length > 0)
  const unresolved = items.filter((n) => skyDroppersFor(n).length === 0)
  assert.ok(items.length >= 128, `distinct items: ${items.length}`)
  assert.ok(resolved.length >= 109, `resolved: ${resolved.length} of ${items.length}`)
  // Every unresolved item is a wind rune or one of the three the catalog simply never lists.
  const expectedGaps = new Set(['Azarack Blood', 'Azarack Skin', 'Bixie Stinger', 'Large Sky Lapis'])
  for (const n of unresolved) {
    assert.ok(
      n.toLowerCase().startsWith('wind rune') || expectedGaps.has(n),
      `unexpected unresolved item: ${n}`
    )
  }
})

test('every resolved dropper lives in the Plane of Sky and is a real catalog row', () => {
  const pages = new Set(MOBS.map((m) => m.page))
  for (const q of QUESTS) {
    for (const it of q.items) {
      for (const d of skyDroppersFor(it.name, it.who)) {
        assert.ok(pages.has(d.page), `${d.page} is not a catalog page`)
        assert.ok(isSkyMob(d), `${d.name} is not in the Plane of Sky`)
      }
    }
  }
})
