// comboAdapter — the ONE place the class-combo module's interval meets `progressionStats`'
// thinner one. PURE: no React, no MUI, only TYPE imports from `@shared`, so
// tests/comboAdapter.test.mts imports it straight under tsx.
//
// THE NAME COLLISION IS DELIBERATE AND IT LIVES HERE. There are two `ComboInterval` types:
//
//   * `@shared/classCombo`     — the MODEL. Candidate SETS per slot, provenance, confidence,
//                                fuzzy boundaries (`startLo`/`startHi`), `endTs: null` for the
//                                open interval, userLocked.
//   * `@shared/progressionStats` — the STRUCTURAL shape `rangeStats` declared for itself before
//                                the combo module existed: `{ startTs, endTs: number,
//                                classes: string[], inferred: boolean }`, nothing else.
//
// progressionStats deliberately never imports the combo implementation (that is what let the
// leveling feature ship first), so SOMETHING has to reconcile them. This file is that something,
// and it is the only file in the tree that knows both shapes.
//
// TWO REDUCTIONS HAPPEN HERE, and both are lossy in a direction that cannot lie:
//
//   1. A slot becomes a STRING via `slotLabel` — `PAL`, or the candidate set `CLR|PAL`, or an
//      em-dash for unknown. The range panel's chip therefore reads `PAL/CLR|PAL/—`, which is
//      the honest sentence; collapsing an ambiguous slot to its first candidate would not be.
//   2. The OPEN interval has no end. `intervalsIn` clips it to the query's own `t1`, which is
//      what "overlapping [t0,t1), clipped to it" already means. `comboAt` has no window to clip
//      against, so it reports `Infinity` — "no end has been stated", never a fabricated one.

import type { ComboInterval as ModelInterval } from '@shared/classCombo'
import type { ComboInterval as StatsInterval, ComboSource } from '@shared/progressionStats'
import { slotLabel } from '../profiles/ClassComboLabels'

/** The model interval, reduced to what `rangeStats` declared it needs, over [startTs, endTs). */
function toStatsInterval(interval: ModelInterval, startTs: number, endTs: number): StatsInterval {
  return {
    startTs,
    endTs,
    classes: interval.slots.map(slotLabel),
    // ANY slot still inferred taints the row: the chip says the loadout was not stated outright,
    // and a partly-observed combo is not an observed one.
    inferred: interval.slots.some((s) => s.provenance === 'inferred')
  }
}

/** An interval's end as a number: the open interval has none, and says so. */
function endOf(interval: ModelInterval): number {
  return interval.endTs ?? Number.POSITIVE_INFINITY
}

/**
 * A `ComboSource` over the module's intervals — the adapter LevelingView hands `rangeStats`, so
 * the range panel's combo chip populates from real intervals instead of the empty default.
 *
 * `intervals` is assumed time-ordered and non-overlapping, which the module guarantees; nothing
 * here re-derives, merges or gap-fills, per the seam's own contract ("zero inference").
 */
export function comboSource(intervals: readonly ModelInterval[]): ComboSource {
  return {
    comboAt(ts: number): StatsInterval | null {
      for (let i = intervals.length - 1; i >= 0; i--) {
        const interval = intervals[i]
        if (ts < interval.startTs) continue
        const end = endOf(interval)
        return ts < end ? toStatsInterval(interval, interval.startTs, end) : null
      }
      return null
    },
    intervalsIn(t0: number, t1: number): StatsInterval[] {
      const out: StatsInterval[] = []
      for (const interval of intervals) {
        const start = Math.max(interval.startTs, t0)
        const end = Math.min(endOf(interval), t1)
        if (end > start) out.push(toStatsInterval(interval, start, end))
      }
      return out
    }
  }
}

/** The empty seam: no intervals at all is a first-class state, never an error. */
export const EMPTY_COMBO_SOURCE: ComboSource = comboSource([])
