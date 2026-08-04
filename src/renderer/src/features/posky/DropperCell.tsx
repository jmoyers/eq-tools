// DropperCell — the kill target for one Plane of Sky quest item ("for our sky tracker, we should
// also show the kill target for each item per eql wiki database", owner).
//
// Its own file so QuestAccordion stays a layout file: this is the ONE place the resolved droppers
// (poskyDroppers.ts) become words, and both surfaces that name an item — the expanded table's
// "Dropped by" column and the collapsed row's chip tooltip — read it.
//
// ONE LINE, always. Up to DROPPER_DISPLAY_CAP names inline, the rest folded into "+N more"; the
// hover carries the full roster with level and zone. Sky quest items really do drop from several
// bosses (every Efreeti weapon is Noble Dojorn AND Overseer of Air AND the Hand of Veeshan), so
// the overflow is the normal case, not an edge one.
//
// Nothing resolved ⇒ fall back to what the scrape literally said (`who`, e.g. "random drop — any
// Plane of Sky mob" on the wind runes, which is the honest answer: there is no kill target).
// Neither ⇒ render nothing at all. Never a guess.

import type { JSX } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import { dropperFacts, dropperLabel, type DropperMob } from './poskyDroppers'

export interface DropperCellProps {
  droppers: readonly DropperMob[]
  /** the posky scrape's raw `who` — shown verbatim when nothing resolved to a mob */
  who?: readonly string[]
}

export function DropperCell({ droppers, who }: DropperCellProps): JSX.Element | null {
  if (droppers.length === 0) {
    const stated = (who ?? []).join(', ')
    if (stated === '') return null
    return (
      <Typography variant="caption" color="text.secondary" data-testid="posky-dropper">
        {stated}
      </Typography>
    )
  }
  return (
    <Tooltip
      arrow
      placement="top"
      title={
        <Box>
          {droppers.map((m) => (
            <Typography key={m.page} variant="caption" display="block">
              {dropperFacts(m)}
            </Typography>
          ))}
        </Box>
      }
    >
      <Typography
        variant="caption"
        color="text.secondary"
        data-testid="posky-dropper"
        sx={{ cursor: 'help' }}
      >
        {dropperLabel(droppers)}
      </Typography>
    </Tooltip>
  )
}
