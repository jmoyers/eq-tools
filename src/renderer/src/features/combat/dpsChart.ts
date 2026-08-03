// The DPS-curve GEOMETRY: turning a DpsSeries into the polyline/polygon point strings the
// chart draws. Split out of CombatDashboard.tsx as pure, MUI-free arithmetic — the panel that
// renders it is then just the SVG, and the sizing constants live with the maths that uses them.

import type { DpsSeries } from './dashboardData'

export const CHART_W = 720
export const CHART_H = 118
export const PAD_X = 4
export const PAD_T = 6
export const PAD_B = 4
/** How much of a LIVE fight the curve shows before it starts scrolling with `now`. */
export const LIVE_WINDOW_MS = 120_000

/** Everything the SVG needs, in chart coordinates. */
export interface DpsChart {
  outLine: string
  outArea: string
  petLine: string | null
  incLine: string | null
  startMs: number
  endMs: number
  /** the visible window is following `now` rather than showing the whole fight. */
  scrolling: boolean
  /** peak outgoing rate WITHIN the visible window (what the header quotes). */
  peakVis: number
  yMax: number
}

/**
 * Build the curve for the visible window. A LIVE fight past the window length shows only its
 * last two minutes (the window follows `now` on the view's existing snapshot cadence — there is
 * no timer here); a finalized fight is drawn whole. Returns null when there is nothing to draw.
 */
export function buildDpsChart(series: DpsSeries | null, live: boolean): DpsChart | null {
  if (!series?.hasAny) return null
  const { n, bucketMs } = series
  const scrolling = live && n * bucketMs > LIVE_WINDOW_MS
  const i0 = scrolling ? Math.max(0, n - Math.ceil(LIVE_WINDOW_MS / bucketMs)) : 0
  const idx: number[] = []
  for (let i = i0; i < n; i++) idx.push(i)
  // A one-bucket fight would draw nothing; repeat it so the opening rate reads as a line.
  if (idx.length === 1) idx.push(i0)
  let yMax = 1
  let peakVis = 0
  for (const i of idx) {
    const out = series.you[i] + series.pet[i]
    peakVis = Math.max(peakVis, out)
    yMax = Math.max(yMax, out, series.inc[i])
  }
  const x = (k: number): number => PAD_X + (idx.length > 1 ? k / (idx.length - 1) : 0.5) * (CHART_W - 2 * PAD_X)
  const y = (v: number): number => CHART_H - PAD_B - (v / yMax) * (CHART_H - PAD_T - PAD_B)
  const pts = (pick: (i: number) => number): string =>
    idx.map((i, k) => `${x(k).toFixed(1)},${y(pick(i)).toFixed(1)}`).join(' ')
  const outLine = pts((i) => series.you[i] + series.pet[i])
  return {
    outLine,
    outArea: `${x(0).toFixed(1)},${CHART_H - PAD_B} ${outLine} ${x(idx.length - 1).toFixed(1)},${CHART_H - PAD_B}`,
    petLine: series.hasPet ? pts((i) => series.pet[i]) : null,
    incLine: series.hasInc ? pts((i) => series.inc[i]) : null,
    startMs: i0 * bucketMs,
    endMs: Math.min(series.durationMs, n * bucketMs),
    scrolling,
    peakVis,
    yMax
  }
}
