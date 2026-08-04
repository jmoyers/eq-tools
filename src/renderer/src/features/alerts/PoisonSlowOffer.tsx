// PoisonSlowOffer — the "a rogue is slowing your mobs" offer.
//
// The auto-detected half of docs/plans/poison-slow-alerts.md: the app has WATCHED rogue slow
// poisons land in your fights (the alerts module counts `poisonProc { effect:'slow' }` over
// replay and live alike) and you have no alert that would fire on them. It says so once, and
// offers to create the same def the "Rogue slow poisons" group card creates — one id, two
// doors, so clicking either is idempotent.
//
// WHERE IT LIVES (docs/plans/suggest-dialog-redesign.md §2, owner: "rogue slows should not be
// exceptional — part of add suggestion"): it is no longer a strip above the alert LIST. It is
// the first card of the suggest dialog's "From your fights" section, beside the observed spells
// it belongs with — one surface where the app volunteers alerts, ordered by what it has seen.
// The detector, the dismissal set and the def it writes are unchanged; only the mount moved.
// (The rank-upgrade strip stays in AlertsView: it edits alerts that already exist, so it
// belongs beside the list it edits.)
//
// It never acts on its own (AGENTS.md — state, never process): Add creates the alert, Dismiss
// hides the offer for good, and nothing else happens. The dismissal shares the upgrade strip's
// localStorage set — offer ids are namespaced, and "I waved this away" is one idea.
//
// COPY RULE: no slow PERCENTAGE appears here or anywhere else in the feature. The wiki states
// both 35% and 15% for Weakening Strike and the contradiction is unresolved; the observed
// count and the 3:30 duration are the facts we actually have.

import type { JSX } from 'react'
import { Box, Button, IconButton, Tooltip, Typography } from '@mui/material'
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
  return n === 1 ? '1 slow landed' : `${n} slows landed`
}

export default function PoisonSlowOffer({
  offers,
  onPersist,
  onDismiss
}: PoisonSlowOfferProps): JSX.Element | null {
  const offer = offers[0]
  if (!offer) return null
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'nowrap',
        gap: 0.75,
        px: 0.75,
        py: 0.25,
        minHeight: 30,
        borderRadius: 1,
        border: 1,
        borderColor: 'primary.main'
      }}
    >
      <HourglassBottomIcon fontSize="small" color="primary" />
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0, flexGrow: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          Rogue slows are landing in your fights
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {observed(offer.count)} · last on {offer.lastTarget}
        </Typography>
      </Box>
      <Tooltip title="Creates the “Rogue slow poisons” alert — Weakening Strike, 3:30, rate-limited to about one nudge per pull">
        <Button
          size="small"
          variant="contained"
          sx={{ flexShrink: 0, py: 0, minHeight: 22, fontSize: '0.7rem' }}
          onClick={() => {
            for (const def of poisonSlowAlertDefs()) onPersist(def)
          }}
        >
          Add alert
        </Button>
      </Tooltip>
      <Tooltip title="Dismiss">
        <IconButton size="small" sx={{ flexShrink: 0 }} onClick={() => onDismiss(offer.id)}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  )
}
