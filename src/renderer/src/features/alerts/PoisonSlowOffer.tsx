// PoisonSlowOffer — the "a rogue is slowing your mobs" strip.
//
// The auto-detected half of docs/plans/poison-slow-alerts.md: the app has WATCHED rogue slow
// poisons land in your fights (the alerts module counts `poisonProc { effect:'slow' }` over
// replay and live alike) and you have no alert that would fire on them. It says so once, and
// offers to create the same def the "Rogue slow poisons" group card creates — one id, two
// doors, so clicking either is idempotent.
//
// It never acts on its own (AGENTS.md — state, never process): Add creates the alert, Dismiss
// hides the offer for good, and nothing else happens. The dismissal shares the upgrade
// strip's localStorage set — offer ids are namespaced, and "I waved this away" is one idea.
//
// COPY RULE: no slow PERCENTAGE appears here or anywhere else in the feature. The wiki states
// both 35% and 15% for Weakening Strike and the contradiction is unresolved; the observed
// count and the 3:30 duration are the facts we actually have.

import type { JSX } from 'react'
import { Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom'
import type { AlertDef } from '@shared/types'
import type { PoisonSlowOffer as Offer } from '@shared/spellLines'
import { poisonSlowAlertDefs } from '@shared/alertGroups'

export interface PoisonSlowOfferProps {
  offers: Offer[]
  /** persist one alert (the same upsert the groups panel and the upgrade strip use). */
  onPersist: (def: AlertDef) => void
  /** hide this offer for good. */
  onDismiss: (id: string) => void
}

/** "3 slows landed" — the observation, plural-correct, with no rate and no percentage. */
function observed(n: number): string {
  return n === 1 ? '1 slow landed so far' : `${n} slows landed so far`
}

export default function PoisonSlowOffer({
  offers,
  onPersist,
  onDismiss
}: PoisonSlowOfferProps): JSX.Element | null {
  const offer = offers[0]
  if (!offer) return null
  return (
    <Paper variant="outlined" sx={{ p: 1.25, borderColor: 'primary.main' }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <HourglassBottomIcon fontSize="small" color="primary" />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Rogue slows are landing in your fights — alert when a mob gets slowed?
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
          {observed(offer.count)} · most recently on {offer.lastTarget}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Creates the “Rogue slow poisons” alert — Weakening Strike, 3:30, rate-limited to about one nudge per pull">
          <span>
            <Button
              size="small"
              variant="contained"
              onClick={() => {
                for (const def of poisonSlowAlertDefs()) onPersist(def)
              }}
            >
              Add alert
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="Dismiss">
          <IconButton size="small" onClick={() => onDismiss(offer.id)}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Paper>
  )
}
