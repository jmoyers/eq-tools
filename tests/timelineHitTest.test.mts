// The pure half of the chart hover (Task #65): cursor → mark, DPS → readout, move → frame.
//
// These functions have no DOM and no React on purpose, so the behaviour a user complains about
// ("it tooltips the wrong tick", "the number jumps at the edges") is pinned here rather than in
// a browser. The tie-break order is the load-bearing part: nearest-in-time hit-testing replaced
// per-element `onMouseEnter`, so WHICH mark wins a near-tie is now a decision this suite owns.
//
// Arithmetic only — no fixture, no log, so it never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { laneAt, pickEventInLane, pickMarker, pickSpanAt } from '../src/renderer/src/features/combat/timelineHitTest'
import { dpsAt, rollingNote } from '../src/renderer/src/features/combat/dpsAt'
import { rafThrottle } from '../src/renderer/src/lib/rafThrottle'
import type { DpsSeries } from '../src/renderer/src/features/combat/dashboardData'
import type { StanceSpan, TimelineEvent, TimelineMarker } from '../src/shared/combat'

/** A landed melee tick unless overridden. */
function ev(t: number, lane: string, over: Partial<TimelineEvent> = {}): TimelineEvent {
  return { t, lane, category: 'melee', amount: 100, crit: false, kind: 'you', ...over }
}

const EVENTS: TimelineEvent[] = [
  ev(0, 'Melee'),
  ev(500, 'Backstab'),
  ev(1000, 'Melee'),
  ev(1200, 'Melee', { outcome: 'miss', amount: 0, detail: 'parry' }),
  ev(5000, 'Melee')
]

test('pickEventInLane takes the nearest tick IN THAT LANE, and nothing outside the tolerance', () => {
  assert.equal(pickEventInLane(EVENTS, 'Melee', 1040, 100)?.item.t, 1000)
  assert.equal(pickEventInLane(EVENTS, 'Melee', 1150, 100)?.item.t, 1200)
  // A neighbouring lane's tick is never borrowed, however close it is.
  assert.equal(pickEventInLane(EVENTS, 'Backstab', 490, 100)?.item.t, 500)
  assert.equal(pickEventInLane(EVENTS, 'Backstab', 1000, 100), null)
  // Beyond tolerance is a MISS, not "the closest anyway".
  assert.equal(pickEventInLane(EVENTS, 'Melee', 3000, 100), null)
  // The boundary is inclusive, and dtMs is the absolute distance.
  const edge = pickEventInLane(EVENTS, 'Melee', 900, 100)
  assert.equal(edge?.item.t, 1000)
  assert.equal(edge?.dtMs, 100)
  assert.equal(edge?.index, 2)
  assert.equal(pickEventInLane(EVENTS, 'Melee', 899, 100), null)
})

test('an empty population and a zero tolerance are answers, not crashes', () => {
  assert.equal(pickEventInLane([], 'Melee', 0, 100), null)
  assert.equal(pickEventInLane(EVENTS, 'Melee', 1000, 0)?.item.t, 1000)
  assert.equal(pickEventInLane(EVENTS, 'Melee', 1001, 0), null)
})

test('the tie-break is pinned: landed beats avoided, then the larger amount, then the earlier tick', () => {
  // Exact tie in |dt|: the solid mark wins, because that is the one the eye is on.
  const tie = [ev(900, 'Melee', { outcome: 'miss', amount: 0 }), ev(1100, 'Melee')]
  assert.equal(pickEventInLane(tie, 'Melee', 1000, 200)?.item.outcome, undefined)
  // 'hit' is spelled out the same as an absent outcome.
  const tieHit = [ev(900, 'Melee', { outcome: 'resist', amount: 0 }), ev(1100, 'Melee', { outcome: 'hit' })]
  assert.equal(pickEventInLane(tieHit, 'Melee', 1000, 200)?.item.t, 1100)
  // Both landed at the same distance ⇒ the bigger hit is the one being asked about.
  const amounts = [ev(900, 'Melee', { amount: 40 }), ev(1100, 'Melee', { amount: 900 })]
  assert.equal(pickEventInLane(amounts, 'Melee', 1000, 200)?.item.amount, 900)
  // Identical in every respect ⇒ the earlier tick, deterministically (index 0, not 1).
  const same = [ev(900, 'Melee'), ev(1100, 'Melee')]
  assert.equal(pickEventInLane(same, 'Melee', 1000, 200)?.index, 0)
  // …including when the cursor sits exactly ON two coincident ticks.
  const coincident = [ev(1000, 'Melee'), ev(1000, 'Melee')]
  assert.equal(pickEventInLane(coincident, 'Melee', 1000, 200)?.index, 0)
})

test('pickMarker is lane-independent, tolerance-bounded, and ties to the earlier marker', () => {
  const marks: TimelineMarker[] = [
    { t: 1000, kind: 'coat', label: 'Neurotoxic' },
    { t: 1400, kind: 'slow', label: 'a zol ghoul knight' },
    { t: 9000, kind: 'stance', label: 'Berserker' }
  ]
  assert.equal(pickMarker(marks, 1050, 200)?.item.kind, 'coat')
  assert.equal(pickMarker(marks, 1300, 200)?.item.kind, 'slow')
  assert.equal(pickMarker(marks, 5000, 200), null)
  assert.equal(pickMarker([], 0, 200), null)
  const tie: TimelineMarker[] = [
    { t: 900, kind: 'coat', label: 'a' },
    { t: 1100, kind: 'coat', label: 'b' }
  ]
  assert.equal(pickMarker(tie, 1000, 200)?.index, 0)
})

test('laneAt maps Y to a lane and refuses everything outside the block', () => {
  assert.equal(laneAt(0, 22, 3), 0)
  assert.equal(laneAt(21.9, 22, 3), 0)
  assert.equal(laneAt(22, 22, 3), 1)
  assert.equal(laneAt(65, 22, 3), 2)
  assert.equal(laneAt(66, 22, 3), null, 'past the last lane is not the last lane')
  assert.equal(laneAt(-1, 22, 3), null, 'above the block (the pin rows / rail) is not lane 0')
})

test('pickSpanAt covers a range — inside is a hit, the gaps and the other group are not', () => {
  const spans: StanceSpan[] = [
    { group: 'stance', name: 'Berserker', start: 0, end: 2000 },
    { group: 'stance', name: 'Precision', start: 3000, end: 4000 },
    { group: 'invocation', name: 'Vigor', start: 0, end: 4000 }
  ]
  assert.equal(pickSpanAt(spans, 'stance', 1500)?.name, 'Berserker')
  assert.equal(pickSpanAt(spans, 'stance', 2000)?.name, 'Berserker', 'the end is inclusive')
  assert.equal(pickSpanAt(spans, 'stance', 2500), null, 'the gap between stances is empty rail')
  assert.equal(pickSpanAt(spans, 'invocation', 2500)?.name, 'Vigor')
})

// ── dpsAt / rollingNote ────────────────────────────────────────────────────────────

/** A 4-bucket, 1s-per-bucket series (what buildDpsSeries produces for a short fight). */
function series(over: Partial<DpsSeries> = {}): DpsSeries {
  return {
    bucketMs: 1000,
    smoothMs: 5000,
    n: 4,
    you: Float64Array.from([10, 20, 30, 40]),
    pet: Float64Array.from([1, 2, 3, 4]),
    inc: Float64Array.from([0, 5, 0, 5]),
    peakOut: 44,
    hasPet: true,
    hasInc: true,
    hasAny: true,
    durationMs: 4000,
    estimated: false,
    ...over
  }
}

test('dpsAt samples the bucket the cursor is in and CLAMPS at both ends', () => {
  const s = series()
  assert.deepEqual(dpsAt(s, 0), { you: 10, pet: 1, inc: 0, out: 11 })
  assert.deepEqual(dpsAt(s, 1500), { you: 20, pet: 2, inc: 5, out: 22 })
  // No interpolation: the whole bucket reads the same, which is what "Ns rolling" promises.
  assert.deepEqual(dpsAt(s, 1001), dpsAt(s, 1999))
  // Before the fight and past its end clamp to the first/last bucket instead of reading off
  // the end of the Float64Array (which would silently produce NaN in a tooltip).
  assert.deepEqual(dpsAt(s, -5000), dpsAt(s, 0))
  assert.deepEqual(dpsAt(s, 99_000), { you: 40, pet: 4, inc: 5, out: 44 })
})

test('rollingNote states the series own window, and marks an inexact ring', () => {
  assert.equal(rollingNote(series()), '5s rolling')
  assert.equal(rollingNote(series({ smoothMs: 3000 })), '3s rolling')
  assert.equal(rollingNote(series({ estimated: true })), '5s rolling · ~ estimated')
})

// ── rafThrottle ────────────────────────────────────────────────────────────────────

/** Drive the frames by hand: the throttle resolves `requestAnimationFrame` off the global at
 *  CALL time, so stubbing it here is enough. */
function stubFrames(): { flush: () => void; pending: () => number; cancelled: number[] } {
  const cbs = new Map<number, () => void>()
  const cancelled: number[] = []
  let next = 1
  const g = globalThis as unknown as {
    requestAnimationFrame: (cb: () => void) => number
    cancelAnimationFrame: (h: number) => void
  }
  g.requestAnimationFrame = (cb) => {
    const h = next++
    cbs.set(h, cb)
    return h
  }
  g.cancelAnimationFrame = (h) => {
    cancelled.push(h)
    cbs.delete(h)
  }
  return {
    flush: () => {
      const run = [...cbs.values()]
      cbs.clear()
      run.forEach((cb) => cb())
    },
    pending: () => cbs.size,
    cancelled
  }
}

test('rafThrottle coalesces a burst into ONE call per frame, last args win', () => {
  const frames = stubFrames()
  const seen: number[] = []
  const t = rafThrottle((x: number) => seen.push(x))

  t(1)
  t(2)
  t(3)
  assert.deepEqual(seen, [], 'nothing runs before the frame')
  assert.equal(frames.pending(), 1, 'a burst schedules exactly one frame')
  frames.flush()
  assert.deepEqual(seen, [3], 'the LAST position is the one drawn')

  // The next burst schedules a fresh frame (the throttle is not one-shot).
  t(4)
  frames.flush()
  assert.deepEqual(seen, [3, 4])
})

test('cancel drops the pending frame and its stale args', () => {
  const frames = stubFrames()
  const seen: number[] = []
  const t = rafThrottle((x: number) => seen.push(x))
  t(1)
  t.cancel()
  assert.equal(frames.cancelled.length, 1, 'the scheduled frame is actually cancelled')
  frames.flush()
  assert.deepEqual(seen, [], 'an unmounted layer never sees the queued move')
  // Cancel is idempotent, and the throttle still works afterwards.
  t.cancel()
  t(9)
  frames.flush()
  assert.deepEqual(seen, [9])
})
