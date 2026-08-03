// ComboCard — "which three classes am I running", at a glance.
//
// The CURRENT interval only. The history and the correction editor live in Preferences →
// Profiles (ClassComboPanel); this card is the glance, exactly like LevelingCard shows one rate
// and links to the tab that owns the charts. It takes no navigation callback on purpose — there
// is no Loadout tab to route to, and inventing one for a four-line card would be the tail
// wagging the router.
//
// IT IS MOUNTED INSIDE THE NOW ROW'S HYDRATION GATE. Mid-replay the "current" interval is
// whatever the log had reached a few seconds ago, which during startup is an arbitrary point in
// your past — the same lie the DPS card's gate exists to prevent.
//
// EVERY UNKNOWN STAYS UNKNOWN. An ambiguous slot renders as its candidate set and an unknown one
// as an em-dash; the `inferred` chip is present whenever any slot is inference, which — the log
// having exactly eleven /who rows in 1.1M lines — is nearly always.

import type { JSX } from 'react'
import { Stack, Typography } from '@mui/material'
import type { ComboSnap } from '@shared/classCombo'
import { DashCard, QuietNote } from '../combat/combatShared'
import { ConfidenceChip, LockedChip, ProvenanceChip, SlotChips } from '../profiles/ClassComboChips'
import { spanText, startFuzzText } from '../profiles/ClassComboLabels'

export interface ComboCardProps {
  snap: ComboSnap
}

export function ComboCard({ snap }: ComboCardProps): JSX.Element {
  const current = snap.current
  return (
    <DashCard title="Class loadout" testId="overview-combo">
      {!current ? (
        <QuietNote>
          {snap.ready
            ? 'No loadout read yet — one appears as soon as the log names classes you played.'
            : 'No class knowledge available in this build, so the loadout cannot be read.'}
        </QuietNote>
      ) : (
        <>
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
            <SlotChips slots={current.slots} />
            <ProvenanceChip interval={current} />
            <ConfidenceChip interval={current} />
            {current.userLocked && <LockedChip />}
          </Stack>
          <Typography
            variant="caption"
            color="text.secondary"
            data-testid="overview-combo-span"
            title={startFuzzText(current) ?? undefined}
            noWrap
            sx={{ mt: 0.5, minWidth: 0 }}
          >
            {startFuzzText(current) ? '~ ' : ''}
            {spanText(current)}
          </Typography>
        </>
      )}
    </DashCard>
  )
}
