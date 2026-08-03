// GOLDEN WINDOW: the SELF rune-absorb miss (`YOUR magical skin absorbs the blow!`).
//
// THE BUG (user-reported, integrator-verified against the real log). MISS_RE's absorb
// alternative was written as
//
//     |.+?'s magical skin (absorbs) the blow)
//
// which requires a POSSESSIVE `<name>'s magical skin`. That matches the third-person twin — a
// MOB's own rune eating OUR swing (`You try to slash Kahaptra Z`Taj, but Kahaptra Z`Taj's magical
// skin absorbs the blow!`) — but it can never match the SELF form, where the game writes no name
// at all:
//
//     A deadly black widow tries to bite YOU, but YOUR magical skin absorbs the blow!
//
// So no self-form line ever produced a MISS event. (Originally they fell through the whole
// classify() battery to the 'unknown' kind; Task #59's heal meter then added a downstream
// SKIN_ABSORB_BLOW_RE branch that claimed them as `mitigation`/'absorbSwing' — which fixed the
// absorption COUNT but left the defensive miss aggregate just as blind, because a mitigation event
// never reaches routeMiss.) Full-log sweep (2026-08-02, eqlog_Primitive_freeport.txt):
//
//     385  bare `YOUR magical skin absorbs the blow!`     — silently DROPPED
//   1,428  possessive `<name>'s magical skin absorbs …`   — parsed fine
//     235  `YOUR magical skin absorbs the damage of <X>'s thorns.` — a different family
//                                                            (mitigation/absorbDamageShield),
//                                                            already parsed, not affected here
//
// Nothing else in the log says "absorb": the only other hits are two player chat lines, which the
// fixture scrub drops anyway. There is no Riposte-variant or alternative absorb phrasing to find.
//
// THE BLAST RADIUS is exactly one aggregate. Every self-form line is an INCOMING avoided swing, so
// the loss was an undercount in `addIncMiss` — the per-mob incoming miss counts and therefore the
// DEFENSIVE hit% / avoidance breakdown. No damage total could move: a miss carries no amount
// (AGENTS.md law 8), and the self-form lines never carried one in either lane.
//
// BEFORE/AFTER on this exact fixture (both replays run, pre-fix parser vs post-fix):
//                                    pre-fix                        post-fix
//   incoming "a Teir`Dal priest"     3 misses, absorb 0, hit 50%    5 misses, absorb 2, hit 37.5%
//   incoming "Kahaptra Z`Taj"        1 miss,   absorb 0             identical
//   outgoing "You"                   31 misses, absorb 3            identical
//   damage totals (2247 / 74 / 87)   —                              byte-identical
//   mitigation.absorbedSwings        2                              2  ← the no-double-count gate
// One row moved, and it is the row the bug report named.
//
// THE FIX (src/main/log/parser.ts): a second absorb alternative, `(YOUR) magical skin absorbs the
// blow`, as group 9. The two shapes are DISJOINT — `.+?'s ` needs a literal apostrophe-s the
// `YOUR` form does not have — so the possessive path is provably untouched. DEFENDER RESOLUTION
// differs between them and is the subtle part: the possessive branch takes the defender from the
// swing's OBJECT capture (group 2), because the object IS the named mob whose rune fired. The self
// branch has no name to capture, so it supplies the defender itself: `YOUR magical skin` can only
// ever describe the player, so the defender is You. (Group 2 does read "YOU" on all 385 real
// lines, but the branch — not the object text — is the authority.)
//
// KNOCK-ON, verified rather than assumed:
//   - defenderLabel() gating (Task #58) is untouched. The self form resolves to target 'You',
//     which defenderLabel short-circuits to 'You' before any world lookup, so a whiff still
//     spawns no instance and drifts no gen counter (law 8).
//   - the absorbed-swing COUNT in the healing meter is unchanged. The engine counts absorbed
//     swings off BOTH lanes — routeMitigation('absorbSwing') and routeMiss(mtype 'absorb',
//     incoming) — and a line yields EXACTLY ONE event, so moving the self form from the first
//     lane to the second can neither double-count nor drop it. Both lanes also use the SAME
//     encounter gate (`ts - current.lastTs <= FALLBACK_IDLE_MS`), so the per-fight count is
//     unchanged too, not just the zone one. Measured: 2 before, 2 after. W27 in
//     healingWindows.test.mts pins its single absorbed swing at 1 across the same change.
//
// THE WINDOW — tests/fixtures/w29-absorb-both-shapes.log, raw log lines 990649..990795
// (Sun Aug 02 15:25:34 → 15:26:04), extracted verbatim by tests/extract-combat-fixtures.mjs (one
// player chat line dropped by the shared scrub). It is the tightest real span carrying BOTH absorb
// shapes, so one replay proves the fix and the no-regression at once. HAND-READ, every avoided
// swing in the file:
//
//   OUTGOING (You → mob), 31 total:
//     Kahaptra Z`Taj  12 = 9 plain misses + 3 POSSESSIVE absorbs (his rune ate our slashes at
//                          15:25:34, :36, :36) — these must stay OUTGOING and must never be
//                          credited to our mitigation.
//     a Teir`Dal priest 19 = 18 plain misses + 1 parry (15:25:55)
//     ⇒ breakdown miss 27 · parry 1 · absorb 3
//
//   INCOMING (mob → You), 6 total:
//     Kahaptra Z`Taj     1 = 1 plain miss (15:25:40 crush)
//     a Teir`Dal priest  5 = 3 plain misses (15:25:49 crush, 15:25:49 bash, 15:25:55 crush)
//                          + 2 SELF absorbs (15:25:57 bash, 15:26:01 crush)  ← THE BUG.
//                          Before the fix this row read 3 and its absorb bucket read 0.
//
//   ABSORPTION ledger: 9 rune grants (13+25+9+26+1+19+16+9+11 = 129, max 26, min 1),
//                      4 absorbed thorns ticks, 2 absorbed swings — all count-only families
//                      unchanged in shape by this fix.
//
// The two pulls are ONE encounter (the priest lands damage 4s after Kahaptra dies, inside the
// death-linger), which is why the fight-scoped and zone-scoped incoming rows agree below. The one
// outgoing miss that is NOT in the encounter is the very first line of the window: it precedes the
// first landed damage, and law 8 says a miss never OPENS an encounter, so it reaches the zone
// aggregate only (31 zone vs 30 fight).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import type { SegmentView, SourceView } from '../src/shared/combat'

// ── the parser half: both absorb shapes, verbatim real lines ──────────────────────────

/** Parse one line and assert it came back as a `miss` event (narrowing helper). */
function miss(text: string): { attacker: string; target: string; mtype: string } {
  const ev = parseEvent(`[Sun Aug 02 15:25:57 2026] ${text}`, 0)
  assert.ok(ev, `line did not parse at all: ${text}`)
  assert.equal(ev.kind, 'miss', `expected a miss event for: ${text}`)
  if (ev.kind !== 'miss') throw new Error('unreachable')
  return { attacker: ev.attacker, target: ev.target, mtype: ev.mtype }
}

test('SELF rune absorb: the bare `YOUR magical skin` form parses (it used to be dropped)', () => {
  // The exact line from the user's report.
  assert.deepEqual(miss('A deadly black widow tries to bite YOU, but YOUR magical skin absorbs the blow!'), {
    attacker: 'A deadly black widow', target: 'You', mtype: 'absorb'
  })
  // The two shapes actually in the window.
  assert.deepEqual(miss('A Teir`Dal priest tries to bash YOU, but YOUR magical skin absorbs the blow!'), {
    attacker: 'A Teir`Dal priest', target: 'You', mtype: 'absorb'
  })
  assert.deepEqual(miss('A Teir`Dal priest tries to crush YOU, but YOUR magical skin absorbs the blow!'), {
    attacker: 'A Teir`Dal priest', target: 'You', mtype: 'absorb'
  })
  // The one trailing modifier this family ever carries (34× log-wide) — discarded, as everywhere
  // else in the miss family.
  assert.deepEqual(miss('A zol ghoul knight tries to hit YOU, but YOUR magical skin absorbs the blow! (Riposte)'), {
    attacker: 'A zol ghoul knight', target: 'You', mtype: 'absorb'
  })
})

test('the POSSESSIVE absorb is untouched — its defender still comes from the swing object', () => {
  // A mob's own rune eating our swing: outgoing, defender = the named mob.
  assert.deepEqual(miss("You try to slash Kahaptra Z`Taj, but Kahaptra Z`Taj's magical skin absorbs the blow!"), {
    attacker: 'You', target: 'Kahaptra Z`Taj', mtype: 'absorb'
  })
  assert.deepEqual(miss("You try to bash a revenant, but a revenant's magical skin absorbs the blow!"), {
    attacker: 'You', target: 'a revenant', mtype: 'absorb'
  })
  // The prepositional-verb strip (Task #58) still applies on this branch.
  assert.deepEqual(miss("You try to frenzy on a revenant, but a revenant's magical skin absorbs the blow!"), {
    attacker: 'You', target: 'a revenant', mtype: 'absorb'
  })
  // …and a mob absorbing ANOTHER mob's swing keeps the named defender, not You.
  assert.deepEqual(miss("An orc pawn tries to hit a revenant, but a revenant's magical skin absorbs the blow!"), {
    attacker: 'An orc pawn', target: 'a revenant', mtype: 'absorb'
  })
})

test('the two absorb branches never collide, and the rest of the miss family is unchanged', () => {
  // Disjointness: the possessive alternative is tried FIRST and needs a literal "'s ", so it can
  // never claim a `YOUR` line; the self alternative is anchored on `YOUR ` and can never claim a
  // possessive one. A mob whose NAME ends in "your" is still handled by the possessive branch.
  assert.deepEqual(miss("You try to slash Bane of Your Kin, but Bane of Your Kin's magical skin absorbs the blow!"), {
    attacker: 'You', target: 'Bane of Your Kin', mtype: 'absorb'
  })
  // Every other outcome in the family still resolves to the same mtype/defender as before.
  assert.deepEqual(miss('A Teir`Dal priest tries to crush YOU, but misses!'), {
    attacker: 'A Teir`Dal priest', target: 'You', mtype: 'miss'
  })
  assert.deepEqual(miss('A Teir`Dal priest tries to crush YOU, but YOU dodge!'), {
    attacker: 'A Teir`Dal priest', target: 'You', mtype: 'dodge'
  })
  assert.deepEqual(miss('You try to backstab a Teir`Dal priest, but a Teir`Dal priest parries!'), {
    attacker: 'You', target: 'a Teir`Dal priest', mtype: 'parry'
  })
  assert.deepEqual(miss('You try to slash Kahaptra Z`Taj, but miss!'), {
    attacker: 'You', target: 'Kahaptra Z`Taj', mtype: 'miss'
  })
  // The DAMAGE-SHIELD absorb is a DIFFERENT family and must NOT be pulled into the miss lane
  // (it has no attacker/defender grammar at all — it is a mitigation tick).
  const ds = parseEvent(
    "[Sun Aug 02 15:25:36 2026] YOUR magical skin absorbs the damage of Kahaptra Z`Taj's thorns.",
    0
  )
  assert.equal(ds?.kind, 'mitigation')
  if (ds.kind !== 'mitigation') throw new Error('unreachable')
  assert.equal(ds.mtype, 'absorbDamageShield')
})

// ── the engine half: the golden window ────────────────────────────────────────────────

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function replay(): { zone: SegmentView; fight: SegmentView } {
  const lines = readFileSync(join(FIXTURES, 'w29-absorb-both-shapes.log'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
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
  const at = lastTs + 90_000
  const snap = eng.snapshot(at, { selectedId: 'zone' })
  assert.ok(snap.selected, 'zone segment must resolve')
  const fights = snap.segments.filter((s) => s.kind === 'fight')
  assert.equal(fights.length, 1, 'the two pulls fold into ONE encounter (death-linger)')
  const fight = eng.snapshot(at, { selectedId: fights[0].id }).selected
  assert.ok(fight, 'fight segment must resolve')
  return { zone: snap.selected!, fight: fight! }
}

const byName = (rows: readonly SourceView[], name: string): SourceView => {
  const r = rows.find((x) => x.name.toLowerCase() === name.toLowerCase())
  assert.ok(r, `expected a row for "${name}" (got ${rows.map((x) => x.name).join(', ')})`)
  return r!
}

test('W29: the previously-dropped self absorbs land in the INCOMING miss aggregate', () => {
  const { zone } = replay()

  // THE FIX, stated as the number that was wrong: the priest's incoming row.
  const priest = byName(zone.incoming, 'a Teir`Dal priest')
  assert.equal(priest.misses, 5, '3 plain misses + the 2 self absorbs that used to vanish')
  assert.deepEqual(priest.missBreakdown, {
    miss: 3, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 2
  })

  // The other mob in the window absorbs nothing incoming — it is the control.
  const kahaptra = byName(zone.incoming, 'Kahaptra Z`Taj')
  assert.equal(kahaptra.misses, 1)
  assert.deepEqual(kahaptra.missBreakdown, {
    miss: 1, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 0
  })

  // Exactly two hostiles swung at us in this window; nothing phantom appeared.
  assert.deepEqual([...zone.incoming].map((s) => s.name).sort(), ['Kahaptra Z`Taj', 'a Teir`Dal priest'])

  // DEFENSIVE hit% — the stat the undercount silently inflated. The priest landed 3 attacks
  // (31 Holy Might + 27 crush + 29 crush) and had 5 avoided, so 3/8 = 37.5%. Before the fix the
  // denominator was 6 and it read 50%.
  assert.equal(priest.hitPct, (3 / 8) * 100)
  assert.equal(priest.total, 87, '31 + 27 + 29')
})

test('W29: the possessive absorbs stay OUTGOING and are never credited to our defense', () => {
  const { zone } = replay()
  const you = byName(zone.entities, 'You')
  assert.equal(you.misses, 31)
  assert.deepEqual(you.missBreakdown, {
    miss: 27, dodge: 0, parry: 1, riposte: 0, block: 0, absorb: 3
  }, "the 3 absorbs are Kahaptra Z`Taj's OWN rune eating our slashes")

  // The three possessive lines name Kahaptra as the defender, so they can only ever appear on the
  // outgoing side. Our incoming absorb bucket totals exactly the 2 self-form lines.
  assert.equal(
    zone.incoming.reduce((s, r) => s + r.missBreakdown.absorb, 0),
    2,
    'incoming absorbs = the self form only'
  )
})

test('W29: a miss still never opens an encounter (law 8), and the fight is a subset of the zone', () => {
  const { zone, fight } = replay()

  // The window's FIRST line is an outgoing miss that precedes the first landed damage. It reaches
  // the zone aggregate only — 31 zone vs 30 fight. If a miss ever opened an encounter, these would
  // be equal and the fight would start two seconds early.
  assert.equal(byName(zone.entities, 'You').misses, 31)
  assert.equal(byName(fight.entities, 'You').misses, 30)

  // Incoming misses all arrive mid-fight, so both scopes agree — including the two self absorbs.
  for (const scope of [zone, fight]) {
    const p = byName(scope.incoming, 'a Teir`Dal priest')
    assert.equal(p.misses, 5)
    assert.equal(p.missBreakdown.absorb, 2)
  }
})

test('W29: the absorbed-swing COUNT is unchanged by the lane move (no double-count, no drop)', () => {
  const { zone, fight } = replay()
  // The engine counts absorbed swings from BOTH the mitigation path and incoming misses with
  // mtype 'absorb'. The window has exactly TWO self-absorb lines, so the counter must read 2 —
  // 4 would mean the fix introduced a double-count, 0 that it dropped the family.
  for (const scope of [zone, fight]) {
    const mit = scope.healing.mitigation
    assert.equal(mit.absorbedSwings, 2)
    // …and it agrees line-for-line with the incoming miss aggregate, which is the same evidence
    // counted through the other lane.
    assert.equal(
      mit.absorbedSwings,
      scope.incoming.reduce((s, r) => s + r.missBreakdown.absorb, 0),
      'the two lanes describe the same two lines'
    )
    // The sibling absorption families are untouched by the fix.
    assert.equal(mit.absorbedDamageShields, 4)
    assert.equal(mit.runeCount, 9)
    assert.equal(mit.runeTotal, 129, '13+25+9+26+1+19+16+9+11')
    assert.equal(mit.runeMax, 26)
    assert.equal(mit.runeMin, 1)
  }
})

test('W29 TRIPWIRE: no damage total moved — a miss carries no amount', () => {
  const { zone } = replay()
  // The 385 dropped lines produced NO event before the fix, so they contributed nothing that could
  // now be double-added; and a miss has no amount, so nothing they produce now can be added either.
  assert.equal(zone.outTotal, 2247)
  assert.equal(byName(zone.incoming, 'Kahaptra Z`Taj').total, 74, 'crush 7 + 13 thorns ticks')
  assert.equal(byName(zone.incoming, 'a Teir`Dal priest').total, 87)

  // The per-source identity that guards every damage-free instant (AGENTS.md law 8).
  for (const src of [...zone.entities, ...zone.incoming]) {
    assert.equal(
      src.categories.reduce((s, c) => s + c.total, 0),
      src.total,
      `${src.name}: category sum must equal its total`
    )
  }
  assert.equal(zone.entities.reduce((s, e) => s + e.total, 0), zone.outTotal)
})
