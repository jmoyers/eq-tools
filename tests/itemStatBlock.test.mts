// ITEM-WINDOW STAT BLOCK TEST — the pure `statsblock` text → structured fields parse that
// draws the game's item description window (src/shared/itemStats.ts), plus the item
// level/tier + exaltation-socket rules derived from the wiki's own tables.
//
// Split out of tests/itemLookup.test.mts, which had grown past the 400-code-line factoring
// ceiling. Not one assertion moved or changed: the file was cut along the seams its own
// section banners already drew, and this half is the stat-block half.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseItemWikitext } from '../src/main/itemLookupParse'
import {
  parseStatsBlock,
  damageRatio,
  expToNextTier,
  itemTierFromName,
  statLabel,
  tierBonusPct,
  unlockedExaltationSlots
} from '../src/shared/itemStats'

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
