import { type JSX, memo } from 'react'
import { Box, Chip, Stack, TableCell, TableRow, Tooltip, Typography } from '@mui/material'
import type { ItemKnowledge, LootDisposition, LootEvent } from '@shared/types'
import { formatDateTime } from '../../lib/formatDate'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { FavoriteStar } from '../favorites/FavoriteStar'
import type { InventoryRow } from '../inventory/reconcile'
import { isQuestItem } from './lootItemData'
import { KnowledgeBadge } from './KnowledgeBadge'
import type { GroupRow } from './lootGrouping'

// Fixed dense-row height (px) for the windowed tables (MUI Table size="small").
export const ROW_HEIGHT = 37

function fmtTime(ts: number): string {
  return formatDateTime(ts, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// A subtle disposition chip (Tasks #40/#47): where a looted-and-routed item went.
// Dense, low-emphasis — no chip for ordinary kept loot. Kept storage (currency/hoard/
// depot) reads info-blue; 'sold' (gone) is dimmed; 'combined' (merged into an upgrade)
// reads success-green.
function DispositionChip({ disposition }: { disposition?: LootDisposition }): JSX.Element | null {
  if (!disposition) return null
  const sx = { height: 18, fontSize: 11 } as const
  if (disposition === 'sold') {
    return <Chip size="small" variant="outlined" color="default" label="sold" sx={{ ...sx, opacity: 0.7 }} />
  }
  if (disposition === 'combined') {
    return <Chip size="small" variant="outlined" color="success" label="combined" sx={sx} />
  }
  return <Chip size="small" variant="outlined" color="info" label={disposition} sx={sx} />
}

/**
 * The "In inventory" cell — an ESTIMATE, never a fact (world-model law 1). The number is
 * the reconciled net held count (inventory/reconcile.ts): the active count source (looted
 * log and/or the last `/outputfile inventory` export) minus everything consumed by a
 * turned-in quest. The log cannot see bank deposits, destroys, trades or vendor sales that
 * happen off-camera, so it renders as a `~` chip like every other inferred value, with the
 * inputs spelled out in the tooltip. `+N` upgrade variants pool onto the base counting key,
 * so a `Sphinx Claw` row and a `Sphinx Claw +1` row show the same pooled estimate.
 */
const InventoryEstimate = memo(function InventoryEstimate({ inv }: { inv?: InventoryRow }): JSX.Element {
  if (!inv || inv.net <= 0) return <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>
  const parts: string[] = [`${inv.log} looted`]
  if (inv.inv > 0) parts.push(`${inv.inv} in the inventory export`)
  if (inv.consumed > 0) parts.push(`${inv.consumed} turned in (${inv.consumedBy.join(', ')})`)
  return (
    <Tooltip title={`Estimate — ${parts.join(' · ')}`}>
      <Chip
        size="small"
        variant="outlined"
        label={`~${inv.net}`}
        sx={{ height: 18, fontSize: 11, cursor: 'help', color: 'text.secondary' }}
      />
    </Tooltip>
  )
})

// Memoized rows (React.memo + stable props) so a re-render that doesn't touch a
// given row's data skips it entirely (precedent: #17's combat work).
export const GroupedRow = memo(function GroupedRow({
  g,
  favorited,
  knowledge,
  inv,
  onToggleFavorite,
  onSelect
}: {
  g: GroupRow
  favorited: boolean
  knowledge?: ItemKnowledge
  inv?: InventoryRow
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}): JSX.Element {
  const posky = isQuestItem(g.item)
  return (
    <TableRow
      hover
      sx={{ cursor: 'pointer', height: ROW_HEIGHT, '& td': { py: 0 }, opacity: g.invOnly ? 0.7 : 1 }}
      onClick={() => onSelect(g.item)}
    >
      <TableCell padding="checkbox">
        <FavoriteStar name={g.item} favorited={favorited} onToggle={onToggleFavorite} />
      </TableCell>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          {/* Hover = what it is + what it's for (fetched on open); click (the row) = deep dive. */}
          <KnownItemTooltip name={g.item} knowledge={knowledge}>
            <Box component="span" sx={{ cursor: 'help' }}>
              {g.item}
            </Box>
          </KnownItemTooltip>
          {posky && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
          <KnowledgeBadge knowledge={knowledge} isPosky={posky} />
          <DispositionChip disposition={g.disposition} />
        </Stack>
      </TableCell>
      <TableCell align="right" sx={g.invOnly ? { color: 'text.disabled' } : undefined}>
        {g.invOnly ? '—' : g.count}
      </TableCell>
      <TableCell align="right">
        <InventoryEstimate inv={inv} />
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{g.topSource ?? '—'}</TableCell>
      <TableCell align="right" sx={{ color: 'text.secondary' }}>
        {g.zoneCount || '—'}
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{g.invOnly ? '—' : fmtTime(g.last)}</TableCell>
    </TableRow>
  )
})

export const FlatRow = memo(function FlatRow({
  e,
  favorited,
  knowledge,
  onToggleFavorite,
  onSelect
}: {
  e: LootEvent
  favorited: boolean
  knowledge?: ItemKnowledge
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}): JSX.Element {
  const posky = isQuestItem(e.item)
  return (
    <TableRow
      hover
      sx={{ cursor: 'pointer', height: ROW_HEIGHT, '& td': { py: 0 } }}
      onClick={() => onSelect(e.item)}
    >
      <TableCell padding="checkbox">
        <FavoriteStar name={e.item} favorited={favorited} onToggle={onToggleFavorite} />
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{fmtTime(e.ts)}</TableCell>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">
          <KnownItemTooltip name={e.item} knowledge={knowledge}>
            <Box component="span" sx={{ cursor: 'help' }}>
              {e.count && e.count > 1 ? `${e.count} × ${e.item}` : e.item}
            </Box>
          </KnownItemTooltip>
          {posky && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
          <KnowledgeBadge knowledge={knowledge} isPosky={posky} />
          <DispositionChip disposition={e.disposition} />
          {e.disposition === 'combined' && e.created && (
            <Typography variant="caption" color="text.secondary">
              → {e.created}
            </Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{e.source ?? '—'}</TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{e.zone ?? '—'}</TableCell>
    </TableRow>
  )
})
