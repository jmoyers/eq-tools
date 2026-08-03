import { itemCountKey } from '../../lib/itemName'
import { getPoskyData } from '../../data'

const posky = getPoskyData()

// Names of every item required by a Plane of Sky quest (for highlighting). Keyed by the
// normalized counting key (Task #42) so an upgraded `Sphinx Claw +1` row is still flagged
// as a Sky quest item — the row keeps showing its `+N`; only the RECOGNITION is normalized.
export const questItemNames = new Set<string>(posky.quests.flatMap((q) => q.items.map((i) => itemCountKey(i.name))))

// EQ stat block per item name (quest items + rewards), for the drill-down.
export const itemStats: Record<string, string> = {}
for (const qz of posky.quests) {
  // Keyed by the normalized counting key so a `+N` variant drill-down resolves the base
  // item's stat block (Task #42).
  for (const it of qz.items) if (it.stats) itemStats[itemCountKey(it.name)] = it.stats
  if (qz.reward && qz.rewardStats) itemStats[itemCountKey(qz.reward)] = qz.rewardStats
}

export function isQuestItem(name: string): boolean {
  return questItemNames.has(itemCountKey(name))
}
