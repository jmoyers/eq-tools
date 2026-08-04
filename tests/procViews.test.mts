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
import { addSpellProc, laneCount } from '../src/main/combat/procDetect'
import type { SpellProcLane } from '../src/main/combat/procDetect'
import type { EffectAttribution, ProcLaneView } from '../src/shared/procAnalytics'
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

  // THE DEFECT WAVE 2 PINNED, NOW CORRECTED. One lifetap prints a damage line AND a heal line,
  // and wave 1's single `count` was bumped from both ingest paths — so twelve firings reported
  // 24. `SpellProcLane` now counts the two sides apart and the lane takes the LARGER
  // (procDetect.laneCount): twelve damage lines, twelve heal lines, TWELVE firings.
  assert.equal(tap.count, 12)
  assert.notEqual(tap.count, 12 * 2)
  // The damage and healing TOTALS were never wrong and did not move — only the firing count did.
  assert.equal(tap.directDamage + tap.directHeal, 458 + 474)
  // …and the ppm headline follows the count, so the fix reaches every rate the lane reports.
  assert.equal(tap.rate.count, 12)
})

test('a heal-ONLY proc still counts once — max, never the damage side alone', () => {
  // The other half of the same rule. It used to be pinned on w40's `Center`, which is no longer
  // a lane at all (the next test says why), so it is pinned where the rule actually lives: a
  // lane whose firings printed ONLY heal lines counts them, because counting damage lines alone
  // would erase it. `Blood Siphon Strike` in w41 is the real shape — 13 heal lines, 0 damage
  // lines on the spell-proc side — and the rule is `max`, never `damageHits`.
  const lanes = new Map<string, SpellProcLane>()
  for (let i = 0; i < 13; i++) {
    addSpellProc(lanes, { spell: 'Center', amount: 66, isHeal: true, active: new Set<string>() })
  }
  const lane = lanes.get('center')
  assert.ok(lane)
  assert.equal(lane.hits.damage, 0)
  assert.equal(lane.hits.heal, 13)
  assert.equal(laneCount(lane), 13)
})

test('W40: a Quick Buff burst is CAST EVIDENCE — its landings are not procs', { skip: missing(W40) }, () => {
  // `You activate Quick Buff.` at 19:26:58, then at 19:27:01 `You healed Primitive for 66 hit
  // points by Center.` with no cast line anywhere. Wave 1 called that a cast-less effect and
  // said so in this test's old name; the owner's report is what settled it. The AA re-applies
  // every memorized buff and prints ONLY the landings — six buff spells, 254 phantom "procs"
  // across the real log, every one of them inside five seconds of that activation line, and not
  // one true proc inside the same window (procDetect's header carries the sweep).
  //
  // So the burst is cast evidence in a different shape, and `Center` is a buff the player cast.
  const { procs } = zoneProcs(W40)
  assert.equal(
    (procs.lanes ?? []).some((l) => l.name === 'Center'),
    false
  )
  // The aura landing in the SAME burst is still a state span, and the weapon procs around it
  // are still procs: the gate suppresses the heal inference only, and only inside the burst.
  assert.equal(laneNamed(procs, 'Smiting Strike').count, 28)
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

  // SPELLBLADE. Tier B still refuses to put a number on it — two eligible minutes is not a
  // comparison — but TIER A now answers instead, exactly: one lane fired only under it, at real
  // exposure. `measured` is not a Tier-B estimate and never carries a `marginal`.
  const blade = a.effects.find((e) => e.key === 'spellblade')
  assert.ok(blade)
  assert.equal(blade.verdict, 'measured')
  assert.equal(blade.marginal, undefined)
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

test('W40: a lane that carries no damage contributes 0% and 0 dps — never NaN', { skip: missing(W40) }, () => {
  // The arithmetic this used to prove on `Center` (now suppressed as a Quick Buff landing) is
  // still worth pinning, so it moves to a lane the window still has: every lane divides by the
  // segment's totals, and a zero numerator must produce 0 and not NaN.
  const { procs } = zoneProcs(W40)
  for (const l of procs.lanes ?? []) {
    assert.ok(Number.isFinite(l.pctOfOut), `${l.name} pctOfOut is finite`)
    assert.ok(Number.isFinite(l.dpsContribution), `${l.name} dpsContribution is finite`)
  }
  const slay = laneNamed(procs, 'Slay Undead')
  assert.equal(slay.directHeal, 0)
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
// The link feed — folded on ingest, and it agrees with the hand-read split
// ─────────────────────────────────────────────────────────────────────────────────────

test('W39: the per-state split reproduces the hand-read spellblade partition exactly', { skip: missing(W39) }, () => {
  const { procs } = zoneProcs(W39)
  // procGoldenWindows hand-split this fixture on the spellblade span 16:08:56 → 16:11:19: 406
  // swings inside, 225 outside, 631 total. The ingest-folded exposure must land on the same 225
  // — the whole link surface rests on that denominator, and a re-derivation from the (capped,
  // zone-less) event ring is exactly what folding on ingest exists to avoid.
  const dm = laneNamed(procs, 'Discordant Mind')
  const blade = dm.linked.find((l) => l.key === 'spellblade')
  assert.ok(blade)
  assert.equal(blade.inactiveSwings, 225)
  assert.equal(procs.overall?.swings, 631)
  // 14 firings, every one of them under spellblade — and it is the EXPOSURE, not the ratio,
  // that earns 'exclusive' (225 swings at 14/406 predict ~7.8 firings; seeing zero is a
  // measurement). Pinned in procGoldenWindows against these same numbers.
  assert.equal(blade.withCount, 14)
  assert.equal(blade.withoutCount, 0)
  assert.equal(blade.concentration, 1)
  assert.equal(blade.strength, 'exclusive')

  // The same fixture separates the classifier's other verdicts on its OTHER lanes, so one window
  // proves all four are reachable rather than just the interesting one.
  const strength = (lane: string, key: string): string | undefined =>
    laneNamed(procs, lane).linked.find((l) => l.key === key)?.strength
  assert.equal(strength('Smiting Strike', 'spellblade'), 'weak') // 13 / 7 — fires on both sides
  assert.equal(strength('Lifetap Strike', 'offensive'), 'correlated') // 11 / 1 — 92%
  assert.equal(strength('Condemnation of Nife', 'spellblade'), 'weak') // 0 / 6 — the reverse
})

test('W39: every state gets a row on every spell lane, and only spell lanes get rows', { skip: missing(W39) }, () => {
  const { procs } = zoneProcs(W39)
  const states = new Set((procs.states ?? []).map((s) => `${s.kind}:${s.key}`))
  assert.equal(states.size, 6) // 4 invocations + 2 stances, deduped across seven spans
  for (const l of procs.lanes ?? []) {
    if (l.origin !== 'spell') {
      // A SLAY lane's count comes from the damage taxonomy, not a proc fold, and its damage is
      // "damage on swings that procced" — rolling that up as a state's exact contribution would
      // overstate it by a whole swing each. Absent, not zero-filled.
      assert.deepEqual(l.linked, [], `${l.name} (${l.origin}) has no per-state fold`)
      continue
    }
    assert.equal(l.linked.length, states.size, `${l.name} reports every state, none omitted`)
    // withCount + withoutCount is the lane's own count on EVERY row — the split is a partition
    // of the same firings, never a second counter that can drift from it.
    for (const k of l.linked) assert.equal(k.withCount + k.withoutCount, l.count)
  }
})

/** One effect row of a zone selection's Tier-B report. */
const effectNamed = (p: ProcsView, key: string): EffectAttribution => {
  const e = p.attribution?.effects.find((x) => x.key === key)
  assert.ok(e, `effect ${key} is reported`)
  return e
}

test('W39: TIER A reaches `measured`, and the roll-up IS the lane', { skip: missing(W39) }, () => {
  const { procs, seg } = zoneProcs(W39)
  const blade = effectNamed(procs, 'spellblade')
  assert.equal(blade.verdict, 'measured')
  // 14 firings, 5,482 damage, no healing — the lane's own numbers, named so they are auditable.
  assert.deepEqual(blade.direct.lanes, ['Discordant Mind'])
  assert.equal(blade.direct.hits, 14)
  assert.equal(blade.direct.damage, 5482)
  assert.equal(blade.direct.damage, laneNamed(procs, 'Discordant Mind').directDamage)
  assert.ok(Math.abs(blade.direct.dpsContribution - 5482 / seg.activeSec) < 1e-9)
  // A measured verdict is a COUNT, so it never carries a window estimate beside it.
  assert.equal(blade.marginal, undefined)
})

test('W39: two states switched on together each DECLARE the other', { skip: missing(W39) }, () => {
  const { procs } = zoneProcs(W39)
  // `offensive` was committed three seconds after spellblade and covers the same fourteen
  // firings, so BOTH rows measure the same 5,482 damage. Each must name the other: two rows
  // silently claiming one body of evidence is how a proc meter double-counts a session.
  const blade = effectNamed(procs, 'spellblade')
  const off = effectNamed(procs, 'offensive')
  assert.equal(off.verdict, 'measured')
  assert.equal(off.direct.damage, 5482)
  assert.ok(blade.confounds.some((c) => c.startsWith('co-exclusive') && c.includes('offensive')))
  assert.ok(off.confounds.some((c) => c.startsWith('co-exclusive') && c.includes('spellblade')))
})

test('W40: exclusivity still cannot be bought with concentration alone', { skip: missing(W40) }, () => {
  // The honest-limits case, now through the link feed. Condemnation of Nife fired 4 times with
  // the aura up and never without — a 100% concentration — against 36 inactive swings, which at
  // the lane's own rate predict 0.16 firings. 'inconclusive', so no state reaches 'measured'
  // anywhere in this window. This is the assertion that stops the gate being loosened.
  installSpellDb(loadSpellDb())
  try {
    const { eng, lastTs } = replay(W40)
    const procs = segment(eng, lastTs, 'zone').procs
    const nife = laneNamed(procs, 'Condemnation of Nife').linked.find((l) => l.kind === 'buff')
    assert.equal(nife?.name, 'Instrument of Nife')
    assert.equal(nife?.withCount, 4)
    assert.equal(nife?.withoutCount, 0)
    assert.equal(nife?.concentration, 1)
    assert.equal(nife?.inactiveSwings, 36)
    assert.equal(nife?.strength, 'inconclusive')
    assert.equal(procs.attribution?.effects.some((e) => e.verdict === 'measured'), false)
  } finally {
    installSpellDb(undefined)
  }
})

test('W41: a poison lane keeps an EMPTY link list, because the link would be tautological', { skip: missing(W35, W41) }, () => {
  const { procs } = zoneProcs([...W35, ...W41])
  // An Asp Venom Strike cannot fire without asp venom on the blade. 'exclusive' there would
  // restate the mechanic rather than measure anything, so the poison lanes carry no rows at all
  // — and no coat reaches 'measured' off the back of one.
  for (const l of procs.lanes ?? []) {
    if (l.origin === 'poison') assert.deepEqual(l.linked, [])
  }
  const coats = procs.attribution?.effects.filter((e) => e.kind === 'coat') ?? []
  assert.ok(coats.length > 0)
  assert.equal(coats.some((e) => e.verdict === 'measured'), false)
})
