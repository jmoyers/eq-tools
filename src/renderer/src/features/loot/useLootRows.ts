import { useDeferredValue, useMemo } from 'react'
import type { LootEvent } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'
import { normalizeQuery } from '../../lib/search'
import type { InventoryRow } from '../inventory/reconcile'
import { buildInvOnlyRows, filterLootEvents, groupLootRows, type GroupRow, type KeyedLoot } from './lootGrouping'

export interface LootRowsInput {
  history: LootEvent[]
  inventoryRows: InventoryRow[]
  /** The raw search box value — deferred in here, so typing never blocks on the filter. */
  query: string
  questOnly: boolean
  showInventoryOnly: boolean
  isFavorite: (name: string) => boolean
}

export interface LootRows {
  /** The filtered flat history, most recent first. */
  events: KeyedLoot[]
  /** The grouped-by-item rows (loot only) — the "unique items" count comes from here. */
  grouped: GroupRow[]
  /** What the grouped table renders: `grouped`, plus the opt-in inventory-only tail. */
  groupRows: GroupRow[]
  /** Held per the export but never looted this epoch — the toolbar chip counts these. */
  invOnlySource: InventoryRow[]
  /** countKey → reconciled inventory row, for the O(1) per-row "In inventory" estimate. */
  invByKey: Map<string, InventoryRow>
}

/**
 * Everything the Loot tables derive from the raw history + reconciled inventory. Split out
 * of the view because it is pure derivation: each step is memoized on exactly the inputs it
 * reads, so a keystroke re-runs the filter and nothing else.
 */
export function useLootRows({
  history,
  inventoryRows,
  query,
  questOnly,
  showInventoryOnly,
  isFavorite
}: LootRowsInput): LootRows {
  // Typing echoes IMMEDIATELY (the caller's local `query` state); the filter consumes a
  // DEFERRED copy so a keystroke never blocks on the filter + re-render (Task #41).
  const deferredQuery = useDeferredValue(query)
  const q = normalizeQuery(deferredQuery)

  // Precompute the lowercase + counting keys ONCE per history change (not per keystroke).
  const keyed = useMemo<KeyedLoot[]>(
    () => history.map((e) => ({ ...e, itemKey: e.item.toLowerCase(), countKey: itemCountKey(e.item) })),
    [history]
  )

  // countKey → reconciled inventory row, rebuilt ONCE per inventory change so the estimate
  // lookup stays O(1) per rendered row (the table is windowed; never scan per row).
  const invByKey = useMemo(() => {
    const m = new Map<string, InventoryRow>()
    for (const r of inventoryRows) m.set(r.key, r)
    return m
  }, [inventoryRows])

  // Every counting key that appears in loot history, so "inventory-only" means exactly
  // "held per the export but never looted this epoch".
  const lootCountKeys = useMemo(() => new Set(keyed.map((e) => e.countKey)), [keyed])

  const invOnlySource = useMemo(
    () => inventoryRows.filter((r) => r.net > 0 && !lootCountKeys.has(r.key)),
    [inventoryRows, lootCountKeys]
  )

  const events = useMemo(() => filterLootEvents({ keyed, questOnly, q }), [keyed, q, questOnly])
  const grouped = useMemo(() => groupLootRows(events, isFavorite), [events, isFavorite])

  // The opt-in inventory-only tail is kept OUT of the default view so the Loot table stays a
  // loot table; the toolbar chip says how many are hiding.
  const invOnlyRows = useMemo<GroupRow[]>(
    () => (showInventoryOnly ? buildInvOnlyRows({ source: invOnlySource, questOnly, q, isFavorite }) : []),
    [showInventoryOnly, invOnlySource, questOnly, q, isFavorite]
  )

  const groupRows = useMemo(
    () => (invOnlyRows.length === 0 ? grouped : [...grouped, ...invOnlyRows]),
    [grouped, invOnlyRows]
  )

  return { events, grouped, groupRows, invOnlySource, invByKey }
}
