// THE PPM ENGINE + THE MINUTE-WINDOW LEDGER (docs/plans/proc-analytics.md §4.2–4.3, §5.1–5.2).
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE (AGENTS.md law 5): a rate below its sample floor is
// ABSENT, never 0. `1 proc in a 2-second pull` is not `30 ppm`, and `0.0 ppm` printed for a
// pull that was too short to measure is a lie the UI would repeat forever. So every floor test
// below asserts `undefined` explicitly — `assert.ok(!x)` would pass for 0 and prove nothing.
//
// The second half pins the ledger the Tier-B counterfactual is computed FROM: minute bucketing,
// the union of states observed in a window, the per-GROUP transition record, and the two
// eligibility gates. The comparison itself (medians, IQRs, verdicts, confounds) is a later
// wave; what is proved here is that the sample it will read is built correctly.
//
// Also pinned end-to-end: the active-time delta the ledger accrues is the ENGINE'S OWN number,
// not a re-derivation — the two can never drift, because there is only one computation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import {
  MIN_ACTIVE_SEC,
  MIN_ARM_WINDOWS,
  MIN_INACTIVE_SWINGS,
  MIN_SWINGS,
  MIN_WINDOW_ACTIVE_MS,
  MIN_WINDOW_SWINGS,
  WINDOW_CAP,
  WINDOW_MS,
  WindowAccum,
  concentrationOf,
  linkStrength,
  partitionWindows,
  procRate,
  type ProcWindow
} from '../src/main/combat/procWindows'

// ---------------------------------------------------------------------------------------
// 1. The three denominators, and their floors
// ---------------------------------------------------------------------------------------

test('above the floors, all three denominators are carried — none is hidden', () => {
  const r = procRate({ count: 18, activeSec: 264, durationSec: 300, swings: 500 })
  assert.equal(r.count, 18)
  assert.equal(r.swings, 500)
  assert.equal(r.ppmActive, 18 / (264 / 60))
  assert.equal(r.ppmWall, 18 / (300 / 60))
  assert.equal(r.per100Swings, (100 * 18) / 500)
  // They are genuinely DIFFERENT questions: active-time PPM outruns wall-clock PPM whenever
  // there were idle seconds, which is why collapsing them is how a proc meter starts lying.
  assert.ok((r.ppmActive ?? 0) > (r.ppmWall ?? 0))
})

test('ABSENT, NOT ZERO — a two-second pull reports no ppm at all', () => {
  const r = procRate({ count: 1, activeSec: 2, durationSec: 2, swings: 3 })
  assert.equal(r.ppmActive, undefined)
  assert.equal(r.ppmWall, undefined)
  assert.equal(r.per100Swings, undefined)
  // The COUNTS survive: they are lines the game printed, and they are always exact.
  assert.equal(r.count, 1)
  assert.equal(r.swings, 3)
})

test('each floor gates only its own number', () => {
  // Enough active time, not enough swings: the two time-based rates land, the mechanical one
  // does not.
  const timeOnly = procRate({ count: 4, activeSec: MIN_ACTIVE_SEC, durationSec: 60, swings: MIN_SWINGS - 1 })
  assert.notEqual(timeOnly.ppmActive, undefined)
  assert.notEqual(timeOnly.ppmWall, undefined)
  assert.equal(timeOnly.per100Swings, undefined)
  // Enough swings, not enough active time: the reverse.
  const swingOnly = procRate({ count: 4, activeSec: MIN_ACTIVE_SEC - 1, durationSec: 60, swings: MIN_SWINGS })
  assert.equal(swingOnly.ppmActive, undefined)
  assert.equal(swingOnly.ppmWall, undefined)
  assert.notEqual(swingOnly.per100Swings, undefined)
})

test('a zero-length segment never divides by zero', () => {
  const r = procRate({ count: 0, activeSec: 0, durationSec: 0, swings: 0 })
  assert.equal(r.ppmActive, undefined)
  assert.equal(r.ppmWall, undefined)
  assert.equal(r.per100Swings, undefined)
})

test('a lane that never fired reports 0 procs at a real rate — 0 ppm is a MEASUREMENT here', () => {
  // The distinction the UI must not collapse: `undefined` = "not measurable", `0` = "measured,
  // and it never happened". A long fight with no procs is the second one.
  const r = procRate({ count: 0, activeSec: 300, durationSec: 320, swings: 400 })
  assert.equal(r.ppmActive, 0)
  assert.equal(r.per100Swings, 0)
})

// ---------------------------------------------------------------------------------------
// 2. Link strength — the inactive side is the denominator
// ---------------------------------------------------------------------------------------

test('"it never fired without it" is only evidence when it COULD have fired without it', () => {
  // A lane that never fired without the state, with NO inactive exposure to have fired in, is
  // inconclusive no matter how lopsided the counts look.
  assert.equal(linkStrength({ withCount: 1_084, withoutCount: 0, inactiveSwings: 0 }), 'inconclusive')
  assert.equal(
    linkStrength({ withCount: 1_084, withoutCount: 0, inactiveSwings: MIN_INACTIVE_SWINGS - 1 }),
    'inconclusive'
  )
  // The spellblade case: the gem-#1 spells fired 352 times, every one of them under spellblade,
  // with tens of thousands of swings outside it. THAT is exclusivity.
  assert.equal(linkStrength({ withCount: 352, withoutCount: 0, inactiveSwings: 40_000 }), 'exclusive')
})

test('the shipped floor is exactly what the plan specifies — including where the plan is WRONG', () => {
  // ⚠ Pinned deliberately, and it is not the behaviour the plan's NARRATIVE asks for. See the
  // MIN_INACTIVE_SWINGS doc comment: the plan fixes the floor at 200 (§4.3) while also stating
  // that Instrument of Nife's 289 inactive swings must read 'inconclusive' (§0.3, §2.1). 289 is
  // over the floor, so as specified it reads 'exclusive'. This test exists so the contradiction
  // is a visible, deliberate line in the suite rather than a surprise in the UI — moving a
  // measured threshold is the integrator's call, so it is reported, not quietly patched.
  assert.equal(MIN_INACTIVE_SWINGS, 200)
  assert.equal(linkStrength({ withCount: 1_084, withoutCount: 0, inactiveSwings: 289 }), 'exclusive')
})

test('concentration alone can never reach exclusive, and the default is inconclusive', () => {
  assert.equal(linkStrength({ withCount: 99, withoutCount: 1, inactiveSwings: MIN_INACTIVE_SWINGS }), 'correlated')
  assert.equal(linkStrength({ withCount: 50, withoutCount: 50, inactiveSwings: MIN_INACTIVE_SWINGS }), 'weak')
  assert.equal(linkStrength({ withCount: 0, withoutCount: 0, inactiveSwings: 10_000 }), 'inconclusive')
  assert.equal(linkStrength({ withCount: 99, withoutCount: 1, inactiveSwings: MIN_INACTIVE_SWINGS - 1 }), 'inconclusive')
})

test('concentration of a lane that never fired is 0, never NaN', () => {
  assert.equal(concentrationOf(0, 0), 0)
  assert.equal(concentrationOf(3, 1), 0.75)
})

// ---------------------------------------------------------------------------------------
// 3. The minute-window ledger
// ---------------------------------------------------------------------------------------

const NONE: ReadonlySet<string> = new Set()

test('activity buckets by wall-clock minute and accumulates within it', () => {
  const w = new WindowAccum()
  w.fold({ ts: 0, activeDeltaMs: 1_000, outDamage: 100, swings: 1 }, NONE)
  w.fold({ ts: 59_999, activeDeltaMs: 2_000, outDamage: 50, procDamage: 50, swings: 2 }, NONE)
  w.fold({ ts: 60_000, activeDeltaMs: 3_000, outDamage: 7, swings: 1 }, NONE)
  const list = w.list()
  assert.deepEqual(list.map((x) => x.minute), [0, 1])
  assert.deepEqual(
    [list[0].activeMs, list[0].outDamage, list[0].procDamage, list[0].swings],
    [3_000, 150, 50, 3]
  )
  assert.deepEqual([list[1].activeMs, list[1].outDamage, list[1].swings], [3_000, 7, 1])
})

test('stateKeys is a UNION over the window — a state that turns on mid-minute still counts', () => {
  const w = new WindowAccum()
  w.fold({ ts: 1_000, swings: 1 }, new Set(['invocation:inversion']))
  w.fold({ ts: 30_000, swings: 1 }, new Set(['invocation:spellblade', 'buff:instrument of nife']))
  const only = w.list()[0]
  assert.deepEqual(
    [...only.stateKeys].sort(),
    ['buff:instrument of nife', 'invocation:inversion', 'invocation:spellblade']
  )
})

test('transitions are recorded PER GROUP — an unrelated coat swap must not veto a stance study', () => {
  const w = new WindowAccum()
  w.fold({ ts: 1_000, swings: 5 }, NONE)
  w.noteTransition(2_000, 'coat:utility', NONE)
  const only = w.list()[0]
  assert.equal(only.transitions, 1)
  assert.equal(only.transitionGroups.has('coat:utility'), true)
  assert.equal(only.transitionGroups.has('invocation'), false)
})

test('the ledger is bounded, drop-oldest', () => {
  const w = new WindowAccum()
  for (let i = 0; i < WINDOW_CAP + 5; i++) w.fold({ ts: i * WINDOW_MS, swings: 1 }, NONE)
  assert.equal(w.windows.size, WINDOW_CAP)
  assert.equal(w.list()[0].minute, 5, 'the five oldest minutes were dropped, not the newest')
})

// ---------------------------------------------------------------------------------------
// 4. The eligibility partition — the interval-query surface Tier B consumes
// ---------------------------------------------------------------------------------------

function win(minute: number, over: Partial<ProcWindow> = {}): ProcWindow {
  return {
    minute,
    activeMs: MIN_WINDOW_ACTIVE_MS,
    swings: MIN_WINDOW_SWINGS,
    outDamage: 1_000,
    procDamage: 100,
    transitions: 0,
    transitionGroups: new Set(),
    stateKeys: new Set(),
    ...over
  }
}

test('a window containing a switch is DISCARDED, not split — the boundary IS the confound', () => {
  const key = 'invocation:spellblade'
  const windows = [
    win(0, { stateKeys: new Set([key]) }),
    win(1, { stateKeys: new Set([key]), transitions: 1, transitionGroups: new Set(['invocation']) }),
    win(2, {})
  ]
  const arms = partitionWindows(windows, key, 'invocation')
  assert.equal(arms.total, 3)
  assert.equal(arms.eligible, 2)
  assert.deepEqual(arms.active.map((w) => w.minute), [0])
  assert.deepEqual(arms.inactive.map((w) => w.minute), [2])
})

test('a transition in ANOTHER group leaves the window eligible', () => {
  const key = 'invocation:spellblade'
  const windows = [win(0, { stateKeys: new Set([key]), transitions: 1, transitionGroups: new Set(['coat:utility']) })]
  const arms = partitionWindows(windows, key, 'invocation')
  assert.equal(arms.eligible, 1)
  assert.deepEqual(arms.active.map((w) => w.minute), [0])
})

test('a minute spent standing still is evidence about nothing and is dropped from both arms', () => {
  const key = 'stance:offensive'
  const windows = [
    win(0, { swings: MIN_WINDOW_SWINGS - 1 }),
    win(1, { activeMs: MIN_WINDOW_ACTIVE_MS - 1 }),
    win(2, { stateKeys: new Set([key]) })
  ]
  const arms = partitionWindows(windows, key, 'stance')
  assert.equal(arms.eligible, 1)
  assert.deepEqual(arms.active.map((w) => w.minute), [2])
  assert.deepEqual(arms.inactive, [])
})

test('the sample gate is a per-ARM floor, so one fat arm can never carry a comparison', () => {
  const key = 'buff:instrument of nife'
  // The Instrument of Nife shape: the buff is up essentially always, so the inactive arm is
  // empty no matter how large the active one gets. Tier B must report insufficient-sample.
  const windows = Array.from({ length: 500 }, (_, i) => win(i, { stateKeys: new Set([key]) }))
  const arms = partitionWindows(windows, key, key)
  assert.equal(arms.active.length, 500)
  assert.equal(arms.inactive.length, 0)
  assert.ok(arms.active.length >= MIN_ARM_WINDOWS)
  assert.ok(arms.inactive.length < MIN_ARM_WINDOWS, 'no comparison is possible; Tier A is the answer')
})

// ---------------------------------------------------------------------------------------
// 5. END-TO-END — the ledger's active time IS the engine's active time
// ---------------------------------------------------------------------------------------

const T = (mmss: string, text: string): string => `[Sun Aug 02 21:${mmss} 2026] ${text}`

test('END-TO-END: window activeMs is the engine\'s own capped-gap accrual, not a copy of it', () => {
  installSpellDb(loadSpellDb())
  const eng = new CombatEngine()
  const lines = [
    T('43:00', 'You have entered Cabilis East.'),
    T('43:01', 'You slash a wan ghoul knight for 40 points of damage.'),
    T('43:03', 'You slash a wan ghoul knight for 40 points of damage.'), // 2s gap → +2000
    T('43:20', 'You slash a wan ghoul knight for 40 points of damage.'), // 17s gap → capped +3000
    T('43:21', 'You try to backstab a wan ghoul knight, but miss!')
  ]
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev || ev.kind === 'unknown') continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  const st = (eng as unknown as { st: { zoneAgg: { windows: WindowAccum; procs: { swings: number } } } }).st
  const windows = st.zoneAgg.windows.list()
  assert.equal(windows.length, 1)
  // First hit adds 0, then +2000, then min(17000, 3000) = +3000 — the ACTIVE_MS cap, verbatim.
  assert.equal(windows[0].activeMs, 5_000)
  assert.equal(windows[0].outDamage, 120)
  assert.equal(windows[0].swings, 4, 'three landed swings + one miss')
  assert.equal(st.zoneAgg.procs.swings, 4, 'the segment counter agrees with the window ledger')

  // And it agrees with the shipped meter's own number, which is the whole point of reading the
  // delta out of the engine instead of recomputing it.
  const snap = eng.snapshot(lastTs + 600_000, { selectedId: 'zone' })
  assert.equal(snap.selected?.activeSec, 5)
})
