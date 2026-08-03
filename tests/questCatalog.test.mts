// QUEST-CATALOG TESTS: the pure quest-page wikitext parser (scripts/sources/questPage.ts)
// plus identity checks on the committed dataset it produces
// (src/renderer/src/data/eqlegends/quests.json, written by `npm run scrape:quests`).
//
// WHY the catalog exists: an item page only names a quest when someone filled in its
// `|relatedquests` field, so classic turn-in items read as quest-less from the item side.
// The linkage lives on the QUEST pages — the scraper indexes them item-first, and
// src/main/itemLookup.ts merges that index in as a second LOCAL source (before the wiki).
//
// The wikitext fixtures below are VERBATIM excerpts of real eqlwiki quest pages
// (fetched 2026-08-02), trimmed to the structures the parser reads. They are wiki text,
// not game log, so the fixture-scrub law doesn't apply.
//
// Dataset assertions are IDENTITIES ("this item resolves to >= 1 quest", "givers are
// non-empty strings") — never frozen counts of a scrape that will grow.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dedupe,
  isEmptyParse,
  linkTargets,
  parseQuestPage,
  parseTopTable,
  splitSections,
  stripMarkup,
  transclusionTargets
} from '../scripts/sources/questPage'
import { MAX_ATTACHED_REWARDS, buildQuestItemIndex, questItemKey } from '../src/main/questItemIndex'
import questsJson from '../src/renderer/src/data/eqlegends/quests.json'
import type { QuestData } from '../src/shared/types'

// --- verbatim wikitext fixtures --------------------------------------------------

// "Ale for Beur": the canonical shape — questTopTable header, a Reward section whose item
// is a {{:Name}} transclusion box, and the turn-in item as a plain [[link]] in prose.
const ALE_FOR_BEUR = `{{Classic Era}}
[[File:npc_beur_tenlah.png|frame|Beur Tenlah]]
{| class="questTopTable"
! ''' Start Zone: '''
| [[Freeport|East Freeport]]
|-
! ''' Quest Giver: '''
| [[Beur Tenlah]]
|-
! ''' Minimum Level: '''
| 1
|-
! ''' Classes: '''
| [[Warrior]], [[Ranger]], [[Bard]], [[Rogue]]
|-
! ''' Related Zones: '''
| None
|-
! ''' Related NPCs: '''
| [[Harkin Duskfoot]]
|}

== Reward ==

<ul><li>  {{:Used Merchants Gloves}}
</li></ul>

== Walkthrough ==

You say, 'Hail, Beur Tenlah'

'''Bring him some [[Dwarven Ale]].'''

{{YouGainExperience}}

'''This leads in to the [[Note for Janam]] quest as Harkin Dustfoot is stood next to him.'''

[[Category:Quests]]
[[Category:East Freeport]]`

// "Corrupt Guards": a Minimum Level cell carrying PROSE, "All" classes, a many-item Reward
// list, the {{exp}} spelling of the experience marker, and a turn-in item ([[Guard Bracelet]])
// buried in prose next to NPC and zone links that must NOT become items.
const CORRUPT_GUARDS = `{{Classic Era}}
{| class="questTopTable"
! ''' Start Zone: '''
| [[Northern Karana]]
|-
! ''' Quest Giver: '''
| [[Capt Linarius]]
|-
! ''' Minimum Level: '''
| 15 (lowest level of the guard you need to kill is 30)
|-
! ''' Classes: '''
| All
|-
! ''' Related Zones: '''
| [[Western Karana]]
|-
! ''' Related NPCs: '''
| [[Guard McCluskey]]
|}

== Reward ==

<ul><li>  {{:Bunker Battle Blade}}
</li><li> {{:Fine Steel Dagger}}
</li></ul>

== Walkthrough ==

A [[Guard Bracelet]] (identifies as "Corrupt Guard Bracelet") drops from [[Guard McCluskey]] in [[Western Karana]].

{{exp}} (About 48,000 exp per bracer)

[[Category:Quests]]`

// "Bone Chips Quests": a disambiguation HUB — no top table, no reward, only links to the
// real quest pages. Must parse to nothing so the scraper LISTS it as skipped.
const BONE_CHIPS_HUB = `{{Disambiguation}}
: [[File:Item_804.png]] There are many quest iterations regarding turning in '''[[Bone Chips]]''' for city/guard faction.

*[[Bone Chips Felwithe|Yeolarn ('''Felwithe''')]] - In the Cleric guild.
*[[Assist the Great Xelha|Xelha ('''Freeport''')]] - give 4 Bone Chips to [[Xelha Nevagon]].

[[Category: Quests]]
[[Category: Repeatable Turn-in Quests]]`

// The item-title set the scraper supplies (in the real run: every page embedding
// Template:Itempage + Category:Quest Items). Only these titles may become items.
const ITEMS = new Set(
  [
    'Dwarven Ale',
    'Used Merchants Gloves',
    'Guard Bracelet',
    'Bunker Battle Blade',
    'Fine Steel Dagger',
    'Bone Chips'
  ].map((s) => s.toLowerCase())
)
const isItem = (t: string): boolean => ITEMS.has(t.toLowerCase())

// --- parser tests -----------------------------------------------------------------

test('Ale for Beur: top table, transcluded reward, prose turn-in item, exp marker', () => {
  const q = parseQuestPage('Ale for Beur', ALE_FOR_BEUR, isItem)
  assert.equal(q.hasTopTable, true)
  assert.equal(q.startZone, 'East Freeport') // [[Freeport|East Freeport]] → the LABEL
  assert.equal(q.giver, 'Beur Tenlah')
  assert.equal(q.minLevel, 1)
  assert.deepEqual(q.classes, ['Warrior', 'Ranger', 'Bard', 'Rogue'])
  assert.deepEqual(q.relatedZones, []) // "None" is not a zone
  assert.deepEqual(q.relatedNpcs, ['Harkin Duskfoot'])
  assert.deepEqual(q.rewards, ['Used Merchants Gloves'])
  assert.deepEqual(q.requiredItems, ['Dwarven Ale'])
  assert.equal(q.expReward, true)
  assert.equal(isEmptyParse(q), false)
})

test('Corrupt Guards: prose Minimum Level, All classes, {{exp}}, NPC/zone links are not items', () => {
  const q = parseQuestPage('Corrupt Guards', CORRUPT_GUARDS, isItem)
  assert.equal(q.minLevel, 15) // numeric part only…
  assert.equal(q.minLevelText, '15 (lowest level of the guard you need to kill is 30)') // …prose kept
  assert.deepEqual(q.classes, ['All'])
  assert.deepEqual(q.rewards, ['Bunker Battle Blade', 'Fine Steel Dagger'])
  assert.deepEqual(q.requiredItems, ['Guard Bracelet'])
  // The walkthrough also links an NPC and a zone — neither is in the item set.
  assert.equal(q.requiredItems.includes('Guard McCluskey'), false)
  assert.equal(q.requiredItems.includes('Western Karana'), false)
  assert.equal(q.expReward, true)
})

test('a reward item is never ALSO listed as required (Reward section is excluded from the body)', () => {
  const q = parseQuestPage('Corrupt Guards', CORRUPT_GUARDS, isItem)
  for (const r of q.rewards) assert.equal(q.requiredItems.includes(r), false)
})

test('Bone Chips Quests: a disambiguation hub parses to nothing and is flagged, not dropped', () => {
  const q = parseQuestPage('Bone Chips Quests', BONE_CHIPS_HUB, isItem)
  assert.equal(q.disambiguation, true)
  assert.equal(q.hasTopTable, false)
  assert.equal(q.rewards.length, 0)
  // [[Bone Chips]] IS an item, so the hub isn't literally empty of item links — the
  // "empty" verdict is about quest FIELDS (no table, no giver, no zone, no reward).
  assert.equal(q.giver, undefined)
  assert.equal(
    isEmptyParse({ ...q, requiredItems: [] }),
    true
  )
})

test('link/transclusion extraction: labels vs targets, namespaces skipped, dedupe', () => {
  assert.deepEqual(linkTargets('[[Freeport|East Freeport]] and [[Dwarven Ale]]'), ['Freeport', 'Dwarven Ale'])
  assert.deepEqual(linkTargets('[[File:x.png|frame|Cap]] [[Category:Quests]] [[Bone Chips]]'), ['Bone Chips'])
  assert.deepEqual(transclusionTargets('<li> {{:Small Tattered Belt}} </li>{{Classic Era}}'), [
    'Small Tattered Belt'
  ])
  assert.deepEqual(dedupe(['Bone Chips', 'bone chips', 'Rusty Dagger']), ['Bone Chips', 'Rusty Dagger'])
  assert.equal(stripMarkup("''' [[Freeport|East  Freeport]] '''"), 'East Freeport')
})

test('parseTopTable returns null when the page has no questTopTable', () => {
  assert.equal(parseTopTable(BONE_CHIPS_HUB), null)
})

test('splitSections separates the lead from == Heading == blocks', () => {
  const { lead, sections } = splitSections(ALE_FOR_BEUR)
  assert.match(lead, /questTopTable/)
  assert.deepEqual(
    sections.map((s) => s.heading),
    ['Reward', 'Walkthrough']
  )
})

// --- committed dataset ------------------------------------------------------------

const data = questsJson as unknown as QuestData

/**
 * The item→quests index src/main/itemLookup.ts serves — the REAL builder, not a mirror of it.
 * It lives in its own pure module (src/main/questItemIndex.ts) precisely so this test can
 * import it: itemLookup itself imports `electron`, which cannot load outside an Electron
 * process, and a re-implemented index proves nothing about the shipped one.
 */
const byItem = buildQuestItemIndex(data)

test('quests.json loads with a sane, non-empty catalog', () => {
  assert.ok(data.scrapedAt)
  assert.ok(data.source.includes('eqlwiki'))
  assert.ok(data.quests.length > 200, `expected a substantial catalog, got ${data.quests.length}`)
  for (const q of data.quests) {
    assert.ok(q.name && q.page, 'every quest carries a name + page')
    assert.equal(typeof q.name, 'string')
  }
  // Deterministic output: sorted by page title.
  const pages = data.quests.map((q) => q.page)
  assert.deepEqual(pages, [...pages].sort((a, b) => a.localeCompare(b)))
  // No duplicate quest pages.
  assert.equal(new Set(pages).size, pages.length)
})

test('the byItem index answers classic turn-in items the ITEM pages never link', () => {
  // These items' own wiki pages carry no |relatedquests — the linkage lives on the quest
  // pages ("Ale for Beur", "Corrupt Guards", the Bone Chips turn-ins). That gap is the whole
  // reason the catalog exists, so each must resolve to at least one quest.
  for (const item of ['dwarven ale', 'bone chips', 'guard bracelet']) {
    const uses = byItem.get(item) ?? []
    assert.ok(uses.length >= 1, `${item} should resolve to at least one quest`)
    assert.ok(
      uses.some((u) => u.role === 'required'),
      `${item} should be a turn-in for at least one quest`
    )
  }
})

test('the index carries BOTH roles: reward items resolve too', () => {
  const rewardItems = [...byItem.entries()].filter(([, uses]) => uses.some((u) => u.role === 'reward'))
  assert.ok(rewardItems.length > 50, 'quest rewards should be indexed, not just turn-ins')
  const requiredItems = [...byItem.entries()].filter(([, uses]) => uses.some((u) => u.role === 'required'))
  assert.ok(requiredItems.length > 50, 'turn-in items should be indexed')
})

// --- reward attachment (Task #62) --------------------------------------------------
//
// A turn-in use now carries what the quest HANDS OUT, so the item hover card can answer
// "…and what do I get for it" one hop deep without a second lookup. Identity-style: the
// attached names must be exactly the quest's own reward names, capped — never invented,
// never on the wrong role.

test('a required-role use carries its quest rewards; a reward-role use never does', () => {
  let checkedRequired = 0
  for (const q of data.quests) {
    const rewardNames = (q.rewards ?? []).map((r) => r.name.trim()).filter(Boolean)
    for (const it of q.requiredItems ?? []) {
      const use = (byItem.get(questItemKey(it)) ?? []).find((u) => u.page === q.page && u.role === 'required')
      assert.ok(use, `${it} should carry a required use for ${q.page}`)
      if (rewardNames.length === 0) {
        // Law 1: a quest whose page names no reward attaches NOTHING, not an empty list.
        assert.equal(use.rewards, undefined, `${q.page}: no rewards known ⇒ no rewards field`)
      } else {
        assert.deepEqual(use.rewards, rewardNames.slice(0, MAX_ATTACHED_REWARDS))
        checkedRequired++
      }
    }
    for (const r of q.rewards ?? []) {
      const use = (byItem.get(questItemKey(r.name)) ?? []).find((u) => u.page === q.page && u.role === 'reward')
      assert.ok(use, `${r.name} should carry a reward use for ${q.page}`)
      assert.equal(use.rewards, undefined, 'a reward item is its own outcome — never re-listed')
    }
  }
  assert.ok(checkedRequired > 20, `expected many turn-ins to name an outcome, got ${checkedRequired}`)
})

test('attached rewards are capped and are real, non-empty names', () => {
  for (const uses of byItem.values()) {
    for (const u of uses) {
      if (!u.rewards) continue
      assert.equal(u.role, 'required')
      assert.ok(u.rewards.length > 0 && u.rewards.length <= MAX_ATTACHED_REWARDS)
      for (const r of u.rewards) assert.ok(r.trim().length > 0 && !r.includes('[['), `clean reward name: ${r}`)
    }
  }
})

test('the index keys items the way itemLookup does (base name, case-folded)', () => {
  // `+N` upgrade variants share the base item's knowledge (Task #42) — the index must key
  // the same way itemLookup's cacheKey does or a looted "Sphinx Claw +1" resolves to nothing.
  assert.equal(questItemKey('  Dwarven Ale '), questItemKey('dwarven ale'))
  assert.equal(questItemKey('Guard Bracelet +2'), questItemKey('Guard Bracelet'))
})

test('quest metadata survives the scrape (givers, zones, levels are real values)', () => {
  const withGiver = data.quests.filter((q) => q.giver)
  assert.ok(withGiver.length > 100, `expected many quests to name a giver, got ${withGiver.length}`)
  for (const q of withGiver) {
    assert.ok(q.giver && q.giver.length > 1 && !q.giver.includes('[['), `clean giver on ${q.page}`)
  }
  for (const q of data.quests) {
    if (q.minLevel != null) assert.ok(q.minLevel >= 0 && q.minLevel <= 100, `sane minLevel on ${q.page}`)
    for (const z of q.relatedZones ?? []) assert.ok(!/^none$/i.test(z))
  }
})
