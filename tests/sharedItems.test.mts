// SHARED-ITEMS DERIVATION TEST (Task #44): the pure "which OTHER Sky quests contend
// for each of a quest's required items" map that PoskyView renders as a "Shared
// items" section + a quiet contested-row indicator.
//
// Pins:
//   - a contested item (Sphinx Claw — required by Beastlord Test of Claw AND Paladin
//     Test of Love) appears in BOTH quests' shared sets, each pointing at the OTHER.
//   - Wind Runes (currency) are EXCLUDED: every Test turns one in, so they'd overlap
//     universally and carry no contention signal (per the user).
//   - `+N` variant normalization is respected (a synthetic `Sphinx Claw +1` requirement
//     folds onto the base and is still detected as shared).
//   - class-prefixing (sharingQuestLabel) only kicks in for quest names that repeat
//     across classes.
//   - overlap stats over the real posky.json are sane (validates the feature against data).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSharedItems,
  isCurrencyItem,
  ambiguousQuestNames,
  sharingQuestLabel
} from '../src/renderer/src/features/posky/sharedItems'
import { questKey } from '../src/renderer/src/features/posky/keys'
import { itemCountKey } from '../src/renderer/src/lib/itemName'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { PoskyQuest, PoskyItem } from '../src/shared/types'

const quests = (poskyRaw as { quests: PoskyQuest[] }).quests

function item(name: string, count = 1): PoskyItem {
  return { name, who: [], where: '', count }
}
function quest(className: string, name: string, items: PoskyItem[]): PoskyQuest {
  return { className, name, items, source: 'test' }
}

test('isCurrencyItem matches Wind Runes (any suffix) and nothing else', () => {
  assert.equal(isCurrencyItem('Wind Rune Geza'), true)
  assert.equal(isCurrencyItem('Wind Rune Meda +1'), true) // +N normalized first
  assert.equal(isCurrencyItem('Sphinx Claw'), false)
  assert.equal(isCurrencyItem('Windswept Cloak'), false) // not a rune despite prefix-ish
})

test('a contested item appears in BOTH quests, each pointing at the other', () => {
  const a = quest('Beastlord', 'Test of Claw', [item('Sphinx Claw'), item('Bear Pelt')])
  const b = quest('Paladin', 'Test of Love', [item('Sphinx Claw'), item('Golden Hilt')])
  const map = computeSharedItems([a, b])

  const sa = map.get(questKey(a))
  const sb = map.get(questKey(b))
  assert.ok(sa && sb, 'both quests have shared items')

  // A's shared list has exactly Sphinx Claw, pointing at B.
  assert.equal(sa!.length, 1)
  assert.equal(sa![0].key, itemCountKey('Sphinx Claw'))
  assert.deepEqual(sa![0].quests.map((q) => q.name), ['Test of Love'])

  // B's shared list has exactly Sphinx Claw, pointing at A.
  assert.equal(sb!.length, 1)
  assert.deepEqual(sb![0].quests.map((q) => q.name), ['Test of Claw'])

  // Non-shared items (Bear Pelt, Golden Hilt) never appear.
  assert.ok(!sa!.some((s) => s.name === 'Bear Pelt'))
})

test('Wind Runes are excluded from the shared set even when two quests share one', () => {
  const a = quest('Beastlord', 'Test of Claw', [item('Sphinx Claw'), item('Wind Rune Geza')])
  const b = quest('Paladin', 'Test of Love', [item('Golden Hilt'), item('Wind Rune Geza')])
  const map = computeSharedItems([a, b])
  // They share ONLY a Wind Rune → excluded → no shared entries at all.
  assert.equal(map.has(questKey(a)), false)
  assert.equal(map.has(questKey(b)), false)
})

test('+N variant normalization: a `Sphinx Claw +1` requirement folds onto the base', () => {
  const a = quest('Beastlord', 'Test of Claw', [item('Sphinx Claw')])
  const b = quest('Paladin', 'Test of Love', [item('Sphinx Claw +1')])
  const map = computeSharedItems([a, b])
  const sa = map.get(questKey(a))
  assert.ok(sa, 'base-claw quest sees the +1 quest as a sharer')
  assert.equal(sa![0].key, itemCountKey('Sphinx Claw'))
  assert.equal(sa![0].name, 'Sphinx Claw') // display is the normalized base
})

test('an item required by 3 quests lists both of the OTHER two under each', () => {
  const a = quest('A', 'Qa', [item('Widget')])
  const b = quest('B', 'Qb', [item('Widget')])
  const c = quest('C', 'Qc', [item('Widget')])
  const map = computeSharedItems([a, b, c])
  const sa = map.get(questKey(a))!
  assert.deepEqual(sa[0].quests.map((q) => q.name).sort(), ['Qb', 'Qc'])
})

test('class-prefix labels only ambiguous (cross-class-repeated) quest names', () => {
  const a = quest('Monk', 'Test of Body', [item('Widget')])
  const b = quest('Warrior', 'Test of Body', [item('Widget')]) // same name, different class
  const c = quest('Cleric', 'Test of Faith', [item('Widget')])
  const ambiguous = ambiguousQuestNames([a, b, c])
  assert.equal(ambiguous.has('Test of Body'), true)
  assert.equal(ambiguous.has('Test of Faith'), false)
  assert.equal(
    sharingQuestLabel({ key: questKey(a), className: 'Monk', name: 'Test of Body' }, ambiguous),
    'Monk · Test of Body'
  )
  assert.equal(
    sharingQuestLabel({ key: questKey(c), className: 'Cleric', name: 'Test of Faith' }, ambiguous),
    'Test of Faith'
  )
})

test('real posky.json: overlap stats are sane and Wind Runes never appear', () => {
  const map = computeSharedItems(quests)
  // Every listed shared item is required by ≥2 quests and is not currency.
  const contestedNames = new Set<string>()
  for (const [, list] of map) {
    for (const si of list) {
      assert.ok(si.quests.length >= 1, 'each shared item points at ≥1 other quest')
      assert.equal(isCurrencyItem(si.name), false, `${si.name} must not be currency`)
      contestedNames.add(si.name)
    }
  }
  // From the data analysis: 14 distinct contested items across 23 quests. (Task #46
  // restored the efreeti-cycle turn-in items the scraper had dropped — Brass Knuckles is
  // now shared by Beastlord Test of Claw + Monk Test of Fists, Efreeti Great Staff by
  // Berserker + Necromancer, Efreeti Standard by Berserker + Cleric, Efreeti Statuette by
  // Druid + Wizard — lifting the counts from 19 quests / 10 items.)
  assert.equal(map.size, 23, 'exactly 23 quests have ≥1 contested item')
  assert.equal(contestedNames.size, 14, 'exactly 14 distinct contested items')
  assert.ok(contestedNames.has('Sphinx Claw'), 'Sphinx Claw is a known contested item')
  assert.ok(contestedNames.has('Brass Knuckles'), 'Brass Knuckles (restored, Task #46) is contested')
})
