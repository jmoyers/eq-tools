// PURE unit tests for the Overview leveling card's view model
// (src/renderer/src/features/overview/overviewLevelingData.ts).
//
// No log, no fixture, no DOM — so this file never skips. What is pinned here is the set of
// rules that would otherwise rot silently inside the card's JSX:
//
//   1. WINDOW A IS ANCHORED ON THE DATA'S CLOCK. `[lastTs - 60min, lastTs]`, never
//      `[Date.now() - 60min, Date.now()]`. This is the one that matters most: the card is read
//      by someone who has alt-tabbed out of the game, and a wall-clock window would hand them
//      an empty hour and call the result a rate. Every snapshot below is anchored HOURS in the
//      past precisely so a `Date.now()` regression fails here instead of in front of a user.
//   2. WINDOW B IS THE LAST ZONE INTERVAL, and its absence is a first-class state — no zone
//      line yet ⇒ no second line, never a fabricated zone.
//   3. AN AT-CAP WINDOW IS AN EM-DASH, never '0.00'. Experience lines that stated no
//      percentage mean unknown, not zero.
//   4. AN EMPTY SNAPSHOT IS EMPTY. `lastTs === 0` ⇒ the quiet state, not a zero-length window
//      whose rates read as measurements.
//   5. THE NEXT-LEVEL ESTIMATE HAS FOUR KILL SWITCHES, and each one is a hole in the evidence
//      rather than a degraded number. The log never states your position in the level bar — it
//      states a percentage PER GAIN — so the only way to know it is to sum every stated
//      percentage since the last ding. No ding, an at-cap line in that span, a retention floor
//      that rose past the ding, or an hour with no pace ⇒ NO estimate, and a reason on hover.
//      A projection built on a guessed bar position cannot even be labelled inferred; it is
//      just wrong, and this file exists to keep it out.
//   6. THE HISTORY COMPARISON NEVER CROSSES A CLASS SWAP. One level is shared by a three-class
//      loadout and swapping a class in drops it with NO log line at all, so the span across
//      that drop covers time the log cannot account for. The walk stops at the boundary; it
//      never reaches back into an older run to fill its quota.
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` / `@renderer` aliases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HEADLINE_WINDOW_MS,
  HISTORY_MAX,
  currentLevel,
  levelEta,
  levelingWindows,
  overviewLeveling,
  paceVerdict,
  recentLevelSpans
} from '../src/renderer/src/features/overview/overviewLevelingData'
import { rangeStats } from '../src/shared/progressionStats'
import { NONE } from '../src/renderer/src/features/leveling/rangeStatsRows'
import { formatTime } from '../src/renderer/src/lib/formatDate'
import type { ProgressionSnap } from '../src/shared/progressionTypes'
import type { RangeStats } from '../src/shared/progressionStats'

const MIN = 60_000
const HOUR = 60 * MIN
/** An arbitrary, readable anchor. Deliberately NOT near `Date.now()` — see rule 1. */
const T0 = Date.parse('Sat Aug 01 12:00:00 2026')

function emptySnap(): ProgressionSnap {
  return {
    expTs: [], expPct: [], expFlag: [],
    killTs: [], killZone: [], killCredit: [],
    witnessTs: [], recentKills: [], lootTs: [],
    zoneStart: [], zoneEnd: [], zoneName: [],
    levelTs: [], levelValue: [], aaGainTs: [], aaGainAmount: [],
    lastTs: 0, windowStart: 0, dropped: 0
  }
}

/**
 * A snapshot with one open zone interval and a kill+exp sample every `everyMs` across the last
 * hour of LOG time. `pct` is the stated level-bar percentage; `unstated` makes every sample an
 * at-cap line instead (percentage -1, flag bit 1).
 *
 * The loop stops STRICTLY BEFORE `lastTs`: `rangeStats` ranges are half-open `[t0, t1)`, so a
 * sample landing exactly on the end instant belongs to the next window, not this one. At a
 * one-minute cadence that makes 59 samples in the hour, and the expectations below say 59.
 */
function farming(opts: { everyMs: number; pct: number; unstated?: boolean; zoneStart?: number }): ProgressionSnap {
  const s = emptySnap()
  const lastTs = T0
  const start = lastTs - HOUR
  for (let ts = start + opts.everyMs; ts < lastTs; ts += opts.everyMs) {
    s.expTs.push(ts)
    s.expPct.push(opts.unstated ? -1 : opts.pct)
    s.expFlag.push(opts.unstated ? 1 : 0)
    s.killTs.push(ts)
    s.killZone.push(0)
    s.killCredit.push(0)
  }
  s.zoneStart.push(opts.zoneStart ?? start)
  s.zoneEnd.push(0)
  s.zoneName.push('Plane of Sky')
  s.lastTs = lastTs
  return s
}

test('empty snapshot: the quiet state, not a zero-length window', () => {
  const snap = emptySnap()
  assert.deepEqual(levelingWindows(snap), { hour: null, zone: null })
  const state = overviewLeveling(snap)
  assert.equal(state.empty, true)
  assert.equal(state.rate, NONE, 'a snapshot with nothing in it never states a rate')
  assert.equal(state.killRate, NONE)
  assert.equal(state.zoneLine, null)
  assert.equal(state.level, null)
  assert.equal(state.kills, 0)
})

test('window A is anchored on lastTs — the DATA clock, not the wall clock', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  const { hour } = levelingWindows(snap)
  assert.ok(hour)
  assert.equal(hour.t1, snap.lastTs)
  assert.equal(hour.t0, snap.lastTs - HEADLINE_WINDOW_MS)
  assert.equal(hour.t1 - hour.t0, HOUR)
  // The snapshot is anchored in the past on purpose: a `Date.now()`-anchored window would see
  // none of these 60 samples and would report the emptiness as a measurement.
  assert.ok(snap.lastTs < Date.now() - HOUR, 'fixture must sit well behind the wall clock')
  const state = overviewLeveling(snap)
  assert.equal(state.kills, 59)
  assert.equal(state.rate, '0.59 lvl/hr', '59 samples of 1% over one fully-active hour')
  assert.equal(state.killRate, '59.0 kills/hr')
  assert.equal(state.activity, '1h 0m active')
})

test('window B is the last zone interval, and names the zone raw', () => {
  // The camp opened 20 minutes ago — a window strictly shorter than the headline hour.
  const snap = farming({ everyMs: MIN, pct: 1, zoneStart: T0 - 20 * MIN })
  const { zone } = levelingWindows(snap)
  assert.ok(zone)
  assert.equal(zone.t0, T0 - 20 * MIN)
  assert.equal(zone.t1, snap.lastTs)
  assert.equal(zone.zone, 'Plane of Sky')
  const state = overviewLeveling(snap)
  assert.ok(state.zoneLine)
  assert.ok(state.zoneLine.startsWith('in Plane of Sky: '), state.zoneLine)
  assert.ok(state.zoneLine.includes(' lvl/hr · '), state.zoneLine)
  assert.ok(
    state.zoneLine.endsWith(`since ${formatTime(T0 - 20 * MIN, { hour: '2-digit', minute: '2-digit' })}`),
    state.zoneLine
  )
})

test('no zone interval: no window B and no second line — never a fabricated zone', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  snap.zoneStart.length = 0
  snap.zoneEnd.length = 0
  snap.zoneName.length = 0
  const w = levelingWindows(snap)
  assert.ok(w.hour, 'the headline window does not depend on a zone line')
  assert.equal(w.zone, null)
  const state = overviewLeveling(snap)
  assert.equal(state.zoneLine, null)
  assert.equal(state.rate, '0.59 lvl/hr', 'the headline is unaffected by the missing zone')
})

test('a closed final zone interval is honoured, never stretched to lastTs', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  snap.zoneEnd[0] = T0 - 10 * MIN
  const { zone } = levelingWindows(snap)
  assert.ok(zone)
  assert.equal(zone.t1, T0 - 10 * MIN, 'the range must not claim time in a zone you left')
})

test('at cap: every rate an em-dash, the chip on, and never 0.00', () => {
  const snap = farming({ everyMs: MIN, pct: 1, unstated: true })
  const state = overviewLeveling(snap)
  assert.equal(state.rate, NONE, 'unknown is not zero')
  assert.equal(state.atCap, true)
  // Kills are still STATED, so that rate survives — the two unknowns are independent.
  assert.equal(state.killRate, '59.0 kills/hr')
  assert.ok(state.zoneLine)
  assert.ok(state.zoneLine.includes(`${NONE} · 59.0 kills/hr`), state.zoneLine)
})

test('a silent hour reports idle time and an em-dash rate, not a zero rate', () => {
  const snap = emptySnap()
  snap.zoneStart.push(T0 - 3 * HOUR)
  snap.zoneEnd.push(0)
  snap.zoneName.push('Plane of Sky')
  // One lone sample 3 hours before the end of the log: the headline hour is pure silence.
  snap.expTs.push(T0 - 3 * HOUR)
  snap.expPct.push(2)
  snap.expFlag.push(0)
  snap.lastTs = T0
  const state = overviewLeveling(snap)
  assert.equal(state.rate, NONE, 'no active time ⇒ no rate at all')
  assert.equal(state.killRate, NONE)
  assert.ok(state.activity.includes('idle'), state.activity)
  assert.ok(!state.activity.toLowerCase().includes('afk'), 'the log cannot say AFK')
})

test('current level is the LATEST reported value, never the max', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  assert.equal(currentLevel(snap), null, 'no ding in the snapshot ⇒ the chip is omitted')
  // A loadout swap re-reports a LOWER level with no line of its own — the latest wins.
  snap.levelTs.push(T0 - 2 * HOUR, T0 - HOUR)
  snap.levelValue.push(42, 37)
  assert.equal(currentLevel(snap), 37)
  assert.equal(overviewLeveling(snap).level, 37)
})

test('clipped: a window reaching below the retention floor says so', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  assert.equal(overviewLeveling(snap).clipped, false)
  snap.windowStart = T0 - 30 * MIN
  assert.equal(overviewLeveling(snap).clipped, true)
})

// ---------------------------------------------------------------------------------------
// NEXT-LEVEL ESTIMATE (rule 5)
// ---------------------------------------------------------------------------------------

/** Window A's stats for a snapshot — the exact object `overviewLeveling` feeds `levelEta`. */
function hourStats(snap: ProgressionSnap): RangeStats {
  const { hour } = levelingWindows(snap)
  assert.ok(hour, 'fixture must have a headline window')
  return rangeStats({ snap, range: hour })
}

/** A ding at `ts` reaching `level`. Appended in order by every caller below. */
function ding(snap: ProgressionSnap, ts: number, level: number): void {
  snap.levelTs.push(ts)
  snap.levelValue.push(level)
}

test('next level: the estimate, and every assumption it rests on', () => {
  // 59 samples of 1% across the hour; the last ding sits at the half-hour mark, so exactly the
  // 29 samples AFTER it are progress into the current bar — 29%.
  const snap = farming({ everyMs: MIN, pct: 1 })
  ding(snap, T0 - 30 * MIN, 43)
  const eta = levelEta(snap, hourStats(snap))
  assert.equal(eta.blocked, null)
  assert.ok(eta.blocked === null) // narrowing for the reads below
  assert.equal(Math.round(eta.progress * 100), 29)
  assert.equal(eta.toLevel, 44)
  // remaining 0.71 levels at the hour's WALL pace of 0.59 lvl/hr.
  assert.ok(Math.abs(eta.ms - (0.71 / 0.59) * HOUR) < 1000, String(eta.ms))
  const state = overviewLeveling(snap)
  assert.equal(state.eta, '~1h 12m to level 44')
  assert.ok(state.etaTitle.includes('29% of level 43'), state.etaTitle)
  assert.ok(state.etaTitle.includes('idle'), 'the tooltip must admit the idle time it assumed')
  assert.ok(state.etaTitle.includes('never a countdown'), state.etaTitle)
})

test('next level: no ding observed ⇒ no estimate, because the bar position is unknowable', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  assert.equal(levelEta(snap, hourStats(snap)).blocked, 'no-ding')
  const state = overviewLeveling(snap)
  assert.equal(state.eta, null, 'the log never states where you are in the bar — only per-gain %')
  assert.ok(state.etaTitle.includes('No level-up has been recorded'), state.etaTitle)
})

test('next level: an at-cap line since the ding poisons the sum ⇒ no estimate', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  ding(snap, T0 - 30 * MIN, 43)
  // ONE line after the ding that stated no percentage is enough: the sum now has a hole in it
  // of unknown size, and 'the rest of the bar' would be a fabricated remainder.
  const at = snap.expTs.findIndex((ts) => ts > T0 - 30 * MIN)
  snap.expPct[at] = -1
  snap.expFlag[at] = 1
  assert.equal(levelEta(snap, hourStats(snap)).blocked, 'unstated')
  const state = overviewLeveling(snap)
  assert.equal(state.eta, null)
  assert.ok(state.etaTitle.includes('unknown, not zero'), state.etaTitle)
  assert.equal(state.rate, '0.58 lvl/hr', 'the headline still stands — one unstated line is not at-cap')
})

test('next level: a retention floor past the ding ⇒ no estimate (dropped samples are a hole)', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  ding(snap, T0 - 30 * MIN, 43)
  snap.windowStart = T0 - 10 * MIN
  assert.equal(levelEta(snap, hourStats(snap)).blocked, 'clipped')
  assert.equal(overviewLeveling(snap).eta, null)
})

test('next level: no pace in the last hour ⇒ nothing to project', () => {
  const snap = emptySnap()
  snap.zoneStart.push(T0 - 3 * HOUR)
  snap.zoneEnd.push(0)
  snap.zoneName.push('Plane of Sky')
  snap.expTs.push(T0 - 3 * HOUR)
  snap.expPct.push(2)
  snap.expFlag.push(0)
  ding(snap, T0 - 3 * HOUR, 43)
  snap.lastTs = T0
  assert.equal(levelEta(snap, hourStats(snap)).blocked, 'no-pace')
  const state = overviewLeveling(snap)
  assert.equal(state.eta, null)
  assert.ok(state.etaTitle.includes('no levels of progress'), state.etaTitle)
})

test('next level: more than a full bar stated with no ding ⇒ the position is unknown', () => {
  const snap = farming({ everyMs: MIN, pct: 5 })
  ding(snap, T0 - HOUR, 43)
  assert.equal(levelEta(snap, hourStats(snap)).blocked, 'overfull')
  assert.equal(overviewLeveling(snap).eta, null)
})

test('next level: an absurd horizon says so instead of pretending to minutes', () => {
  // 0.01% a minute is ~0.006 levels an hour: about a week to the next level. Printing
  // '169h 12m' would be arithmetic wearing the costume of a prediction.
  const snap = farming({ everyMs: MIN, pct: 0.01 })
  ding(snap, T0 - 30 * MIN, 43)
  const eta = levelEta(snap, hourStats(snap))
  assert.equal(eta.blocked, null)
  assert.ok(eta.blocked === null && eta.ms > 24 * HOUR, 'fixture must exceed the horizon')
  assert.equal(overviewLeveling(snap).eta, '>1 day to level 44 at this pace')
})

// ---------------------------------------------------------------------------------------
// LEVEL HISTORY COMPARISON (rule 6)
// ---------------------------------------------------------------------------------------

test('level history stops at a class swap and never bridges one', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  // 44 → 45, then a loadout swap drops the character to 38 with NO log line, then 38 → 39 → 40.
  ding(snap, T0 - 20 * HOUR, 44)
  ding(snap, T0 - 18 * HOUR, 45)
  ding(snap, T0 - 10 * HOUR, 38)
  ding(snap, T0 - 8 * HOUR, 39)
  ding(snap, T0 - 2 * HOUR, 40)
  const spans = recentLevelSpans(snap)
  assert.equal(spans.length, 2, 'the 45 → 38 drop is a swap boundary; the walk stops there')
  assert.deepEqual(
    spans.map((s) => [s.fromLevel, s.toLevel]),
    [
      [38, 39],
      [39, 40]
    ]
  )
  assert.equal(spans[0].ms, 2 * HOUR)
  assert.equal(spans[1].ms, 6 * HOUR)
  const history = overviewLeveling(snap).history ?? ''
  assert.equal(history, 'lvl 38→39 2.0h · 39→40 6.0h')
  assert.ok(!history.includes('45'), 'the pre-swap run is unreachable — its span covers unlogged time')
})

test('level history: no completed level in this run ⇒ no line at all', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  assert.deepEqual(recentLevelSpans(snap), [], 'no dings')
  ding(snap, T0 - 2 * HOUR, 40)
  assert.deepEqual(recentLevelSpans(snap), [], 'one ding is a start line, not a span')
  const state = overviewLeveling(snap)
  assert.equal(state.history, null)
  assert.equal(state.verdict, null)
  assert.equal(state.historyTitle, '')
})

test(`level history keeps at most ${HISTORY_MAX} levels, the most recent ones`, () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  for (let k = 0; k < 8; k++) ding(snap, T0 - (10 - k) * HOUR, 35 + k)
  const spans = recentLevelSpans(snap)
  assert.equal(spans.length, HISTORY_MAX)
  assert.equal(spans[0].fromLevel, 37, 'oldest kept pair')
  assert.equal(spans[spans.length - 1].toLevel, 42, 'newest kept pair')
})

/** `n` identical spans of `ms`, ascending from level 40 — a fixture for the verdict bands. */
function evenSpans(msList: readonly number[]): { fromLevel: number; toLevel: number; ms: number }[] {
  return msList.map((ms, i) => ({ fromLevel: 40 + i, toLevel: 41 + i, ms }))
}

/** The wall levels/hour rate that corresponds to exactly `ms` of wall time per level. */
function wallFor(ms: number): number {
  return HOUR / ms
}

test('pace verdict: ±20% around the median of your recent levels is the same pace', () => {
  const spans = evenSpans([4 * HOUR, 4 * HOUR]) // median 4h ⇒ band [3.2h, 5h]
  assert.equal(paceVerdict(spans, wallFor(3 * HOUR)), 'ahead')
  assert.equal(paceVerdict(spans, wallFor(3.5 * HOUR)), 'even')
  assert.equal(paceVerdict(spans, wallFor(4.5 * HOUR)), 'even')
  assert.equal(paceVerdict(spans, wallFor(5.5 * HOUR)), 'behind')
  // The median, not the mean: one 30-hour level (an overnight camp with the log running) must
  // not drag the comparison for the four ordinary ones around it.
  const skewed = evenSpans([1 * HOUR, 1 * HOUR, 30 * HOUR, 1 * HOUR, 1 * HOUR])
  assert.equal(paceVerdict(skewed, wallFor(1 * HOUR)), 'even')
})

test('pace verdict is omitted rather than guessed', () => {
  assert.equal(paceVerdict(evenSpans([4 * HOUR]), wallFor(HOUR)), null, 'one level is not a pace')
  assert.equal(paceVerdict([], wallFor(HOUR)), null)
  assert.equal(paceVerdict(evenSpans([4 * HOUR, 4 * HOUR]), null), null, 'no rate ⇒ no comparison')
  assert.equal(paceVerdict(evenSpans([4 * HOUR, 4 * HOUR]), 0), null, 'a zero rate is not a pace')
})

test('the card wires the estimate, the history and the verdict together', () => {
  const snap = farming({ everyMs: MIN, pct: 1 })
  ding(snap, T0 - 10 * HOUR, 38)
  ding(snap, T0 - 8 * HOUR, 39)
  ding(snap, T0 - 2 * HOUR, 40)
  const state = overviewLeveling(snap)
  assert.equal(state.history, 'lvl 38→39 2.0h · 39→40 6.0h')
  // median 4h per level; the last hour projects 1/0.59 ≈ 1.7h per level — comfortably ahead.
  assert.equal(state.verdict, 'ahead of your recent pace')
  assert.ok(state.historyTitle.includes('Median 4h 0m per level'), state.historyTitle)
  assert.ok(state.historyTitle.includes('class swap'), state.historyTitle)
  assert.equal(state.eta, '~41m to level 41')
})

test('zone comparison: only when the hour actually spans two named camps', () => {
  assert.equal(overviewLeveling(farming({ everyMs: MIN, pct: 1 })).zoneCompare, null, 'one camp is no comparison')
  const snap = farming({ everyMs: MIN, pct: 1 })
  snap.zoneEnd[0] = T0 - 30 * MIN
  snap.zoneStart.push(T0 - 30 * MIN)
  snap.zoneEnd.push(0)
  snap.zoneName.push('the Dreadlands')
  const line = overviewLeveling(snap).zoneCompare ?? ''
  assert.ok(line.startsWith('best this hour: '), line)
  assert.ok(line.includes(' lvl/hr'), line)
})
