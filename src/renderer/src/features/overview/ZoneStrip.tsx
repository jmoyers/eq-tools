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
//
// IT IS A HEADER BAND, NOT A CARD (visual-hierarchy sweep, 2026-08-03). A border is the app's
// CARD level, and wearing one here made the Overview read as four peer boxes when it is really
// one header plus three cards. So the strip differentiates by a subtle fill on the same surface
// the cards use, with no outline of its own — the cards below keep the only borders on the page.
// (Fill is `background.paper`, not the `background.default` an INSIDE-a-card recess would use:
// this strip sits on the page background, which IS `background.default`, so that token would be
// invisible here and `action.hover` would read brighter than the cards it introduces.)

import type { JSX } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import PlaceIcon from '@mui/icons-material/Place'
import type { CharacterDelta, CharacterSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'

export function ZoneStrip(): JSX.Element {
  const who = useModule<CharacterSnap, CharacterDelta>('character', (s, d) => ({ ...s, ...d }))
  return (
    <Box sx={{ px: 1.25, py: 0.75, flexShrink: 0, borderRadius: 1, bgcolor: 'background.paper' }}>
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
    </Box>
  )
}
