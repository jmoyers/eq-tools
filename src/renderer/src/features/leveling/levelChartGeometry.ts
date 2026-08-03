// Pure geometry + lookup for the two leveling charts (levelCharts.tsx) and everything
// that has to agree with what they DRAW — the hover layer today, a range/drag selection
// later. No React, no DOM, no MUI, and only TYPE imports from sibling modules, so
// tests/levelHover.test.mts can import it straight under tsx (there is no `@shared/*`
// alias in the node test runner — see AGENTS.md / the hover plan's D6).
//
// Why it exists: `AreaChart` and `LevelStepChart` each used to compute `t0/t1/pad`
// inline. A hover readout derived from a second copy of that arithmetic can silently
// disagree with the pixels it is pointing at. One mapping, one source.

import type { LevelSegment } from './levelSeries'

/** The viewBox width both charts draw at (`viewBox="0 0 720 H"`, preserveAspectRatio="none"). */
export const CHART_W = 720
/** The viewBox height both charts draw at. */
export const CHART_H = 150

/**
 * A chart's X mapping, in USER (viewBox) units. `t0..t1` is the time domain the chart
 * plots; `padX` is the horizontal inset; `w` is the viewBox width.
 *
 * Note the two charts do NOT share a domain today (the level chart adds a 4% trailing
 * pad so the current level reads as a plateau). That is preserved deliberately — this
 * type is the seam a future shared `ChartDomain` slots into without touching callers.
 */
export interface ChartScale {
  t0: number
  t1: number
  w: number
  padX: number
}

/**
 * Domain width, guarded. A zero-width domain (every point at one instant) would divide
 * by zero; 1 is the fallback, which is exactly what `AreaChart`'s `Math.max(1, t1 - t0)`
 * did before this module existed (log timestamps are whole milliseconds, so a real
 * non-degenerate AA domain is always >= 1). The level chart's domain always has its 4%
 * trailing pad and so is never degenerate.
 */
function spanOf(s: ChartScale): number {
  return s.t1 > s.t0 ? s.t1 - s.t0 : 1
}

/** Timestamp -> user units (the value that goes into the SVG path). */
export function xOf(s: ChartScale, ts: number): number {
  return s.padX + ((ts - s.t0) / spanOf(s)) * (s.w - 2 * s.padX)
}

/** User units -> timestamp. Exact inverse of `xOf`. */
export function tOf(s: ChartScale, ux: number): number {
  return s.t0 + ((ux - s.padX) / (s.w - 2 * s.padX)) * spanOf(s)
}

/**
 * CSS px -> user units for a `preserveAspectRatio="none"` chart: X is STRETCHED to the
 * element's measured width, so a raw `clientX - rect.left` is not a viewBox coordinate.
 * (Y is 1:1 on these charts — the SVG's `height` attribute equals the viewBox height —
 * so no inverse is needed for it.)
 */
export function pxToUser(cssX: number, rectW: number, w = CHART_W): number {
  return rectW > 0 ? (cssX * w) / rectW : 0
}

/**
 * The level in effect at `ts`, HONESTLY.
 *
 * The `swap-gap` arm deliberately carries NO `level` field: between the last ding of one
 * loadout and the first ding of the next, the level is genuinely unknown — the swap
 * itself is never logged (levelSeries.ts's world model, and the same reason
 * `levelFeedEntries` suppresses `sinceMs` across a swap). A caller therefore CANNOT
 * render a level there; TypeScript enforces the honesty rather than a comment asking for it.
 */
export type LevelAt =
  | { kind: 'level'; level: number; sinceTs: number; nextTs: number | null }
  | { kind: 'swap-gap'; beforeLevel: number; afterLevel: number; gapMs: number }
  | { kind: 'before-first' }

const BEFORE_FIRST: LevelAt = { kind: 'before-first' }

/**
 * Resolve `ts` against the drawn segments. The gap arm starts AT the last pre-swap ding
 * (not one millisecond after it): a `level` arm there would have to name a `nextTs`, and
 * the only candidate is the post-swap ding — which is precisely the fabricated
 * "time to level" the feed refuses to print.
 */
export function levelAt(segments: readonly LevelSegment[], ts: number): LevelAt {
  let si = -1
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].points[0].ts > ts) break
    si = i
  }
  if (si < 0) return BEFORE_FIRST

  const pts = segments[si].points
  let pi = 0
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].ts > ts) break
    pi = i
  }
  const p = pts[pi]
  const next = si + 1 < segments.length ? segments[si + 1].points[0] : null
  if (pi === pts.length - 1 && next) {
    return { kind: 'swap-gap', beforeLevel: p.level, afterLevel: next.level, gapMs: next.ts - p.ts }
  }
  return {
    kind: 'level',
    level: p.level,
    sinceTs: p.ts,
    nextTs: pi + 1 < pts.length ? pts[pi + 1].ts : null
  }
}

/** A cumulative-AA plot point. `nowHave` is the "you now have N" balance reported by the
 *  gain line that produced this step — absent when the caller has only the curve. */
export interface AaPoint {
  ts: number
  y: number
  nowHave?: number
}

/**
 * Index of the last point at or before `ts` (-1 when `ts` precedes the series). Shared
 * step lookup: the curve is a STEP function between gain lines, so this is the only
 * correct "value at t" — never an interpolation between two gains.
 */
export function stepIndexAt(points: readonly { ts: number }[], ts: number): number {
  let lo = 0
  let hi = points.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (points[mid].ts <= ts) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** Cumulative AA gained at `ts`; null before the first gain. */
export function cumulativeAt(points: readonly { ts: number; y: number }[], ts: number): number | null {
  const i = stepIndexAt(points, ts)
  return i < 0 ? null : points[i].y
}

/**
 * The leveling view's one duration formatter (minutes -> hours -> days). Lives here
 * rather than in the view so the hover layer and the progress feed print the same shape
 * for the same span; there is no fourth elapsed formatter in this feature.
 */
export function fmtDelta(ms: number): string {
  if (ms <= 0) return '—'
  const mins = ms / 60000
  if (mins < 60) return `${Math.round(mins)}m`
  const hrs = mins / 60
  if (hrs < 48) return `${hrs.toFixed(1)}h`
  return `${(hrs / 24).toFixed(1)}d`
}

/**
 * The same feature's SPAN formatter: `2h 41m` / `38m` / `45s` / `3d 4h`.
 *
 * Why two, and why both live HERE. `fmtDelta` above answers "how long since the last ding" —
 * one magnitude, one decimal (`2.7h`), which is the right shape for a feed line, a hover
 * readout and a legend row, and it is pinned by tests/levelHover.test.mts. A range readout
 * asks a different question — "how much time is IN this selection" — and `2.7h` there is a
 * worse answer than `2h 41m`: the user picked the boundaries, so the panel owes them the
 * minutes. Widening `fmtDelta` itself would silently restate every existing caption in the
 * feature, so the pair sits in ONE file instead: this module is the leveling feature's
 * duration home, and there is still no third formatter anywhere in it.
 *
 * Days roll over at 48h for the same reason `fmtDelta` does — a multi-day drag would
 * otherwise read `169h 30m`.
 */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hrs = Math.floor(total / 3600)
  if (hrs >= 48) return `${Math.floor(hrs / 24)}d ${hrs % 24}h`
  const mins = Math.floor((total % 3600) / 60)
  if (hrs > 0) return `${hrs}h ${mins}m`
  return mins > 0 ? `${mins}m` : `${total % 60}s`
}
