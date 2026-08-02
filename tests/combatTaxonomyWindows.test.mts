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
