// PROC DETECTION + THE ACTIVE-STATE TIMELINE (docs/plans/proc-analytics.md §3, §4.1).
//
// Two halves, both pinned here:
//
//   1. UNIT — the pure modules (`procDetect.ts`, `stateTimeline.ts`, `shared/procBuffs.ts`).
//      Every edge case of the ONE inference this feature makes ("a spell effect with no own
//      cast behind it") and of the interval model's evidence rules.
//   2. SYNTHETIC END-TO-END — hand-authored log lines in the REAL format, driven through the
//      REAL parser and the REAL CombatEngine, so the ingest wiring is proved and not just the
//      helpers. Synthetic on purpose: the fixture goldens (w38–w41) are a parallel workstream,
//      and these assertions are about MECHANISM (which line opens which span, which effect
//      counts as a proc), which is exactly the thing a hand-built window states most clearly.
//
// THE INVARIANT UNDERNEATH ALL OF IT (AGENTS.md law 8): every number this feature adds is a
// COUNT or an INDEX over damage the meter already counted. The engine's damage totals are
// asserted unchanged alongside the new counters in the end-to-end tests, so a future edit that
// starts moving damage through this path fails here first.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import {
  PROC_CAST_WINDOW_MS,
  addSpellProc,
  isCastless,
  laneCount,
  noteCast,
  procEligibleDamage,
  pruneCasts,
  sidesCount,
  type RecentCasts,
  type SpellProcLane
} from '../src/main/combat/procDetect'
import { StateTimeline, coversWholly, overlapMs, stateKeyOf } from '../src/main/combat/stateTimeline'
import { PROC_BUFF_CATALOG, procBuffFor, procBuffInCandidates } from '../src/shared/procBuffs'
import { coatLineKey } from '../src/shared/poisons'
import type { StateSpan } from '../src/shared/procAnalytics'

// ---------------------------------------------------------------------------------------
// 1. The cast-attribution window
// ---------------------------------------------------------------------------------------

test('a spell with no own cast behind it is a proc; one just cast is not', () => {
  const recent: RecentCasts = new Map()
  assert.equal(isCastless(recent, 'Smiting Strike', 1_000_000), true)
  noteCast(recent, 'Discordant Mind', 1_000_000)
  assert.equal(isCastless(recent, 'Discordant Mind', 1_000_000), false)
  assert.equal(isCastless(recent, 'Discordant Mind', 1_000_000 + PROC_CAST_WINDOW_MS), false)
})

test('the window is a boundary, not a suggestion — one ms past it, the effect is a proc', () => {
  const recent: RecentCasts = new Map()
  noteCast(recent, 'Siphon Life', 5_000)
  assert.equal(isCastless(recent, 'Siphon Life', 5_000 + PROC_CAST_WINDOW_MS), false)
  assert.equal(isCastless(recent, 'Siphon Life', 5_000 + PROC_CAST_WINDOW_MS + 1), true)
})

test('a cast in the FUTURE never suppresses a proc (out-of-order replay safety)', () => {
  const recent: RecentCasts = new Map()
  noteCast(recent, 'Anarchy', 9_000)
  assert.equal(isCastless(recent, 'Anarchy', 8_000), true)
})

test('casts are rank-normalized — `Discordant Mind II` suppresses `Discordant Mind`', () => {
  // Law 2 at the COUNTING boundary: casts print a Roman rank, effect lines are rank-less.
  const recent: RecentCasts = new Map()
  noteCast(recent, 'Discordant Mind II', 1_000)
  assert.equal(isCastless(recent, 'Discordant Mind', 2_000), false)
})

test('THE DoT GATE — only `spell` damage is eligible for cast-less detection', () => {
  // A DoT tick is cast-DETACHED by construction: it arrives minutes after its cast and would
  // misclassify as a proc every single time. This is the gate that keeps the inference honest.
  assert.equal(procEligibleDamage('spell'), true)
  assert.equal(procEligibleDamage('dot'), false)
  assert.equal(procEligibleDamage('melee'), false)
  assert.equal(procEligibleDamage('ds'), false)
})

test('pruning drops only casts that can no longer suppress anything', () => {
  const recent: RecentCasts = new Map()
  noteCast(recent, 'Old Spell', 0)
  noteCast(recent, 'Fresh Spell', PROC_CAST_WINDOW_MS)
  pruneCasts(recent, PROC_CAST_WINDOW_MS + 1)
  assert.deepEqual([...recent.keys()], ['fresh spell'])
})

const NONE: ReadonlySet<string> = new Set()

test('a proc lane counts every firing and keeps damage and healing apart', () => {
  const lanes = new Map<string, SpellProcLane>()
  addSpellProc(lanes, { spell: 'Lifetap Strike', amount: 40, isHeal: false, active: NONE })
  addSpellProc(lanes, { spell: 'Lifetap Strike', amount: 31, isHeal: true, active: NONE })
  addSpellProc(lanes, { spell: 'Lifetap Strike II', amount: 9, isHeal: false, active: NONE })
  const lane = lanes.get('lifetap strike')
  assert.equal(lane?.damage, 49)
  assert.equal(lane?.heal, 31)
  // THE TAP RULE. Two damage lines and one heal line is TWO firings, not three: one lifetap
  // prints both a hit and a heal, so the sides are counted apart and the lane takes the LARGER.
  // (Wave 2 shipped a single counter and w39's twelve firings reported 24.)
  assert.deepEqual(lane?.hits, { damage: 2, heal: 1 })
  assert.equal(laneCount(lane!), 2)
})

test('a HEAL-ONLY proc still counts once — max, never damageHits alone', () => {
  const lanes = new Map<string, SpellProcLane>()
  // `Center`, delivered inside a Quick Buff burst (w40): a real firing that prints no damage
  // line at all. Counting only the damage side would erase it.
  addSpellProc(lanes, { spell: 'Center', amount: 66, isHeal: true, active: NONE })
  const lane = lanes.get('center')
  assert.equal(laneCount(lane!), 1)
  assert.equal(lane?.damage, 0)
  assert.equal(lane?.heal, 66)
})

test('the per-state split folds the ACTIVE SET at the firing instant, side by side', () => {
  const lanes = new Map<string, SpellProcLane>()
  const blade: ReadonlySet<string> = new Set(['invocation:spellblade', 'stance:offensive'])
  // One tap under two states: both sides bump, both states record ONE firing — never two.
  addSpellProc(lanes, { spell: 'Lifetap Strike', amount: 40, isHeal: false, active: blade })
  addSpellProc(lanes, { spell: 'Lifetap Strike', amount: 31, isHeal: true, active: blade })
  // A second firing with nothing on: the lane grows, neither state does.
  addSpellProc(lanes, { spell: 'Lifetap Strike', amount: 12, isHeal: false, active: NONE })
  const lane = lanes.get('lifetap strike')
  assert.equal(laneCount(lane!), 2)
  assert.equal(sidesCount(lane?.byState.get('invocation:spellblade')), 1)
  assert.equal(sidesCount(lane?.byState.get('stance:offensive')), 1)
  // A state nobody ever saw is ABSENT, and reads 0 rather than throwing or inventing a row.
  assert.equal(sidesCount(lane?.byState.get('invocation:inversion')), 0)
})

// ---------------------------------------------------------------------------------------
// 2. The interval model — evidence on both edges
// ---------------------------------------------------------------------------------------

const openSpan = (t: StateTimeline, key: string): StateSpan | undefined =>
  t.spans.find((s) => s.key === key && s.endEvidence === 'open')

test('a replacing sibling ends the previous span INFERRED — the game prints no stance end', () => {
  const t = new StateTimeline()
  t.noteState({ kind: 'stance', key: 'offensive', name: 'offensive', ts: 1_000, group: 'stance' })
  t.noteState({ kind: 'stance', key: 'defensive', name: 'defensive', ts: 5_000, group: 'stance' })
  const first = t.spans[0]
  assert.equal(first.startEvidence, 'observed')
  assert.equal(first.endEvidence, 'inferred')
  assert.equal(first.endTs, 5_000)
  assert.equal(t.spans[1].endEvidence, 'open')
  assert.equal(t.spans[1].endTs, undefined)
  // Exclusivity is real: exactly one stance is active.
  assert.deepEqual([...t.active], [stateKeyOf('stance', 'defensive')])
})

test('stances and invocations are INDEPENDENT groups — committing one never ends the other', () => {
  const t = new StateTimeline()
  t.noteState({ kind: 'stance', key: 'berserker', name: 'berserker', ts: 1_000, group: 'stance' })
  t.noteState({ kind: 'invocation', key: 'spellblade', name: 'spellblade', ts: 2_000, group: 'invocation' })
  assert.equal(openSpan(t, 'berserker')?.kind, 'stance')
  assert.equal(openSpan(t, 'spellblade')?.kind, 'invocation')
  assert.equal(t.active.size, 2)
})

test('combat venoms STACK; a utility coat replaces the one utility slot', () => {
  // The wiki says so and the real log proves it: three combat venoms coated eighteen minutes
  // before a utility coat were all still proccing afterwards. A single-slot model would have
  // to call those procs impossible.
  const t = new StateTimeline()
  t.noteState({ kind: 'coat', key: 'asp venom', name: 'Asp Venom', ts: 1_000, group: 'coat:combat:asp venom' })
  t.noteState({
    kind: 'coat', key: 'blood siphon venom', name: 'Blood Siphon Venom', ts: 2_000,
    group: 'coat:combat:blood siphon venom'
  })
  t.noteState({ kind: 'coat', key: 'binding poison', name: 'Binding Poison', ts: 3_000, group: 'coat:utility' })
  t.noteState({ kind: 'coat', key: 'neurotoxic poison', name: 'Neurotoxic Poison', ts: 4_000, group: 'coat:utility' })
  assert.equal(t.active.size, 3, 'two venoms + one utility')
  assert.equal(openSpan(t, 'asp venom')?.name, 'Asp Venom')
  assert.equal(openSpan(t, 'blood siphon venom')?.name, 'Blood Siphon Venom')
  assert.equal(openSpan(t, 'binding poison'), undefined, 'replaced by the later utility coat')
  assert.equal(t.spans.find((s) => s.key === 'binding poison')?.endEvidence, 'inferred')
})

test('a combat dry closes the WHOLE stack, and inferred — the line cannot name the venom', () => {
  const t = new StateTimeline()
  // Asp and STUNNING, not Asp and Cobra: those two are one venom line (eqlwiki — "Cobra Venom
  // … excluding Asp Venom, which this replaces"), so the engine gives them ONE group and they
  // could never be open together. See the line-replacement test below.
  t.noteState({ kind: 'coat', key: 'asp venom', name: 'Asp Venom', ts: 1_000, group: 'coat:combat:asp' })
  t.noteState({ kind: 'coat', key: 'stunning venom', name: 'Stunning Venom', ts: 1_500, group: 'coat:combat:stunning' })
  t.noteState({ kind: 'coat', key: 'binding poison', name: 'Binding Poison', ts: 2_000, group: 'coat:utility' })
  t.closeGroupPrefix('coat:combat:', 9_000, 'inferred')
  assert.equal(t.active.size, 1, 'the utility coat is untouched')
  for (const s of t.spans.filter((x) => x.key.endsWith('venom'))) {
    assert.equal(s.endEvidence, 'inferred')
    assert.equal(s.endTs, 9_000)
  }
  // A utility dry, by contrast, IS unambiguous — there is only ever one.
  t.closeGroupPrefix('coat:utility', 10_000, 'observed')
  assert.equal(t.spans.find((s) => s.key === 'binding poison')?.endEvidence, 'observed')
})

test('a venom LINE is one group: the upgrade supersedes its predecessor, not the whole stack', () => {
  // The grouping the engine actually derives (`coatLineKey`), asserted here on the timeline
  // primitive so the exclusivity mechanism and the roster fact are pinned in one place.
  const t = new StateTimeline()
  assert.equal(coatLineKey('Cobra Venom'), coatLineKey('Asp Venom'))
  const line = `coat:combat:${coatLineKey('Asp Venom')}`
  t.noteState({ kind: 'coat', key: 'asp venom', name: 'Asp Venom', ts: 1_000, group: line })
  t.noteState({ kind: 'coat', key: 'stunning venom', name: 'Stunning Venom', ts: 1_500, group: 'coat:combat:stunning' })
  t.noteState({ kind: 'coat', key: 'cobra venom', name: 'Cobra Venom', ts: 2_000, group: line })
  // Asp is gone — superseded, and 'inferred' because no line printed its end.
  assert.equal(t.spans.find((s) => s.key === 'asp venom')?.endEvidence, 'inferred')
  assert.equal(openSpan(t, 'asp venom'), undefined)
  // Stunning is on a different line and is untouched: venoms across lines still STACK.
  assert.equal(openSpan(t, 'stunning venom')?.name, 'Stunning Venom')
  assert.equal(t.active.size, 2, 'cobra + stunning — never three venoms from two lines')
})

test('a printed wears-off is the ONLY way a span ends observed; a re-apply supersedes inferred', () => {
  const t = new StateTimeline()
  t.noteState({ kind: 'buff', key: 'instrument of nife', name: 'Instrument of Nife', ts: 1_000 })
  t.noteState({ kind: 'buff', key: 'instrument of nife', name: 'Instrument of Nife', ts: 4_000 })
  assert.equal(t.spans[0].endEvidence, 'inferred', 're-apply supersedes, it does not observe an end')
  t.closeState({ kind: 'buff', key: 'instrument of nife', ts: 9_000, endEvidence: 'observed' })
  assert.equal(t.spans[1].endEvidence, 'observed')
  assert.equal(t.active.size, 0)
})

test('a wears-off for something never seen landing invents nothing', () => {
  const t = new StateTimeline()
  t.closeState({ kind: 'buff', key: 'instrument of nife', ts: 5_000, endEvidence: 'observed' })
  assert.deepEqual(t.spans, [], 'no zero-width span is fabricated')
})

test('a severed boundary censors — never observes, never fabricates an expiry', () => {
  const t = new StateTimeline()
  t.noteState({ kind: 'stance', key: 'offensive', name: 'offensive', ts: 1_000, group: 'stance' })
  t.noteState({ kind: 'buff', key: 'instrument of nife', name: 'Instrument of Nife', ts: 2_000 })
  t.censorAll(7_000)
  assert.deepEqual(t.spans.map((s) => s.endEvidence), ['censored', 'censored'])
  assert.equal(t.active.size, 0)
  // The spans SURVIVE: they describe real observed intervals right up to the cut. Only the
  // evidence says the cut is where our knowledge stops.
  assert.equal(t.spans.length, 2)
})

test('overlap queries treat an OPEN span as open, and a switch instant as one state', () => {
  const t = new StateTimeline()
  t.noteState({ kind: 'invocation', key: 'inversion', name: 'inversion', ts: 1_000, group: 'invocation' })
  t.noteState({ kind: 'invocation', key: 'spellblade', name: 'spellblade', ts: 5_000, group: 'invocation' })
  assert.deepEqual(t.activeAt(3_000).map((s) => s.key), ['inversion'])
  // [startTs, endTs): at the switch instant exactly one state is active, never both.
  assert.deepEqual(t.activeAt(5_000).map((s) => s.key), ['spellblade'])
  assert.deepEqual(t.activeAt(999_999).map((s) => s.key), ['spellblade'], 'an open span has no end')
  assert.deepEqual(t.spansOverlapping(4_000, 6_000).map((s) => s.key), ['inversion', 'spellblade'])
  assert.deepEqual(t.spansOverlapping(0, 500).map((s) => s.key), [])
})

test('overlapMs clamps an open span at the window end, never past the last observation', () => {
  const closed: StateSpan = {
    kind: 'stance', key: 'x', name: 'x', startTs: 1_000, endTs: 4_000,
    startEvidence: 'observed', endEvidence: 'inferred'
  }
  const open: StateSpan = { ...closed, endTs: undefined, endEvidence: 'open' }
  assert.equal(overlapMs(closed, 2_000, 10_000), 2_000)
  assert.equal(overlapMs(closed, 5_000, 10_000), 0)
  assert.equal(overlapMs(open, 2_000, 10_000), 8_000)
  assert.equal(coversWholly(open, 2_000, 10_000), true)
  assert.equal(coversWholly(closed, 2_000, 10_000), false)
})

// ---------------------------------------------------------------------------------------
// 3. The curated proc-buff catalog
// ---------------------------------------------------------------------------------------

test('the catalog is curated and its messages are verbatim from the shipped spell DB', () => {
  const nife = procBuffFor('instrument of nife')
  assert.equal(nife?.name, 'Instrument of Nife')
  assert.equal(nife?.applyMsg, 'A brilliant blue aura surrounds your weapon.')
  assert.equal(nife?.wearOffMsg, 'The brilliant blue aura fades.')
  assert.equal(nife?.grantsProc, 'Condemnation of Nife')
  const db = loadSpellDb()
  const entry = db.spells.find((s) => s.name === 'Instrument of Nife')
  assert.equal(entry?.msgCastOnYou, nife?.applyMsg, 'never invented — copied from spells.json')
  assert.equal(entry?.msgWearsOff, nife?.wearOffMsg)
})

test('the catalog gate is a SET INTERSECTION — landings arrive as candidate lists (law 3)', () => {
  assert.equal(procBuffInCandidates(['Alacrity', 'Celerity'])?.name, undefined)
  assert.equal(procBuffInCandidates(['Alacrity', 'Instrument of Nife'])?.name, 'Instrument of Nife')
  assert.equal(procBuffInCandidates([]), undefined)
  assert.equal(PROC_BUFF_CATALOG.length >= 1, true)
})

// ---------------------------------------------------------------------------------------
// 4. SYNTHETIC END-TO-END — real parser, real engine, hand-authored lines
// ---------------------------------------------------------------------------------------

const T = (mmss: string, text: string): string => `[Sun Aug 02 21:${mmss} 2026] ${text}`

/** Replay raw lines through the REAL parser + engine, with the spell DB installed (the
 *  message-driven buff landing path needs it, exactly as production does). */
function replay(lines: string[]): { eng: CombatEngine; lastTs: number } {
  installSpellDb(loadSpellDb())
  const eng = new CombatEngine()
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev || ev.kind === 'unknown') continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  return { eng, lastTs }
}

/** The engine's private state, reached the way the shipped combat tests reach it. */
function stateOf(eng: CombatEngine): {
  stateTimeline: StateTimeline
  zoneAgg: {
    procs: {
      swings: number
      swingsByState: Map<string, number>
      spellProcs: Map<string, SpellProcLane>
    }
  }
} {
  return (eng as unknown as { st: ReturnType<typeof stateOf> }).st
}

const GRIND = [
  T('43:00', 'You have entered Cabilis East.'),
  T('43:01', 'You begin reciting the inversion invocation.'),
  T('43:02', 'You slash a wan ghoul knight for 40 points of damage.'),
  T('43:03', 'You hit a wan ghoul knight for 102 points of magic damage by Smiting Strike.'),
  T('43:04', 'You try to backstab a wan ghoul knight, but miss!'),
  T('43:05', 'You backstab a wan ghoul knight for 88 points of damage. (Slay Undead)'),
  T('43:06', 'You begin casting Discordant Mind.'),
  T('43:07', 'You hit a wan ghoul knight for 200 points of magic damage by Discordant Mind.'),
  T('43:08', 'You slash a wan ghoul knight for 30 points of damage.')
]

test('END-TO-END: a cast-less spell effect counts as a proc, a hand-cast one does not', () => {
  const { eng } = replay(GRIND)
  const procs = stateOf(eng).zoneAgg.procs
  assert.equal(laneCount(procs.spellProcs.get('smiting strike')!), 1)
  assert.equal(procs.spellProcs.get('smiting strike')?.damage, 102)
  assert.equal(
    procs.spellProcs.has('discordant mind'),
    false,
    'cast one second earlier — inside the 12s window, so it is a cast, not a proc'
  )
})

test('END-TO-END: swings are melee + slay hits plus YOUR misses, and nothing else', () => {
  const { eng } = replay(GRIND)
  // 2 slashes + 1 slay backstab + 1 miss = 4. The two spell lines are NOT swings.
  assert.equal(stateOf(eng).zoneAgg.procs.swings, 4)
})

test('END-TO-END: the per-state split is folded on INGEST, from the state open at the line', () => {
  const { eng } = replay(GRIND)
  const procs = stateOf(eng).zoneAgg.procs
  // The invocation commits at 43:01, before any of it — so all four swings and the one proc are
  // logged under it. Both halves of a ProcLink, and neither is derivable from the event ring:
  // a zone session has no ring at all.
  assert.equal(procs.swingsByState.get('invocation:inversion'), 4)
  assert.equal(procs.swings, 4)
  assert.equal(sidesCount(procs.spellProcs.get('smiting strike')?.byState.get('invocation:inversion')), 1)
  // Nothing else was ever on, so nothing else has an exposure. An absent state is absent, not 0.
  assert.deepEqual([...procs.swingsByState.keys()], ['invocation:inversion'])
})

test('END-TO-END: every damage total is untouched by the analytics fold (law 8 tripwire)', () => {
  const { eng, lastTs } = replay(GRIND)
  const snap = eng.snapshot(lastTs + 600_000, { selectedId: 'zone' })
  // 40 + 102 + 88 + 200 + 30. The proc index counts the 102 a second time as a COUNT; it must
  // never add it to a total again.
  assert.equal(snap.selected?.outTotal, 460)
  const you = snap.selected?.entities.find((e) => e.kind === 'you')
  assert.equal(you?.total, 460)
  assert.equal(
    (you?.categories ?? []).reduce((a, c) => a + c.total, 0),
    you?.total,
    'Σ category.total == source.total, per source'
  )
})

test('END-TO-END: an invocation commit opens a span the ingest switch actually wired up', () => {
  const { eng } = replay([...GRIND, T('43:20', 'You begin reciting the spellblade invocation.')])
  const spans = stateOf(eng).stateTimeline.spans
  const inv = spans.filter((s) => s.kind === 'invocation')
  assert.deepEqual(inv.map((s) => s.key), ['inversion', 'spellblade'])
  assert.equal(inv[0].startEvidence, 'observed')
  assert.equal(inv[0].endEvidence, 'inferred')
  assert.equal(inv[1].endEvidence, 'open')
})

test('END-TO-END: the tracked buff opens on its landing line and closes on its own fade', () => {
  const { eng } = replay([
    T('43:00', 'A brilliant blue aura surrounds your weapon.'),
    T('43:02', 'You slash a wan ghoul knight for 40 points of damage.'),
    T('43:30', 'A brilliant blue aura surrounds your weapon.'),
    T('44:00', 'The brilliant blue aura fades.')
  ])
  const buffs = stateOf(eng).stateTimeline.spans.filter((s) => s.kind === 'buff')
  assert.equal(buffs.length, 2)
  assert.equal(buffs[0].name, 'Instrument of Nife')
  assert.equal(buffs[0].startEvidence, 'observed')
  assert.equal(buffs[0].endEvidence, 'inferred', 'the re-apply superseded it; no end was printed')
  assert.equal(buffs[1].endEvidence, 'observed', 'the fade line IS printed — the rare observed end')
})

test('END-TO-END: coats open spans; a dry closes utility observed and combat inferred', () => {
  const { eng } = replay([
    T('43:00', 'You coat your blades in asp venom.'),
    T('43:05', 'You coat your blades in a binding poison.'),
    T('43:30', 'The poison dries from the blade.')
  ])
  const coats = stateOf(eng).stateTimeline.spans.filter((s) => s.kind === 'coat')
  const venom = coats.find((s) => s.name === 'Asp Venom')
  const utility = coats.find((s) => s.name === 'Binding Poison')
  assert.equal(venom?.endEvidence, 'open', 'a utility dry says nothing about the combat stack')
  assert.equal(venom?.endTs, undefined)
  assert.equal(utility?.endEvidence, 'observed')
  // 21:43:30 on the authored clock — the dry line's own ts, never the observation moment.
  assert.equal(utility?.endTs, new Date('2026-08-02T21:43:30').getTime())
})

test('END-TO-END: a cast-less HEAL is a proc too, and only YOUR heals are counted', () => {
  const { eng } = replay([
    T('43:00', 'You healed Primitive for 31 hit points by Lifetap Strike.'),
    T('43:01', 'an ashenbone drake healed itself for 314 hit points by Drain Spirit.')
  ])
  const procs = stateOf(eng).zoneAgg.procs
  assert.equal(procs.spellProcs.get('lifetap strike')?.heal, 31)
  assert.equal(procs.spellProcs.has('drain spirit'), false, "another entity's proc is not ours")
})
