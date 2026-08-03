// ClassComboData — the renderer's one subscription to the class-combo module, and the delta
// merge that keeps it honest.
//
// THE MERGE IS BY ID AND THE `removed` LIST IS LOAD-BEARING. A correction recomputes every
// interval from the retained observation ring, so ids are NOT stable across a recompute
// (docs/plans/class-combo-inference.md §5.4): an interval that split into two vanishes and two
// new ones arrive. A merge that only upserted `changed` would leave the ghost on screen forever.
// Nothing here ever persists an id — the write path keys on TIME for exactly this reason.

import type { ComboDelta, ComboInterval, ComboSnap } from '@shared/classCombo'
import { useModule } from '../../lib/useModule'

/** Pre-hydration state. `ready:false` is a data-availability flag, not an error. */
export const EMPTY_COMBO: ComboSnap = { intervals: [], current: null, ready: false }

/**
 * Merge a `module:delta` into the held snapshot: drop the ids that no longer exist, upsert the
 * ones that changed, re-sort by start. `ready` rides the hydration snapshot only — a delta
 * never carries it, and inventing `true` here would claim the class tables loaded.
 */
export function applyComboDelta(state: ComboSnap, delta: ComboDelta): ComboSnap {
  const byId = new Map(state.intervals.map((i) => [i.id, i]))
  for (const id of delta.removed) byId.delete(id)
  for (const interval of delta.changed) byId.set(interval.id, interval)
  const intervals = [...byId.values()].sort((a, b) => a.startTs - b.startTs)
  return { intervals, current: intervals.length > 0 ? intervals[intervals.length - 1] : null, ready: state.ready }
}

/** The live combo snapshot. Never null — an un-hydrated view shows the same empty state. */
export function useComboSnap(): ComboSnap {
  return useModule<ComboSnap, ComboDelta>('combo', applyComboDelta) ?? EMPTY_COMBO
}

/** Just the intervals, for the consumers that only ever do a time join. */
export function useComboIntervals(): ComboInterval[] {
  return useComboSnap().intervals
}
