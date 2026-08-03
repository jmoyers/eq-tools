// ZoneStrip — who you are and where you are, in one line.
//
// The zone comes from the CHARACTER module, not from `CombatSnapshot.zone`. Both are the same
// fact from the same `You have entered X.` line, but the character module is the designated
// "who am I / where am I" owner and it arrives over the delta transport rather than a poll
// (docs/plans/overview-tab.md §3.3).
//
// THE ZONE STRING IS RENDERED RAW (law 2 — canonicalize at boundaries, display raw). The
// instance-tier decoder (`zoneTier` / `TIER_LABELS`) lives in `src/main/log/parseWorld.ts` and is
// main-only; the renderer must not import from `src/main` and must not re-implement it. A tier
// chip here is a clean follow-up that STARTS by moving those two into `src/shared/` — explicitly
// not done here.

import type { JSX } from 'react'
import { Paper, Stack, Typography } from '@mui/material'
import PlaceIcon from '@mui/icons-material/Place'
import type { CharacterDelta, CharacterSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'

export function ZoneStrip(): JSX.Element {
  const who = useModule<CharacterSnap, CharacterDelta>('character', (s, d) => ({ ...s, ...d }))
  return (
    <Paper variant="outlined" sx={{ px: 1.25, py: 0.75, flexShrink: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
        <PlaceIcon sx={{ fontSize: 16, color: 'text.disabled', flexShrink: 0 }} />
        <Typography variant="body2" noWrap data-testid="overview-zone" sx={{ fontWeight: 600, minWidth: 0 }}>
          {/* A zone we have not seen a line for is left UNSAID, never guessed. */}
          {who?.zone ?? '—'}
        </Typography>
        {who?.character && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
            {who.character.name} · {who.character.server}
          </Typography>
        )}
      </Stack>
    </Paper>
  )
}
