import type { JSX } from 'react'
import { Table, TableBody, TableCell, TableHead, TableRow, Tooltip } from '@mui/material'
import type { ItemKnowledge } from '@shared/types'
import type { WindowedRows } from '../../lib/useWindowedRows'
import type { InventoryRow } from '../inventory/reconcile'
import type { GroupRow, KeyedLoot } from './lootGrouping'
import { FlatRow, GroupedRow } from './lootRows'

// The spacer rows (top/bottom) that reserve the full scroll height so only the visible
// slice of MUI rows is ever mounted — see useWindowedRows.
function PadRow({ height, colSpan }: { height: number; colSpan: number }): JSX.Element | null {
  if (height <= 0) return null
  return (
    <TableRow style={{ height }}>
      <TableCell colSpan={colSpan} sx={{ p: 0, border: 0 }} />
    </TableRow>
  )
}

/** What both tables need from the view to draw a row. */
export interface LootTableContext {
  win: WindowedRows
  isFavorite: (name: string) => boolean
  knowledgeByKey: Map<string, ItemKnowledge>
  invByKey: Map<string, InventoryRow>
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}

/**
 * The two shapes the same loot can take: one row per ITEM (with the reconciled inventory
 * estimate and the top source), or one row per EVENT — the raw ledger, newest first.
 */
export function LootTable({
  groupByItem,
  rows,
  events,
  ctx
}: {
  groupByItem: boolean
  rows: GroupRow[]
  events: KeyedLoot[]
  ctx: LootTableContext
}): JSX.Element {
  if (groupByItem) {
    return (
      <GroupedLootTable
        rows={rows}
        win={ctx.win}
        isFavorite={ctx.isFavorite}
        knowledgeByKey={ctx.knowledgeByKey}
        invByKey={ctx.invByKey}
        onToggleFavorite={ctx.onToggleFavorite}
        onSelect={ctx.onSelect}
      />
    )
  }
  return (
    <FlatLootTable
      events={events}
      win={ctx.win}
      isFavorite={ctx.isFavorite}
      knowledgeByKey={ctx.knowledgeByKey}
      onToggleFavorite={ctx.onToggleFavorite}
      onSelect={ctx.onSelect}
    />
  )
}

export function GroupedLootTable({
  rows,
  win,
  isFavorite,
  knowledgeByKey,
  invByKey,
  onToggleFavorite,
  onSelect
}: {
  rows: GroupRow[]
  win: WindowedRows
  isFavorite: (name: string) => boolean
  knowledgeByKey: Map<string, ItemKnowledge>
  invByKey: Map<string, InventoryRow>
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}): JSX.Element {
  return (
    <Table size="small" stickyHeader>
      <TableHead>
        <TableRow>
          <TableCell padding="checkbox" />
          <TableCell>Item</TableCell>
          <TableCell align="right">Times looted</TableCell>
          <Tooltip title="Estimated count still on you: the active count source minus anything consumed by a turned-in quest. Inferred, not observed — the log never sees bank deposits, trades or destroys.">
            <TableCell align="right">In inventory</TableCell>
          </Tooltip>
          <TableCell>Top source</TableCell>
          <TableCell align="right">Zones</TableCell>
          <TableCell>Last looted</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <PadRow height={win.topPad} colSpan={7} />
        {rows.slice(win.start, win.end).map((g) => (
          <GroupedRow
            key={g.key}
            g={g}
            favorited={isFavorite(g.item)}
            knowledge={knowledgeByKey.get(g.countKey)}
            inv={invByKey.get(g.countKey)}
            onToggleFavorite={onToggleFavorite}
            onSelect={onSelect}
          />
        ))}
        <PadRow height={win.bottomPad} colSpan={7} />
      </TableBody>
    </Table>
  )
}

export function FlatLootTable({
  events,
  win,
  isFavorite,
  knowledgeByKey,
  onToggleFavorite,
  onSelect
}: {
  events: KeyedLoot[]
  win: WindowedRows
  isFavorite: (name: string) => boolean
  knowledgeByKey: Map<string, ItemKnowledge>
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}): JSX.Element {
  return (
    <Table size="small" stickyHeader>
      <TableHead>
        <TableRow>
          <TableCell padding="checkbox" />
          <TableCell sx={{ width: 150 }}>Time</TableCell>
          <TableCell>Item</TableCell>
          <TableCell>From</TableCell>
          <TableCell>Zone</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        <PadRow height={win.topPad} colSpan={5} />
        {events.slice(win.start, win.end).map((e, i) => (
          <FlatRow
            key={`${e.ts}-${e.item}-${win.start + i}`}
            e={e}
            favorited={isFavorite(e.item)}
            knowledge={knowledgeByKey.get(e.countKey)}
            onToggleFavorite={onToggleFavorite}
            onSelect={onSelect}
          />
        ))}
        <PadRow height={win.bottomPad} colSpan={5} />
      </TableBody>
    </Table>
  )
}
