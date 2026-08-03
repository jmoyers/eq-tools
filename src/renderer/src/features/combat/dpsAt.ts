// "DPS at that point" — sampled from the chart's OWN rolling series, never computed a second
// way. `buildDpsSeries` already defines the app's damage rate over time (trailing rolling mean,
// the reading a live meter gives), so the timeline's hover number and the DPS curve's line can
// never disagree. The same law that made CAT_COLOR one map.
//
// Pure + type-only imports, so the node suite can import it (see timelineHitTest.ts's header).

import type { DpsSeries } from './dashboardData'

/** The four rates a hover readout prints. `out` is the outgoing total (you + pet) — the value
 *  the curve's gold line draws. */
export interface DpsPoint {
  you: number
  pet: number
  inc: number
  out: number
}

/**
 * Sample the rolling series at `tMs`, clamped to the series. NO interpolation between buckets:
 * the series is bucketed at >=1s and the readout says so ("Ns rolling"), so smoothing the steps
 * away would invent a rate the log cannot support.
 */
export function dpsAt(series: DpsSeries, tMs: number): DpsPoint {
  const i = Math.min(series.n - 1, Math.max(0, Math.floor(tMs / series.bucketMs)))
  const you = series.you[i]
  const pet = series.pet[i]
  return { you, pet, inc: series.inc[i], out: you + pet }
}

/**
 * The honesty footer both charts print: the series' own smoothing window, plus the `~` marker
 * when the ring behind it was downsampled and/or truncated (every rate is then a scaled
 * estimate or a lower bound). Established vocabulary — the card legend already reads
 * "5s rolling" and the panel chip already reads "~".
 */
export function rollingNote(series: DpsSeries): string {
  return `${Math.round(series.smoothMs / 1000)}s rolling${series.estimated ? ' · ~ estimated' : ''}`
}
