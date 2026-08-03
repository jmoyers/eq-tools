// Golden-window tests for the HEALING + ABSORPTION model (Task #59).
//
// Methodology (AGENTS.md "Golden-window tests are the law"): LOCATE real spans in
// eqlog_Primitive_freeport.txt, extract them VERBATIM (tests/extract-combat-fixtures.mjs),
// READ them line-by-line, write the hand-summed expectations here, and replay through the REAL
// parser + CombatEngine.
//
// The three windows isolate the three things the model has to get right:
//   W26  a CRITICAL heal — the `… by Healing. (Critical)` shape the old `\.$`-anchored HEAL_RE
//        rejected outright (233 real heals were silently dropped log-wide).
//   W27  the OVERHEAL form `for 1351 (5968) hit points` (raw − effective = wasted healing), plus
//        eleven rune grants and one swing eaten by YOUR rune (which carries NO amount).
//   W28  ENEMY counter-healing (a mob self-healing mid-fight) + the third absorption family,
//        absorbed damage-shield ticks (also amount-less).
//
// HAND-READ EXPECTATIONS — every heal / rune / absorb line in each fixture, verbatim:
//
// w26-healing-crit.log (Sun Aug 02 17:10:51 → 17:11:39)
//   heals (all "You healed Primitive", healer = You):
//     235 Healing · 428 Healing (Critical) · 210 Healing · 235 Healing
//     ⇒ effective 235+428+210+235 = 1108, 4 ticks, 1 crit, max 428, min 210, overheal 0
//   runes: 6 + 15 = 21 over 2 grants (max 15, min 6);  absorbed swings 0;  absorbed DS 0
//
// w27-healing-overheal-absorb.log (Sun Aug 02 17:13:50 → 17:14:49)
//   heals (all "You healed Primitive"):
//     237 Healing · 230 Healing · 239 Healing · 217 Healing  ⇒ lane "Healing" 923 over 4 ticks
//     1351 (5968) Lay on Hands VI                            ⇒ lane 1351, overheal 5968−1351=4617
//     ⇒ effective 923+1351 = 2274, 5 ticks, 0 crits, max 1351, min 217, overheal 4617
//   runes: 7+6+15+9+1+7+23+14+16+30+21 = 149 over 11 grants (max 30, min 1)
//   absorbed swings: 1 ("A zol ghoul knight tries to hit YOU, but YOUR magical skin absorbs the
//     blow! (Riposte)" @17:14:01) — a COUNT, never an amount;  absorbed DS 0
//
// w28-healing-enemy-thorns.log (Sun Aug 02 15:55:20 → 15:55:42)
//   THREE mob self-heal lines are in the span, but only TWO are counter-healing:
//     15:55:22  a Teir`Dal shadowknight  2 Lifespike       — COUNTED (we are fighting it)
//     15:55:23  a Teir`Dal ranger       64 Skin like Rock  — NOT counted: at 15:55:23 no damage
//               has been exchanged with the ranger yet, so it is not ENGAGED in the encounter.
//               Healing an unengaged mob undid none of our damage; counting it would inflate the
//               "effective DPS" annotation with a bystander's buff. (Pre-existing engine rule —
//               enemyHealTotal has always agreed, which this test pins as a tripwire.)
//     15:55:38  a Teir`Dal ranger       64 Skin like Rock  — COUNTED (mid-fight with the ranger)
//     ⇒ enemy counter-healing total 66
//   heals on You: NONE (the friendly ledger must stay empty — a mob's self-heal can never rank
//     in "who kept me alive")
//   runes: 16+5+1+9+11+24 = 66 over 6 grants (max 24, min 1)
//   absorbed damage shields: 3 ("YOUR magical skin absorbs the damage of a Teir`Dal ranger's
//     thorns." @15:55:36, :39, :40) — COUNTS, no amount exists;  absorbed swings 0

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import type { HealSourceView, HealSpellView, SegmentView } from '../src/shared/combat'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

const W26 = 'w26-healing-crit.log'
const W27 = 'w27-healing-overheal-absorb.log'
const W28 = 'w28-healing-enemy-thorns.log'

/** `tests/fixtures/*.log` is gitignored (.gitignore `*.log`), so a clean checkout regenerates the
 *  slices with `node tests/extract-combat-fixtures.mjs "<eqlog path>"`. Same skip convention the
 *  other combat window tests use, so a machine without the real log runs the rest of the suite. */
const have = (f: string): string | false =>
  existsSync(join(FIXTURES, f)) ? false : `fixture ${f} not present — run tests/extract-combat-fixtures.mjs`

function readLines(fixture: string): string[] {
  return readFileSync(join(FIXTURES, fixture), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
}

function replay(fixture: string): SegmentView {
  const lines = readLines(fixture)
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      eng.ingestEvent(ev, false)
      lastTs = ev.ts
    }
  }
  // The ZONE aggregate is the whole-window view: no fixture contains a zone line, so every
  // encounter in the span folds into one session — which is exactly what the 'heal-overall'
  // overlay reads.
  const snap = eng.snapshot(lastTs + 90_000, { selectedId: 'zone' })
  assert.ok(snap.selected, 'zone segment must resolve')
  return snap.selected!
}

const you = (seg: SegmentView): HealSourceView => {
  const h = seg.healing.healers.find((x) => x.id === 'you')
  assert.ok(h, 'expected a "You" healer row')
  return h!
}
const lane = (h: HealSourceView, name: string): HealSpellView => {
  const s = h.spells.find((x) => x.name === name)
  assert.ok(s, `expected spell lane "${name}" (got ${h.spells.map((x) => x.name).join(', ')})`)
  return s!
}

// ---------------------------------------------------------------------------
// Parser shapes — the exact real lines, verbatim.
// ---------------------------------------------------------------------------

test('parser: a heal line carrying the trailing (Critical) modifier parses (it used to be dropped)', () => {
  const ev = parseEvent(
    '[Sun Aug 02 17:11:07 2026] You healed Primitive for 428 hit points by Healing. (Critical)',
    1
  )
  assert.equal(ev?.kind, 'heal')
  assert.equal(ev.healer, 'You')
  assert.equal(ev.target, 'Primitive')
  assert.equal(ev.amount, 428)
  assert.equal(ev.spell, 'Healing')
  assert.equal(ev.crit, true)
  assert.equal(ev.rawAmount, undefined)
})

test('parser: the overheal form keeps effective as `amount` and raw as `rawAmount`', () => {
  const ev = parseEvent(
    '[Sun Aug 02 17:14:38 2026] You healed Primitive for 1351 (5968) hit points by Lay on Hands VI.',
    1
  )
  assert.equal(ev?.kind, 'heal')
  assert.equal(ev.amount, 1351)
  assert.equal(ev.rawAmount, 5968)
  assert.equal(ev.spell, 'Lay on Hands VI')
  assert.equal(ev.crit, false)
})

test('parser: a plain heal still parses unchanged, and a reflexive heal targets its healer', () => {
  const plain = parseEvent('[Sun Aug 02 17:14:09 2026] You healed Primitive for 230 hit points by Healing.', 1)
  assert.equal(plain?.kind, 'heal')
  assert.equal(plain.amount, 230)
  assert.equal(plain.rawAmount, undefined)
  assert.equal(plain.crit, false)

  const reflexive = parseEvent(
    '[Sun Aug 02 15:55:38 2026] a Teir`Dal ranger healed herself for 64 hit points by Skin like Rock.',
    2
  )
  assert.equal(reflexive?.kind, 'heal')
  assert.equal(reflexive.healer, 'a Teir`Dal ranger')
  assert.equal(reflexive.target, 'a Teir`Dal ranger')
  assert.equal(reflexive.amount, 64)
})

test('parser: the three absorption families parse as `mitigation`, and only the rune has an amount', () => {
  const rune = parseEvent('[Sun Aug 02 17:14:15 2026] You gain a rune for 23 points of absorption.', 1)
  assert.equal(rune?.kind, 'mitigation')
  assert.equal(rune.mtype, 'rune')
  assert.equal(rune.amount, 23)

  // Trailing swing modifiers are tolerated and discarded, exactly like the miss family.
  const swing = parseEvent(
    '[Sun Aug 02 17:14:01 2026] A zol ghoul knight tries to hit YOU, but YOUR magical skin absorbs the blow! (Riposte)',
    2
  )
  assert.equal(swing?.kind, 'mitigation')
  assert.equal(swing.mtype, 'absorbSwing')
  assert.equal(swing.amount, undefined, 'the log records NO amount for an absorbed swing')
  assert.equal(swing.source, 'A zol ghoul knight')

  const plainSwing = parseEvent(
    '[Sun Aug 02 17:16:16 2026] A wan ghoul knight tries to hit YOU, but YOUR magical skin absorbs the blow!',
    3
  )
  assert.equal(plainSwing?.kind, 'mitigation')
  assert.equal(plainSwing.mtype, 'absorbSwing')

  const ds = parseEvent(
    "[Sun Aug 02 15:55:36 2026] YOUR magical skin absorbs the damage of a Teir`Dal ranger's thorns.",
    4
  )
  assert.equal(ds?.kind, 'mitigation')
  assert.equal(ds.mtype, 'absorbDamageShield')
  assert.equal(ds.amount, undefined, 'the log records NO amount for an absorbed damage shield')
  assert.equal(ds.source, 'a Teir`Dal ranger')
})

test("parser: a MOB's own rune stays a miss (mtype absorb), never our mitigation", () => {
  const ev = parseEvent(
    '[Sun Aug 02 15:55:31 2026] You try to bash a revenant, but a revenant’s magical skin absorbs the blow!'.replace(
      '’',
      "'"
    ),
    1
  )
  assert.equal(ev?.kind, 'miss')
  assert.equal(ev.mtype, 'absorb')
})

// ---------------------------------------------------------------------------
// W26 — critical heals.
// ---------------------------------------------------------------------------

test('W26: the crit heal is COUNTED (four heals, 1108 effective, one crit)', { skip: have(W26) }, () => {
  const seg = replay(W26)
  const h = you(seg)
  assert.equal(h.kind, 'you')
  assert.equal(h.total, 1108)
  assert.equal(h.count, 4)
  assert.equal(h.crits, 1)
  assert.equal(h.max, 428)
  assert.equal(h.min, 210)
  assert.equal(h.overheal, 0, 'no line in this window carried the (M) raw amount')
  assert.equal(h.fullOverheal, 0)
  assert.equal(seg.healing.total, 1108)

  // One spell lane, and it carries the same numbers (the per-spell drill must reconcile).
  assert.equal(h.spells.length, 1)
  const healing = lane(h, 'Healing')
  assert.equal(healing.total, 1108)
  assert.equal(healing.count, 4)
  assert.equal(healing.crits, 1)
  assert.equal(healing.max, 428)
  assert.equal(healing.min, 210)
})

test('W26: rune grants are absorption, NOT healing — they never enter a healing total', { skip: have(W26) }, () => {
  const seg = replay(W26)
  const mit = seg.healing.mitigation
  assert.equal(mit.runeTotal, 21)
  assert.equal(mit.runeCount, 2)
  assert.equal(mit.runeMax, 15)
  assert.equal(mit.runeMin, 6)
  assert.equal(mit.absorbedSwings, 0)
  assert.equal(mit.absorbedDamageShields, 0)
  // The tripwire: healing totals are the sum of the healer rows and nothing else.
  assert.equal(seg.healing.total, seg.healing.healers.reduce((s, x) => s + x.total, 0))
  assert.equal(seg.healing.total, 1108)
})

// ---------------------------------------------------------------------------
// W27 — overheal + absorbed swing.
// ---------------------------------------------------------------------------

test('W27: overheal is DERIVED from the (M) form and is 0 on every plain line', { skip: have(W27) }, () => {
  const seg = replay(W27)
  const h = you(seg)
  assert.equal(h.total, 2274, 'effective healing = 237+230+239+217+1351')
  assert.equal(h.count, 5)
  assert.equal(h.crits, 0)
  assert.equal(h.max, 1351)
  assert.equal(h.min, 217)
  assert.equal(h.overheal, 4617, 'the ONE (M) line: 5968 raw − 1351 effective')
  assert.equal(h.fullOverheal, 0, 'nothing in this window landed on a full health bar')
  assert.equal(Math.round(h.overhealPct), Math.round((4617 / (2274 + 4617)) * 100))

  // Per spell: the four plain "Healing" ticks waste nothing; the Lay on Hands carries it all.
  const plain = lane(h, 'Healing')
  assert.equal(plain.total, 923)
  assert.equal(plain.count, 4)
  assert.equal(plain.overheal, 0)
  assert.equal(plain.max, 239)
  assert.equal(plain.min, 217)

  const loh = lane(h, 'Lay on Hands VI')
  assert.equal(loh.total, 1351)
  assert.equal(loh.count, 1)
  assert.equal(loh.overheal, 4617)
  assert.equal(loh.max, 1351)
  assert.equal(loh.min, 1351)

  // Spell lanes must reconcile with their healer row on BOTH axes.
  assert.equal(h.spells.reduce((s, x) => s + x.total, 0), h.total)
  assert.equal(h.spells.reduce((s, x) => s + x.overheal, 0), h.overheal)
  assert.equal(h.spells.reduce((s, x) => s + x.count, 0), h.count)
})

test('W27: eleven rune grants sum to 149, and the absorbed swing is a COUNT with no amount', { skip: have(W27) }, () => {
  const seg = replay(W27)
  const mit = seg.healing.mitigation
  assert.equal(mit.runeTotal, 149)
  assert.equal(mit.runeCount, 11)
  assert.equal(mit.runeMax, 30)
  assert.equal(mit.runeMin, 1)
  assert.equal(mit.absorbedSwings, 1)
  assert.equal(mit.absorbedDamageShields, 0)
  // The absorbed swing contributed nothing to any amount-bearing figure.
  assert.equal(seg.healing.total, 2274)
  assert.equal(mit.runeTotal, 149)
})

// ---------------------------------------------------------------------------
// W28 — enemy counter-healing + absorbed damage shields.
// ---------------------------------------------------------------------------

test('W28: a mob self-healing ranks on the ENEMY ledger, never in "who kept me alive"', { skip: have(W28) }, () => {
  const seg = replay(W28)
  assert.deepEqual(seg.healing.healers, [], 'nothing healed You in this window')
  assert.equal(seg.healing.total, 0)

  // 2 (Lifespike) + 64 (the 15:55:38 Skin like Rock). The 15:55:23 Skin like Rock is deliberately
  // NOT here: the ranger had not been engaged yet, so that heal undid none of our damage.
  assert.equal(seg.healing.enemyTotal, 66)
  const byName = Object.fromEntries(seg.healing.enemyHealers.map((h) => [h.name, h]))
  assert.equal(byName['a Teir`Dal ranger'].total, 64)
  assert.equal(byName['a Teir`Dal ranger'].count, 1)
  assert.equal(byName['a Teir`Dal ranger'].kind, 'enemy')
  assert.equal(lane(byName['a Teir`Dal ranger'], 'Skin like Rock').total, 64)
  assert.equal(byName['a Teir`Dal shadowknight'].total, 2)
  assert.equal(byName['a Teir`Dal shadowknight'].count, 1)

  // REGRESSION TRIPWIRE: the healing ledger must agree with the pre-existing enemy-healing
  // annotation the damage meter already showed — the new ledger is additive, not a rewrite.
  assert.equal(seg.healing.enemyTotal, seg.enemyHealTotal)
})

test('W28: absorbed damage-shield ticks are counted, never valued', { skip: have(W28) }, () => {
  const seg = replay(W28)
  const mit = seg.healing.mitigation
  assert.equal(mit.absorbedDamageShields, 3)
  assert.equal(mit.absorbedSwings, 0)
  assert.equal(mit.runeTotal, 66, '16+5+1+9+11+24')
  assert.equal(mit.runeCount, 6)
  assert.equal(mit.runeMax, 24)
  assert.equal(mit.runeMin, 1)
})

// ---------------------------------------------------------------------------
// Cross-cutting: healing/absorption must not perturb the damage model at all.
// ---------------------------------------------------------------------------

test('healing + absorption never touch a DAMAGE total (per-source category tripwire holds)', { skip: have(W26) || have(W27) || have(W28) }, () => {
  for (const fixture of [W26, W27, W28]) {
    const seg = replay(fixture)
    for (const src of [...seg.entities, ...seg.incoming]) {
      const cat = src.categories.reduce((s, c) => s + c.total, 0)
      assert.equal(cat, src.total, `${fixture}: ${src.name} category sum must equal its total`)
    }
    // A rune / absorbed swing / heal must never have opened an encounter or added a hit.
    assert.equal(
      seg.entities.reduce((s, e) => s + e.total, 0),
      seg.outTotal,
      `${fixture}: outgoing total unchanged`
    )
  }
})

test('the fight-scoped healing view is a SUBSET of the zone-scoped one (same ledger, two scopes)', { skip: have(W27) }, () => {
  // 'heal-fight' and 'heal-overall' read the SAME aggregate through the SAME selection machinery,
  // so a single encounter can never report more healing or absorption than its zone session.
  const lines = readLines(W27)
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      eng.ingestEvent(ev, false)
      lastTs = ev.ts
    }
  }
  const zone = eng.snapshot(lastTs + 90_000, { selectedId: 'zone' }).selected!
  const fights = eng.snapshot(lastTs + 90_000, { selectedId: 'zone' }).segments.filter((s) => s.kind === 'fight')
  assert.ok(fights.length > 0, 'the window contains finalized fights')
  let fightHeal = 0
  let fightRunes = 0
  for (const f of fights) {
    const v = eng.snapshot(lastTs + 90_000, { selectedId: f.id }).selected
    if (!v) continue
    fightHeal += v.healing.total
    fightRunes += v.healing.mitigation.runeTotal
    assert.ok(v.healing.total <= zone.healing.total, `${f.name}: fight healing ≤ zone healing`)
  }
  assert.ok(fightHeal <= zone.healing.total)
  assert.ok(fightRunes <= zone.healing.mitigation.runeTotal)
})
