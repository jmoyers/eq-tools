// The nested PET row — one line item inside your damage breakdown, drillable to the pet's own
// skills. Shared by the Combat tab's meter panel and the Overview DPS card so the pet reads the
// same on both (one look, one source of truth — the same rule combatShared exists for).
//
// It is deliberately a `Bar` like every other row in that list, in the pet KIND color rather
// than a damage-category color: it is not a lane of yours, it is another source, and the color
// says so. The name is the pet's REAL name (law 4 — display raw); the caption says "pet" so the
// row can never be mistaken for one of your abilities.

import type { JSX } from 'react'
import { Typography } from '@mui/material'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import { Bar, KIND_COLOR } from './combatShared'
import { formatNum, formatRate } from '../../lib/formatRate'
import type { PetRow } from './petRows'

export function PetBar({
  pet,
  pct,
  onDrill
}: {
  pet: PetRow
  pct: number
  /** Present ⇒ the row drills into the pet's own skill breakdown. */
  onDrill?: () => void
}): JSX.Element {
  return (
    <Bar
      color={KIND_COLOR.pet}
      accent={KIND_COLOR.pet}
      pct={pct}
      onClick={onDrill}
      name={
        <>
          {pet.name}
          <Typography component="span" variant="caption" sx={{ ml: 0.75, color: 'text.secondary', fontWeight: 400 }}>
            pet · {formatRate(pet.dps)}
            {pet.hits > 0 ? ` · ${pet.hits} hits` : ''}
          </Typography>
          {onDrill && (
            <ChevronRightIcon sx={{ fontSize: 13, ml: 0.25, mb: '-2px', color: 'text.disabled' }} />
          )}
        </>
      }
      right={formatNum(pet.total)}
    />
  )
}
