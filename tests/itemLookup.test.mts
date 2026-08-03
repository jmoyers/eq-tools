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
  parseRecipeUses,
  parseCraftRecipes,
  templateField,
  cleanSummary,
  normalizeItemName
} from '../src/main/itemLookupParse'
import { craftedByLabel, isNotableKnowledge, recipeUseLabel } from '../src/shared/itemKnowledge'
// The renderer-side VIEW rule (which items the push surfaces hide). Pure + MUI-free, so it
// runs here; its only import is a type, which tsx erases.
import { isTradeskillOnly } from '../src/renderer/src/lib/itemKnowledgeView'
import {
  parseStatsBlock,
  damageRatio,
  expToNextTier,
  itemTierFromName,
  statLabel,
  tierBonusPct,
  unlockedExaltationSlots
} from '../src/shared/itemStats'

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

// =================================================================================
// ITEM-WINDOW STAT BLOCK (the game's item description window).
// Fixtures are VERBATIM {{Itempage}} wikitext fetched from eqlwiki.com on 2026-08-02:
//   - Red Dragonscale Armor  — armor: AC, one attribute, two saves, 6-class list
//   - Skycleaver             — weapon: modern "Lore Equipped, No Trade" flag line,
//                              Dmg Bon, and a `Combat Effect: … (Req Level N)` line
//   - Djarn's Amethyst Ring  — |focus_effect OUTSIDE the stats block
//   - Boots of the Long Road — a `Click Effect:` line + the one page that hand-writes
//                              an exaltation socket row (`Slot: Ornamentation: empty`)
// =================================================================================

const RED_DRAGONSCALE = `
<onlyinclude>{{Itempage
|notes       =
|itemname    = Red Dragonscale Armor
|lucy_img_ID = 621
|statsblock  =
MAGIC ITEM<br>
Slot: CHEST<br>
AC: 21<br>
STR: +20<br>
SV FIRE: +10  SV MAGIC: +10<br>
WT: 2.5  Size: LARGE<br>
Class: WAR PAL RNG SHD BRD ROG<br>
Race: ALL<br>
|relatedquests =

* [[Red Dragonscale Armor Quest]]

}}</onlyinclude>`

const SKYCLEAVER = `
<onlyinclude>{{Itempage
|notes       = Plane of Sky Custom
|itemname    = Skycleaver
|lucy_img_ID = 568
|statsblock  =
Lore Equipped, No Trade<br>
Slot: PRIMARY<br>
Class: BER<br>
Race: ALL<br>
Skill: 2H Slashing  Atk Delay: 35<br>
DMG: 30  Dmg Bon: 24<br>
STA: +5  DEX: +10<br>
SV DISEASE: +5<br>
WT: 8.0  Size: GIANT<br>
Combat Effect: Haste (Req Level 30)<br>
|relatedquests =
*Berserker Test of Sharpness
}}</onlyinclude>`

const DJARNS_RING = `
<onlyinclude>{{Itempage
|notes       = {{Item Lore Missing}}
|itemname    = Djarns Amethyst Ring
|lucy_img_ID = 612
|statsblock  =
MAGIC ITEM  LORE ITEM<br>
Slot: FINGER<br>
AGI: +9  HP: +80<br>
WT: 0.1  Size: TINY<br>
Class: ALL<br>
Race: ALL<br>
|focus_effect = Spell Haste II
|dropsfrom =

[[Nagafen's Lair]]

* [[Efreeti Lord Djarn]]

}}</onlyinclude>`

const LONG_ROAD_BOOTS = `
<onlyinclude>{{Itempage
|notes       = Lore: Good enough for one more adventure <br>
Note: This item can be augmented (not currently displayed here)
|itemname    = Boots of the Long Road
|lucy_img_ID = 633
|statsblock  =
No Trade  <br>
Slot: FEET<br>
AC: 4<br>
HP: 5<br>
WT: 1.5  Size: SMALL<br>
Class: ALL<br>
Race: ALL<br>
Click Effect: Spirit of the Traveler (Must Equip)
Slot: Ornamentation: empty<br>
Cast Time: Instant<br>
Cooldown: 10 seconds
|dropsfrom = None
}}</onlyinclude>`

test('Red Dragonscale Armor: the full armor window — flags, slot, AC, attribute, saves, classes', () => {
  const k = parseItemWikitext('Red Dragonscale Armor', RED_DRAGONSCALE)
  const s = k.stats
  assert.ok(s)
  assert.deepEqual(s.flags, ['Magic Item'])
  assert.equal(s.slot, 'CHEST')
  assert.equal(s.ac, 21)
  assert.deepEqual(s.stats, [{ key: 'STR', value: '+20' }])
  assert.deepEqual(s.saves, [
    { key: 'SV FIRE', value: '+10' },
    { key: 'SV MAGIC', value: '+10' }
  ])
  assert.equal(s.weight, '2.5')
  assert.equal(s.size, 'LARGE')
  assert.deepEqual(s.classes, ['WAR', 'PAL', 'RNG', 'SHD', 'BRD', 'ROG'])
  assert.deepEqual(s.races, ['ALL'])
  assert.equal(k.iconId, 621)
  // Nothing unmodeled slipped through, and no socket rows were invented.
  assert.deepEqual(s.extras, [])
  assert.deepEqual(s.exaltationSlots, [])
})

test('Skycleaver: weapon line pairs (Skill/Atk Delay, DMG/Dmg Bon) + a Combat Effect', () => {
  const k = parseItemWikitext('Skycleaver', SKYCLEAVER)
  const s = k.stats
  assert.ok(s)
  assert.deepEqual(s.flags, ['Lore Equipped', 'No Trade'])
  assert.equal(s.skill, '2H Slashing')
  assert.equal(s.atkDelay, 35)
  assert.equal(s.dmg, 30)
  assert.equal(s.dmgBonus, 24)
  assert.deepEqual(s.stats, [
    { key: 'STA', value: '+5' },
    { key: 'DEX', value: '+10' }
  ])
  assert.deepEqual(s.effects, [{ kind: 'combat', name: 'Haste', detail: 'Req Level 30', reqLevel: 30 }])
  // "Lore Equipped" counts as the LORE flag for the knowledge card.
  assert.equal(k.lore, true)
  assert.equal(damageRatio(s.dmg, s.atkDelay)?.toFixed(2), '0.86')
})

test("Djarn's Amethyst Ring: |focus_effect lives outside the stats block, still an effect row", () => {
  const k = parseItemWikitext("Djarn's Amethyst Ring", DJARNS_RING)
  const s = k.stats
  assert.ok(s)
  assert.deepEqual(s.flags, ['Magic Item', 'Lore Item'])
  assert.equal(s.slot, 'FINGER')
  assert.deepEqual(s.stats, [
    { key: 'AGI', value: '+9' },
    { key: 'HP', value: '+80' }
  ])
  assert.deepEqual(s.effects, [{ kind: 'focus', name: 'Spell Haste II' }])
})

test('Boots of the Long Road: click effect + the one page that states an exaltation socket', () => {
  const k = parseItemWikitext('Boots of the Long Road', LONG_ROAD_BOOTS)
  const s = k.stats
  assert.ok(s)
  assert.deepEqual(s.flags, ['No Trade'])
  assert.equal(s.slot, 'FEET') // the socket line does NOT overwrite the equip slot
  assert.deepEqual(s.exaltationSlots, [{ type: 'Ornamentation', empty: true }])
  assert.equal(s.effects.length, 1)
  assert.equal(s.effects[0].kind, 'click')
  assert.equal(s.effects[0].name, 'Spirit of the Traveler')
  assert.deepEqual(
    s.stats.map((x) => x.key),
    ['HP', 'CAST TIME', 'COOLDOWN']
  )
})

test('effect kind falls back to the parenthetical when the key is a bare "Effect:"', () => {
  const worn = parseStatsBlock('Effect: [[Serpent Sight]] (Worn)<br>')
  assert.deepEqual(worn.effects, [{ kind: 'worn', name: 'Serpent Sight', detail: 'Worn' }])
  const combat = parseStatsBlock('Effect:  [[Dismiss Undead]] (Combat, Casting Time: Instant) at Level 20<br>')
  assert.deepEqual(combat.effects, [
    { kind: 'combat', name: 'Dismiss Undead', detail: 'Combat, Casting Time: Instant', reqLevel: 20 }
  ])
  // A piped link whose label is a <span> still resolves to the plain effect name.
  const span = parseStatsBlock(
    "Effect:  [[Dismiss Summoned|<span class='itemeff'>Dismiss Summoned</span>]] (Combat, Casting Time: Instant) at Level 45<br>"
  )
  assert.equal(span.effects[0].name, 'Dismiss Summoned')
  assert.equal(span.effects[0].reqLevel, 45)
})

test('unrecognized stat-block text is preserved verbatim, never dropped or guessed', () => {
  const s = parseStatsBlock('Slot: PRIMARY<br>Some unmodeled note about this item<br>')
  assert.equal(s.slot, 'PRIMARY')
  assert.deepEqual(s.flags, ['Some unmodeled note about this item'])
  const s2 = parseStatsBlock('mystery text AC: 12<br>')
  assert.equal(s2.ac, 12)
  assert.deepEqual(s2.extras, ['mystery text'])
})

test('item tier: read from the +N name only — a base name is UNKNOWN, not tier 0', () => {
  assert.equal(itemTierFromName('Cloak of Flames +4'), 4)
  assert.equal(itemTierFromName('Brutish Breastplate +5'), 5)
  assert.equal(itemTierFromName('Cloak of Flames'), undefined)
})

test('tier rules match the wiki tables (Item Upgrade System / Exaltations)', () => {
  // "Exp to Next Level" column: 2^tier. Tier 1 -> 2 (the screenshot "Tier 1  0 / 2"),
  // Tier 7 -> 128 (the screenshot "Tier 7  3 / 128"). Max tier has no next.
  assert.equal(expToNextTier(0), 1)
  assert.equal(expToNextTier(1), 2)
  assert.equal(expToNextTier(7), 128)
  assert.equal(expToNextTier(10), null)
  // +10% cumulative per tier.
  assert.equal(tierBonusPct(3), 30)
  // Sockets unlock +0 Ornamentation, +1 Focus, +2 Click, +3 Worn, +4 Proc — which is why
  // a Tier 1 window shows 2 socket rows and a Tier 7 window shows all 5.
  assert.deepEqual(
    unlockedExaltationSlots(1).map((x) => x.type),
    ['Ornamentation', 'Focus']
  )
  assert.equal(unlockedExaltationSlots(7).length, 5)
  assert.equal(unlockedExaltationSlots(0).length, 1)
})

test('statLabel spells attributes out the way the item window does', () => {
  assert.equal(statLabel('STR'), 'Strength')
  assert.equal(statLabel('WIS'), 'Wisdom')
  assert.equal(statLabel('SV FIRE'), 'SV Fire')
  assert.equal(statLabel('HP'), 'HP')
})

// =================================================================================
// TRADESKILL FIELDS (Task #61): `|recipes` (what CONSUMES this item) + `|playercrafted`
// (how the item is itself made) — the answer for the "QUEST ITEM flag but no quest exists
// anywhere on the wiki" family, which are really recipe components.
//
// Fixtures are VERBATIM {{Itempage}} wikitext fetched from eqlwiki.com on 2026-08-02 via
// action=parse&prop=wikitext. The `|recipes` / `|playercrafted` / `|statsblock` fields are
// byte-for-byte as served; only the long `|dropsfrom` mob lists are trimmed (same treatment
// as the fixtures above).
//   - Gnome Meat      — QUEST ITEM flag, zero quests, ONE recipe (Baking, Gnome Kabobs 56)
//   - Spider Legs     — QUEST ITEM flag, zero quests, FOUR recipes across TWO tradeskills
//   - Skewers         — the one page carrying BOTH fields: crafted two ways, used four ways
//   - Gnome Kabobs    — a craft RESULT: yield, container, ingredient rows with {{SmIcon}}
//   - Pickled Troll   — a second craft result (Baking 51)
// =================================================================================

// The BASE record the whole-ItemKnowledge helpers need around a parse result.
const BASE = { name: 'x', lore: false, quest: false, questUses: [], cached: false }

const GNOME_MEAT = `
<onlyinclude>{{Itempage
|notes       =
|itemname    = Gnome Meat
|lucy_img_ID = 817
|statsblock  =
QUEST ITEM<br>
WT: 1.0  Size: SMALL<br>
Class: ALL<br>
Race: ALL<br>
|dropsfrom =

[[Befallen]]

* [[a necro theurgist]]

|recipes =

* [[Baking]]
** [[Gnome Kabobs]] (Trivial: 56)

}}</onlyinclude>`

const SPIDER_LEGS = `
<onlyinclude>{{Itempage
|notes       =
|itemname    = Spider Legs
|lucy_img_ID = 1089
|statsblock  =
QUEST ITEM<br>
WT: 0.5  Size: SMALL<br>
Class: ALL<br>
Race: ALL<br>
|dropsfrom =

[[Butcherblock Mountains]]

* [[a large spider]]

|recipes =

* [[Brewing]]
** [[Gnomish Spirits]] (Trivial: 102)
** [[Halas Heater]] (Trivial: 135)
* [[Baking]]
** [[Wooly Spider Crunchies]] (Trivial: 46)
** [[Candied Spider]] (Trivial: 88)

}}</onlyinclude>`

const SKEWERS = `{{Classic Era}}
<onlyinclude>{{Itempage
|notes       =
|itemname    = Skewers
|lucy_img_ID = 1012
|statsblock  =
WT: 0.1  Size: SMALL<br>
Class: ALL<br>
Race: ALL<br>
|playercrafted =

* [[Blacksmithing]] (Trivial: 38)
** '''Yield: Skewers''' x1
** In [[Forge]]:
:: {{SmIcon|1031}} 1 x [[Metal Bits]] - Crafted
:: {{SmIcon|1151}} 1 x [[Skewer Mold]] - Bought
:: {{SmIcon|584}} 1 x [[Water Flask]] - Foraged, Crafted, Summoned, Bought, Quested, Dropped

* [[Pottery]] (Trivial: 17)
** '''Yield: Skewers''' x1
** In [[Kiln]]:
:: {{SmIcon|1036}} 1 x [[Quality Firing Sheet]] - Bought
:: {{SmIcon|1034}} 1 x [[Unfired Skewers]] - Crafted

|recipes =

* [[Tinkering]]
** [[Compass]] (Trivial: 50)
* [[Baking]]
** [[Gnome Kabobs]] (Trivial: 56)
** [[Lizard-on-a-Stick]] (Trivial: 56)
** [[Rat Kabobs]] (Trivial: 26)
* [[Blacksmithing]]
** [[Smoker]] (Trivial: 50)

}}</onlyinclude>`

const GNOME_KABOBS = `
<onlyinclude>{{Itempage
|notes       =
|itemname    = Gnome Kabobs
|lucy_img_ID = 1009
|statsblock  =
DEX: +2  INT: +2<br>
This is a meal!<br>
WT: 0.1  Size: SMALL<br>
Class: ALL<br>
Race: ALL<br>
|playercrafted =

* [[Baking]] (Trivial: 56)
** '''Yield: Gnome Kabobs''' x2
** In [[Oven]]:
:: {{SmIcon|817}} 1 x [[Gnome Meat]] - Dropped
:: {{SmIcon|696}} 1 x [[Jug of Sauces]] - Bought
:: {{SmIcon|1012}} 1 x [[Skewers]] - Crafted, Returned on Failure, Returned on Success
:: {{SmIcon|881}} 1 x [[Spices]] - Bought


}}</onlyinclude>`

const PICKLED_TROLL = `
<onlyinclude>{{Itempage
|notes       =
|itemname    = Pickled Troll
|lucy_img_ID = 1018
|statsblock  =
This is a meal!<br>
WT: 0.1  Size: SMALL<br>
Class: ALL<br>
Race: ALL<br>
|playercrafted =

* [[Baking]] (Trivial: 51)
** '''Yield: Pickled Troll''' x2
** In [[Oven]]:
:: {{SmIcon|696}} 1 x [[Jug of Sauces]] - Bought
:: {{SmIcon|817}} 1 x [[Troll Parts]] - Dropped
:: {{SmIcon|1006}} 1 x [[Vinegar]] - Bought


}}</onlyinclude>`

test('Gnome Meat: QUEST ITEM with no quest anywhere — the recipe is the answer', () => {
  const k = parseItemWikitext('Gnome Meat', GNOME_MEAT)
  assert.equal(k.quest, true) // the stats-block flag is real…
  assert.equal(k.questUses.length, 0) // …but the wiki knows no quest for it
  assert.deepEqual(k.recipes, [{ recipe: 'Gnome Kabobs', tradeskill: 'Baking', trivial: 56 }])
  assert.equal(k.recipesNote, undefined)
  // It is not itself crafted, so nothing is claimed about that.
  assert.equal(k.playerCrafted, undefined)
  assert.equal(k.craftedBy, undefined)
  assert.equal(k.craftedNote, undefined)
  assert.equal(recipeUseLabel(k.recipes![0]), 'Gnome Kabobs (Baking 56)')
})

test('Spider Legs: four recipes across two tradeskills, each grouped under its heading', () => {
  const k = parseItemWikitext('Spider Legs', SPIDER_LEGS)
  assert.equal(k.questUses.length, 0)
  assert.deepEqual(k.recipes, [
    { recipe: 'Gnomish Spirits', tradeskill: 'Brewing', trivial: 102 },
    { recipe: 'Halas Heater', tradeskill: 'Brewing', trivial: 135 },
    { recipe: 'Wooly Spider Crunchies', tradeskill: 'Baking', trivial: 46 },
    { recipe: 'Candied Spider', tradeskill: 'Baking', trivial: 88 }
  ])
})

test('Skewers: the one page with BOTH fields — crafted two ways, used in four recipes', () => {
  const k = parseItemWikitext('Skewers', SKEWERS)
  // |recipes — what consumes it
  assert.deepEqual(
    (k.recipes ?? []).map(recipeUseLabel),
    [
      'Compass (Tinkering 50)',
      'Gnome Kabobs (Baking 56)',
      'Lizard-on-a-Stick (Baking 56)',
      'Rat Kabobs (Baking 26)',
      'Smoker (Blacksmithing 50)'
    ]
  )
  // |playercrafted — how it's made. Two independent recipes, each with its own container.
  assert.equal(k.playerCrafted, true)
  assert.equal(k.craftedBy?.length, 2)
  const [smith, pottery] = k.craftedBy!
  assert.equal(smith.tradeskill, 'Blacksmithing')
  assert.equal(smith.trivial, 38)
  assert.equal(smith.container, 'Forge')
  assert.equal(smith.yieldItem, 'Skewers')
  assert.equal(smith.yieldQty, 1)
  assert.deepEqual(smith.ingredients, [
    { name: 'Metal Bits', qty: 1, sources: ['Crafted'] },
    { name: 'Skewer Mold', qty: 1, sources: ['Bought'] },
    {
      name: 'Water Flask',
      qty: 1,
      sources: ['Foraged', 'Crafted', 'Summoned', 'Bought', 'Quested', 'Dropped']
    }
  ])
  assert.equal(pottery.tradeskill, 'Pottery')
  assert.equal(pottery.trivial, 17)
  assert.equal(pottery.container, 'Kiln')
  assert.deepEqual(
    pottery.ingredients.map((i) => i.name),
    ['Quality Firing Sheet', 'Unfired Skewers']
  )
  assert.equal(craftedByLabel({ ...BASE, ...k }), 'Blacksmithing 38 (Forge) · Pottery 17 (Kiln)')
})

test('Gnome Kabobs: a craft RESULT — yield x2, oven, four ingredients, {{SmIcon}} dropped', () => {
  const k = parseItemWikitext('Gnome Kabobs', GNOME_KABOBS)
  assert.equal(k.playerCrafted, true)
  assert.equal(k.recipes, undefined) // nothing consumes it — it IS the meal
  assert.equal(k.craftedBy?.length, 1)
  const c = k.craftedBy![0]
  assert.deepEqual(
    { tradeskill: c.tradeskill, trivial: c.trivial, container: c.container, yieldItem: c.yieldItem, yieldQty: c.yieldQty },
    { tradeskill: 'Baking', trivial: 56, container: 'Oven', yieldItem: 'Gnome Kabobs', yieldQty: 2 }
  )
  assert.deepEqual(c.ingredients, [
    { name: 'Gnome Meat', qty: 1, sources: ['Dropped'] },
    { name: 'Jug of Sauces', qty: 1, sources: ['Bought'] },
    { name: 'Skewers', qty: 1, sources: ['Crafted', 'Returned on Failure', 'Returned on Success'] },
    { name: 'Spices', qty: 1, sources: ['Bought'] }
  ])
  assert.equal(craftedByLabel({ ...BASE, ...k }), 'Baking 56 (Oven)')
})

test('Pickled Troll: the Troll Parts sink — Baking 51, ingredients in page order', () => {
  const k = parseItemWikitext('Pickled Troll', PICKLED_TROLL)
  assert.equal(k.playerCrafted, true)
  assert.equal(k.craftedBy![0].trivial, 51)
  assert.deepEqual(
    k.craftedBy![0].ingredients.map((i) => i.name),
    ['Jug of Sauces', 'Troll Parts', 'Vinegar']
  )
})

test('a non-tradeskill |playercrafted stays PROSE — playerCrafted is never inferred', () => {
  // Coin of Tash's field is literally `* Non-Tradeskill (Quest)`: no link, no tradeskill.
  const k = parseItemWikitext('Coin of Tash', COIN_OF_TASH)
  assert.equal(k.playerCrafted, undefined)
  assert.equal(k.craftedBy, undefined)
  assert.equal(k.craftedNote, 'Non-Tradeskill (Quest)')
  assert.equal(craftedByLabel({ ...BASE, ...k }), 'Non-Tradeskill (Quest)')
})

test('parseRecipeUses: flat list (no ** level) reads as bare recipes; prose falls back', () => {
  const flat = parseRecipeUses('* [[Rat Kabobs]] (Trivial: 26)\n* [[Bandages]]')
  assert.deepEqual(flat.recipes, [{ recipe: 'Rat Kabobs', trivial: 26 }, { recipe: 'Bandages' }])
  assert.equal(flat.note, undefined)
  assert.equal(recipeUseLabel(flat.recipes[1]), 'Bandages') // no tradeskill/trivial ⇒ bare name
  // A piped link keeps the page, displays the label.
  const piped = parseRecipeUses('* [[Baking]]\n** [[Misty Thicket Picnic|Picnic]] (Trivial: 122)')
  assert.deepEqual(piped.recipes, [
    { recipe: 'Picnic', page: 'Misty Thicket Picnic', tradeskill: 'Baking', trivial: 122 }
  ])
  // Freeform text with no links is never structured — it becomes the prose note.
  const prose = parseRecipeUses('See the tradeskill page for combines.')
  assert.deepEqual(prose.recipes, [])
  assert.equal(prose.note, 'See the tradeskill page for combines.')
})

test('parseCraftRecipes: an ingredient row without a source list keeps just name + qty', () => {
  const r = parseCraftRecipes('* [[Baking]]\n** In [[Oven]]:\n:: {{SmIcon|1}} 2 x [[Bear Meat]]')
  assert.deepEqual(r.recipes, [
    {
      tradeskill: 'Baking',
      container: 'Oven',
      ingredients: [{ name: 'Bear Meat', qty: 2 }]
    }
  ])
})

test('recipes do NOT make an item notable — that predicate drives the push surfaces', () => {
  const k = { ...BASE, ...parseItemWikitext('Skewers', SKEWERS) }
  assert.equal((k.recipes ?? []).length > 0, true)
  assert.equal(isNotableKnowledge(k), false) // no lore, no quest flag ⇒ still not a "pickup"
  // Gnome Meat IS notable (its stats block says QUEST ITEM) — and now it has an answer.
  const meat = { ...BASE, ...parseItemWikitext('Gnome Meat', GNOME_MEAT) }
  assert.equal(isNotableKnowledge(meat), true)
  assert.equal(meat.questUses.length, 0)
  assert.equal((meat.recipes ?? []).length, 1)
})

// --- the tradeskill-only view rule (Task #62) ---------------------------------------
//
// The gap the predicate closes: Gnome Meat passes `isNotableKnowledge` purely on its stats
// block's QUEST ITEM flag while no quest in either local catalog uses it. That is what put
// ingredients in the pickups strip and the event-log overlay; this rule takes them back out.

test('isTradeskillOnly: an ingredient nothing quests for is hidden; anything quest-bound is not', () => {
  const meat = { ...BASE, ...parseItemWikitext('Gnome Meat', GNOME_MEAT) }
  assert.equal(isTradeskillOnly(meat), true) // recipes, no quest use, no lore ⇒ ingredient

  // A quest use ALWAYS wins, whatever the recipes say — including a posky (Plane of Sky) one,
  // which is a quest use like any other, so a Sky drop can never read as tradeskill-only.
  assert.equal(
    isTradeskillOnly({ ...meat, questUses: [{ quest: 'Corrupt Guards', source: 'quests', role: 'required' }] }),
    false
  )
  assert.equal(
    isTradeskillOnly({ ...meat, questUses: [{ quest: 'Warrior · Test of Blood', source: 'posky' }] }),
    false
  )
  // LORE is its own reason to surface an item.
  assert.equal(isTradeskillOnly({ ...meat, lore: true }), false)
  // No recipes at all ⇒ not an ingredient. Vendor trash and unresolved items stay visible;
  // hiding on absence of knowledge would hide everything the wiki hasn't answered for.
  assert.equal(isTradeskillOnly({ ...BASE, quest: true }), false)
  assert.equal(isTradeskillOnly({ ...BASE, offline: true }), false)
})
