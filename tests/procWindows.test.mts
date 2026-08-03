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
  MIN_EXPECTED_INACTIVE_PROCS,
  MIN_SWINGS,
  MIN_WINDOW_ACTIVE_MS,
  MIN_WINDOW_SWINGS,
  WINDOW_CAP,
  WINDOW_MS,
  WindowAccum,
  attributeEffect,
  buildAttributionReport,
  concentrationOf,
  expectedInactiveProcs,
  linkStrength,
  marginalOf,
  partitionWindows,
  procRate,
  volumeEligible,
  type ProcWindow
} from '../src/main/combat/procWindows'
import type { StateSpan } from '../src/shared/procAnalytics'

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
  assert.equal(
    linkStrength({ withCount: 1_084, withoutCount: 0, activeSwings: 261_505, inactiveSwings: 0 }),
    'inconclusive'
  )
  // The spellblade case: the gem-#1 spells fired 352 times, every one of them under spellblade,
  // with tens of thousands of swings outside it. THAT is exclusivity.
  assert.equal(
    linkStrength({ withCount: 352, withoutCount: 0, activeSwings: 40_000, inactiveSwings: 40_000 }),
    'exclusive'
  )
})

test('THE GATE IS RATE-AWARE: the same 289 inactive swings answer two lanes differently', () => {
  // ⚠ THIS REPLACES the plan's flat `MIN_INACTIVE_SWINGS = 200` (§4.3), which contradicted the
  // plan's own narrative (§0.3, §2.1: Instrument of Nife's 289 inactive swings must read
  // 'inconclusive'). 289 > 200, so the flat floor said 'exclusive' — the exact claim the plan
  // spent a section refusing to make. The gate is now the lane's OWN observed rate projected
  // onto the inactive exposure, and the two named cases separate for the right reason.
  assert.equal(MIN_EXPECTED_INACTIVE_PROCS, 3)

  // INSTRUMENT OF NIFE — 1,084 procs in 261,505 swings is 0.41 per 100. 289 inactive swings
  // predict ~1.2 procs, so seeing zero is barely evidence at all.
  const nife = { withCount: 1_084, withoutCount: 0, activeSwings: 261_505, inactiveSwings: 289 }
  assert.ok(Math.abs(expectedInactiveProcs(nife) - 1.198) < 0.01)
  assert.equal(linkStrength(nife), 'inconclusive')

  // SPELLBLADE (w39) — 14 procs in 406 swings is 3.4 per 100. 225 inactive swings predict ~7.8,
  // so a zero there IS a measurement. A LOWER exposure, and the opposite verdict: the flat
  // swing floor could not have told these two apart in either direction.
  const blade = { withCount: 14, withoutCount: 0, activeSwings: 406, inactiveSwings: 225 }
  assert.ok(Math.abs(expectedInactiveProcs(blade) - 7.759) < 0.01)
  assert.equal(linkStrength(blade), 'exclusive')
  assert.ok(blade.inactiveSwings < nife.inactiveSwings, 'fewer swings, stronger evidence')
})

test('a lane that DID fire without the state is sampled by observation, not by prediction', () => {
  // withoutCount is the first term of expectedInactiveProcs for exactly this case: six firings
  // on the inactive arm prove the arm was sampled, whatever the active rate would have guessed.
  const fired = { withCount: 0, withoutCount: 6, activeSwings: 406, inactiveSwings: 225 }
  assert.equal(expectedInactiveProcs(fired), 6)
  assert.equal(linkStrength(fired), 'weak')
  // …and a single stray firing does NOT rescue a thin arm: 27 procs in 904 swings predicts 1.1
  // in 36 inactive swings, and exactly 1 was seen. That is the null hypothesis matching itself,
  // not a correlation — the w40 Smiting Strike case (0.96 concentration, still unclassifiable).
  const strayFire = { withCount: 27, withoutCount: 1, activeSwings: 904, inactiveSwings: 36 }
  assert.ok(concentrationOf(27, 1) > 0.96)
  assert.equal(linkStrength(strayFire), 'inconclusive')
})

test('concentration alone can never reach exclusive, and the default is inconclusive', () => {
  const exposed = { activeSwings: 1_000, inactiveSwings: 1_000 }
  assert.equal(linkStrength({ withCount: 99, withoutCount: 1, ...exposed }), 'correlated')
  assert.equal(linkStrength({ withCount: 50, withoutCount: 50, ...exposed }), 'weak')
  assert.equal(linkStrength({ withCount: 0, withoutCount: 0, ...exposed }), 'inconclusive')
  // Same ratio, an inactive arm too thin to have produced three firings ⇒ inconclusive.
  assert.equal(
    linkStrength({ withCount: 99, withoutCount: 0, activeSwings: 100_000, inactiveSwings: 1_000 }),
    'inconclusive'
  )
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
// 5. TIER B — the matched-window counterfactual
//
// MEDIANS, NEVER MEANS (law 5), both n's always carried, and FOUR verdicts none of which may be
// rendered as another. The windows below are synthetic on purpose: the arithmetic of the
// statistic has to be pinned on numbers that can be checked by hand before the real fixtures
// are trusted to exercise it.
// ---------------------------------------------------------------------------------------

const KEY = 'invocation:spellblade'

/** Interleaved arms — even minutes active, odd minutes inactive — so the temporal-separation
 *  confound stays OFF unless a test asks for it. Each window is exactly at the volume floor
 *  (20s active, 10 swings), which makes every derived statistic hand-checkable. */
function arms(nActive: number, nInactive: number, extra: string[] = []): ProcWindow[] {
  const out: ProcWindow[] = []
  for (let i = 0; i < nActive; i++) {
    out.push(win(i * 2, { stateKeys: new Set([KEY, ...extra]), outDamage: 2_000, procDamage: 500 }))
  }
  for (let i = 0; i < nInactive; i++) {
    out.push(win(i * 2 + 1, { stateKeys: new Set(), outDamage: 1_000, procDamage: 125 }))
  }
  return out
}

const span = (kind: StateSpan['kind'], key: string, name: string): StateSpan => ({
  kind, key, name, startTs: 0, startEvidence: 'observed', endEvidence: 'open'
})

test('the statistic is a MEDIAN with an IQR and BOTH n\'s — never a bare mean', () => {
  const m = marginalOf(partitionWindows(arms(25, 25), KEY, 'invocation'))
  assert.equal(m.nActive, 25)
  assert.equal(m.nInactive, 25)
  // 2,000 damage over 20 active seconds = 100 dps; 1,000 over 20 = 50.
  assert.equal(m.medDpsActive, 100)
  assert.equal(m.medDpsInactive, 50)
  assert.deepEqual(m.iqrActive, [100, 100])
  assert.deepEqual(m.iqrInactive, [50, 50])
  assert.equal(m.deltaDps, 50)
  assert.equal(m.deltaPct, 100)
  // PROC damage and damage-per-swing are reported SEPARATELY, and the reason is the real log:
  // spellblade moves proc damage ~40% while leaving damage/swing flat. One blended headline
  // would hide the entire mechanism, so the type carries all three comparisons.
  assert.equal(m.medProcDpsActive, 25)
  assert.equal(m.medProcDpsInactive, 6.25)
  assert.equal(m.medDmgPerSwingActive, 200)
  assert.equal(m.medDmgPerSwingInactive, 100)
})

test('an IQR is a real spread, not a repeated median', () => {
  // Five active windows at 50/100/150/200/250 dps against a flat inactive arm.
  const ws: ProcWindow[] = []
  for (const [i, dmg] of [1_000, 2_000, 3_000, 4_000, 5_000].entries()) {
    ws.push(win(i * 2, { stateKeys: new Set([KEY]), outDamage: dmg }))
  }
  const m = marginalOf(partitionWindows(ws, KEY, 'invocation'))
  assert.equal(m.medDpsActive, 150)
  assert.deepEqual(m.iqrActive, [100, 200]) // type-7 quartiles over 50,100,150,200,250
  assert.equal(m.nInactive, 0)
})

test('the FOUR verdicts, and none of them is rendered as another', () => {
  // ESTIMATE — both arms clear the per-arm floor.
  const est = attributeEffect({ kind: 'invocation', key: 'spellblade', name: 'spellblade', windows: arms(25, 25) })
  assert.equal(est.verdict, 'estimate')
  assert.equal(est.marginal?.nActive, 25)

  // INSUFFICIENT-SAMPLE — a real contrast exists, one arm is short, and the note says WHICH and
  // BY HOW MUCH. A bare "not enough data" would be the thing law 5 forbids.
  const short = attributeEffect({ kind: 'invocation', key: 'spellblade', name: 'spellblade', windows: arms(25, 5) })
  assert.equal(short.verdict, 'insufficient-sample')
  assert.equal(short.marginal, undefined, 'no number is offered when the gates failed')
  assert.ok(short.note?.includes('inactive arm has 5'))
  assert.ok(short.note?.includes(`${MIN_ARM_WINDOWS} are needed`))

  // NOT-OBSERVABLE — the Instrument of Nife shape. The buff was up in every eligible minute, so
  // there is no control group at all. This is the RESULT, not a defect to engineer around.
  const nife = attributeEffect({
    kind: 'buff', key: 'instrument of nife', name: 'Instrument of Nife',
    windows: Array.from({ length: 500 }, (_, i) => win(i, { stateKeys: new Set(['buff:instrument of nife']) }))
  })
  assert.equal(nife.verdict, 'not-observable')
  assert.equal(nife.marginal, undefined)
  assert.ok(nife.note?.includes('no control group'))

  // MEASURED is deliberately unreachable in this wave: it needs an exclusive proc lane behind
  // the state, and the per-lane × per-state split is not folded on ingest yet. Every row says so
  // rather than reporting a zero as if it were an attribution.
  for (const e of [est, short, nife]) {
    assert.notEqual(e.verdict, 'measured')
    assert.deepEqual(e.direct, { damage: 0, heal: 0, hits: 0, dpsContribution: 0, lanes: [] })
    assert.ok(e.note?.includes('No lane is attributed to this state'))
  }
})

test('CONFOUNDS ARE DECLARED, NEVER CORRECTED — including the ones that could not be tested', () => {
  const c = attributeEffect({
    kind: 'invocation', key: 'spellblade', name: 'spellblade',
    windows: arms(25, 25, ['stance:offensive'])
  }).confounds
  // Offensive stance was up in 100% of active windows and 0% of inactive ones — the exact
  // failure mode ("your spellblade bonus is really your stance") this list exists to expose.
  assert.ok(c.some((s) => s.startsWith('co-state — stance:offensive')))
  assert.ok(c.some((s) => s.includes('100% of active windows but 0% of inactive')))
  // Level drift and mob mix are NOT in the minute ledger. Declared as untested rather than
  // omitted: a confound list that silently drops the checks it could not run reads as a pass.
  assert.ok(c.some((s) => s.startsWith('not tested —')))
  // …and the numbers are untouched by any of it. Nothing here adjusts a median.
  const m = marginalOf(partitionWindows(arms(25, 25, ['stance:offensive']), KEY, 'invocation'))
  assert.equal(m.deltaDps, 50)
})

test('temporally separated arms are declared not-interleaved', () => {
  const ws = [
    ...Array.from({ length: 25 }, (_, i) => win(i, { stateKeys: new Set([KEY]), outDamage: 2_000 })),
    ...Array.from({ length: 25 }, (_, i) => win(100 + i, { outDamage: 1_000 }))
  ]
  const e = attributeEffect({ kind: 'invocation', key: 'spellblade', name: 'spellblade', windows: ws })
  assert.equal(e.verdict, 'estimate')
  assert.ok(e.confounds.some((s) => s.startsWith('not-interleaved —')))
  // The interleaved build of the same comparison does NOT carry it.
  const inter = attributeEffect({ kind: 'invocation', key: 'spellblade', name: 'spellblade', windows: arms(25, 25) })
  assert.equal(inter.confounds.some((s) => s.startsWith('not-interleaved')), false)
})

test('EVERY observed state gets a row — the not-observable ones are the point, not the omission', () => {
  const ws = arms(25, 25, ['stance:offensive'])
  // The Nife shape, on the same ledger: the buff was up in EVERY window, both arms alike, so it
  // has no control group while the two states beside it do.
  for (const w of ws) w.stateKeys.add('buff:instrument of nife')
  const rep = buildAttributionReport({
    sessionId: 'zs3',
    windows: ws,
    states: [
      span('invocation', 'spellblade', 'spellblade'),
      span('stance', 'offensive', 'offensive'),
      span('buff', 'instrument of nife', 'Instrument of Nife'),
      span('invocation', 'spellblade', 'spellblade') // a re-commit must not duplicate the row
    ]
  })
  assert.equal(rep.sessionId, 'zs3')
  assert.equal(rep.windowSec, 60)
  assert.equal(rep.windowsTotal, 50)
  assert.equal(rep.windowsEligible, 50)
  assert.deepEqual(rep.effects.map((e) => e.name), ['Instrument of Nife', 'spellblade', 'offensive'])
  // The buff that was only ever ON has no control group; the two with both arms do.
  assert.deepEqual(rep.effects.map((e) => e.verdict), ['not-observable', 'estimate', 'estimate'])
  // A stance/invocation ALWAYS carries the "no per-hit marker" sentence, whatever its verdict —
  // an estimate about something the log never marks is still an estimate about nothing marked.
  for (const e of rep.effects.filter((x) => x.kind !== 'buff')) {
    assert.ok(e.note?.includes('no per-hit marker in the log'))
  }
  assert.equal(rep.effects.find((e) => e.kind === 'buff')?.note?.includes('no per-hit marker'), false)
})

test('windowsEligible counts the VOLUME gate only — purity is decided per state', () => {
  const ws = [win(0), win(1, { swings: MIN_WINDOW_SWINGS - 1 }), win(2, { activeMs: MIN_WINDOW_ACTIVE_MS - 1 })]
  assert.equal(volumeEligible(ws), 1)
  // A transition makes a window impure for ONE state's group, which is not a volume fact and
  // must not change the report's denominator.
  const withSwitch = [win(0), win(1, { transitionGroups: new Set(['invocation']) })]
  assert.equal(volumeEligible(withSwitch), 2)
  assert.equal(partitionWindows(withSwitch, KEY, 'invocation').eligible, 1)
})

test('a COAT study is impure on ANY coat commit — the dry line cannot name a venom', () => {
  // The projected StateSpan cannot say utility from combat (law 6), so the purity group is the
  // family prefix and any coat commit discards the minute. It throws away MORE windows than a
  // per-venom rule would, which is the safe direction for a purity gate.
  const key = 'coat:asp venom'
  const ws = [
    win(0, { stateKeys: new Set([key]) }),
    win(1, { stateKeys: new Set([key]), transitionGroups: new Set(['coat:utility']) }),
    win(2, { stateKeys: new Set([key]), transitionGroups: new Set(['coat:combat:asp venom']) })
  ]
  assert.equal(partitionWindows(ws, key, 'coat:').eligible, 1)
  // …and an unrelated stance commit still leaves it alone.
  const other = [win(0, { stateKeys: new Set([key]), transitionGroups: new Set(['stance']) })]
  assert.equal(partitionWindows(other, key, 'coat:').eligible, 1)
})

// ---------------------------------------------------------------------------------------
// 6. END-TO-END — the ledger's active time IS the engine's active time
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
