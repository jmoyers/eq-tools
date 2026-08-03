// DpsCurveCard — the Overview tab's binding of the live DPS-over-time curve.
//
// It is a THIN wrapper on purpose: the chart, its markers, its hover crosshair and every number
// on it come from `features/combat/DpsOverTime` verbatim (the ONE source rule covers the whole
// chart, not just its colors). All this file decides is the card's chrome — compact mode, the
// testid, and the sentence shown when there is nothing to draw.
//
// THE SUBJECT IS THE DPS CARD'S SUBJECT. `useOverviewCombat` pulls with no `selectedId`, so the
// engine resolves the default every tick (the open fight, else the most recent finalized one) and
// `snap.timeline` is the ring of THAT segment — by construction the same fight `fightScopeOptions`
// names in the DPS card's head row right above. The two cards therefore cannot disagree about
// which fight you are looking at, which is also why `live` is read from that same head row rather
// than re-derived here: only a genuinely open fight lets the window scroll with `now`.

import type { JSX } from 'react'
import type { CombatSnapshot } from '@shared/combat'
import { ringlessText } from '../combat/CombatDashboard'
import { DpsOverTime } from '../combat/DpsOverTime'
import { fightScopeOptions } from '../combat/dashboardData'

export function DpsCurveCard({ snap }: { snap: CombatSnapshot | null }): JSX.Element {
  const head = fightScopeOptions(snap?.segments ?? []).head
  const tl = snap?.timeline ?? null

  return (
    <DpsOverTime
      tl={tl}
      live={head?.live ?? false}
      // Two honest empty states, never one: no fights at all is the same "engage something"
      // idiom the DPS card uses; a fight whose event ring has been dropped is a different fact
      // and gets the Combat tab's own wording rather than a second phrasing of it.
      noRing={head ? ringlessText('evicted') : 'No fights yet — the curve starts with your first hit.'}
      compact
      testId="overview-dps-curve"
    />
  )
}
