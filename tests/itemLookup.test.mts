// ITEM-KNOWLEDGE PARSER TEST (Task #53): the pure wikitext → ItemKnowledge classification
// that answers "what's this lore/quest item for". Fixtures are VERBATIM {{Itempage}}
// wikitext fetched from eqlwiki.com (the real pages the feature parses at runtime):
//   - Coin of Tash              — the "42 tash" (Tashania) spell-quest collectible
//   - Glowing Coin of Tash      — carries an explicit QUEST ITEM flag in statsblock
//   - Sphinx Claw               — a Plane of Sky class-Test drop (piped [[Page|Label]] link)
//   - Water Flask               — NOT lore, but used in MANY quests (multi-link relatedquests)
//   - Golden Earring            — vendor trash: no lore, no relatedquests → not notable
//
// Pins the flag detection (LORE ITEM / QUEST ITEM), the [[Page|Label]] quest-link parsing,
// the notes→summary one-liner, and the not-notable negative. Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseItemWikitext,
  parseQuestLinks,
  templateField,
  cleanSummary,
  normalizeItemName
} from '../src/main/itemLookupParse'

// --- verbatim real wikitext (trimmed to the {{Itempage}} template) --------------

const COIN_OF_TASH = `
<onlyinclude>{{Itempage
|notes       =
|itemname    = Coin of Tash
|lucy_img_ID = 646
|statsblock  =
MAGIC ITEM  LORE ITEM  NO DROP<br>
WT: 0.1  Size: TINY<br>
Class: ALL<br>
Race: ALL<br>
|relatedquests =

* [[Coin of Tash (Tashania)]]

|playercrafted =

* Non-Tradeskill (Quest)

}}</onlyinclude>`

const GLOWING_COIN = `
<onlyinclude>{{Itempage
|notes       =
|itemname    = Glowing Coin of Tash
|lucy_img_ID = 646
|statsblock  =
MAGIC ITEM  LORE ITEM  NO DROP  QUEST ITEM<br>
WT: 0.1  Size: TINY<br>
Class: ALL<br>
Race: ALL<br>
|relatedquests =

* [[Coin of Tash (Tashania spell)]]

}}</onlyinclude>`

const SPHINX_CLAW = `
<onlyinclude>{{Itempage
|notes       =
|itemname    = Sphinx Claw
|lucy_img_ID = 801
|statsblock  =
LORE ITEM  NO DROP<br>
Slot: PRIMARY<br>
Skill: 1H Slashing  Atk Delay: 20<br>
DMG: 12 <br>
WT: 2.0  Size: MEDIUM<br>
Class: PAL<br>
Race: ALL<br>
|dropsfrom =

[[Plane of Sky]]

* [[Sister of the Spire]]

|relatedquests =

* [[Paladin Plane of Sky Tests|Paladin Test of Love]]

}}</onlyinclude>`

const WATER_FLASK = `
<onlyinclude>{{Itempage
|notes       = 1sp 1cp per flask
|itemname    = Water Flask
|lucy_img_ID = 584
|statsblock  =
This is a drink.<br>
WT: 0.4  Size: SMALL<br>
Class: ALL<br>
Race: ALL<br>
|dropsfrom =

Various Zones

* Newbie Mobs

|relatedquests =

* [[Quench Lasen's Thirst]]
* [[Trooper Scale Armor Quests|Trooper Scale Pauldron]]
* [[Coldain Prayer Shawl Quests|Coldain Shawl #7: Runed Coldain Prayer Shawl]]
* [[Zimel's Blades (SoulFire)]]

}}</onlyinclude>`

const GOLDEN_EARRING = `
<onlyinclude>{{Itempage
|notes       = Vendor trash.
|itemname    = Golden Earring
|lucy_img_ID = 535
|statsblock  =
Slot: EAR<br>
WT: 0.1  Size: TINY<br>
Class: ALL<br>
Race: ALL<br>
|dropsfrom =

[[Befallen]]

}}</onlyinclude>`

// --- tests ----------------------------------------------------------------------

test('Coin of Tash: LORE + the Tashania spell-quest association (the 42-tash example)', () => {
  const k = parseItemWikitext('Coin of Tash', COIN_OF_TASH)
  assert.equal(k.lore, true)
  assert.equal(k.quest, true) // has a relatedquest even without a QUEST ITEM flag
  assert.deepEqual(
    k.questUses.map((u) => u.quest),
    ['Coin of Tash (Tashania)']
  )
  assert.equal(k.questUses[0].source, 'wiki')
  // statsblock <br> collapse to newlines, flags preserved
  assert.match(k.statsBlock ?? '', /LORE ITEM/)
})

test('Glowing Coin of Tash: explicit QUEST ITEM flag + spell-quest link', () => {
  const k = parseItemWikitext('Glowing Coin of Tash', GLOWING_COIN)
  assert.equal(k.lore, true)
  assert.equal(k.quest, true)
  assert.deepEqual(
    k.questUses.map((u) => u.quest),
    ['Coin of Tash (Tashania spell)']
  )
})

test('Sphinx Claw: LORE Sky drop, piped [[Page|Label]] quest link resolves to the label', () => {
  const k = parseItemWikitext('Sphinx Claw', SPHINX_CLAW)
  assert.equal(k.lore, true)
  assert.equal(k.quest, true)
  assert.equal(k.questUses.length, 1)
  assert.equal(k.questUses[0].quest, 'Paladin Test of Love')
  assert.equal(k.questUses[0].page, 'Paladin Plane of Sky Tests')
})

test('Water Flask: NOT lore, but used in multiple quests (all links captured)', () => {
  const k = parseItemWikitext('Water Flask', WATER_FLASK)
  assert.equal(k.lore, false)
  assert.equal(k.quest, true) // relatedquests present → quest-relevant
  assert.equal(k.questUses.length, 4)
  const labels = k.questUses.map((u) => u.quest)
  assert.ok(labels.includes("Quench Lasen's Thirst"))
  assert.ok(labels.includes('Trooper Scale Pauldron')) // the piped label, not the page
  assert.equal(k.summary, '1sp 1cp per flask')
})

test('Golden Earring: vendor trash — not lore, no quests → not notable', () => {
  const k = parseItemWikitext('Golden Earring', GOLDEN_EARRING)
  assert.equal(k.lore, false)
  assert.equal(k.quest, false)
  assert.equal(k.questUses.length, 0)
  assert.equal(k.summary, 'Vendor trash.')
  // "not notable" is the (lore || quest || uses) predicate the UI uses:
  assert.equal(k.lore || k.quest || k.questUses.length > 0, false)
})

test('templateField isolates a single field and stops at the next pipe', () => {
  const sb = templateField(SPHINX_CLAW, 'statsblock')
  assert.match(sb ?? '', /LORE ITEM/)
  assert.doesNotMatch(sb ?? '', /relatedquests/)
  assert.doesNotMatch(sb ?? '', /Sister of the Spire/) // dropsfrom is a later field
})

test('parseQuestLinks handles plain and piped links, dedupes', () => {
  const uses = parseQuestLinks('* [[A Quest]]\n* [[Page X|Label X]]\n* [[A Quest]]')
  assert.deepEqual(
    uses.map((u) => u.quest),
    ['A Quest', 'Label X']
  )
  assert.equal(uses[1].page, 'Page X')
})

test('cleanSummary strips markup + caps to one sentence', () => {
  const s = cleanSummary("'''Bone Chips''' are used as a [[Necromancer]] reagent. And more prose here.")
  assert.equal(s, 'Bone Chips are used as a Necromancer reagent.')
})

test('normalizeItemName strips a trailing +N upgrade suffix only', () => {
  assert.equal(normalizeItemName('Sphinx Claw +1'), 'Sphinx Claw')
  assert.equal(normalizeItemName('Coin of Tash'), 'Coin of Tash')
})
