// RecentKillsCard — the newest credited kills, and what each one paid.
//
// The sibling of RecentDropsCard and built to the same three rules:
//
// FIXED HEIGHT IS A CONTRACT, not styling (AGENTS.md — "a growing list lives in a FIXED-height
// scroll box"). Explicit height, its own `overflow: auto`, measured by the e2e harness. An
// append-only feed on a glance surface that sizes to its content is the Task #56 bug waiting to
// happen.
//
// NOT GATED ON HYDRATION. Kills are HISTORY: the progression module's ring is complete and
// correct during the startup replay, so a spinner over a list of real past kills would be the
// opposite lie from the one the NOW row's gate prevents.
//
// EVERY ABSENCE IS LABELED (law 1). Three different unknowns share this row and none of them may
// render as a number:
//   · no experience line accompanied the kill  → '—', tooltip says exactly that;
//   · a line came but stated no percentage (the at-the-cap shape) → '—', a DIFFERENT tooltip;
//   · the kill was credited to a bound pet     → a `pet` chip, because that credit is INFERRED
//     from pet-binding lines and never stated on the kill line. The log never names the pet
//     there either, so the chip carries no name — one is not available to carry.

import type { JSX } from 'react'
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material'
import type { ProgressionKill } from '@shared/types'
import { DashCard, QuietNote } from '../combat/combatShared'
import { formatTime } from '../../lib/formatDate'

/** The scroll box's height. Explicit, and the panel's whole size contract. */
const FEED_HEIGHT = 258

/** `expFlag` bit 2 — the joined line was the `party experience` shape. */
const EXP_PARTY = 2

export interface RecentKillsCardProps {
  rows: ProgressionKill[]
  onOpenLeveling: () => void
}

/**
 * The experience the kill paid: the RAW stated percent, or an em dash that says which unknown
 * it is. Never 0%, and never a percent we computed ourselves.
 */
function ExpCell({ row }: { row: ProgressionKill }): JSX.Element {
  if (row.expPct !== undefined) {
    return (
      <Typography variant="caption" sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
        {`+${row.expPct.toFixed(2)}%`}
      </Typography>
    )
  }
  const tip =
    row.expFlag === undefined
      ? 'No experience line accompanied this kill.'
      : 'Experience was gained, but the log stated no percentage — at the level cap there is no bar to report against.'
  return (
    <Tooltip title={tip}>
      <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
        —
      </Typography>
    </Tooltip>
  )
}

function Row({ row }: { row: ProgressionKill }): JSX.Element {
  const party = ((row.expFlag ?? 0) & EXP_PARTY) !== 0
  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      data-testid="overview-kill-row"
      sx={{ minWidth: 0, py: 0.3, px: 0.5, borderRadius: 0.5 }}
    >
      <Typography variant="caption" noWrap sx={{ minWidth: 0 }}>
        {row.name}
      </Typography>
      {row.credit === 1 && (
        <Tooltip title="Credited to a bound pet — inferred from its pet/charm lines, not stated on the kill line.">
          <Chip size="small" variant="outlined" label="pet" sx={{ height: 18, flexShrink: 0 }} />
        </Tooltip>
      )}
      <Box sx={{ flexGrow: 1 }} />
      {row.zone !== '' && (
        <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 1, minWidth: 0 }}>
          {row.zone}
        </Typography>
      )}
      {party && (
        <Tooltip title="Paid as party experience — a group-mate's kill counted toward your bar.">
          <Chip size="small" variant="outlined" label="party" sx={{ height: 18, flexShrink: 0 }} />
        </Tooltip>
      )}
      <ExpCell row={row} />
      <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
        {formatTime(row.ts)}
      </Typography>
    </Stack>
  )
}

export function RecentKillsCard({ rows, onOpenLeveling }: RecentKillsCardProps): JSX.Element {
  return (
    <DashCard
      title="Recent kills"
      right={
        <Typography
          variant="caption"
          role="button"
          tabIndex={0}
          onClick={onOpenLeveling}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onOpenLeveling()
          }}
          sx={{ color: 'primary.main', cursor: 'pointer', flexShrink: 0 }}
        >
          Leveling
        </Typography>
      }
    >
      <Box data-testid="overview-kills" sx={{ height: FEED_HEIGHT, overflow: 'auto', minWidth: 0 }}>
        {rows.length === 0 ? (
          <QuietNote>Nothing killed yet — your kills land here as you make them.</QuietNote>
        ) : (
          rows.map((row, i) => <Row key={`${String(row.ts)}|${row.name}|${String(i)}`} row={row} />)
        )}
      </Box>
    </DashCard>
  )
}
