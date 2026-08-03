// overviewData — the PURE view models behind the Overview tab's recent-drops feed.
//
// No React, no MUI, no window.eq: everything here is a function of data the caller already
// holds, so `tests/overviewData.test.mts` drives it under plain node (docs/plans/overview-tab.md
// §1.2, §8).
//
// IMPORT DISCIPLINE. VALUE imports are RELATIVE, never `@shared/*` — the alias exists only
// inside the vite build, and this module is imported by the node test runner. Type-only imports
// keep the alias because tsx erases them. Same constraint, same reason, as
// `features/mobs/mobSearch.ts:33` and `features/mobs/mobZone.ts`.
//
// The three value imports are each pure + MUI-free by their own contract:
//   isNotableKnowledge — src/shared/itemKnowledge.ts (main AND renderer share it)
//   isTradeskillOnly   — lib/itemKnowledgeView.ts (lives in lib/ precisely so the MUI-free
//                        overlay bundle can use it too)
//   itemCountKey       — lib/itemName.ts (the `+N`-stripping counting key)

import type { ItemKnowledge, LootDisposition, LootEvent } from '@shared/types'
import { isNotableKnowledge } from '../../../../shared/itemKnowledge'
import { isTradeskillOnly } from '../../lib/itemKnowledgeView'
import { itemCountKey } from '../../lib/itemName'

/** One row of the recent-drops feed. Built from a LootEvent joined with what we know. */
export interface DropRow {
  /** stable React key — `${ts}|${key}|${i}` (two identical loots can share a timestamp). */
  id: string
  ts: number
  /** RAW item name exactly as looted, `+N` intact (law 2 — canonicalize at boundaries,
   *  display raw). */
  item: string
  /** `itemCountKey(item)` — the counting/knowledge key, `+N` stripped, lowercased. */
  key: string
  /** the corpse it came off, when the line named one. */
  source?: string
  zone?: string
  /** stack size when the line named one; undefined = 1. */
  count?: number
  /** currency / hoard / depot / sold / combined, when the line routed it. */
  disposition?: LootDisposition
  /** Plane of Sky turn-in item — LOCAL, instant, offline (`questItemNames`). */
  posky: boolean
  /** async item knowledge; absent until the probe lands. NEVER filled in to mean "checked". */
  knowledge?: ItemKnowledge
  /** the ONE highlight predicate — see `isHighlighted` below. */
  highlighted: boolean
}

/**
 * How many rows the feed renders. It is a GLANCE surface; the Loot tab is the ledger.
 *
 * 25 is also comfortably inside `useNotablePickups`' `PROBE_LIMIT = 40` DISTINCT items, so every
 * rendered row's knowledge is guaranteed to be probed — no row can sit permanently
 * un-highlighted merely for lack of a lookup.
 */
export const DROP_FEED_CAP = 25

/**
 * THE highlight rule, in one place.
 *
 *   posky             → a Plane of Sky turn-in item. Local, instant, offline, certain.
 *   notable knowledge → lore / QUEST ITEM flag / used by a known quest (`isNotableKnowledge`,
 *                       shared/itemKnowledge.ts — the same predicate the loot tab's pickups
 *                       strip and the main-side event feed use).
 *   MINUS tradeskill-only → an item whose stats block says QUEST ITEM but which no quest
 *                       anywhere uses is a recipe component (`isTradeskillOnly`). Every bone
 *                       chip and spider leg in the game trips the flag; highlighting them
 *                       drowns the one coin that actually starts a quest. The row still SHOWS —
 *                       only the highlight is withheld. That mirrors the events overlay
 *                       (unconditional filter) and the loot strip (default-off toggle) without
 *                       inventing a third rule.
 *
 * A row whose probe has not landed (`k` undefined) is un-highlighted and upgrades IN PLACE when
 * it does: never a flicker of a wrong claim, and never a "we checked, it's nothing" implication
 * for an item we have not checked.
 */
export function isHighlighted(posky: boolean, k?: ItemKnowledge): boolean {
  if (posky) return true
  if (!k) return false
  return isNotableKnowledge(k) && !isTradeskillOnly(k)
}

/**
 * The feed, newest-first and capped.
 *
 * `history` is the loot module's snapshot, which serves OLDEST→NEWEST; this walks the tail
 * backwards so the cap keeps the most RECENT drops and the result reads newest-first. One pass,
 * no sort — the module's order is already the log's order.
 *
 * `poskyKeys` is passed IN rather than imported: `features/loot/lootItemData.ts` reaches
 * `src/renderer/src/data/index.ts`, which JSON-imports the posky dataset and reads
 * `localStorage` for the active profile — neither of which exists under the node test runner.
 * The caller (useRecentDrops) supplies `questItemNames`; the test supplies its own set.
 */
export function buildDropRows(
  history: readonly LootEvent[],
  poskyKeys: ReadonlySet<string>,
  knowledgeByKey: ReadonlyMap<string, ItemKnowledge>
): DropRow[] {
  const first = Math.max(0, history.length - DROP_FEED_CAP)
  const rows: DropRow[] = []
  for (let i = history.length - 1; i >= first; i--) {
    const e = history[i]
    const key = itemCountKey(e.item)
    const posky = poskyKeys.has(key)
    const knowledge = knowledgeByKey.get(key)
    rows.push({
      id: `${String(e.ts)}|${key}|${String(i)}`,
      ts: e.ts,
      item: e.item,
      key,
      source: e.source,
      zone: e.zone,
      count: e.count,
      disposition: e.disposition,
      posky,
      knowledge,
      highlighted: isHighlighted(posky, knowledge)
    })
  }
  return rows
}
