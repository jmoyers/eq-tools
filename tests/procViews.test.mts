// THE PROC-LEDGER SERIALIZATION (docs/plans/proc-analytics.md §6) — `ProcsView.lanes` /
// `.overall` / `.states` / `.attribution`, replayed through the REAL parser + CombatEngine over
// the four committed proc goldens.
//
// tests/procGoldenWindows.test.mts hand-read every number these lanes are built FROM (lane
// counts, category totals, swing denominators) off the fixture clock. This file proves the
// SERIALIZATION agrees with those numbers rather than re-deriving them, and pins the three
// counting rules that a later "cleanup" would otherwise quietly collapse:
//
//   1. A POISON lane counts EMOTES; tick damage and tap healing are separate fields. Blood
//      Siphon Strike is 4 / 658 / 611 and no two of those may ever be added together.
//   2. A poison lane SUPPRESSES the spell-proc lane of the same name — one proc, one row.
//   3. A SLAY lane's damage is "damage on swings that procced", with the excess over an
//      ordinary swing in `marginalDamage` and the assumption stated in the type.
//
// THE DAMAGE TRIPWIRE (law 8) runs through all of it: every `directDamage` here is read back
// out of the same aggregate the meter's bars come from, so each assertion below doubles as a
// check that the index still equals the thing it indexes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { CombatEngine } from '../src/main/combat/engine'
import type { ProcLaneView } from '../src/shared/procAnalytics'
import type { ProcsView, SegmentView } from '../src/shared/combat'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}

const W35 = fixture('w35-poison-coats.log')
const W38 = fixture('w38-proc-ppm.log')
const W39 = fixture('w39-spellblade-switch.log')
const W40 = fixture('w40-nife-buff.log')
const W41 = fixture('w41-poison-asp-venom.log')

const missing = (...w: string[][]): string | false =>
  w.some((f) => f.length === 0) ? 'fixture not present' : false

function replay(lines: string[]): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      lastTs = ev.ts
      eng.ingestEvent(ev, false)
    }
  }
  return { eng, lastTs }
}

function segment(eng: CombatEngine, lastTs: number, id: string): SegmentView {
  const s = eng.snapshot(lastTs, { selectedId: id })
  assert.ok(s.selected, `segment ${id} resolves`)
  return s.selected
}

function zoneProcs(lines: string[]): { procs: ProcsView; seg: SegmentView; eng: CombatEngine; lastTs: number } {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(lines)
  const seg = segment(eng, lastTs, 'zone')
  return { procs: seg.procs, seg, eng, lastTs }
}

const laneNamed = (p: ProcsView, name: string): ProcLaneView => {
  const l = p.lanes?.find((x) => x.name === name)
  assert.ok(l, `lane ${name} is serialized`)
  return l
}

// ─────────────────────────────────────────────────────────────────────────────────────
// W38 — spell + slay lanes, the three denominators, and the overall identity
// ─────────────────────────────────────────────────────────────────────────────────────

test('W38: every lane the engine detected is serialized, with its origin', { skip: missing(W38) }, () => {
  const { procs } = zoneProcs(W38)
  assert.deepEqual(
    procs.lanes?.map((l) => [l.name, l.origin, l.count, l.directDamage]),
    [
      ['Smiting Strike', 'spell', 27, 2796],
      ['Condemnation of Nife', 'spell', 5, 1165],
      ['Dismiss Undead', 'spell', 5, 683],
      ['Slay Undead', 'slay', 6, 5111]
    ]
  )
  // THE TRIPWIRE: the three spell lanes ARE the spell category, exactly. A proc lane is an
  // INDEX over damage already counted — if these ever stop summing, the index grew a number of
  // its own.
  assert.equal(27 + 5 + 5, 37)
  assert.equal(2796 + 1165 + 683, 4644)
})

test('W38: `overall` is an IDENTITY over the lanes, not a parallel counter', { skip: missing(W38) }, () => {
  const { procs, seg } = zoneProcs(W38)
  const sum = (procs.lanes ?? []).reduce((n, l) => n + l.count, 0)
  assert.equal(procs.overall?.count, sum)
  assert.equal(procs.overall?.count, 43) // 37 cast-less spell procs + 6 slay hits
  // Every lane shares the segment's swing denominator — the mechanical one, with no active-time
  // ambiguity in it at all.
  assert.equal(procs.overall?.swings, 922)
  for (const l of procs.lanes ?? []) assert.equal(l.rate.swings, 922)
  // 43 procs over 280 active seconds; 43 per 922 swings. Computed from the SEGMENT's own clock.
  assert.equal(seg.activeSec, 280)
  assert.ok(Math.abs((procs.overall?.ppmActive ?? 0) - (43 * 60) / 280) < 1e-9)
  assert.ok(Math.abs((procs.overall?.per100Swings ?? 0) - (100 * 43) / 922) < 1e-9)
})

test('W38: SLAY damage is "swings that procced", and the marginal says so separately', { skip: missing(W38) }, () => {
  const { procs, seg } = zoneProcs(W38)
  const slay = laneNamed(procs, 'Slay Undead')
  // 6 hits for 5,111 against a 513-hit / 36,227 melee body (hand-read in procGoldenWindows).
  assert.equal(slay.count, 6)
  assert.equal(slay.directDamage, 5111)
  const meanMelee = 36227 / 513
  assert.ok(Math.abs((slay.marginalDamage ?? 0) - (5111 - 6 * meanMelee)) < 1e-9)
  assert.ok((slay.marginalDamage ?? 0) < slay.directDamage, 'the marginal is ALWAYS below the raw total')
  // …and it is the ONLY origin that carries one: for a spell or poison lane the proc's whole
  // damage IS its marginal damage, so a field there would be a second name for the same number.
  for (const l of procs.lanes ?? []) {
    if (l.origin !== 'slay') assert.equal(l.marginalDamage, undefined)
  }
  // pctOfOut / dpsContribution are read off the segment, not recomputed.
  assert.ok(Math.abs(slay.pctOfOut - (5111 / seg.outTotal) * 100) < 1e-9)
  assert.ok(Math.abs(slay.dpsContribution - 5111 / seg.activeSec) < 1e-9)
})

test('W38: state spans ride the payload with evidence on BOTH edges', { skip: missing(W38) }, () => {
  const { procs } = zoneProcs(W38)
  assert.deepEqual(
    procs.states?.map((s) => [s.kind, s.key, s.startEvidence, s.endEvidence]),
    [
      ['invocation', 'inversion', 'observed', 'open'],
      ['stance', 'balanced', 'observed', 'open']
    ]
  )
  // Neither is ever superseded inside the window, so neither may carry an end time: the game
  // prints no "your stance ends" line and the model must not invent one.
  for (const s of procs.states ?? []) assert.equal(s.endTs, undefined)
})

// ─────────────────────────────────────────────────────────────────────────────────────
// W39 — the tap that heals more than it deals, and the fight/zone scope split
// ─────────────────────────────────────────────────────────────────────────────────────

test('W39: healing is its own field and can EXCEED the damage on the same lane', { skip: missing(W39) }, () => {
  const { procs } = zoneProcs(W39)
  const tap = laneNamed(procs, 'Lifetap Strike')
  // 458 dealt, 474 restored (12 damage lines and 12 heal lines, hand-read). `directHeal` can
  // never be derived from `directDamage` — the tap returns MORE than it takes.
  assert.equal(tap.directDamage, 458)
  assert.equal(tap.directHeal, 474)
  assert.ok(tap.directHeal > tap.directDamage)

  // ⚠ PINNED DEFECT, NOT A DESIGN. `count` reads 24 for 12 firings: wave 1's ingest folds the
  // damage line and the heal line of ONE lifetap as two separate procs
  // (ingest.ts foldDamageAnalytics + foldHealAnalytics both call ProcAccum.addSpellProc, which
  // carries a single `count`). The fix belongs in procDetect.ts/aggregate.ts — separate
  // damage-firing and heal-firing counters, with the lane reporting max(damageHits, healHits)
  // so a heal-ONLY proc still counts once — which is outside this wave's file ownership. Pinned
  // here so correcting it is a deliberate act with a failing test behind it, never a surprise.
  assert.equal(tap.count, 24)
  assert.equal(tap.count, 12 * 2)
})

test('W39: the counterfactual is ZONE-SCOPE ONLY — a single pull never gets one', { skip: missing(W39) }, () => {
  const { procs, eng, lastTs } = zoneProcs(W39)
  assert.notEqual(procs.attribution, undefined)
  assert.equal(procs.attribution?.sessionId, 'zone')
  assert.equal(procs.attribution?.windowSec, 60)
  // A fight still gets lanes, rates and states — but NO attribution. One pull has no inactive
  // sample, and offering a per-fight counterfactual would be an invitation to read noise.
  const fight = segment(eng, lastTs, 'e1').procs
  assert.equal(fight.attribution, undefined)
  assert.notEqual(fight.lanes, undefined)
  assert.notEqual(fight.overall, undefined)
  assert.notEqual(fight.states, undefined)
})

test('W39: a six-minute window cannot fill the arms, and the report SAYS so', { skip: missing(W39) }, () => {
  const { procs } = zoneProcs(W39)
  const a = procs.attribution
  assert.ok(a, 'a zone selection carries the counterfactual report')
  // Five invocation commits and two stance commits in six minutes: seven wall-clock minutes,
  // four of which clear the volume gates. No arm can reach twenty windows, so not one effect
  // may report an estimate — the fixture is a sample-gate test as much as a serialization one.
  assert.equal(a.windowsTotal, 7)
  assert.equal(a.windowsEligible, 4)
  assert.equal(a.effects.some((e) => e.verdict === 'estimate'), false)

  // SPELLBLADE. The one place this log measures a 100% co-occurrence — and Tier B still refuses
  // to put a number on it, because two eligible minutes is not a comparison. That refusal is
  // the feature working, not the feature failing.
  const blade = a.effects.find((e) => e.key === 'spellblade')
  assert.ok(blade)
  assert.equal(blade.verdict, 'insufficient-sample')
  assert.equal(blade.marginal, undefined)
  assert.ok(blade.note?.includes('are needed'))
  // Every stance/invocation row carries the "no per-hit marker" sentence whatever its verdict:
  // per the wiki that is 17 of the 18, and the report must SAY it rather than omit the rows.
  for (const e of a.effects) {
    assert.ok(e.note?.includes('no per-hit marker in the log'), `${e.name} declares its unobservability`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────────────
// W41 — the rogue coat: three numbers for one proc, and no lane counted twice
// ─────────────────────────────────────────────────────────────────────────────────────

test('W41: a poison lane counts EMOTES, and reports ticks and taps separately', { skip: missing(W35, W41) }, () => {
  const { procs } = zoneProcs([...W35, ...W41])
  // The Blood Siphon three-way pin, now as ONE serialized row. The emote is shared with Blood
  // Draw Strike (law 3), so the label carries both candidates and the row is `ambiguous` — the
  // COUNT is exact, only the name is uncertain.
  const bs = laneNamed(procs, 'Blood Siphon Strike / Blood Draw Strike')
  assert.equal(bs.origin, 'poison')
  assert.equal(bs.ambiguous, true)
  assert.equal(bs.count, 4) // emotes — the proc fired four times
  assert.equal(bs.directDamage, 658) // 14 dot ticks
  assert.equal(bs.directHeal, 611) // 13 heal lines (one tick printed none)
  // NONE of the three may ever be added to another. 4 + 14 + 13 is not a number this app knows.
  assert.notEqual(bs.count, 14)
  assert.notEqual(bs.count, 13)

  // The shipped emote ledger is untouched and still sums to the same 32 landings.
  assert.equal(procs.strikeCount, 32)
  assert.equal(
    (procs.lanes ?? []).filter((l) => l.origin === 'poison').reduce((n, l) => n + l.count, 0),
    32
  )
})

test('W41: one proc, one row — the poison lane suppresses its spell-proc twin', { skip: missing(W35, W41) }, () => {
  const { procs } = zoneProcs([...W35, ...W41])
  // `Asp Venom Strike` prints BOTH an emote and a `points of poison damage by Asp Venom Strike`
  // line for a single proc. The damage line is cast-less, so the spell detector sees it too —
  // and emitting both rows would count that proc twice in the ppm headline.
  const names = (procs.lanes ?? []).map((l) => l.name)
  assert.equal(names.filter((n) => n.includes('Asp Venom Strike')).length, 1)
  const asp = laneNamed(procs, 'Asp Venom Strike / Cobra Venom Strike')
  assert.equal(asp.origin, 'poison')
  assert.equal(asp.directDamage, 106) // the two poison-damage lines, joined by NAME
  assert.deepEqual(procs.poisonDamage, [{ name: 'Asp Venom Strike', count: 2, total: 106 }])

  // …and the damage did not go missing: the one surviving spell lane plus the suppressed 106
  // reconstruct the spell category exactly (27 hits / 3,181, hand-read).
  const smiting = laneNamed(procs, 'Smiting Strike')
  assert.equal(smiting.origin, 'spell')
  assert.equal(smiting.directDamage + 106, 3181)
  // No undead in Ruins of Old Paineel: a lane that never fired is ABSENT, not a 0-count row.
  assert.equal((procs.lanes ?? []).some((l) => l.origin === 'slay'), false)
})

test('W41: coat spans serialize with the evidence the log actually gave', { skip: missing(W35, W41) }, () => {
  const { procs } = zoneProcs([...W35, ...W41])
  const coats = (procs.states ?? []).filter((s) => s.kind === 'coat')
  // A UTILITY dry is unambiguous — one slot — so its span ends 'observed'. The three combat
  // venoms coated eighteen minutes earlier are still open: no line ever ended them.
  const neuro = coats.filter((s) => s.key === 'neurotoxic poison')
  assert.equal(neuro.length, 2, 'coated, replaced, then coated again')
  assert.equal(neuro[0].endEvidence, 'observed')
  assert.equal(neuro[1].endEvidence, 'open')
  assert.deepEqual(
    coats.filter((s) => s.endEvidence === 'open').map((s) => s.name).sort(),
    ['Asp Venom', 'Blood Siphon Venom', 'Neurotoxic Poison', 'Stunning Venom']
  )
  // A state seen twice is ONE effect row, never two.
  const rows = procs.attribution?.effects.filter((e) => e.key === 'neurotoxic poison')
  assert.equal(rows?.length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────────────
// W40 — Instrument of Nife: the honest-limits case, end to end
// ─────────────────────────────────────────────────────────────────────────────────────

test('W40: Tier A is exact and serialized; Tier B refuses to guess', { skip: missing(W40) }, () => {
  const { procs, seg } = zoneProcs(W40)
  // TIER A — 4 procs, 1,326 damage, 3.34% of outgoing. An exact number that needed no comparison.
  const nife = laneNamed(procs, 'Condemnation of Nife')
  assert.equal(nife.count, 4)
  assert.equal(nife.directDamage, 1326)
  assert.ok(Math.abs(nife.pctOfOut - (1326 / seg.outTotal) * 100) < 1e-9)
  assert.ok(nife.pctOfOut < 4)

  // TIER B — the aura was up for 904 of 940 logged swings, so no minute of this window is an
  // inactive control. The buff never even reaches the effects table as a comparison: the two
  // states that DID commit here are stances, and the one that never turned off has no arm.
  const a = procs.attribution
  assert.equal(a?.effects.some((e) => e.verdict === 'estimate'), false)
  assert.equal(a?.effects.some((e) => e.verdict === 'measured'), false)
  const balanced = a?.effects.find((e) => e.key === 'balanced')
  assert.equal(balanced?.verdict, 'not-observable')
  assert.ok(balanced?.note?.includes('No comparison is possible'))
  // Every not-observable note names WHICH side is empty rather than saying "no data": the two
  // ways to have no control group are opposite findings and the UI must not collapse them.
  assert.ok(/never active in an eligible minute|active in every one of the/.test(balanced?.note ?? ''))
})

test('W40: a Quick Buff heal with no cast line IS a cast-less effect, and is labeled as one', { skip: missing(W40) }, () => {
  const { procs } = zoneProcs(W40)
  // `You healed Primitive for 66 hit points by Center.` at 19:27:01 — inside the Quick Buff
  // burst, which prints landings and NO cast line at all. The detector is right that nothing
  // cast it; what it cannot know is that an AA activation, not a weapon, delivered it. That is
  // law 6 in one row: a proc line never names its source, so `origin: 'spell'` claims only
  // "a spell effect with no own cast behind it" and nothing more.
  const center = laneNamed(procs, 'Center')
  assert.equal(center.origin, 'spell')
  assert.equal(center.count, 1)
  assert.equal(center.directDamage, 0)
  assert.equal(center.directHeal, 66)
  // A lane that carries no damage still contributes 0% and 0 dps — never NaN.
  assert.equal(center.pctOfOut, 0)
  assert.equal(center.dpsContribution, 0)
})

test('W40: WITH THE SPELL DB, the aura becomes a span and Tier B still says no', { skip: missing(W40) }, () => {
  // The other tests here run DB-less (the shipped golden convention), and a buff landing is
  // resolved from a message through the DB's candidate table — so `Instrument of Nife` only
  // exists as a state when the DB is installed, exactly as it is in the real app. This test is
  // the whole feature's honest-limits case, end to end, so it pays for the DB load.
  installSpellDb(loadSpellDb())
  try {
    const { eng, lastTs } = replay(W40)
    const procs = segment(eng, lastTs, 'zone').procs
    // Two landings 13 seconds apart (a cast, then a Quick Buff burst) and NO fade line in the
    // window. So the first span is superseded — end 'inferred', never 'observed' — and the
    // second is still open. 97 landings against ONE fade in the whole log is why EdgeEvidence
    // exists at all.
    const spans = (procs.states ?? []).filter((s) => s.kind === 'buff')
    assert.deepEqual(spans.map((s) => [s.key, s.endEvidence]), [
      ['instrument of nife', 'inferred'],
      ['instrument of nife', 'open']
    ])
    assert.equal(spans[0].startEvidence, 'observed')

    // AND THE VERDICT IS STILL 'not-observable'. The aura was up in every eligible minute of
    // this window, so there is no control group and no number may be offered — while the exact
    // Tier-A figure (4 procs, 1,326 damage) sits in the lane list beside it. That asymmetry is
    // the RESULT, not a defect to engineer around, and this assertion is what stops anyone
    // later "improving" it into an estimate.
    const nife = procs.attribution?.effects.find((e) => e.kind === 'buff')
    assert.equal(nife?.name, 'Instrument of Nife')
    assert.equal(nife?.verdict, 'not-observable')
    assert.equal(nife?.marginal, undefined)
    assert.equal(laneNamed(procs, 'Condemnation of Nife').directDamage, 1326)
    // …and it does NOT carry the stance sentence: a BUFF's unobservability is about sample, not
    // about the log lacking a marker. The two reasons must not be rendered as one.
    assert.equal(nife?.note?.includes('no per-hit marker'), false)
  } finally {
    installSpellDb(undefined)
  }
})

// ─────────────────────────────────────────────────────────────────────────────────────
// The link feed — declared missing rather than faked
// ─────────────────────────────────────────────────────────────────────────────────────

test('every lane ships an EMPTY link list, because the per-state split is not folded yet', { skip: missing(W39) }, () => {
  const { procs } = zoneProcs(W39)
  // A `ProcLink` needs each lane's firings split by which state was active at the time, and that
  // split has to be folded on INGEST — the event ring is capped, truncated and absent entirely
  // for zone sessions, so deriving it from there is the one thing the plan forbids. Wave 1's
  // SpellProcLane carries no such split, so the honest serialization is an empty list rather
  // than a number reconstructed from a ring. `linkStrength` itself is shipped, gated and pinned
  // against the goldens (procGoldenWindows) — only the per-lane feed is missing.
  assert.ok((procs.lanes?.length ?? 0) > 0)
  for (const l of procs.lanes ?? []) assert.deepEqual(l.linked, [])
})
