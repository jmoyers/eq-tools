// useRecentKills — the `progression` module's named kill ring → the Overview feed's rows.
//
// WHY THE PROGRESSION MODULE AND NOT THE KILLS MODULE. The progression series is the one place
// a kill is joined to the experience it paid (the join is measured and lives in
// src/main/modules/progression.ts: the experience line PRECEDES its kill line, always, so the
// module pairs them at fold time). Nothing renderer-side could reconstruct that pairing from two
// separate module snapshots without re-deriving the whole rule, and a second implementation of a
// measured rule is exactly how two surfaces start disagreeing.
//
// A SECOND SUBSCRIBER, deliberately. `useOverviewLeveling` already subscribes to `progression`
// in this same view, so this is a second `useModule` on one module id — the one place in the app
// where that happens. It costs one extra hydration fetch and one extra run of the (pure) delta
// reducer per flush, over a snapshot three orders of magnitude under its caps. The alternative —
// widening `OverviewLevelingState` to carry a feed the leveling CARD does not render — would put
// two unrelated cards' data behind one derivation, which is the coupling the Overview tab's whole
// "each card owns its own hook" rule exists to prevent.
//
// NOT GATED ON HYDRATION, exactly like the recent-drops feed: kills are HISTORY. The module's
// ring is complete and correct during the startup replay, so a spinner over a list of real past
// kills would be a lie in the other direction.

import { useMemo } from 'react'
import type { ProgressionDelta, ProgressionKill, ProgressionSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { EMPTY_PROGRESSION, applyProgressionDelta } from '../leveling/progressionDelta'

/**
 * How many rows the feed renders. A GLANCE surface; the Leveling tab is the analysis. The main
 * ring is 50 deep (RECENT_KILL_CAP), so the cap here is a render bound, never the retention one.
 */
export const KILL_FEED_CAP = 25

/** The feed's rows, NEWEST FIRST. The ring serves oldest→newest, so the tail is reversed. */
export function useRecentKills(): ProgressionKill[] {
  const prog = useModule<ProgressionSnap, ProgressionDelta>('progression', applyProgressionDelta) ?? EMPTY_PROGRESSION
  return useMemo(() => prog.recentKills.slice(-KILL_FEED_CAP).reverse(), [prog])
}
