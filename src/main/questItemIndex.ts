// questItemIndex — the item→quests index built from the scraped wiki quest catalog
// (src/renderer/src/data/eqlegends/quests.json).
//
// Lifted OUT of itemLookup.ts so it can be unit-tested: itemLookup imports `electron`, which
// cannot load outside an Electron process, and tests/questCatalog.test.mts previously had to
// RE-IMPLEMENT this index to assert anything about it. A mirrored index proves nothing about
// the shipped one, so the real builder lives here and both sides import it.
//
// WHAT IT ADDS over a plain "item → quest name" map: a `required`-role use also carries the
// quest's REWARD item names. That closes the one-hop gap the UI needs — "you looted a Guard
// Bracelet; it's a turn-in for Corrupt Guards, which pays a Bunker Battle Blade" — without a
// second lookup. Law 1: the field exists only when the catalog names rewards.

import { normalizeItemName } from './itemLookupParse'
import type { ItemQuestUse, QuestData } from '../shared/types'

/**
 * How many reward names a `required` use carries. A handful is the whole point (the hover
 * card lists outcomes, it is not a loot table); a few quests list a dozen class-specific
 * rewards and would otherwise bloat every cached record.
 */
export const MAX_ATTACHED_REWARDS = 4

/** The index's key: the same normalization itemLookup's `cacheKey` applies. */
export function questItemKey(name: string): string {
  return normalizeItemName(name).toLowerCase()
}

/**
 * Index the quest catalog by normalized item name → the quests that use it, from BOTH sides
 * of a quest: its turn-in/collectible items (role 'required') and the items it hands out
 * (role 'reward'). This is the answer for every classic turn-in item whose own wiki page
 * never listed a quest.
 */
export function buildQuestItemIndex(data: QuestData): Map<string, ItemQuestUse[]> {
  const byItem = new Map<string, ItemQuestUse[]>()
  for (const q of data.quests) {
    // Computed once per quest, not per item: every required item of a quest shares its
    // outcome. Blank/whitespace names are dropped rather than rendered as empty chips.
    const rewardNames = (q.rewards ?? [])
      .map((r) => (r?.name ?? '').trim())
      .filter((n) => n.length > 0)
      .slice(0, MAX_ATTACHED_REWARDS)

    const add = (itemName: string, role: 'required' | 'reward'): void => {
      const key = questItemKey(itemName)
      const uses = byItem.get(key) ?? []
      if (!uses.some((u) => u.page === q.page && u.role === role)) {
        const use: ItemQuestUse = { quest: q.name, page: q.page, source: 'quests', role }
        if (q.giver) use.giver = q.giver
        if (q.startZone) use.zone = q.startZone
        // Only a TURN-IN has an outcome to name. A reward-role use IS the outcome; listing
        // the quest's rewards there would just repeat the item back to itself.
        if (role === 'required' && rewardNames.length > 0) use.rewards = [...rewardNames]
        uses.push(use)
      }
      byItem.set(key, uses)
    }

    for (const it of q.requiredItems ?? []) add(it, 'required')
    for (const r of q.rewards ?? []) add(r.name, 'reward')
  }
  return byItem
}
