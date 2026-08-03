// TRADESKILL-FIELDS TEST (Task #61) — `|recipes` (what CONSUMES this item) and
// `|playercrafted` (how the item is itself made): the answer for the "QUEST ITEM flag but no
// quest exists anywhere on the wiki" family, which are really recipe components.
//
// Split out of tests/itemLookup.test.mts, which had grown past the 400-code-line factoring
// ceiling. Not one assertion moved or changed: the file was cut along the seams its own
// section banners already drew, and this half is the tradeskill half.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseItemWikitext, parseRecipeUses, parseCraftRecipes } from '../src/main/itemLookupParse'
import { craftedByLabel, isNotableKnowledge, recipeUseLabel } from '../src/shared/itemKnowledge'
// The renderer-side VIEW rule (which items the push surfaces hide). Pure + MUI-free, so it
// runs here; its only import is a type, which tsx erases.
import { isTradeskillOnly } from '../src/renderer/src/lib/itemKnowledgeView'

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
