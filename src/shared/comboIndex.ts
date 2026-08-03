// THE READ SEAM for class-combo intervals (docs/plans/class-combo-inference.md § 5.2).
//
// PURE, no Electron, importable from main AND the renderer — because the answer to "which
// loadout was I running when I killed that?" is a TIME JOIN, never a stamped field.
//
// This is the load-bearing architectural decision of the feature, so it is written down here
// rather than only in the plan. Interval boundaries are FUZZY AND REVISABLE: a `/who` typed an
// hour from now retroactively re-labels the last hour, a user correction re-labels an arbitrary
// span, and the over-determination bisector can split an interval that already "happened". Any
// `comboId` stamped onto a boss kill or an encounter summary at record time goes stale the
// moment the past is revised, and there is no reconciliation path short of a migration per
// revision. Every record we would want to tag ALREADY carries a timestamp, so a join is exact,
// free, and automatically correct after any recompute.
//
// The same reasoning rules out enriching events on the bus: that would force a field onto
// LogEventBase which every parser rule, every fixture expectation and every module's
// discriminated-union narrowing would have to carry — an enormous blast radius for a derived
// fact that changes under them.

import type { ComboInterval } from './classCombo'

/**
 * The interval whose ESTIMATE covers `ts`, or null.
 *
 * Deliberately keyed on `[startTs, endTs)` — the estimate — and not on the uncertainty window:
 * a timestamp has to land in exactly one interval for grouping to be a partition. The
 * uncertainty is not discarded, it is DISPLAYED (`startLo`/`startHi` draw as a hatched region),
 * which is the honest version of "this kill might belong to either side".
 */
export function comboAt(intervals: readonly ComboInterval[], ts: number): ComboInterval | null {
  for (let i = intervals.length - 1; i >= 0; i--) {
    const interval = intervals[i]
    if (ts < interval.startTs) continue
    if (interval.endTs === null || ts < interval.endTs) return interval
    return null
  }
  return null
}

/**
 * Group timestamped rows by the interval covering them, in interval order. Rows before the
 * first interval (or outside every one) land in a leading `interval: null` group rather than
 * being dropped — a row we cannot attribute is still a row the user owns.
 */
export function groupByCombo<T extends { ts: number }>(
  intervals: readonly ComboInterval[],
  rows: readonly T[]
): { interval: ComboInterval | null; rows: T[] }[] {
  const groups = new Map<string, { interval: ComboInterval | null; rows: T[] }>()
  const ordered: { interval: ComboInterval | null; rows: T[] }[] = []
  for (const row of [...rows].sort((a, b) => a.ts - b.ts)) {
    const interval = comboAt(intervals, row.ts)
    const key = interval?.id ?? ''
    let group = groups.get(key)
    if (!group) {
      group = { interval, rows: [] }
      groups.set(key, group)
      ordered.push(group)
    }
    group.rows.push(row)
  }
  return ordered
}
