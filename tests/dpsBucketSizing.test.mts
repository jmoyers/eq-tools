// THE DPS CURVE'S SAMPLING GRID — `buildDpsSeries`'s bucket sizing.
//
// This is the residual commit 5a9dbc2 wrote down and left for the wave that owns
// dashboardData.ts: the grid was sized off the encounter's RAW wall-clock duration, so a live
// fight coarsened its buckets at 6 / 12 / 18 minutes even though the curve only ever SHOWS the
// last two minutes. The visible window therefore lost resolution the longer you fought, and
// every re-size stepped the whole line — in the one region the user is actually looking at.
//
// The fix sizes the grid off `min(durationMs, LIVE_WINDOW_MS)` while the chart is scrolling.
// The two properties that matter are both asserted below, and the second is the tripwire:
//   1. a LIVE fight of any length keeps 1-second buckets;
//   2. a FINALIZED fight is byte-identical to before — it draws its whole span, so its grid must
//      still be sized by that span. `live` defaults to false precisely so no existing caller
//      (the timeline's hover sampler reads the curve across the entire encounter) changes at all.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDpsSeries } from '../src/renderer/src/features/combat/dashboardData'
import type { TimelineView } from '../src/shared/combat'

/** The chart's live window, mirrored from dpsChart.ts — the number the grid has to agree with. */
const LIVE_WINDOW_MS = 120_000

/** A timeline of `durationMs` carrying one hit a second, so every bucket has something in it. */
function tl(durationMs: number): TimelineView {
  const events: TimelineView['events'] = []
  for (let t = 0; t < durationMs; t += 1000) {
    events.push({ t, kind: 'you', lane: 'Melee', category: 'melee', amount: 100 })
  }
  return {
    id: 'f1',
    startTs: 1_000_000,
    durationMs,
    lanes: [{ lane: 'Melee', category: 'melee', total: 100 * events.length, kind: 'you' }],
    events,
    stanceSpans: [],
    markers: [],
    downsampled: false,
    rawCount: events.length,
    totalCount: events.length,
    truncated: false
  }
}

test('a FINALIZED fight keeps exactly the grid it always had (the regression tripwire)', () => {
  // 360 buckets is the budget, so the old rule is `ceil(durationMs / 360 / 1000) * 1000`, min 1s.
  for (const [durationMs, bucketMs] of [
    [30_000, 1000],
    [360_000, 1000],
    [361_000, 2000],
    [720_000, 2000],
    [1_080_000, 3000]
  ] as const) {
    assert.equal(buildDpsSeries(tl(durationMs)).bucketMs, bucketMs, `finalized ${durationMs}ms`)
    // And the default is the finalized behaviour — an omitted flag can never change a curve.
    assert.equal(buildDpsSeries(tl(durationMs), false).bucketMs, bucketMs)
  }
})

test('a LIVE fight sizes its grid by the VISIBLE window, so 1s buckets survive any length', () => {
  // 40 minutes in, the curve still shows only the last two — and the sample it draws is still
  // per-second. Before this, a fight this long was on 7-second buckets in a 2-minute window.
  for (const durationMs of [30_000, 360_000, 720_000, 2_400_000]) {
    const s = buildDpsSeries(tl(durationMs), true)
    assert.equal(s.bucketMs, 1000, `live ${durationMs}ms`)
    // The budget the grid exists to protect is about what is DRAWN, and what is drawn is one
    // window's worth of buckets — comfortably inside 360 whatever the fight's total length.
    assert.ok(LIVE_WINDOW_MS / s.bucketMs <= 360)
  }
})

test('live and finalized agree wherever the fight is shorter than the visible window', () => {
  // Under two minutes nothing scrolls, so there is no second opinion to have: `min()` picks the
  // duration and the two paths are the same series.
  for (const durationMs of [1000, 30_000, 119_000]) {
    const live = buildDpsSeries(tl(durationMs), true)
    const done = buildDpsSeries(tl(durationMs))
    assert.equal(live.bucketMs, done.bucketMs)
    assert.equal(live.n, done.n)
    assert.deepEqual([...live.you], [...done.you])
  }
})

test('the smoothing window and the rates still follow the grid, whichever grid it is', () => {
  const live = buildDpsSeries(tl(720_000), true)
  const done = buildDpsSeries(tl(720_000))
  // 5s of smoothing: five 1s buckets live, two-and-a-half rounded to three 2s buckets finalized.
  assert.equal(live.smoothMs, 5000)
  assert.equal(done.smoothMs, 6000)
  // Same fight, same damage — the grid changes the RESOLUTION, never the total. 100 damage a
  // second is 100 dps on both curves once the smoothing window has filled.
  assert.equal(Math.round(live.you[live.n - 1]), 100)
  assert.equal(Math.round(done.you[done.n - 1]), 100)
  assert.equal(live.durationMs, done.durationMs)
})
