import type { ReactElement } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { EQ_ITEM_COLORS, ItemWindow } from '../../lib/ItemWindow'

export interface ItemTooltipProps {
  name: string
  /** raw EQ stat-block text from the posky scrape (parsed into the game window layout) */
  stats?: string
  who?: string[]
  where?: string
  children: ReactElement
}

/**
 * The hover item popover, drawn in the game's item-window language (green name, white
 * flags, magenta effects, red ratio) via the shared ItemWindow.
 *
 * This is a HOVER surface, so it stays compact: no icon fetch, no socket chips, and the
 * knowledge we hold beyond the item window itself (drop source / island) sits BELOW a
 * hairline, visually separate from the game-style block. Items with no stat text degrade
 * to just that lower block — never a fabricated stat window.
 */
export function ItemTooltip({ name, stats, who, where, children }: ItemTooltipProps): JSX.Element {
  const extra = (where ? 1 : 0) + (who && who.length > 0 ? 1 : 0)
  const body = (
    <Box sx={{ p: 0.25, minWidth: 180 }}>
      <ItemWindow name={name} rawStats={stats} compact />
      {extra > 0 && (
        <Box sx={{ mt: 0.75, pt: 0.6, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
          {where && (
            <Typography sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11, lineHeight: 1.4 }}>{where}</Typography>
          )}
          {who && who.length > 0 && (
            <Typography sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11, lineHeight: 1.4 }}>
              Drops: {who.join(', ')}
            </Typography>
          )}
        </Box>
      )}
      {!stats && extra === 0 && (
        <Typography sx={{ color: EQ_ITEM_COLORS.label, fontSize: 11, mt: 0.5 }}>No item details available</Typography>
      )}
    </Box>
  )

  return (
    <Tooltip
      title={body}
      arrow
      placement="top"
      enterDelay={150}
      slotProps={{
        tooltip: {
          sx: {
            bgcolor: EQ_ITEM_COLORS.bg,
            border: `1px solid ${EQ_ITEM_COLORS.border}`,
            borderRadius: 1,
            maxWidth: 380,
            p: 1,
            boxShadow: 6
          }
        },
        arrow: { sx: { color: EQ_ITEM_COLORS.bg, '&::before': { border: `1px solid ${EQ_ITEM_COLORS.border}` } } }
      }}
    >
      {children}
    </Tooltip>
  )
}
