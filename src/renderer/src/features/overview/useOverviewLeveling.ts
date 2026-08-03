// useOverviewLeveling — the Overview tab's read of the `progression` module.
//
// The SAME module and the SAME delta reducer the Leveling tab uses (`applyProgressionDelta`,
// re-exported from features/leveling/progressionDelta) — deliberately not a second copy. That
// reducer encodes a four-step contract (close the open zone interval, append, front-drop, replace
// scalars) that is subtle enough that a re-implementation here would drift silently and show two
// different pasts on two tabs. There is never a second concurrent subscriber either: `ViewContent`
// in App.tsx mounts exactly one feature view at a time.
//
// ALL the arithmetic lives in `overviewLevelingData.ts` (pure, node-tested). This file is only
// the transport plus ONE memo — keyed on the snapshot's identity, which is exactly right for
// `useModule`: every delta produces a brand-new snapshot object and nothing else ever mutates
// one, so the two `rangeStats` sweeps run once per delta rather than once per render.

import { useMemo } from 'react'
import type { ProgressionDelta, ProgressionSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { EMPTY_PROGRESSION, applyProgressionDelta } from '../leveling/progressionDelta'
import { overviewLeveling, type OverviewLevelingState } from './overviewLevelingData'

/**
 * The leveling card's whole state. Pre-hydration the module hook returns null and
 * `EMPTY_PROGRESSION` stands in — which derives to `empty: true`, the card's quiet state, and
 * never to a zero rate.
 */
export function useOverviewLeveling(): OverviewLevelingState {
  const prog = useModule<ProgressionSnap, ProgressionDelta>('progression', applyProgressionDelta) ?? EMPTY_PROGRESSION
  return useMemo(() => overviewLeveling(prog), [prog])
}
