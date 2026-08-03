// PROC ANALYTICS golden windows (docs/plans/proc-analytics.md, wave 1).
//
// Four real spans of eqlog_Primitive_freeport.txt, cut by tests/extract-proc-fixtures.mjs
// through the shared scrub, replayed through the REAL parser + CombatEngine. Every number
// below was hand-read off the fixture with grep and the clock BEFORE the engine was asked, and
// the two agreed; where they did not, the disagreement is written down rather than smoothed
// over (see the miss-modifier note on `swingsOf`).
//
//   w38-proc-ppm.log          Sun Aug 02 21:43:03 → 21:47:56   PPM under ONE stable invocation
//   w39-spellblade-switch.log Fri Jul 31 16:06:46 → 16:12:45   the 100%-exclusivity measurement
//   w40-nife-buff.log         Sun Aug 02 19:26:05 → 19:32:49   the honest-limits case + slay
//   w41-poison-asp-venom.log  Mon Aug 03 15:21:45 → 15:26:18   coats + the poison damage lane
//
// WHAT THIS FILE IS FOR, in priority order:
//   1. The DAMAGE TRIPWIRE (law 8). This feature is an additive index over damage already
//      counted. Every lane total, category total and swing count here is pinned exactly, so a
//      wave that moves one is caught by the same test that documents it.
//   2. The three denominators and their FLOORS. `procRate()` is exercised on hand-read inputs,
//      so `ppmActive` being ABSENT rather than 0 on a 5-second pull is a test, not a comment.
//   3. The link classifier. w39 holds a genuine 'exclusive' lane beside three lopsided ones;
//      w40 holds a lane that fired on 904 of 940 swings and STILL cannot be classified. Those
//      two windows exist so nobody later "fixes" the second into the first.
//
// The serialized `ProcsView.lanes` / `.overall` / `.states` arrive in a later wave; the last
// test in this file cross-checks them against these same hand-read numbers and turns itself on
// automatically the moment the engine starts populating them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installSpellDb } from '../src/main/log/rulesets'
import { CombatEngine } from '../src/main/combat/engine'
import {
  MIN_ACTIVE_SEC,
  MIN_INACTIVE_SWINGS,
  MIN_SWINGS,
  concentrationOf,
  linkStrength,
  procRate
} from '../src/main/combat/procWindows'
import { PROC_CAST_WINDOW_MS } from '../src/main/combat/procDetect'
import type { SegmentView, SourceView } from '../src/shared/combat'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string[] {
  const p = join(FIXTURES, name)
  return existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.length > 0) : []
}

const W35 = fixture('w35-poison-coats.log') // PRIME for w41 — see the extractor header
const W38 = fixture('w38-proc-ppm.log')
const W39 = fixture('w39-spellblade-switch.log')
const W40 = fixture('w40-nife-buff.log')
const W41 = fixture('w41-poison-asp-venom.log')

const missing = (...w: string[][]): string | false =>
  w.some((f) => f.length === 0) ? 'fixture not present' : false

/** Replay through the REAL parser + engine; returns the engine at the last ingested ts. */
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

/** The `You` row of a segment — every proc denominator is measured against it. */
function you(seg: SegmentView): SourceView {
  const row = seg.entities.find((e) => e.id === 'you')
  assert.ok(row, `${seg.id} has a You row`)
  return row
}

const laneOf = (row: SourceView, name: string): { hits: number; total: number } => {
  const s = row.skills.find((k) => k.name === name)
  return s ? { hits: s.hits, total: s.total } : { hits: 0, total: 0 }
}

const catOf = (row: SourceView, c: string): { hits: number; total: number } => {
  const k = row.categories.find((x) => x.category === c)
  return k ? { hits: k.hits, total: k.total } : { hits: 0, total: 0 }
}

/**
 * The plan's swing denominator: YOUR melee + slay hits, plus YOUR avoided swings.
 *
 * A naive grep of the fixture undercounts this — the avoided-swing family carries paren
 * modifiers too (`You try to slash an ashenbone drake, but miss! (Riposte)`), and the first
 * hand count missed one line in w39 and five in w40 for exactly that reason. The engine's
 * `misses` is the authority; the hand count was corrected to match it, not the other way round.
 */
const swingsOf = (seg: SegmentView): number => {
  const row = you(seg)
  return catOf(row, 'melee').hits + catOf(row, 'slay').hits + row.misses
}

// ─────────────────────────────────────────────────────────────────────────────────────
// W38 — the PPM arithmetic, with one invocation and nothing else moving
// ─────────────────────────────────────────────────────────────────────────────────────

test('W38: three cast-less lanes, exact counts and damage', { skip: missing(W38) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W38)
  const z = you(segment(eng, lastTs, 'zone'))

  // Hand-counted off the fixture (grep, no engine). None of the three has a `You begin casting`
  // line anywhere in the window — its only casts are Greater Healing ×13, Reckless Strength and
  // Lay on Hands VIII — so all three are PURE procs and the detector must score cast = 0.
  assert.deepEqual(laneOf(z, 'Smiting Strike'), { hits: 27, total: 2796 })
  assert.deepEqual(laneOf(z, 'Condemnation of Nife'), { hits: 5, total: 1165 })
  assert.deepEqual(laneOf(z, 'Dismiss Undead'), { hits: 5, total: 683 })

  // THE TRIPWIRE (law 8). Proc lanes are an index over damage already counted, so the spell
  // category must equal the three lanes exactly and the body totals must not move.
  assert.deepEqual(catOf(z, 'spell'), { hits: 37, total: 4644 })
  assert.equal(27 + 5 + 5, 37)
  assert.deepEqual(catOf(z, 'melee'), { hits: 513, total: 36227 })
  assert.deepEqual(catOf(z, 'slay'), { hits: 6, total: 5111 })
  assert.equal(segment(eng, lastTs, 'zone').outTotal, 45982)
})

test('W38: the swing denominator, and the whiff that belongs to no fight', { skip: missing(W38) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W38)
  const zone = segment(eng, lastTs, 'zone')

  // 513 melee + 6 slay hits + 403 avoided = 922.
  assert.equal(swingsOf(zone), 922)
  assert.equal(you(zone).misses, 403)

  // The window's FIRST line is `You try to backstab a wan ghoul knight, but miss!`, landed
  // before any damage. Law 8: a miss never opens an encounter, so it lives in the zone
  // aggregate and in no fight — Σ(fight swings) is 921, one short, forever. If these two ever
  // become equal, either the miss started opening encounters or the zone stopped seeing it.
  const fights = ['e1', 'e2', 'e3'].map((id) => segment(eng, lastTs, id))
  assert.deepEqual(fights.map(swingsOf), [371, 196, 354])
  assert.equal(371 + 196 + 354, 921)
  assert.equal(swingsOf(zone) - 921, 1)
})

test('W38: the three denominators, computed off the fixture clock', { skip: missing(W38) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W38)
  const zone = segment(eng, lastTs, 'zone')

  // 21:43:03 → 21:47:56 is 293 wall seconds, but the SEGMENT spans first-hit → last-hit: 282s,
  // of which 280 are active (the meter's own capped-3s-gap definition — a near-continuous
  // grind, so the two are almost equal, which is what makes this the clean PPM window).
  assert.equal(zone.durationSec, 282)
  assert.equal(zone.activeSec, 280)

  const r = procRate({ count: 27, activeSec: 280, durationSec: 282, swings: 922 })
  assert.equal(r.count, 27)
  assert.equal(r.swings, 922)
  assert.ok(Math.abs(r.ppmActive! - (27 * 60) / 280) < 1e-9) // 5.7857 ppm
  assert.ok(Math.abs(r.ppmWall! - (27 * 60) / 282) < 1e-9) // 5.7447 ppm
  assert.ok(Math.abs(r.per100Swings! - (100 * 27) / 922) < 1e-9) // 2.9284 / 100 swings
  // ppmActive > ppmWall always, because activeSec <= durationSec by construction.
  assert.ok(r.ppmActive! > r.ppmWall!)
})

test('W38: one invocation, one stance, and both spans stay open', { skip: missing(W38) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W38)
  const zone = segment(eng, lastTs, 'zone').procs

  // `inversion` at 21:43:05 and `balanced` at 21:45:50 — the only two commits in five minutes.
  // Neither is ever superseded inside the window, so both spans end `open`, never `observed`:
  // the game prints no "your stance ends" line and the model must not invent one.
  assert.equal(zone.invocationSwitches, 1)
  assert.equal(zone.stanceSwitches, 1)
  // The invocation lands in the first fight, the stance in the third. Independent kinds.
  assert.equal(segment(eng, lastTs, 'e1').procs.invocationSwitches, 1)
  assert.equal(segment(eng, lastTs, 'e3').procs.stanceSwitches, 1)
  // A window with no rogue coat reports an EMPTY poison ledger — the negative half of law 1.
  assert.equal(zone.strikeCount, 0)
  assert.equal(zone.coatAtEngage, undefined)
  assert.equal(zone.slowExpected, false)
})

// ─────────────────────────────────────────────────────────────────────────────────────
// W39 — Spellblade: the one place the log measures a 100% correlation, with both arms real
// ─────────────────────────────────────────────────────────────────────────────────────

test('W39: the gem-1 lane fires 14 times, all of them cast-less', { skip: missing(W39) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W39)
  const z = you(segment(eng, lastTs, 'zone'))

  assert.deepEqual(laneOf(z, 'Discordant Mind'), { hits: 14, total: 5482 })
  // Not one `You begin casting Discordant Mind.` in the window (its casts are Pillage
  // Enchantment ×4, Superior Healing II ×3, Pacify ×2, Dazzle ×2, Swift Like the Wind,
  // Shiftless Deeds IV, Boon of the Garou II). Every firing is therefore outside
  // PROC_CAST_WINDOW_MS of any cast of its own — vacuously, since there are none.
  assert.equal(PROC_CAST_WINDOW_MS, 12_000)
  assert.equal(W39.filter((l) => l.includes('You begin casting Discordant Mind')).length, 0)
  // Two `Cleric of Innoruuk resisted your Discordant Mind!` lines. A resist is damage-free and
  // first-class (law 8): it must not inflate the lane's 14 hits.
  assert.equal(you(segment(eng, lastTs, 'zone')).resists, 2)
  assert.deepEqual(laneOf(z, 'Smiting Strike'), { hits: 20, total: 4283 })
  assert.deepEqual(laneOf(z, 'Condemnation of Nife'), { hits: 6, total: 1978 })
  assert.deepEqual(laneOf(z, 'Lifetap Strike'), { hits: 12, total: 458 })
})

test('W39: EXCLUSIVE is earned by the inactive arm, not by the ratio', { skip: missing(W39) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W39)
  // Hand-read by splitting the fixture on the spellblade span 16:08:56 → 16:11:19: 406 swings
  // inside it, 225 outside. 406 + 225 = 631 = the zone's own swing count, which is the check
  // that the split lost nothing.
  const inside = 406
  const outside = 225
  assert.equal(swingsOf(segment(eng, lastTs, 'zone')), inside + outside)

  // THE MEASUREMENT: 14 firings inside the span, 0 outside, against 225 swings of real
  // opportunity outside it. 225 clears MIN_INACTIVE_SWINGS by 25 — thin, and deliberately so:
  // this is the only 'exclusive' link in any fixture here, and it is one bad window from not
  // being one. The strength comes from the EXPOSURE, never from the concentration.
  assert.equal(MIN_INACTIVE_SWINGS, 200)
  assert.equal(concentrationOf(14, 0), 1)
  assert.equal(linkStrength({ withCount: 14, withoutCount: 0, inactiveSwings: outside }), 'exclusive')
  // Same lane, same ratio, a thinner inactive arm ⇒ 'inconclusive'. The gate is the point.
  assert.equal(linkStrength({ withCount: 14, withoutCount: 0, inactiveSwings: 199 }), 'inconclusive')

  // The other three lanes in the SAME window are lopsided but NOT exclusive, so one fixture
  // proves the classifier separates them. Smiting Strike 13/7 and Lifetap Strike 9/3 fire on
  // both sides; Condemnation of Nife fires 6 times and never once under spellblade.
  assert.equal(linkStrength({ withCount: 13, withoutCount: 7, inactiveSwings: outside }), 'weak')
  assert.equal(linkStrength({ withCount: 9, withoutCount: 3, inactiveSwings: outside }), 'weak')
  assert.equal(linkStrength({ withCount: 0, withoutCount: 6, inactiveSwings: outside }), 'weak')
  assert.equal(concentrationOf(0, 6), 0)
  assert.ok(concentrationOf(9, 3) < 0.8) // 0.75 — just under the 'correlated' line
})

test('W39: five invocation commits, and the tap that heals more than it deals', { skip: missing(W39) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W39)
  const zone = segment(eng, lastTs, 'zone').procs

  // recovery 16:07:02 → divine :32 → inversion :50 → spellblade 16:08:56 → inversion 16:11:19.
  // FIVE commits, so four spans end `inferred` (a sibling replaced them) and the fifth is open.
  // Plus defensive 16:07:12 and offensive 16:08:59.
  assert.equal(zone.invocationSwitches, 5)
  assert.equal(zone.stanceSwitches, 2)

  // TIER A's healing half, hand-counted from the 12 `You healed Primitive for N hit points by
  // Lifetap Strike.` lines: 474 healed against 458 dealt. The tap RETURNS MORE THAN IT TAKES
  // (30 → 31, and the crit 79 → 82), so `directHeal` can never be derived from `directDamage`.
  const heals = W39.filter((l) => l.includes('You healed Primitive') && l.includes('Lifetap Strike'))
  assert.equal(heals.length, 12)
  const healed = heals.reduce((n, l) => n + Number(/for (\d+) hit points/.exec(l)![1]), 0)
  assert.equal(healed, 474)
  assert.equal(laneOf(you(segment(eng, lastTs, 'zone')), 'Lifetap Strike').total, 458)
  assert.ok(healed > 458)
})

// ─────────────────────────────────────────────────────────────────────────────────────
// W40 — Instrument of Nife: an exact Tier-A number, and no counterfactual at all
// ─────────────────────────────────────────────────────────────────────────────────────

test('W40: the aura lands twice — a cast, then a Quick Buff burst', { skip: missing(W40) }, () => {
  installSpellDb(undefined)
  const aura = W40.filter((l) => l.includes('A brilliant blue aura surrounds your weapon.'))
  // Two applies, 13 seconds apart — the only such pair in the whole log, which is why this
  // window was cut here. The FIRST is own-cast; the SECOND has no cast line at all because
  // Quick Buff prints landings only. Neither is ever followed by `The brilliant blue aura
  // fades.`, so the first span ends `inferred` (superseded) and the second ends `open`.
  assert.equal(aura.length, 2)
  assert.ok(aura[0].startsWith('[Sun Aug 02 19:26:48 2026]'))
  assert.ok(aura[1].startsWith('[Sun Aug 02 19:27:01 2026]'))
  assert.equal(W40.filter((l) => l.includes('You begin casting Instrument of Nife')).length, 1)
  assert.equal(W40.filter((l) => l.includes('You activate Quick Buff.')).length, 1)
  assert.equal(W40.filter((l) => l.includes('The brilliant blue aura fades.')).length, 0)
})

test('W40: 904 swings with the aura up, 36 without — and that is the whole finding', { skip: missing(W40) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W40)
  const zone = segment(eng, lastTs, 'zone')
  const z = you(zone)

  // Hand-read by splitting the fixture at 19:26:48: 904 swings after, 36 before. 940 total.
  assert.equal(swingsOf(zone), 940)
  const inactiveSwings = 36

  // TIER A is EXACT and needs no comparison: 4 procs, 1,326 damage, flat 221 per non-crit.
  assert.deepEqual(laneOf(z, 'Condemnation of Nife'), { hits: 4, total: 1326 })
  assert.ok(zone.outTotal > 0 && (1326 / zone.outTotal) * 100 < 4) // 3.34% of outgoing

  // TIER B IS IMPOSSIBLE, and the model must say so rather than report a big number. All four
  // procs happened with the aura up and none without — a 100% concentration — yet the verdict
  // is 'inconclusive', because 36 swings is not a control group. This assertion is the reason
  // the fixture exists: nobody may later "improve" it into 'exclusive'.
  assert.equal(concentrationOf(4, 0), 1)
  assert.equal(linkStrength({ withCount: 4, withoutCount: 0, inactiveSwings }), 'inconclusive')
  assert.ok(inactiveSwings < MIN_INACTIVE_SWINGS)

  // Smiting Strike fires 27 times up and ONCE down (19:26:35, before the aura), which proves it
  // is not aura-granted — and it too is unclassifiable here, for the same reason.
  assert.deepEqual(laneOf(z, 'Smiting Strike'), { hits: 28, total: 2464 })
  assert.equal(linkStrength({ withCount: 27, withoutCount: 1, inactiveSwings }), 'inconclusive')
})

test('W40: the sample floors, on a 5-second pull and a 13-second one', { skip: missing(W40) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W40)
  const e1 = segment(eng, lastTs, 'e1')
  const e2 = segment(eng, lastTs, 'e2')

  // e1 is a 5-second finish: 14 melee + 2 slay hits + 9 avoided = 25 swings, ONE Smiting Strike.
  assert.equal(e1.activeSec, 5)
  assert.equal(swingsOf(e1), 25)
  const r1 = procRate({ count: 1, activeSec: 5, durationSec: 5, swings: 25 })
  // BELOW the time floor: absent, NOT 0. `1 proc in a 5-second pull` is not `12 ppm`.
  assert.equal(MIN_ACTIVE_SEC, 10)
  assert.equal(r1.ppmActive, undefined)
  assert.equal(r1.ppmWall, undefined)
  // ABOVE the swing floor, so the mechanically-honest denominator still reports.
  assert.equal(MIN_SWINGS, 20)
  assert.equal(r1.per100Swings, 4)
  assert.equal(r1.count, 1) // the COUNT is never absent — it is a line the game printed

  // e2 clears both floors at 13 seconds / 52 swings, so the same lane reports all three.
  assert.equal(e2.activeSec, 13)
  assert.equal(swingsOf(e2), 52)
  const r2 = procRate({ count: 1, activeSec: 13, durationSec: 13, swings: 52 })
  assert.ok(Math.abs(r2.ppmActive! - 60 / 13) < 1e-9)
  assert.ok(Math.abs(r2.per100Swings! - 100 / 52) < 1e-9)
})

test('W40: the cast-window control, and the slay marginal', { skip: missing(W40) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W40)
  const z = you(segment(eng, lastTs, 'zone'))

  // THE NEGATIVE CONTROL. `You begin casting Smite.` at 19:30:27, `You hit a basilisk … by
  // Smite.` at 19:30:28 — one second, far inside the 12s window, so this lane is a CAST and
  // must never appear as a proc. (Two `Your Smite spell fizzles!` lines precede it; a fizzle
  // carries no damage and must not be counted either way.)
  assert.deepEqual(laneOf(z, 'Smite'), { hits: 1, total: 95 })
  assert.equal(W40.filter((l) => l.includes('You begin casting Smite.')).length, 1)
  assert.equal(W40.filter((l) => l.includes('Your Smite spell fizzles!')).length, 2)

  // SLAY UNDEAD. 15 hits for 7,008 against a 468-hit / 28,554 melee body. `directDamage` is
  // "damage on swings that PROCCED slay" — an honest label, and NOT "damage slay added". The
  // marginal figure subtracts the swing that would have landed anyway, and the assumption
  // travels with it.
  assert.deepEqual(catOf(z, 'slay'), { hits: 15, total: 7008 })
  assert.deepEqual(catOf(z, 'melee'), { hits: 468, total: 28554 })
  const meanMelee = 28554 / 468
  const marginal = 7008 - 15 * meanMelee
  assert.ok(Math.abs(meanMelee - 61.0128205) < 1e-6)
  assert.ok(Math.abs(marginal - 6092.8077) < 1e-3)
  assert.ok(marginal < 7008) // the marginal is ALWAYS below the raw slay total
  // No invocation commit anywhere in this window: the invocation span is entirely CENSORED
  // (already open when the replay began, never re-committed, never closed).
  assert.equal(segment(eng, lastTs, 'zone').procs.invocationSwitches, 0)
  assert.equal(segment(eng, lastTs, 'zone').procs.stanceSwitches, 3)
})

// ─────────────────────────────────────────────────────────────────────────────────────
// W41 — the rogue coat, primed by W35 (the shipped W35→W36 pattern)
// ─────────────────────────────────────────────────────────────────────────────────────

test('W41: the coat in force at engage comes from the PRIME, and a mid-fight swap does not relabel it', { skip: missing(W35, W41) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay([...W35, ...W41])
  // e1 is W35's own sand scarab fight (the prime landed); e2..e4 are this window's.
  assert.equal(segment(eng, lastTs, 'e1').name, 'a sand scarab')

  // e2 — Stonesoul the Unmoving, engaged 15:21:47 while the utility coat was Neurotoxic (applied
  // 14:59:44, outside the window: exactly why the prime is not optional). Slow was possible and
  // landed four times, first at +40s.
  const e2 = segment(eng, lastTs, 'e2').procs
  assert.equal(e2.coatAtEngage?.poison, 'Neurotoxic Poison')
  assert.equal(e2.slowExpected, true)
  assert.equal(e2.slowLands, 4)
  assert.equal(e2.slowLandMs, 40_000)
  // Mage Bane replaces it at 15:23:32, MID-FIGHT (+105s). That is a `coats` entry and a coat
  // span boundary — it must NOT retroactively change what was on at engage.
  assert.deepEqual(e2.coats, [{ poison: 'Mage Bane Poison', tMs: 105_000 }])
  assert.equal(e2.coatAtEngage?.poison, 'Neurotoxic Poison')

  // e3 engages under Mage Bane, which grants no Weakening Strike: slow was not possible, and
  // none landed. `slowExpected: false` with `slowLands: 0` is a loadout fact, not a dice roll.
  const e3 = segment(eng, lastTs, 'e3').procs
  assert.equal(e3.coatAtEngage?.poison, 'Mage Bane Poison')
  assert.equal(e3.slowExpected, false)
  assert.equal(e3.slowLands, 0)

  // e4 also engages under Mage Bane — and then Neurotoxic goes back on at +31s and two slows
  // land. Engage state stays Mage Bane; the swap is a `coats` entry. Both halves are true.
  const e4 = segment(eng, lastTs, 'e4').procs
  assert.equal(e4.coatAtEngage?.poison, 'Mage Bane Poison')
  assert.equal(e4.slowExpected, false)
  assert.deepEqual(e4.coats, [{ poison: 'Neurotoxic Poison', tMs: 31_000 }])
  assert.equal(e4.slowLands, 2)
  // The three COMBAT venoms coated at 01:05 are still up through all of it — the two-slot model.
  assert.deepEqual(e4.combatAtEngage.map((c) => c.poison), [
    'Asp Venom',
    'Blood Siphon Venom',
    'Stunning Venom'
  ])
})

test('W41: three different counts of the same proc, each correct for its own question', { skip: missing(W35, W41) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay([...W35, ...W41])
  const zone = segment(eng, lastTs, 'zone')
  const z = you(zone)

  // ASP VENOM STRIKE — a poison DAMAGE lane: `You hit an elemental crusader for 53 points of
  // poison damage by Asp Venom Strike.` ×2. Two hits, 106 damage, and it must equal the You
  // row's own skill lane or the Procs tab has started inventing damage.
  assert.deepEqual(laneOf(z, 'Asp Venom Strike'), { hits: 2, total: 106 })
  assert.deepEqual(zone.procs.poisonDamage, [{ name: 'Asp Venom Strike', count: 2, total: 106 }])
  assert.equal(zone.procs.poisonDamageTotal, 106)

  // BLOOD SIPHON STRIKE — the awkward one, and the reason `origin` is a field. THREE numbers:
  //   14 damage ticks / 658  — `<mob> has taken 47 damage from your Blood Siphon Strike.`
  //                            which parses as `dot`, so the cast-less SPELL detector must skip
  //                            it entirely (a DoT tick is cast-detached by construction).
  //   13 heal lines  / 611   — one tick at 15:25:22 printed no heal line at all.
  //    4 emotes              — `begins to bleed profusely!`, the shipped strike ledger.
  // None of the three is wrong; they answer different questions, and a lane that reported one
  // as another would be lying about the mechanic.
  assert.deepEqual(laneOf(z, 'Blood Siphon Strike'), { hits: 14, total: 658 })
  assert.deepEqual(catOf(z, 'dot'), { hits: 14, total: 658 })
  const bsHeals = W41.filter((l) => l.includes('healed Primitive') && l.includes('Blood Siphon Strike'))
  assert.equal(bsHeals.length, 13)
  assert.equal(bsHeals.reduce((n, l) => n + Number(/for (\d+) hit points/.exec(l)![1]), 0), 611)
  const emote = zone.procs.strikes.find((s) => s.name.startsWith('Blood Siphon Strike'))
  assert.equal(emote?.count, 4)

  // The shipped ledger over the whole window, unchanged by anything above (the tripwire).
  assert.equal(zone.procs.strikeCount, 32)
  assert.equal(zone.procs.slowLands, 6)
  assert.deepEqual(catOf(z, 'melee'), { hits: 501, total: 32484 })
  assert.deepEqual(catOf(z, 'spell'), { hits: 27, total: 3181 })
  assert.equal(zone.outTotal, 36323)
  assert.equal(swingsOf(zone), 860)
  // No undead in Ruins of Old Paineel: the slay lane is EMPTY here, which is itself a finding
  // the segment scope surfaces (slay PPM is 0 against everything that is not undead).
  assert.deepEqual(catOf(z, 'slay'), { hits: 0, total: 0 })
})

// ─────────────────────────────────────────────────────────────────────────────────────
// Forward gate — turns itself on the moment the engine serializes the new fields
// ─────────────────────────────────────────────────────────────────────────────────────

test('serialized proc lanes agree with the hand-read numbers', { skip: missing(W38) }, () => {
  installSpellDb(undefined)
  const { eng, lastTs } = replay(W38)
  const zone = segment(eng, lastTs, 'zone')
  const lanes = zone.procs.lanes
  if (!lanes) {
    // `ProcsView.lanes` / `.overall` / `.states` are optional until the serialization wave
    // lands (plan §10, wave 2). Until then this test asserts only that they are absent
    // TOGETHER — a half-populated payload is worse than an empty one.
    assert.equal(zone.procs.overall, undefined)
    assert.equal(zone.procs.states, undefined)
    return
  }
  // Once populated, the same three lanes must carry the same counts and damage this file has
  // pinned by hand, with the rates the floors allow.
  const by = new Map(lanes.map((l) => [l.name, l]))
  assert.equal(by.get('Smiting Strike')?.count, 27)
  assert.equal(by.get('Smiting Strike')?.directDamage, 2796)
  assert.equal(by.get('Smiting Strike')?.origin, 'spell')
  assert.equal(by.get('Condemnation of Nife')?.count, 5)
  assert.equal(by.get('Dismiss Undead')?.count, 5)
  for (const l of lanes) assert.equal(l.rate.swings, 922)
  // `overall` is the sum of the lanes it is built from — an identity, so it cannot drift.
  assert.equal(zone.procs.overall?.count, lanes.reduce((n, l) => n + l.count, 0))
  // 37 cast-less spell procs + 6 slay hits = 43 in this window.
  assert.equal(zone.procs.overall?.count, 43)
})
