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
//
// Imported RELATIVELY: node tests run through tsx with no `@shared` / `@renderer` aliases.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HEADLINE_WINDOW_MS,
  currentLevel,
  levelingWindows,
  overviewLeveling
} from '../src/renderer/src/features/overview/overviewLevelingData'
import { NONE } from '../src/renderer/src/features/leveling/rangeStatsRows'
import { formatTime } from '../src/renderer/src/lib/formatDate'
import type { ProgressionSnap } from '../src/shared/progressionTypes'

const MIN = 60_000
const HOUR = 60 * MIN
/** An arbitrary, readable anchor. Deliberately NOT near `Date.now()` — see rule 1. */
const T0 = Date.parse('Sat Aug 01 12:00:00 2026')

function emptySnap(): ProgressionSnap {
  return {
    expTs: [], expPct: [], expFlag: [],
    killTs: [], killZone: [], killCredit: [],
    witnessTs: [], lootTs: [],
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
