// COMBINE-PETS IS A VIEW, AND A VIEW MAY NOT TOUCH THE AGGREGATE.
//
// `sourceViews(map, dur, combinePets: true)` folds each pet source into a synthetic
// "You +pets" row. That fold is presentation-only (AGENTS.md law 4: the engine's attribution
// is authoritative and must survive the layout) — but it was implemented as an IN-PLACE fold:
//
//   const you = merged.get('you') ?? newSource('You +pets', 'you')
//   mergePetInto(you, s)          // you.total += s.total, you.bySkill.set(...), …
//
// When `you` came out of `merged`, it WAS the caller's live `SourceStat` — the very object
// `Agg.out` holds and `Agg.addOut` keeps accumulating into (segmentViews.buildView hands the
// live `agg.out` straight in; there is no freeze, no copy). So:
//
//   1. every snapshot taken with combine-pets on ADDED the pet's damage into your live row —
//      permanently. Two snapshots double-counted it, ten counted it ten times, and the
//      contamination outlived the option: turning combine-pets back OFF still showed the
//      inflated "You";
//   2. the pet's lanes ("Vebarn: Melee") were written into YOUR live `bySkill` / per-category
//      maps, so they showed up as lanes of yours forever after;
//   3. the same rows then flowed into the fight's own history and the zone session, because
//      those share the same `SourceStat` objects.
//
// And the mirror-image bug, from the same line: when the PET's source was inserted into the
// aggregate BEFORE yours (a pet swing landing before your first — routine, since the pet is
// already engaged when you close), the `else` branch ran second and did `merged.set('you', s)`,
// CLOBBERING the accumulated "You +pets" row with your bare one. The pets simply vanished from
// the combined meter. Map iteration order is insertion order, so which of the two bugs you got
// depended on who swung first.
//
// The invariants pinned here:
//   A. building a view NEVER mutates the aggregate it reads (deep-compare before/after);
//   B. building the SAME view twice yields identical results (idempotence — no drift);
//   C. a combine-pets build cannot perturb a later combine-pets-OFF build (no inheritance);
//   D. the combined total is you + pets EXACTLY ONCE, whichever source was seen first.
//
// The window is SYNTHETIC (generated, not extracted): it is in the log's verbatim line
// grammar, but the numbers are round so "5 hits × 100" is checkable by hand and so the
// double-count would be unmistakable if it ever came back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agg, type DamageEvent, type SourceRef, type SourceStat } from '../src/main/combat/aggregate'
import { sourceViews } from '../src/main/combat/sourceViews'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import type { CombatSnapshot, DamageCategory, SourceView } from '../src/shared/combat'

// ── the unit half: sourceViews over a hand-built aggregate ────────────────────────────

const YOU: SourceRef = { id: 'you', name: 'You', kind: 'you' }
const PET: SourceRef = { id: 'pet:7', name: 'Vebarn', kind: 'pet' }

interface Hit {
  attacker: string
  amount: number
  skill: string
  category: DamageCategory
  ts: number
}

function dmg({ attacker, amount, skill, category, ts }: Hit): DamageEvent {
  return {
    ts,
    attacker,
    target: 'a flighty fiend',
    amount,
    dtype: category === 'spell' || category === 'dot' ? category : 'melee',
    skill,
    crit: false,
    category,
    modifiers: []
  }
}

/** An aggregate with your lanes and a pet's, folded in the given source order. */
function aggregate(order: 'you-first' | 'pet-first'): Agg {
  const agg = new Agg()
  const mine = (): void => {
    agg.addOut(YOU, dmg({ attacker: 'You', amount: 100, skill: 'Slash', category: 'melee', ts: 1000 }))
    agg.addOut(YOU, dmg({ attacker: 'You', amount: 100, skill: 'Slash', category: 'melee', ts: 2000 }))
    agg.addOut(YOU, dmg({ attacker: 'You', amount: 300, skill: 'Ancient Wrath', category: 'spell', ts: 3000 }))
    agg.addOutMiss(YOU, 'dodge', 'Slash')
  }
  const pet = (): void => {
    agg.addOut(PET, dmg({ attacker: 'Vebarn', amount: 50, skill: 'Slash', category: 'melee', ts: 1000 }))
    agg.addOut(PET, dmg({ attacker: 'Vebarn', amount: 50, skill: 'Bash', category: 'melee', ts: 2000 }))
    agg.addOutMiss(PET, 'miss', 'Slash')
  }
  if (order === 'you-first') { mine(); pet() } else { pet(); mine() }
  return agg
}

const MY_TOTAL = 500
const PET_TOTAL = 100

function rowOf(views: SourceView[], id: string): SourceView {
  const v = views.find((s) => s.id === id)
  assert.ok(v, `expected a ${id} row`)
  return v
}

test('A: a combine-pets build leaves the aggregate byte-identical (deep-compare)', () => {
  for (const order of ['you-first', 'pet-first'] as const) {
    const agg = aggregate(order)
    const before = structuredClone(agg.out)
    sourceViews(agg.out, 60, true)
    assert.deepEqual(agg.out, before, `${order}: the fold wrote into the live aggregate`)
  }
})

test('B: building the same view twice is identical — and the tenth time too', () => {
  for (const order of ['you-first', 'pet-first'] as const) {
    const agg = aggregate(order)
    const first = JSON.stringify(sourceViews(agg.out, 60, true))
    for (let i = 0; i < 9; i++) {
      assert.equal(
        JSON.stringify(sourceViews(agg.out, 60, true)),
        first,
        `${order}: view build #${i + 2} drifted from the first`
      )
    }
  }
})

test('C: combine-pets ON cannot contaminate a later combine-pets OFF build', () => {
  for (const order of ['you-first', 'pet-first'] as const) {
    const agg = aggregate(order)
    const off = JSON.stringify(sourceViews(agg.out, 60, false))
    sourceViews(agg.out, 60, true)
    sourceViews(agg.out, 60, true)
    assert.equal(JSON.stringify(sourceViews(agg.out, 60, false)), off, `${order}: the option leaked`)
  }
})

test('D: the combined row is you + pets exactly once, whichever source landed first', () => {
  for (const order of ['you-first', 'pet-first'] as const) {
    const agg = aggregate(order)
    const views = sourceViews(agg.out, 60, true)
    assert.equal(views.length, 1, `${order}: one synthetic row, no leftover pet row`)
    const you = rowOf(views, 'you')
    assert.equal(you.name, 'You +pets')
    assert.equal(you.total, MY_TOTAL + PET_TOTAL, `${order}: the pet counted exactly once`)
    assert.equal(you.hits, 5)
    assert.equal(you.misses, 2)
    // The pet's lanes are namespaced, never merged into a lane of yours.
    const lanes = new Map(you.skills.map((k) => [k.name, k.total]))
    assert.equal(lanes.get('Slash'), 200, `${order}: your Slash is yours alone`)
    assert.equal(lanes.get('Vebarn: Slash'), 50)
    assert.equal(lanes.get('Vebarn: Bash'), 50)
    // Law 8's tripwire holds on the synthetic row too.
    assert.equal(you.categories.reduce((s, c) => s + c.total, 0), you.total)
    assert.equal(you.skills.reduce((s, k) => s + k.total, 0), you.total)
  }
})

test('the uncombined build is untouched by any of this: two authoritative rows', () => {
  const agg = aggregate('you-first')
  const views = sourceViews(agg.out, 60, false)
  assert.equal(rowOf(views, 'you').total, MY_TOTAL)
  assert.equal(rowOf(views, 'pet:7').total, PET_TOTAL)
  assert.equal(rowOf(views, 'pet:7').name, 'Vebarn')
})

test('the returned view never aliases the aggregate’s own maps', () => {
  const agg = aggregate('you-first')
  const live = agg.out.get('you') as SourceStat
  const views = sourceViews(agg.out, 60, true)
  const you = rowOf(views, 'you')
  // Mutating the SERIALIZED view (a plain object tree) is inert by construction, but the
  // real guard is the other direction: nothing the fold built may still point at the live
  // accumulator's objects.
  assert.notEqual(you.name, live.name, 'the synthetic row is not the live row renamed')
  assert.equal(live.name, 'You', 'the live row kept its own display name')
})

// ── the engine half: repeated snapshots through the real pipeline ──────────────────────

/** SYNTHETIC window in the log's verbatim grammar: you and your summoned pet on one mob. */
const WINDOW: string[] = [
  "[Sat Aug 01 16:52:11 2026] Vebarn told you, 'Attacking a flighty fiend Master.'",
  '[Sat Aug 01 16:52:12 2026] Vebarn slashes a flighty fiend for 50 points of damage.',
  '[Sat Aug 01 16:52:13 2026] You slash a flighty fiend for 100 points of damage.',
  '[Sat Aug 01 16:52:14 2026] Vebarn bashes a flighty fiend for 50 points of damage.',
  '[Sat Aug 01 16:52:15 2026] You slash a flighty fiend for 100 points of damage.',
  '[Sat Aug 01 16:52:16 2026] You try to slash a flighty fiend, but miss!'
]

function replay(lines: string[]): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  return { eng, lastTs }
}

function outTotal(snap: CombatSnapshot): number {
  return snap.selected?.outTotal ?? -1
}

test('ENGINE: opening the drill with combine-pets on, ten times, never moves a number', () => {
  const { eng, lastTs } = replay(WINDOW)
  const truth = 300 // you 200 + Vebarn 100

  const plain = JSON.stringify(eng.snapshot(lastTs, { combinePets: false }).selected)
  const combinedFirst = JSON.stringify(eng.snapshot(lastTs, { combinePets: true }).selected)
  for (let i = 0; i < 10; i++) {
    const snap = eng.snapshot(lastTs, { combinePets: true })
    assert.equal(outTotal(snap), truth, `snapshot #${i + 2} inflated the fight total`)
    assert.equal(JSON.stringify(snap.selected), combinedFirst, `snapshot #${i + 2} drifted`)
  }
  // …and the option is still a pure toggle afterwards.
  assert.equal(
    JSON.stringify(eng.snapshot(lastTs, { combinePets: false }).selected),
    plain,
    'a combined snapshot contaminated the uncombined view'
  )
  assert.equal(outTotal(eng.snapshot(lastTs, { combinePets: false })), truth)
})

test('ENGINE: the zone session inherits the aggregate, not the combined totals', () => {
  const { eng, lastTs } = replay(WINDOW)
  for (let i = 0; i < 5; i++) eng.snapshot(lastTs, { combinePets: true })
  const zone = eng.snapshot(lastTs, { combinePets: false, selectedId: 'zone' })
  assert.equal(outTotal(zone), 300, 'the zone rollup carries the fight once, uncombined')
  const you = zone.selected?.entities.find((e) => e.kind === 'you')
  assert.ok(you)
  assert.equal(you.total, 200, 'your zone row is YOUR damage — no pet folded into it')
  assert.equal(you.skills.some((k) => k.name.startsWith('Vebarn:')), false, 'no pet lane in your row')
})
