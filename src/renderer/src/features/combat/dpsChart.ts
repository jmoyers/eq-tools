// The DPS-curve GEOMETRY: turning a DpsSeries into the polyline/polygon point strings the
// chart draws, plus the mappings a hover layer needs to read the drawing backwards. Split out of
// CombatDashboard.tsx as pure, MUI-free arithmetic — the panel that renders it is then just the
// SVG, and the sizing constants live with the maths that uses them.
//
// The `@shared/*` imports here are TYPE-ONLY and erase, so tests/dpsChartHover.test.mts can load
// this under tsx with no renderer alias (see timelineHitTest.ts's header).
//
// COORDINATES, because this is the trap on this chart: the SVG is a fixed 720-unit viewBox drawn
// at `width="100%"` with `preserveAspectRatio="none"`, so X is STRETCHED to the card's width and
// Y is 1:1. A raw `clientX - rect.left` is therefore not an X on this chart — every px↔user
// conversion goes through `pxToUser`/`userToPx`, and every user↔time conversion through
// `xAtT`/`tAtUserX`, which are exact inverses of each other.

import type { TimelineMarker, TimelineView } from '@shared/combat'
import type { DpsSeries } from './dashboardData'

export const CHART_W = 720
export const CHART_H = 118
export const PAD_X = 4
export const PAD_T = 6
export const PAD_B = 4
/** The plot's inner width in user units — what one full visible window maps across. */
const INNER_W = CHART_W - 2 * PAD_X
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
  /** first series bucket drawn (>0 only while a live window scrolls) and how many vertices the
   *  polylines carry — the drawn line's index domain, so a hover can find the curve at a cursor
   *  X instead of guessing where the points went. */
  i0: number
  count: number
}

/** Damage rate → user Y. The ONE vertical mapping the curve is drawn with, so a hover dot placed
 *  through it sits ON the line rather than beside it. */
export function yAt(yMax: number, v: number): number {
  return CHART_H - PAD_B - (v / yMax) * (CHART_H - PAD_T - PAD_B)
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
  const x = (k: number): number => PAD_X + (idx.length > 1 ? k / (idx.length - 1) : 0.5) * INNER_W
  const y = (v: number): number => yAt(yMax, v)
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
    yMax,
    i0,
    count: idx.length
  }
}

/** Clamp to the plot's inner span as a 0..1 fraction — the shared first step of every X mapping. */
function frac(ux: number): number {
  return Math.min(1, Math.max(0, (ux - PAD_X) / INNER_W))
}

/** Encounter time → user X. Markers are placed by TIME (not by bucket index) so a tick sits
 *  exactly where it happened rather than snapping to the sampling grid. */
export function xAtT(chart: DpsChart, tMs: number): number {
  return PAD_X + ((tMs - chart.startMs) / Math.max(1, chart.endMs - chart.startMs)) * INNER_W
}

/** User X → the encounter time it stands for, clamped to the visible window. The exact inverse of
 *  `xAtT`, so a marker hovered at its own pixel resolves to its own instant. */
export function tAtUserX(chart: DpsChart, ux: number): number {
  return chart.startMs + frac(ux) * Math.max(1, chart.endMs - chart.startMs)
}

/**
 * CSS px → user units. `preserveAspectRatio="none"` stretches the 720-unit viewBox across the
 * card, so a cursor offset in CSS px is NOT an X on this chart until it comes through here.
 */
export function pxToUser(cssX: number, rectW: number): number {
  return rectW > 0 ? (cssX / rectW) * CHART_W : 0
}

/** User units → CSS px: the inverse of `pxToUser`, for drawing over the stretched chart in a
 *  1:1 overlay (a circle in the stretched space would paint as an ellipse). */
export function userToPx(ux: number, rectW: number): number {
  return rectW > 0 ? (ux / CHART_W) * rectW : 0
}

/** The outgoing (you + pet) rate at drawn vertex `k`, clamped to the series. */
function outAtVertex(chart: DpsChart, series: DpsSeries, k: number): number {
  const i = Math.min(series.n - 1, chart.i0 + Math.max(0, k))
  return series.you[i] + series.pet[i]
}

/**
 * The DRAWN outgoing polyline's Y at user X — the line the eye is following, read off the same
 * vertices `buildDpsChart` emitted (between two of them it is the straight segment the SVG
 * actually paints). This positions the hover DOT only: the rate the tooltip prints is always the
 * bucket sample from `dpsAt`, never this interpolation, which would invent a rate (D2).
 */
export function curveYAtUserX(chart: DpsChart, series: DpsSeries, ux: number): number {
  if (chart.count <= 1) return yAt(chart.yMax, outAtVertex(chart, series, 0))
  const g = frac(ux) * (chart.count - 1)
  const k = Math.min(chart.count - 2, Math.floor(g))
  const v0 = outAtVertex(chart, series, k)
  return yAt(chart.yMax, v0 + (outAtVertex(chart, series, k + 1) - v0) * (g - k))
}

/** One marker, already placed in chart X coordinates. */
export interface PlacedMarker {
  m: TimelineMarker
  x: number
}

/**
 * MARKERS (Task #64) — thin vertical ticks at the instants the fight CHANGED: a stance or
 * invocation commit, a blade coat, a slow landing.
 *
 * Markers outside the visible (scrolling) window are DROPPED rather than clamped to the edge,
 * which would put a coat from four minutes ago at t=0 and read as if it had just happened. The
 * engine never downsamples markers (see TimelineMarker), so what survives here is the complete
 * set for the visible span — this chart can be read as exhaustive, and so can its hover.
 */
export function placeMarkers(tl: TimelineView | null, chart: DpsChart | null): PlacedMarker[] {
  if (!tl || !chart) return []
  return tl.markers.filter((m) => m.t >= chart.startMs && m.t <= chart.endMs).map((m) => ({ m, x: xAtT(chart, m.t) }))
}
