// OverviewView — the at-a-glance landing surface: current DPS (headline + the live curve), the
// mob in front of you and its drops, your zone, and the recent-drops feed. A COMPOSITION over module
// snapshots + the combat engine's pull-snapshot; it owns no state of its own and is deliberately
// not an EqModule (docs/plans/overview-tab.md §0).
//
// IT ROUTES, IT NEVER NAVIGATES. Every destination arrives as a callback from App.tsx, which is
// what lets a card be added here without touching the router — each card owns its own hook and
// asks for its own data, so a future MapCard or ClassComboCard is one file plus one grid cell.
//
// LAYOUT. `minmax(0, 1fr)` is the load-bearing part of the grid: it lets a track shrink BELOW its
// content, so no card can dictate the grid's size (an intrinsic track is exactly how a growing
// panel used to push the page taller — Task #56). The view owns exactly the height it is given
// and scrolls INSIDE the grid, so the app's content area never gains a page-level scrollbar.
//
// HYDRATION IS A STATE (§4). During the startup replay every combat snapshot describes the PAST:
// an hours-old fight is `current` and a mob you killed at lunch is `currentTarget`. So the NOW
// row — zone, damage, target — renders a quiet placeholder until `hydrating` clears. `snap === null`
// (the first pull still in flight) reads the same way, which is why the gate is
// `snap?.hydrating ?? true`. The recent-drops card is NOT gated: it is a HISTORY surface whose
// module snapshot is complete and correct during the replay.

import type { JSX } from 'react'
import { Box, CircularProgress, Paper, Skeleton, Stack, Typography } from '@mui/material'
import type { CombatFocus } from '../combat/combatFocus'
import type { MobTarget } from '../mobs/mobTarget'
import { ComboCard } from './ComboCard'
import { DpsCard } from './DpsCard'
import { DpsCurveCard } from './DpsCurveCard'
import { CurrentMobCard } from './CurrentMobCard'
import { LevelingCard } from './LevelingCard'
import { useComboSnap } from '../profiles/ClassComboData'
import { RecentDropsCard } from './RecentDropsCard'
import { RecentKillsCard } from './RecentKillsCard'
import { ZoneStrip } from './ZoneStrip'
import { useCurrentMob } from './useCurrentMob'
import { useOverviewCombat } from './useOverviewCombat'
import { useOverviewLeveling } from './useOverviewLeveling'
import { useRecentDrops } from './useRecentDrops'
import { useRecentKills } from './useRecentKills'

export interface OverviewViewProps {
  /** DPS card → "Open in Combat": jump to an explicit scope + selection. */
  onOpenCombat: (f: CombatFocus) => void
  /** Mob card → the app-wide mob detail router (Mobs tab), seeded with what we already hold. */
  onOpenMob: (t: MobTarget) => void
  /** Drops feed → "All loot": the Loot tab is the ledger, this card is the glance. */
  onOpenLoot: () => void
  /** Leveling card → the Leveling tab: charts, the drag-selected range, AA. */
  onOpenLeveling: () => void
}

/**
 * The NOW row while the engine is still folding history. Same visual language as CombatView's
 * `HydratingPanel` — state ("Reading log…"), never process — with its own testid so the e2e can
 * tell the two surfaces apart.
 */
function OverviewHydrating(): JSX.Element {
  return (
    <Paper
      variant="outlined"
      data-testid="overview-hydrating"
      sx={{ p: 1.5, gridColumn: { md: '1 / -1' }, minWidth: 0 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <CircularProgress size={13} thickness={5} />
        <Typography variant="caption" color="text.secondary">
          Reading log…
        </Typography>
      </Stack>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} variant="rounded" height={22} sx={{ mb: '3px', opacity: 1 - i * 0.18 }} />
      ))}
    </Paper>
  )
}

export default function OverviewView({
  onOpenCombat,
  onOpenMob,
  onOpenLoot,
  onOpenLeveling
}: OverviewViewProps): JSX.Element {
  const snap = useOverviewCombat()
  const mob = useCurrentMob(snap)
  const rows = useRecentDrops()
  const kills = useRecentKills()
  // Its own module, its own hook: the leveling card asks for what it needs, exactly like every
  // other card here, so nothing about it touches the combat snapshot.
  const leveling = useOverviewLeveling()
  // Same rule again: its own module, its own hook. The combo card reads the class-combo module
  // directly and nothing about it touches the combat snapshot.
  const combo = useComboSnap()
  const hydrating = snap?.hydrating ?? true

  return (
    <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {!hydrating && <ZoneStrip />}
      <Box
        data-testid="overview-grid"
        sx={{
          display: 'grid',
          gap: 1.5,
          flexGrow: 1,
          minHeight: 0,
          minWidth: 0,
          overflow: 'auto',
          alignContent: 'start',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
          // Every card is internally bounded (a fixed-height scroll box around anything that
          // grows), so `min-content` rows are safe here and keep the cards from being stretched
          // into tall empty boxes on a big window.
          gridAutoRows: 'min-content',
          '& > *': { minWidth: 0, minHeight: 0 }
        }}
      >
        {hydrating ? (
          <OverviewHydrating />
        ) : (
          <>
            <DpsCard snap={snap} onOpenCombat={onOpenCombat} />
            <CurrentMobCard state={mob} onOpenMob={onOpenMob} />
            {/* Gated with the NOW row for the same reason the others are: its window is "the last
                hour of the log", and mid-replay that hour is an arbitrary point in your past. */}
            <LevelingCard state={leveling} onOpenLeveling={onOpenLeveling} />
            {/* Gated with the NOW row for the same reason: mid-replay the "current" interval is
                wherever the fold has reached, which is an arbitrary point in your past. */}
            <ComboCard snap={combo} />
            {/* Full width, directly under the NOW row and gated with it: the curve describes the
                SAME fight the DPS card above names, so showing it while the replay still calls an
                hours-old fight `current` would be the same lie the gate exists to prevent. */}
            <Box sx={{ gridColumn: { md: '1 / -1' }, minWidth: 0 }}>
              <DpsCurveCard snap={snap} />
            </Box>
          </>
        )}
        {/* The two HISTORY feeds, side by side on md and stacked on xs. Neither is gated: both
            describe the past, and the module snapshots behind them are complete during the
            replay. They share one fixed body height so the pair reads as one band. */}
        <RecentDropsCard rows={rows} onOpenLoot={onOpenLoot} />
        <RecentKillsCard rows={kills} onOpenLeveling={onOpenLeveling} />
      </Box>
    </Stack>
  )
}
