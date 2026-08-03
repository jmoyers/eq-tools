// The "notable pickup" predicate (Task #53), shared by main and the renderer.
//
// It used to live only in features/loot/useNotablePickups.ts, but the event-log overlay's
// feed module (main-side) needs the SAME rule — a notable loot is a feed event. One
// definition, imported by both, so the strip and the feed can never disagree about what
// counts as notable.

import type { ItemKnowledge } from './types'

/** Is a knowledge record "notable" (worth flagging / listing)? Lore, quest-flagged, or used
 *  by at least one known quest. Everything else is ordinary vendor trash. */
export function isNotableKnowledge(k: ItemKnowledge): boolean {
  return k.lore || k.quest || k.questUses.length > 0
}
