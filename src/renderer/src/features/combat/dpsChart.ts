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
//
// ONE TIME BASE (the marker-jitter fix). `{t0, t1}` is the single time span this chart maps across
// its inner width, and EVERYTHING reads it: the polyline vertices, the marker ticks, the elapsed
// axis, the hover's X→time inverse and its grab radius. Both ends are exact multiples of
// `series.bucketMs` — t0 = the first drawn bucket's start, t1 = the last drawn bucket's END — so a
// live window advances by exactly one bucket per bucket and never by a wall-clock fraction.
//
// That last part is the whole bug this shape exists to kill. The curve is drawn from BUCKETED
// samples, but markers carry exact instants; when the two were mapped through different spans
// (vertices spread evenly over `count-1` intervals, markers scaled against a right edge that was
// the live `durationMs` — i.e. `now`) the marker mapping was both permanently stretched by
// count/(count-1) AND re-scaled on every snapshot as the partial last bucket filled. Markers
// therefore crept against a curve that only moved in whole-bucket steps: the observed swim. A
// canvas would have repainted exactly that mismatch, faster.
//
// The sample for bucket `i` is anchored at the bucket's CENTRE (`bucketCenterMs`), which is the
// instant a `dpsAt` lookup at that x resolves back to — so a marker that landed mid-bucket sits on
// the same x the curve's own sample does, and the hover dot, the tooltip's rate and the tick all
// name the same bucket. The cost is a half-bucket inset at each end of the drawn line (0.4% of the
// width on a scrolling 2:00 window); the gain is that no vertex claims a time it does not stand for.

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
  /** THE time base, both ends on the bucket grid: the start of the first drawn bucket and the end
   *  of the last. Every X mapping on this chart — curve, markers, axis, hover — is this span. */
  t0: number
  t1: number
  /** the sampling grid `t0`/`t1` are quantized to (`series.bucketMs`), carried so the mappings
   *  that need to talk in whole samples don't have to be handed the series as well. */
  bucketMs: number
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

/** Encounter time → user X against an explicit span. `xAtT` is this with the chart's own time
 *  base filled in; `buildDpsChart` needs it before there is a chart to read the base off. */
function xInSpan(t0: number, t1: number, tMs: number): number {
  return PAD_X + ((tMs - t0) / Math.max(1, t1 - t0)) * INNER_W
}

/**
 * The instant a series bucket's sample stands for: the bucket's CENTRE. The sample itself is a
 * trailing rolling mean, but it is READ as "the rate over this bucket" (`dpsAt` resolves any t
 * inside the bucket to it), and the centre is the one anchor that keeps the drawn vertex, the
 * hover's bucket lookup and a marker at that instant all on the same x.
 */
export function bucketCenterMs(chart: DpsChart, i: number): number {
  return (i + 0.5) * chart.bucketMs
}

/**
 * Build the curve for the visible window. A LIVE fight past the window length shows only its
 * last two minutes (the window follows `now` on the view's existing snapshot cadence — there is
 * no timer here); a finalized fight is drawn whole. Returns null when there is nothing to draw.
 *
 * The window is QUANTIZED to the sampling grid: it starts at a bucket boundary and ends at one,
 * so consecutive frames differ by a whole number of buckets. The last bucket is still filling, so
 * `t1` runs up to one bucket ahead of the fight's real duration — that is the honest statement of
 * "this sample is in progress", and it is stable, which the wall-clock right edge it replaced was
 * not (it re-scaled every marker on every snapshot; see the header).
 */
export function buildDpsChart(series: DpsSeries | null, live: boolean): DpsChart | null {
  if (!series?.hasAny) return null
  const { n, bucketMs } = series
  const scrolling = live && n * bucketMs > LIVE_WINDOW_MS
  const i0 = scrolling ? Math.max(0, n - Math.ceil(LIVE_WINDOW_MS / bucketMs)) : 0
  const t0 = i0 * bucketMs
  const t1 = n * bucketMs
  const idx: number[] = []
  for (let i = i0; i < n; i++) idx.push(i)
  // A one-bucket fight would draw nothing; repeat it so the opening rate reads as a line — and
  // that pair spans the bucket's whole width rather than sitting twice on its centre, which
  // would paint a zero-length line.
  const single = idx.length === 1
  if (single) idx.push(i0)
  let yMax = 1
  let peakVis = 0
  for (const i of idx) {
    const out = series.you[i] + series.pet[i]
    peakVis = Math.max(peakVis, out)
    yMax = Math.max(yMax, out, series.inc[i])
  }
  const x = (k: number): number => (single ? PAD_X + k * INNER_W : xInSpan(t0, t1, (i0 + k + 0.5) * bucketMs))
  const y = (v: number): number => yAt(yMax, v)
  const pts = (pick: (i: number) => number): string =>
    idx.map((i, k) => `${x(k).toFixed(1)},${y(pick(i)).toFixed(1)}`).join(' ')
  const outLine = pts((i) => series.you[i] + series.pet[i])
  return {
    outLine,
    outArea: `${x(0).toFixed(1)},${CHART_H - PAD_B} ${outLine} ${x(idx.length - 1).toFixed(1)},${CHART_H - PAD_B}`,
    petLine: series.hasPet ? pts((i) => series.pet[i]) : null,
    incLine: series.hasInc ? pts((i) => series.inc[i]) : null,
    t0,
    t1,
    bucketMs,
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

/** Encounter time → user X, on the chart's ONE time base. Markers keep their exact instants (a
 *  tick sits where it happened, not snapped to the grid) — but they are scaled by the same span
 *  the curve's vertices are, so the two can no longer drift apart. */
export function xAtT(chart: DpsChart, tMs: number): number {
  return xInSpan(chart.t0, chart.t1, tMs)
}

/** User X → the encounter time it stands for, clamped to the visible window. The exact inverse of
 *  `xAtT`, so a marker hovered at its own pixel resolves to its own instant. */
export function tAtUserX(chart: DpsChart, ux: number): number {
  return chart.t0 + frac(ux) * Math.max(1, chart.t1 - chart.t0)
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
  // Vertex index, read through the SAME time base the vertices were placed with: the cursor's
  // instant, in buckets from `t0`, less the half-bucket the first sample is anchored at. Deriving
  // it from `frac` directly would re-introduce a second grid the moment the anchor changed.
  const g = Math.min(chart.count - 1, Math.max(0, (tAtUserX(chart, ux) - chart.t0) / chart.bucketMs - 0.5))
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
 *
 * The window tested is the chart's own `t0..t1`, so a kept marker's x is always inside the plot
 * (no clipping, no clamping) and one that just landed in the still-filling last bucket is drawn
 * immediately, near the right edge, instead of waiting for that bucket to close.
 */
export function placeMarkers(tl: TimelineView | null, chart: DpsChart | null): PlacedMarker[] {
  if (!tl || !chart) return []
  return tl.markers.filter((m) => m.t >= chart.t0 && m.t <= chart.t1).map((m) => ({ m, x: xAtT(chart, m.t) }))
}
