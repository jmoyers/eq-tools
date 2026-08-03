import type { LootDisposition, LootEvent } from '@shared/types'
import type { InventoryRow } from '../inventory/reconcile'
import { questItemNames } from './lootItemData'

// A loot event with two precomputed keys — computed ONCE per history change so the
// per-keystroke filter is a plain substring test (never re-lowercasing thousands of rows
// on every character typed).
//   itemKey  — raw lowercase; the GROUPING identity, so `Sphinx Claw +1` keeps its own row.
//   countKey — `+N`-stripped counting key (Task #42); the join key onto quest items and
//              onto the reconciled inventory rows, which are keyed the same way.
export type KeyedLoot = LootEvent & { itemKey: string; countKey: string }

export interface GroupRow {
  /** Stable React key — the raw lowercase item name, or `inv:<countKey>` for an
   *  inventory-only row (which has no loot history to group). */
  key: string
  /** Normalized counting key — the join onto the reconciled inventory rows. */
  countKey: string
  item: string
  count: number
  last: number
  topSource?: string
  zoneCount: number
  disposition?: LootDisposition
  /** Held per the inventory export but never looted this epoch — no loot columns. */
  invOnly?: boolean
}

/** The active filters, most recent first. */
export function filterLootEvents({
  keyed,
  questOnly,
  q
}: {
  keyed: KeyedLoot[]
  questOnly: boolean
  q: string
}): KeyedLoot[] {
  let list: KeyedLoot[] = keyed
  if (questOnly) list = list.filter((e) => questItemNames.has(e.countKey))
  if (q) list = list.filter((e) => e.itemKey.includes(q))
  return [...list].reverse() // most recent first
}

interface Group {
  item: string
  countKey: string
  count: number
  last: number
  sources: Map<string, number>
  zones: Set<string>
  /** Distinct dispositions seen across the group's rows (undefined = kept). */
  dispositions: Set<LootDisposition | undefined>
}

function tallyGroups(events: KeyedLoot[]): Map<string, Group> {
  const map = new Map<string, Group>()
  for (const e of events) {
    const key = e.itemKey
    let cur = map.get(key)
    if (!cur) {
      cur = {
        item: e.item,
        countKey: e.countKey,
        count: 0,
        last: 0,
        sources: new Map(),
        zones: new Set(),
        dispositions: new Set()
      }
      map.set(key, cur)
    }
    // Stacked loots count their stack size (Task #47): "2 Bone Chips" is two items.
    cur.count += e.count ?? 1
    cur.last = Math.max(cur.last, e.ts)
    if (e.source) cur.sources.set(e.source, (cur.sources.get(e.source) ?? 0) + 1)
    if (e.zone) cur.zones.add(e.zone)
    cur.dispositions.add(e.disposition)
  }
  return map
}

export function groupLootRows(events: KeyedLoot[], isFavorite: (name: string) => boolean): GroupRow[] {
  const list: GroupRow[] = [...tallyGroups(events).entries()].map(([key, g]) => {
    const topSource = [...g.sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    // The group's dominant disposition — shown only when ALL of its rows share one, so a
    // mixed item (some kept, some sold) stays unlabeled rather than mislabeled.
    const disposition = g.dispositions.size === 1 ? [...g.dispositions][0] : undefined
    return {
      key,
      countKey: g.countKey,
      item: g.item,
      count: g.count,
      last: g.last,
      topSource,
      zoneCount: g.zones.size,
      disposition
    }
  })
  list.sort((a, b) => b.count - a.count || b.last - a.last)
  // Pin favorites to the top (stable).
  return list.sort((a, b) => Number(isFavorite(b.item)) - Number(isFavorite(a.item)))
}

/**
 * The opt-in tail of items the inventory export knows about but that were never looted this
 * epoch (bank stock, pre-epoch gear). Kept OUT of the default view so the Loot table stays a
 * loot table. Already net-desc from reconcile, so only the favorites pin re-sorts it.
 */
export function buildInvOnlyRows({
  source,
  questOnly,
  q,
  isFavorite
}: {
  source: InventoryRow[]
  questOnly: boolean
  q: string
  isFavorite: (name: string) => boolean
}): GroupRow[] {
  let list = source
  if (questOnly) list = list.filter((r) => questItemNames.has(r.key))
  if (q) list = list.filter((r) => r.name.toLowerCase().includes(q))
  const rows: GroupRow[] = list.map((r) => ({
    key: `inv:${r.key}`,
    countKey: r.key,
    item: r.name,
    count: 0,
    last: 0,
    zoneCount: 0,
    invOnly: true
  }))
  return rows.sort((a, b) => Number(isFavorite(b.item)) - Number(isFavorite(a.item)))
}
