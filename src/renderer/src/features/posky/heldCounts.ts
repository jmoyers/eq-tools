// THE one place held counts derive from loot history (Tasks #40/#42/#47). Both quest
// progress and inventory reconcile consume this map; the golden-window loot tests
// (tests/lootDispositionWindows.test.mts) import it directly so the asserted rule IS the
// production rule.
//
// Disposition rules:
//   undefined  — ordinary kept loot → held.
//   'currency' — stored in the currency tab (Wind Runes) → held (quest-countable).
//   'hoard'    — stored in the Dragon Hoard (bank-type storage) → held.
//   'depot'    — stored in the tradeskill depot (bank-type storage) → held.
//   'sold'     — auto-vendored the instant it dropped → GONE, never held; skipping it
//      here also keeps reconcile from ever subtracting a never-held item downstream.
//   'combined' — the looted copy merged with an ALREADY-HELD copy to create the upgraded
//      `created` item (`… to create a <item> +N`). Net-ZERO on the counting key: the
//      counting key strips ` +N` (Task #42), so consumed base, consumed held copy, and
//      created upgrade all share one key — loot +1, consume 2, create 1 nets 0, and the
//      held copy stays counted by its own earlier loot row. Skipping the row is exactly
//      that net-zero (verified: all 293 real combine lines create `<same base> +N`).
//
// Stack counts (Task #47): `--You have looted 2 Bone Chips …--` is TWO items — counted
// rows add `count`, not 1.

import type { LootEvent } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'

/** Fold loot history into held counts keyed by the normalized counting key. */
export function computeHeldCounts(lootHistory: readonly LootEvent[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const e of lootHistory) {
    if (e.disposition === 'sold' || e.disposition === 'combined') continue
    // Fold +N variants onto the base counting key (Task #42): `Sphinx Claw` and
    // `Sphinx Claw +1` are two of the same held item for quest purposes.
    const k = itemCountKey(e.item)
    c[k] = (c[k] ?? 0) + (e.count ?? 1)
  }
  return c
}
