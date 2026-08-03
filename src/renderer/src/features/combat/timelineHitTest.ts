// Pure hit-testing for the combat timeline's hover layer: cursor → the tick / marker / lane it
// is pointing at. No React, no DOM, no MUI — so tests/timelineHitTest.test.mts can import it
// under tsx (the `@shared/*` imports here are TYPE-ONLY and erase; a value import would need
// the renderer's resolve.alias and break the node suite — see dashboardData.ts's SLAY_LABEL).
//
// Everything works in the TIME domain, never in pixels: the caller converts its own tolerance
// (`TOL_PX * msPerCssPx`) before calling. One implementation is then correct for the timeline's
// 1:1 SVG and for the `preserveAspectRatio="none"` charts, whose X is stretched.

import type { StanceSpan, TimelineEvent, TimelineMarker } from '@shared/combat'

/** A resolved hit: the thing under the cursor, where it sits in its array, and how far
 *  (ABSOLUTE ms) it is from the cursor. */
export interface HitPick<T> {
  item: T
  index: number
  dtMs: number
}

/** A landed tick — a solid mark — as opposed to a hollow miss/resist. */
function landed(e: TimelineEvent): boolean {
  return e.outcome == null || e.outcome === 'hit'
}

/**
 * The tie-break, pinned so the tests can hold it: closer wins; on an EXACT tie the LANDED tick
 * beats a miss/resist (the solid mark is what the eye is on), then the larger amount. Ties past
 * that fall to the earlier index, which comes for free from the strict comparisons plus an
 * ascending scan.
 */
function beats(cand: TimelineEvent, candDt: number, best: TimelineEvent, bestDt: number): boolean {
  if (candDt !== bestDt) return candDt < bestDt
  if (landed(cand) !== landed(best)) return landed(cand)
  return cand.amount > best.amount
}

/** First index whose `t` is >= `cursorMs` (the array is ascending — ring append order). */
function lowerBound(events: readonly TimelineEvent[], cursorMs: number): number {
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].t < cursorMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Nearest event in `laneName` (already resolved from Y) within ±tolMs. Binary search to the
 * cursor, then an ascending scan of the tolerance window only — O(log n + k) over an array that
 * the caller has already windowed to what is on screen.
 */
export function pickEventInLane(
  events: readonly TimelineEvent[],
  laneName: string,
  cursorMs: number,
  tolMs: number
): HitPick<TimelineEvent> | null {
  let from = lowerBound(events, cursorMs)
  while (from > 0 && cursorMs - events[from - 1].t <= tolMs) from--
  let bestIdx = -1
  let bestDt = 0
  for (let i = from; i < events.length && events[i].t - cursorMs <= tolMs; i++) {
    const e = events[i]
    if (e.lane !== laneName) continue
    const dt = Math.abs(e.t - cursorMs)
    if (dt > tolMs) continue
    if (bestIdx < 0 || beats(e, dt, events[bestIdx], bestDt)) {
      bestIdx = i
      bestDt = dt
    }
  }
  return bestIdx < 0 ? null : { item: events[bestIdx], index: bestIdx, dtMs: bestDt }
}

/**
 * Nearest marker within ±tolMs, lane-independent (the rail spans every lane). Linear: markers
 * are sparse by construction and are never downsampled (the densest fight in the user's whole
 * log carries three), so there is nothing here for a binary search to save.
 * Ties go to the earlier marker.
 */
export function pickMarker(
  markers: readonly TimelineMarker[],
  cursorMs: number,
  tolMs: number
): HitPick<TimelineMarker> | null {
  let bestIdx = -1
  let bestDt = 0
  for (let i = 0; i < markers.length; i++) {
    const dt = Math.abs(markers[i].t - cursorMs)
    if (dt > tolMs) continue
    if (bestIdx < 0 || dt < bestDt) {
      bestIdx = i
      bestDt = dt
    }
  }
  return bestIdx < 0 ? null : { item: markers[bestIdx], index: bestIdx, dtMs: bestDt }
}

/**
 * The pinned span COVERING `cursorMs` in one pin row. Spans are ranges, not points, so there is
 * no tolerance and no nearest: the cursor is either inside one or over empty rail. A group's
 * spans never overlap (one stance at a time), so the first cover is the only cover.
 */
export function pickSpanAt(
  spans: readonly StanceSpan[],
  group: StanceSpan['group'],
  cursorMs: number
): StanceSpan | null {
  return spans.find((s) => s.group === group && cursorMs >= s.start && cursorMs <= s.end) ?? null
}

/** Y (px, relative to the lane block's top) → lane index, or null outside the block. */
export function laneAt(y: number, laneH: number, laneCount: number): number | null {
  if (y < 0 || laneH <= 0) return null
  const i = Math.floor(y / laneH)
  return i < laneCount ? i : null
}
