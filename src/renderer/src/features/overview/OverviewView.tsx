// OverviewView — the at-a-glance landing surface: current DPS, the mob in front of you and
// its drops, your zone, and the recent-drops feed. A renderer-side COMPOSITION over existing
// module snapshots + the combat engine's pull-snapshot; it owns no state of its own and is
// deliberately not an EqModule (docs/plans/overview-tab.md §0).
//
// STUB (wave 1): the prop contract below is the finished one — Overview routes, it never
// navigates itself, so every destination arrives as a callback from App.tsx. Wave 2 replaces
// the body with the card grid; it does not change this shape.

import type { JSX } from 'react'
import { Paper, Stack, Typography } from '@mui/material'
import type { CombatFocus } from '../combat/combatFocus'
import type { MobTarget } from '../mobs/mobTarget'

export interface OverviewViewProps {
  /** DPS card → "Open in Combat": jump to an explicit scope + selection. */
  onOpenCombat: (f: CombatFocus) => void
  /** Mob card → the app-wide mob detail router (Mobs tab), seeded with what we already hold. */
  onOpenMob: (t: MobTarget) => void
  /** Drops feed → "All loot": the Loot tab is the ledger, this card is the glance. */
  onOpenLoot: () => void
}

export default function OverviewView(_props: OverviewViewProps): JSX.Element {
  return (
    <Paper
      variant="outlined"
      data-testid="overview-grid"
      sx={{ p: 2, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Stack spacing={0.5}>
        <Typography variant="h6">Overview</Typography>
        <Typography variant="body2" color="text.secondary">
          Your fight, your target and your drops at a glance — coming soon.
        </Typography>
      </Stack>
    </Paper>
  )
}
