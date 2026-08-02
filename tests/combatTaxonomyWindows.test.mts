// Golden-window tests for the combat taxonomy + stances + timeline (Task #51).
//
// Methodology (the user's mandate — see AGENTS.md "Golden-window testing"): LOCATE a real
// span in eqlog_Primitive_freeport.txt, READ it line-by-line, extract it VERBATIM, replay
// it through the REAL parser + CombatEngine, and assert the model against hand-verified
// numbers. This window is the Gynok Moltor fight (Jul 19 15:50–15:52): the player has a
// claimed pet (Gibober), assumes a defensive stance + recovery invocation, then fights the
// undead named Gynok with melee + a Slay Undead proc + two direct spells.
//
// HAND-VERIFIED You-outgoing taxonomy (summed from the raw lines below):
//   melee: crush/smite→Melee 7+22+2+18+22+22 = 93, Kick 10+9+7 = 26  → 119 (9 hits)
//   slay:  the one "(Slay Undead)" crush                              →  75 (1 hit)
//   spell: Smiting Strike 63+63 = 126, Vampiric Embrace 29+29 = 58    → 184 (4 hits)
//   TOTAL = 378 — and melee+slay+spell MUST sum EXACTLY to 378 (the taxonomy tripwire).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { parseModifiers, damageCategory } from '../src/main/combat/taxonomy'

const FULL_LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

const WINDOW: string[] = [
  "[Sun Jul 19 15:46:28 2026] Gibober told you, 'Attacking an elf skeleton Master.'",
  '[Sun Jul 19 15:50:36 2026] You assume a defensive stance.',
  '[Sun Jul 19 15:50:37 2026] You begin reciting the recovery invocation.',
  '[Sun Jul 19 15:51:28 2026] You smite Gynok Moltor for 7 points of damage.',
  '[Sun Jul 19 15:51:28 2026] You hit Gynok Moltor for 63 points of magic damage by Smiting Strike.',
  '[Sun Jul 19 15:51:28 2026] You kick Gynok Moltor for 10 points of damage.',
  '[Sun Jul 19 15:51:29 2026] You hit Gynok Moltor for 29 points of magic damage by Vampiric Embrace.',
  '[Sun Jul 19 15:51:29 2026] You crush Gynok Moltor for 22 points of damage.',
  '[Sun Jul 19 15:51:31 2026] Gibober crushes Gynok Moltor for 19 points of damage.',
  '[Sun Jul 19 15:51:36 2026] You kick Gynok Moltor for 9 points of damage.',
  '[Sun Jul 19 15:51:37 2026] You crush Gynok Moltor for 2 points of damage.',
  '[Sun Jul 19 15:51:40 2026] You hit Gynok Moltor for 29 points of magic damage by Vampiric Embrace.',
  '[Sun Jul 19 15:51:40 2026] You crush Gynok Moltor for 18 points of damage.',
  '[Sun Jul 19 15:51:42 2026] You smite Gynok Moltor for 22 points of damage.',
  '[Sun Jul 19 15:51:42 2026] You hit Gynok Moltor for 63 points of magic damage by Smiting Strike.',
  '[Sun Jul 19 15:51:42 2026] You crush Gynok Moltor for 75 points of damage. (Slay Undead)',
  '[Sun Jul 19 15:51:42 2026] You crush Gynok Moltor for 22 points of damage.',
  '[Sun Jul 19 15:51:44 2026] You kick Gynok Moltor for 7 points of damage.',
  '[Sun Jul 19 15:52:06 2026] Gynok Moltor has been slain by Gibober!'
]

function replay(): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of WINDOW) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      eng.ingestEvent(ev, false)
      lastTs = ev.ts
    }
  }
  return { eng, lastTs }
}

test('taxonomy: parseModifiers splits compound paren modifiers', () => {
  assert.deepEqual(parseModifiers('Riposte Critical'), ['Riposte', 'Critical'])
  assert.deepEqual(parseModifiers('Riposte Slay Undead'), ['Slay Undead', 'Riposte'])
  assert.deepEqual(parseModifiers('Finishing Blow'), ['Finishing Blow'])
  assert.deepEqual(parseModifiers(undefined), [])
})

test('taxonomy: a Slay Undead melee hit categorizes as slay, plain melee stays melee', () => {
  assert.equal(damageCategory('melee', ['Slay Undead']), 'slay')
  assert.equal(damageCategory('melee', ['Critical']), 'melee')
  assert.equal(damageCategory('spell', ['Critical']), 'spell')
  assert.equal(damageCategory('dot', []), 'dot')
})

test('W-tax1: Gynok window — You-outgoing category totals sum EXACTLY to the total (tripwire)', () => {
  const { eng, lastTs } = replay()
  const snap = eng.snapshot(lastTs + 6000, { selectedId: 'zone' })
  const you = snap.selected!.entities.find((e) => e.id === 'you')
  assert.ok(you, 'You is an outgoing source')

  const byCat = new Map(you!.categories.map((c) => [c.category, c]))
  assert.equal(byCat.get('melee')?.total, 119, 'melee total (hand-verified)')
  assert.equal(byCat.get('melee')?.hits, 9)
  assert.equal(byCat.get('slay')?.total, 75, 'Slay Undead is its own category')
  assert.equal(byCat.get('slay')?.hits, 1)
  assert.equal(byCat.get('spell')?.total, 184, 'direct spells total')
  assert.equal(byCat.get('spell')?.hits, 4)

  // The tripwire: the category dimension is a partition — it re-sums to the source total.
  const catSum = you!.categories.reduce((s, c) => s + c.total, 0)
  assert.equal(catSum, you!.total, 'category sum == source total (EXACT)')
  assert.equal(you!.total, 378)
})

test('W-tax1: level-3 per-skill breakdown within the spell category', () => {
  const { eng, lastTs } = replay()
  const snap = eng.snapshot(lastTs + 6000, { selectedId: 'zone' })
  const you = snap.selected!.entities.find((e) => e.id === 'you')!
  const spell = you.categories.find((c) => c.category === 'spell')!
  const skills = new Map(spell.skills.map((s) => [s.name, s]))
  assert.equal(skills.get('Smiting Strike')?.total, 126)
  assert.equal(skills.get('Vampiric Embrace')?.total, 58)
})

/**
 * Per-skill MIN/MAX (the skill-bar stat summary). Hand-read straight off the WINDOW lines
 * above — every landed amount, per lane:
 *   melee 'Melee' (smite/crush): 7, 22, 2, 18, 22, 22          → min  2 / max 22 (6 hits)
 *   melee 'Kick':                10, 9, 7                      → min  7 / max 10 (3 hits)
 *   slay  'Melee' (the one Slay Undead crush): 75              → min 75 / max 75 (1 hit)
 *   spell 'Smiting Strike':      63, 63                        → min 63 / max 63 (2 hits)
 *   spell 'Vampiric Embrace':    29, 29                        → min 29 / max 29 (2 hits)
 * The single-value lanes are the "min === max collapses to just max" case the UI relies on.
 */
test('W-tax1: per-skill min tracks the smallest LANDED hit, next to max', () => {
  const { eng, lastTs } = replay()
  const snap = eng.snapshot(lastTs + 6000, { selectedId: 'zone' })
  const you = snap.selected!.entities.find((e) => e.id === 'you')!
  const cat = (c: string): Map<string, { min?: number; max: number; hits: number }> =>
    new Map(you.categories.find((x) => x.category === c)!.skills.map((s) => [s.name, s]))

  const melee = cat('melee')
  assert.equal(melee.get('Melee')?.min, 2, 'smallest crush in the window')
  assert.equal(melee.get('Melee')?.max, 22)
  assert.equal(melee.get('Kick')?.min, 7)
  assert.equal(melee.get('Kick')?.max, 10)

  // Slay Undead is its own lane: one 75 hit, so min === max (the UI collapses it to "max 75").
  const slay = cat('slay')
  assert.equal(slay.get('Melee')?.min, 75)
  assert.equal(slay.get('Melee')?.max, 75)

  const spell = cat('spell')
  assert.equal(spell.get('Smiting Strike')?.min, 63)
  assert.equal(spell.get('Vampiric Embrace')?.min, 29)

  // The source-level lane merges melee + slay under the same skill name ("Melee"), so its min
  // is the melee 2 and its max the slay 75 — the aggregation is per (lane) there by design.
  const top = new Map(you.skills.map((s) => [s.name, s]))
  assert.equal(top.get('Melee')?.min, 2)
  assert.equal(top.get('Melee')?.max, 75)

  // Totals are untouched by the additive field (the tripwire again).
  assert.equal(you.total, 378)
})

test('W-tax1: melee-rounds heuristic is an honest cluster distribution', () => {
  const { eng, lastTs } = replay()
  const snap = eng.snapshot(lastTs + 6000, { selectedId: 'zone' })
  const you = snap.selected!.entities.find((e) => e.id === 'you')!
  assert.ok(you.rounds, 'melee hits produce a rounds view')
  // Rounds only cluster melee/slay hits; the histogram totals must equal the melee+slay
  // hit count (9 melee + 1 slay = 10 hits across the observed second-buckets).
  const totalHits = you.rounds!.histogram.reduce((s, n, i) => s + n * (i + 1), 0)
  assert.equal(totalHits, 10)
  assert.ok(you.rounds!.maxHitsInRound >= 1)
})

test('W-tax1: stance + invocation state is tracked and current', () => {
  const { eng, lastTs } = replay()
  const snap = eng.snapshot(lastTs + 6000, {})
  assert.equal(snap.stance.stance, 'defensive')
  assert.equal(snap.stance.invocation, 'recovery')
})

test('W-tax1: the timeline pins the stance + invocation spans and lanes the skills', () => {
  const { eng, lastTs } = replay()
  const snap = eng.snapshot(lastTs + 6000, { timeline: true })
  const tl = snap.timeline
  assert.ok(tl, 'a fight is selected with a timeline')
  // Both pinned groups present, both starting at t=0 (inherited into the fight).
  const groups = new Set(tl!.stanceSpans.map((s) => s.group))
  assert.ok(groups.has('stance') && groups.has('invocation'))
  for (const s of tl!.stanceSpans) assert.equal(s.start, 0)
  // Lanes are the skill/spell names, ordered melee-category first.
  assert.ok(tl!.lanes.length > 0)
  assert.ok(tl!.events.length > 0)
  assert.ok(!tl!.downsampled, 'a tiny fight is not downsampled')
})

// ============================================================================
// Task #51 v2 — miss/resist as first-class timeline events + drill-down rates.
//
// Golden window: the real Jul 30 21:55:30–37 fight vs "Initiate Sirlis" (Primitive
// mezzing an adjacent "A revenant" that RESISTS Mesmerization III — a rank-suffixed
// spell). The leading slash (21:55:30, real) opens the encounter BEFORE the mez lands —
// faithful to the log (You were already meleeing Sirlis; see AGENTS.md). Hand-verified
// You-outgoing from the raw lines below:
//   melee HITS:   slash 83 (Riposte Critical → crit) + kick 106 + kick 106 + smite 2
//                 = 297 (4 hits, 1 crit)
//   melee MISSES: 9 whiffs (slash/bash/bash/kick/claw/slash/slash/claw/strike, all 'miss')
//   spell HITS:   Condemnation of Nife 243 + Smiting Strike 165 = 408 (2 hits)
//   RESIST:       "A revenant resisted your Mesmerization III!" = 1 resist, lane
//                 "Mesmerization III" (rank suffix preserved in the display lane).
//   You total damage = 705 (unchanged by the resist — the tripwire). melee hitPct =
//   4/(4+9) ≈ 30.8%. spell resistPct = 1/(2+1) = 33.3%.
// ============================================================================
const RESIST_WINDOW: string[] = [
  '[Thu Jul 30 21:55:30 2026] You slash Initiate Sirlis for 83 points of damage. (Riposte Critical)',
  '[Thu Jul 30 21:55:32 2026] You begin casting Mesmerization III.',
  '[Thu Jul 30 21:55:33 2026] A revenant resisted your Mesmerization III!',
  '[Thu Jul 30 21:55:33 2026] You try to slash Initiate Sirlis, but miss!',
  '[Thu Jul 30 21:55:33 2026] You try to bash Initiate Sirlis, but miss!',
  '[Thu Jul 30 21:55:33 2026] You try to bash Initiate Sirlis, but miss!',
  '[Thu Jul 30 21:55:34 2026] You kick Initiate Sirlis for 106 points of damage.',
  '[Thu Jul 30 21:55:34 2026] You kick Initiate Sirlis for 106 points of damage.',
  '[Thu Jul 30 21:55:34 2026] You try to kick Initiate Sirlis, but miss!',
  '[Thu Jul 30 21:55:34 2026] You try to claw Initiate Sirlis, but miss!',
  '[Thu Jul 30 21:55:35 2026] You hit Initiate Sirlis for 243 points of magic damage by Condemnation of Nife.',
  '[Thu Jul 30 21:55:35 2026] You try to slash Initiate Sirlis, but miss!',
  '[Thu Jul 30 21:55:35 2026] You try to slash Initiate Sirlis, but miss!',
  '[Thu Jul 30 21:55:37 2026] You try to claw Initiate Sirlis, but miss!',
  '[Thu Jul 30 21:55:37 2026] You try to strike Initiate Sirlis, but miss!',
  '[Thu Jul 30 21:55:37 2026] You smite Initiate Sirlis for 2 points of damage.',
  '[Thu Jul 30 21:55:37 2026] You hit Initiate Sirlis for 165 points of magic damage by Smiting Strike.'
]

function replayResist(): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of RESIST_WINDOW) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      eng.ingestEvent(ev, false)
      lastTs = ev.ts
    }
  }
  return { eng, lastTs }
}

test('parser: the three resist shapes (yours / caster / incoming) with rank suffix', () => {
  const yours = parseEvent('[Thu Jul 30 21:55:33 2026] A revenant resisted your Mesmerization III!', 0)
  assert.equal(yours?.kind, 'resist')
  assert.deepEqual(
    yours?.kind === 'resist' ? { caster: yours.caster, target: yours.target, spell: yours.spell, incoming: yours.incoming } : null,
    { caster: 'you', target: 'A revenant', spell: 'Mesmerization III', incoming: false }
  )
  // A spell name that itself contains "'s" must NOT be mis-split as a caster possessive.
  const denon = parseEvent("[Thu Jul 30 21:55:33 2026] A willowisp resisted your Denon's Disruptive Discord!", 0)
  assert.equal(denon?.kind === 'resist' && denon.spell, "Denon's Disruptive Discord")
  assert.equal(denon?.kind === 'resist' && denon.caster, 'you')
  const caster = parseEvent("[Thu Jul 30 21:55:33 2026] A hardened skeleton resisted Giber's Disease Cloud!", 0)
  assert.equal(caster?.kind === 'resist' && caster.caster, 'Giber')
  assert.equal(caster?.kind === 'resist' && caster.incoming, false)
  const incoming = parseEvent("[Thu Jul 30 21:55:33 2026] You resist a ghoul's Ghoul Root!", 0)
  assert.equal(incoming?.kind, 'resist')
  assert.equal(incoming?.kind === 'resist' && incoming.incoming, true)
  assert.equal(incoming?.kind === 'resist' && incoming.target, 'You')
})

test('W-res1: resist is a lane + a rate, and does NOT move the damage total (tripwire)', () => {
  const { eng, lastTs } = replayResist()
  const snap = eng.snapshot(lastTs + 6000, {})
  const you = snap.selected!.entities.find((e) => e.id === 'you')!
  // Damage total is byte-identical to the sum of landed hits (resist adds nothing).
  assert.equal(you.total, 705, 'You total damage unchanged by the resist')
  const catSum = you.categories.reduce((s, c) => s + c.total, 0)
  assert.equal(catSum, you.total, 'category sum == total (resist carries no amount)')
  // Source-level resist rate: 1 resist / (2 spell casts landed + 1 resist) = 33.3%.
  assert.equal(you.resists, 1)
  assert.ok(Math.abs(you.resistPct - (1 / 3) * 100) < 0.01, `resistPct ~33.3 (got ${you.resistPct})`)
  // Accuracy: hitPct = hits / (hits + misses) over ALL landed hits (6: 4 melee + 2 spell)
  // vs 9 avoided swings = 6/15 = 40% (the pre-existing hitPct semantics — spell hits count
  // toward the denominator; the per-category melee row is where a pure melee rate lives).
  assert.equal(you.misses, 9)
  assert.equal(you.missBreakdown.miss, 9)
  assert.equal(Math.round(you.hitPct), 40)
  // The spell CATEGORY carries the resist; the resisted spell appears as its own lane
  // with 0 hits + 1 resist (an always-resisted spell still shows a row).
  const spell = you.categories.find((c) => c.category === 'spell')!
  assert.equal(spell.resists, 1)
  assert.ok(Math.abs(spell.resistPct - (1 / 3) * 100) < 0.01)
  const mez = spell.skills.find((s) => s.name === 'Mesmerization III')
  assert.ok(mez, 'the resisted mez is a lane in the spell category')
  assert.equal(mez!.hits, 0)
  assert.equal(mez!.resists, 1)
})

/**
 * min is over LANDED amounts only. This window is the proof: nine avoided swings and one
 * fully-resisted spell, none of which carries an amount — so the melee lane's min stays the
 * real smallest hit (the 2-damage smite) and the resist-only mez lane reports NO min at all
 * rather than a fabricated 0. Hand-read from RESIST_WINDOW:
 *   'Melee' (slash 83 + smite 2)  → min  2 / max  83, plus 9 misses
 *   'Kick'  (106, 106)            → min 106 / max 106  (min === max)
 *   'Mesmerization III'           → 0 hits, 1 resist   → min undefined
 */
test('W-res1: misses and resists never fabricate a min of 0', () => {
  const { eng, lastTs } = replayResist()
  const snap = eng.snapshot(lastTs + 6000, {})
  const you = snap.selected!.entities.find((e) => e.id === 'you')!
  const top = new Map(you.skills.map((s) => [s.name, s]))
  assert.equal(top.get('Melee')?.misses, 9, 'the whiffs bucket under the Melee lane')
  assert.equal(top.get('Melee')?.min, 2, 'nine whiffs did NOT pull the minimum to 0')
  assert.equal(top.get('Melee')?.max, 83)
  assert.equal(top.get('Kick')?.min, 106)
  assert.equal(top.get('Kick')?.max, 106)
  const mez = you.categories.find((c) => c.category === 'spell')!.skills.find((s) => s.name === 'Mesmerization III')!
  assert.equal(mez.hits, 0)
  assert.equal(mez.resists, 1)
  assert.equal(mez.min, undefined, 'a lane that only ever resisted has no smallest landed hit')
  assert.equal(you.total, 705, 'damage total still byte-identical')
})

test('W-res1: the timeline carries a resist tick + a miss tick, each attributed', () => {
  const { eng, lastTs } = replayResist()
  const snap = eng.snapshot(lastTs + 6000, { timeline: true })
  const tl = snap.timeline!
  const resistTicks = tl.events.filter((e) => e.outcome === 'resist')
  const missTicks = tl.events.filter((e) => e.outcome === 'miss')
  assert.equal(resistTicks.length, 1, 'one resist tick')
  assert.equal(resistTicks[0].lane, 'Mesmerization III', 'resist lands in the mez lane')
  assert.equal(resistTicks[0].amount, 0)
  assert.equal(resistTicks[0].target, 'A revenant')
  assert.equal(resistTicks[0].kind, 'you')
  assert.equal(missTicks.length, 9, 'nine melee miss ticks')
  assert.ok(missTicks.every((m) => m.lane === 'Melee' && m.amount === 0))
  // The mez lane exists in the Y-axis lanes even though it only ever resisted.
  assert.ok(tl.lanes.some((l) => l.lane === 'Mesmerization III'))
})

// ---- full-log tripwires (skipped when the real log is absent) ----

test('full-log: category totals sum EXACTLY to source totals (the taxonomy tripwire)', { skip: !existsSync(FULL_LOG) }, () => {
  const lines = readFileSync(FULL_LOG, 'utf8').split(/\r?\n/)
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) eng.ingestEvent(ev, false)
  }
  const snap = eng.snapshot(Date.now(), { selectedId: 'zone' })
  for (const e of snap.selected!.entities) {
    const catSum = e.categories.reduce((s, c) => s + c.total, 0)
    assert.equal(catSum, e.total, `outgoing ${e.name}: category sum == total`)
  }
  for (const e of snap.selected!.incoming) {
    const catSum = e.categories.reduce((s, c) => s + c.total, 0)
    assert.equal(catSum, e.total, `incoming ${e.name}: category sum == total`)
  }
})

test('full-log: resist events parse in bulk AND never move a damage total (the v2 tripwire)', { skip: !existsSync(FULL_LOG) }, () => {
  const lines = readFileSync(FULL_LOG, 'utf8').split(/\r?\n/)
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let parsedResists = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    if (ev.kind === 'resist') parsedResists++
    eng.ingestEvent(ev, false)
  }
  // The parser recognizes the full resist family (>5k in this log family). Reported split
  // (you / pet / other / incoming) is in AGENTS.md; here we just assert bulk recognition and
  // that NO resist ever contaminated a damage total (the zone aggregate's category sums).
  assert.ok(parsedResists > 5000, `bulk resist recognition (got ${parsedResists})`)
  const snap = eng.snapshot(Date.now(), { selectedId: 'zone' })
  for (const e of [...snap.selected!.entities, ...snap.selected!.incoming]) {
    const catSum = e.categories.reduce((s, c) => s + c.total, 0)
    assert.equal(catSum, e.total, `${e.name}: resists left the damage total byte-identical`)
    // resistPct is a rate over casts, never negative / >100.
    assert.ok(e.resistPct >= 0 && e.resistPct <= 100)
  }
})

test('full-log: stance + invocation sweep finds all verified names', { skip: !existsSync(FULL_LOG) }, () => {
  const lines = readFileSync(FULL_LOG, 'utf8').split(/\r?\n/)
  const stances = new Set<string>()
  const invocations = new Set<string>()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev?.kind === 'stanceChange') stances.add(ev.stance)
    if (ev?.kind === 'invocationChange') invocations.add(ev.invocation)
  }
  // 9 verified stances + 9 verified invocations (the sweep found more than the brief's 5+5).
  for (const s of ['defensive', 'offensive', 'balanced', 'mage hunter', 'evasive', 'striker', 'berserker', 'channeler', 'ranged'])
    assert.ok(stances.has(s), `stance "${s}" observed`)
  for (const i of ['inversion', 'overchannel', 'recovery', 'spellblade', 'divine', 'inviolable', 'empowering', 'arcane mastery', 'unyielding'])
    assert.ok(invocations.has(i), `invocation "${i}" observed`)
})

test('full-log: per-encounter timeline ring is memory-bounded (drop-oldest across the session)', { skip: !existsSync(FULL_LOG) }, () => {
  const lines = readFileSync(FULL_LOG, 'utf8').split(/\r?\n/)
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) eng.ingestEvent(ev, false)
  }
  eng.snapshot(Date.now(), {})
  // Reflect into the private history to count retained rings (a whole-session bound check).
  const anyEng = eng as unknown as { history: Array<{ events: unknown[] }>; current: { events: unknown[] } | null }
  let withRing = 0
  let retained = 0
  for (const h of anyEng.history) {
    if (h.events.length) {
      withRing++
      retained += h.events.length
    }
  }
  if (anyEng.current) retained += anyEng.current.events.length
  // Thousands of fights replay, but only the most recent handful keep their event ring.
  assert.ok(anyEng.history.length > 500, 'many encounters finalized')
  assert.ok(withRing <= 61, `only recent encounters keep a ring (got ${withRing})`)
  assert.ok(retained < 400_000, `retained timeline events bounded (got ${retained})`)
})
