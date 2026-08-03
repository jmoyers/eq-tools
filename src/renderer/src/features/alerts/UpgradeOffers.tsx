// UpgradeOffers — the "you have levelled past this alert" strip.
//
// An alert whose trigger pins a RANK ("Mesmerization III") stops firing the moment you level
// into the next rank, and it stops SILENTLY. This strip is the only place the app says so,
// and it never acts on its own: nothing is rewritten, added or disabled without a click
// (AGENTS.md — state, never process; world-model law 1 — never silently guess).
//
// TWO ACTIONS, AND "ADD ALONGSIDE" IS THE DEFAULT (owner decision). EQ Legends runs up to
// three classes at once and you can hold several loadouts: a level-50 Paladin in one trio and
// a low-level Paladin in another. Swapping back puts you on the OLD rank, so replacing the
// alert would mute it in the other loadout. Keeping both defs is the honest default; Replace
// is the deliberate "I have abandoned that rank" action. Both preserve the alert's sound,
// volume and cooldown — the same respect-the-user rule migrateAlertSounds follows.
//
// A dismissal is per OFFER (not per alert), so a later rank re-offers cleanly.

import type { JSX } from 'react'
import { Box, Button, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import type { AlertDef } from '@shared/types'
import {
  addRankAlongsideDef,
  replaceRankInDef,
  type RankUpgradeOffer
} from '@shared/spellLines'

export interface UpgradeOffersProps {
  offers: RankUpgradeOffer[]
  /** the current alert list — the def an offer names is looked up here. */
  alerts: AlertDef[]
  /** persist one alert (add or replace both go through the same upsert). */
  onPersist: (def: AlertDef) => void
  /** hide this offer for good. */
  onDismiss: (id: string) => void
}

/** "Upgrade 3 alerts…" — plural-correct, and it counts OFFERS, which is one per spell line. */
function headline(n: number): string {
  return n === 1 ? 'One alert is behind your current rank' : `${n} alerts are behind your current ranks`
}

function OfferRow({
  offer,
  def,
  onPersist,
  onDismiss
}: {
  offer: RankUpgradeOffer
  def: AlertDef | undefined
  onPersist: (def: AlertDef) => void
  onDismiss: (id: string) => void
}): JSX.Element {
  const covered = offer.covered.length > 1 ? ` · already covered: ${offer.covered.join(', ')}` : ''
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {offer.from} → {offer.to}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
        {def ? def.name : offer.alertName}
        {covered}
      </Typography>
      <Tooltip title={`Keep "${offer.from}" and add the same alert for ${offer.to}`}>
        <span>
          <Button
            size="small"
            variant="contained"
            disabled={!def}
            onClick={() => def && onPersist(addRankAlongsideDef(def, offer.from, offer.to))}
          >
            Add alongside
          </Button>
        </span>
      </Tooltip>
      <Tooltip title={`Re-point this alert at ${offer.to} — it will no longer fire for ${offer.from}`}>
        <span>
          <Button
            size="small"
            variant="outlined"
            disabled={!def}
            onClick={() => def && onPersist(replaceRankInDef(def, offer.from, offer.to))}
          >
            Replace
          </Button>
        </span>
      </Tooltip>
      <Tooltip title="Dismiss">
        <IconButton size="small" onClick={() => onDismiss(offer.id)}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Stack>
  )
}

export default function UpgradeOffers({
  offers,
  alerts,
  onPersist,
  onDismiss
}: UpgradeOffersProps): JSX.Element | null {
  if (offers.length === 0) return null
  const byId = new Map(alerts.map((a) => [a.id, a]))
  return (
    <Paper variant="outlined" sx={{ p: 1.25, borderColor: 'primary.main' }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center">
          <TrendingUpIcon fontSize="small" color="primary" />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {headline(offers.length)}
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="caption" color="text.secondary">
            Adding keeps the old rank firing — loadout swaps go back to it.
          </Typography>
        </Stack>
        {offers.map((o) => (
          <OfferRow
            key={o.id}
            offer={o}
            def={byId.get(o.alertId)}
            onPersist={onPersist}
            onDismiss={onDismiss}
          />
        ))}
      </Stack>
    </Paper>
  )
}
