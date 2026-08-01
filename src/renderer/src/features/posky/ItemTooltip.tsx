import type { ReactElement } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'

export interface ItemTooltipProps {
  name: string
  stats?: string
  who?: string[]
  where?: string
  children: ReactElement
}

/** An EverQuest-style item popover (dark box, gold border) shown on hover. */
export function ItemTooltip({ name, stats, who, where, children }: ItemTooltipProps): JSX.Element {
  const body = (
    <Box sx={{ fontFamily: '"Consolas","Courier New",monospace', p: 0.25, minWidth: 160 }}>
      <Typography
        component="div"
        sx={{ color: '#ffd76b', fontWeight: 700, fontSize: 13, mb: 0.5, fontFamily: 'inherit' }}
      >
        {name}
      </Typography>
      {stats ? (
        <Box sx={{ whiteSpace: 'pre-line', fontSize: 12, color: '#e9e2c9', lineHeight: 1.4 }}>{stats}</Box>
      ) : (
        <Box sx={{ fontSize: 12, color: '#c9c2a9', lineHeight: 1.4 }}>
          {where && <div>{where}</div>}
          {who && who.length > 0 && <div>Drops: {who.join(', ')}</div>}
          {!where && (!who || who.length === 0) && <div>No item details available</div>}
        </Box>
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
            bgcolor: '#12131c',
            border: '1px solid #b9932f',
            borderRadius: 1,
            maxWidth: 360,
            p: 1,
            boxShadow: 6
          }
        },
        arrow: { sx: { color: '#12131c', '&::before': { border: '1px solid #b9932f' } } }
      }}
    >
      {children}
    </Tooltip>
  )
}
