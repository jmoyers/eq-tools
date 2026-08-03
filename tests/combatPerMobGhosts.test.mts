// Task #58 golden window: THE PER-MOB PANEL SHOWS ONLY REAL INSTANCES.
//
// The report (integrator-verified against the real log + a user screenshot): the dashboard's
// "Damage by mob" panel showed FOUR rows for a two-mob fight against "a deadly black widow" —
// the two correct instance-labelled rows plus TWO 0-damage phantoms:
//
//   1. a bare "a deadly black widow" row. The panel groups the encounter's timeline instants
//      by their `target`, and the DAMAGE path writes the world-model INSTANCE label
//      (`world.label(world.resolve(...))` → "… (7)" / "… (8)", law 2 + the twin
//      disambiguation), while the MISS and RESIST paths wrote the RAW log name. Every whiff
//      at either twin therefore piled onto one phantom row that no instance owns.
//
//   2. an "on a deadly black widow" row. The frenzy miss family — "You try to frenzy ON X,
//      but miss!" — is the one prepositional verb in the "tr(y|ies) to <verb> <object>"
//      family (1,012 lines in the real log; verified as the ONLY one, full-log sweep). The
//      parser's object capture swallowed the preposition, so the miss target was literally
//      "on a deadly black widow". The LANDED form ("You frenzy on X for N points…") has
//      always parsed clean, which is why the ghost carried misses but never damage.
//
// THE FIX is symmetric with the damage path on both sides:
//   parser  — MISS_RE strips an optional leading "on " from the object capture.
//   engine  — routeMiss/routeResist run the defender through defenderLabel(), which
//             resolves to the world instance ONLY when that name is already ENGAGED in the
//             encounter. `engaged` membership comes exclusively from LANDED damage/heals, so
//             a whiff at a mob we have never damaged still spawns no instance and moves no
//             gen counter (AGENTS.md law 8: a miss/resist is damage-free AND side-effect-free).
//
// THE WINDOW — tests/fixtures/w25-per-mob-miss-ghosts.log, raw log lines 1006240..1007109
// (Sun Aug 02 16:50:57 → 16:53:23), extracted verbatim by tests/extract-combat-fixtures.mjs
// (only player chat dropped). Hand-read; the load-bearing beats:
//   16:50:57–16:52:09  a SIX-widow blob (gens 1–6) — a long chain of misses that must split
//                      across six instances instead of collapsing onto one bare row.
//   16:52:14–16:52:32  a vampire-bat fight. At 16:52:38 ONE whiff at a widow arrives while
//                      the bat encounter is still open (the widow's first DAMAGE is the very
//                      next line) — a mob that is NOT engaged here. It must keep its raw
//                      name and spawn nothing; if it spawned, the widows below would
//                      renumber to (8)/(9) and the user's labels would drift.
//   16:52:38–16:53:22  THE REPORTED FIGHT: exactly two widow instances, gens 7 and 8, and 56
//                      outgoing misses (the 57 in the wall-clock span minus the one at
//                      16:52:38 that lands before the fight's first damage, so it attaches to
//                      the still-open bat encounter — law 8: a miss never OPENS an encounter).
//
// REGRESSION TRIPWIRE: the pre-fix replay of this exact window produced fight totals
// 9052 / 2600 / 3045 and per-target damage totals identical to the ones asserted below —
// misses and resists carry no amount, so relabelling them cannot move a single point of
// damage. Miss COUNTS are conserved too: e1's 108 (102 bare + 6 "on") now distribute
// 18/24/16/19/8/23 across the six real instances.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { groupByTarget } from '../src/renderer/src/features/combat/dashboardData'
import type { SegmentSummary, TimelineView } from '../src/shared/combat'

// ── the parser half: the prepositional miss family ────────────────────────────────────

/** Parse one line and assert it came back as a `miss` event (narrowing helper). */
function miss(text: string): { attacker: string; target: string; mtype: string } {
  const ev = parseEvent(`[Sun Aug 02 16:50:57 2026] ${text}`, 0)
  assert.ok(ev, `line did not parse at all: ${text}`)
  assert.equal(ev.kind, 'miss', `expected a miss event for: ${text}`)
  if (ev.kind !== 'miss') throw new Error('unreachable')
  return { attacker: ev.attacker, target: ev.target, mtype: ev.mtype }
}

test('frenzy MISS: the "on" preposition never reaches the target (both persons)', () => {
  // The exact ghost-producing line (10 of these against the widow in the real log).
  assert.deepEqual(miss('You try to frenzy on a deadly black widow, but miss!'), {
    attacker: 'You', target: 'a deadly black widow', mtype: 'miss'
  })
  // Third person keeps the same object shape ("tries to frenzy on <X>").
  assert.deepEqual(miss('An elemental warrior tries to frenzy on Master Yael, but misses!'), {
    attacker: 'An elemental warrior', target: 'Master Yael', mtype: 'miss'
  })
  // Incoming: the defender is YOU, and the object capture is the one carrying the preposition.
  assert.deepEqual(miss('Lord Nagafen tries to frenzy on YOU, but misses!'), {
    attacker: 'Lord Nagafen', target: 'You', mtype: 'miss'
  })
})

test('frenzy MISS: the avoided-swing variants (defender-named / YOU / absorb) stay intact', () => {
  // Defender-named avoid: the target comes from the "but <defender> parries!" capture,
  // which never carried the preposition — this asserts the fix did not disturb it.
  assert.deepEqual(miss('You try to frenzy on a deadly black widow, but a deadly black widow parries!'), {
    attacker: 'You', target: 'a deadly black widow', mtype: 'parry'
  })
  assert.deepEqual(miss('Lord Nagafen tries to frenzy on YOU, but YOU block!'), {
    attacker: 'Lord Nagafen', target: 'You', mtype: 'block'
  })
  // The absorb branch reads its defender from the OBJECT capture, so it is the other
  // consumer of the strip; a prepositional absorb must land on the bare mob name too.
  assert.deepEqual(miss('You try to bash Cazic-Thule, but Cazic-Thule\'s magical skin absorbs the blow!'), {
    attacker: 'You', target: 'Cazic-Thule', mtype: 'absorb'
  })
  assert.deepEqual(miss('You try to frenzy on Cazic-Thule, but Cazic-Thule\'s magical skin absorbs the blow!'), {
    attacker: 'You', target: 'Cazic-Thule', mtype: 'absorb'
  })
})

test('non-prepositional verbs are untouched, and "on" is stripped only as a whole word', () => {
  assert.deepEqual(miss('You try to slash a deadly black widow, but miss!'), {
    attacker: 'You', target: 'a deadly black widow', mtype: 'miss'
  })
  assert.deepEqual(miss('You try to backstab a deadly black widow, but miss!'), {
    attacker: 'You', target: 'a deadly black widow', mtype: 'miss'
  })
  assert.deepEqual(miss('A deadly black widow tries to bite YOU, but misses!'), {
    attacker: 'A deadly black widow', target: 'You', mtype: 'miss'
  })
  // The strip is "on" + space, so a name merely STARTING with the letters "on" is safe.
  assert.deepEqual(miss('You try to slash onyx drake hatchling, but miss!'), {
    attacker: 'You', target: 'onyx drake hatchling', mtype: 'miss'
  })
  // Trailing swing modifiers still parse (the ghost family and this one coexist).
  assert.deepEqual(miss('A deadly black widow tries to bite YOU, but misses! (Riposte)'), {
    attacker: 'A deadly black widow', target: 'You', mtype: 'miss'
  })
})

test('the LANDED frenzy form was always clean — miss and hit now agree on the target', () => {
  const ev = parseEvent('[Sun Aug 02 16:51:15 2026] You frenzy on a deadly black widow for 115 points of damage. (Critical)', 0)
  assert.ok(ev)
  assert.equal(ev.kind, 'damage')
  if (ev.kind !== 'damage') throw new Error('unreachable')
  assert.equal(ev.attacker, 'You')
  assert.equal(ev.target, 'a deadly black widow', 'the landed form never carried "on "')
  assert.equal(ev.skill, 'Frenzy')
  assert.equal(ev.amount, 115)
  assert.equal(ev.crit, true)
  // The pair that produced the two rows in the user's screenshot now shares one target.
  assert.equal(miss('You try to frenzy on a deadly black widow, but miss!').target, ev.target)
})

// ── the engine half: the golden window ────────────────────────────────────────────────

// Fixtures are COMMITTED (`.gitignore` negates `tests/fixtures/*.log`) — regenerate
// with `node tests/extract-combat-fixtures.mjs <path to eqlog_Primitive_freeport.txt>`.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const W25_PATH = join(FIXTURES, 'w25-per-mob-miss-ghosts.log')
const W25 = existsSync(W25_PATH)
  ? readFileSync(W25_PATH, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
  : []
const SKIP = W25.length === 0 && 'fixture not present'

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

/** Finalized fights, oldest → newest, observed well after the window (everything closed). */
function fights(eng: CombatEngine, lastTs: number): SegmentSummary[] {
  return eng.snapshot(lastTs + 120_000, {}).segments.filter((s) => s.kind === 'fight').reverse()
}

/** The timeline the dashboard's per-mob panel actually consumes, for one fight. */
function timeline(eng: CombatEngine, lastTs: number, id: string): TimelineView {
  const tl = eng.snapshot(lastTs + 120_000, { selectedId: id, timeline: true }).timeline
  assert.ok(tl, `fight ${id} has no timeline ring`)
  return tl
}

test('W25: the reported fight shows EXACTLY its two real widow instances', { skip: SKIP }, () => {
  const { eng, lastTs } = replay(W25)
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 3, 'six-widow blob, vampire bats, then the reported two-widow fight')

  const reported = fs[2]
  assert.equal(reported.name, 'a deadly black widow (8) +1', 'largest target + the "+N others" suffix')
  const { rows, total, estimated } = groupByTarget(timeline(eng, lastTs, reported.id))
  assert.equal(estimated, false, 'the window is far under the serialization budget — exact numbers')

  // THE ASSERTION THE BUG FAILED: two rows, not four.
  assert.deepEqual(
    rows.map((r) => [r.target, r.total, r.hits, r.misses, r.resists]),
    [
      ['a deadly black widow (8)', 1543, 33, 35, 0],
      ['a deadly black widow (7)', 1502, 26, 21, 0]
    ]
  )
  assert.equal(total, 3045, 'per-target totals sum to the fight total — nothing leaked to a ghost')
  assert.equal(rows[0].misses + rows[1].misses, 56, 'every outgoing whiff attached to a real instance')
})

test('W25: no ghost rows anywhere — no "on "-prefixed and no unowned bare target', { skip: SKIP }, () => {
  const { eng, lastTs } = replay(W25)
  const fs = fights(eng, lastTs)

  for (const f of fs) {
    const { rows, total } = groupByTarget(timeline(eng, lastTs, f.id))
    for (const r of rows) {
      // (1) the parser ghost — a preposition can never reach a defender name again.
      assert.ok(!r.target.startsWith('on '), `"${r.target}" leaked a preposition in ${f.name}`)
      // (2) every row is a plausible mob label: a bare name or the twin "(N)" suffix form,
      //     never the mixed shape the raw-name path produced.
      assert.match(r.target, /^[^(]+( \(\d+\))?$/, `"${r.target}" is not an instance label`)
    }
    assert.equal(
      rows.reduce((s, r) => s + r.total, 0), total,
      `${f.name}: per-target damage must reconstruct the panel total`
    )
  }

  // The six-widow blob: every instance owns its own row, and the miss COUNT is conserved
  // (pre-fix: 102 on a bare ghost + 6 on an "on " ghost = 108, spread over ZERO real mobs).
  const blob = groupByTarget(timeline(eng, lastTs, fs[0].id))
  assert.equal(blob.rows.length, 6, 'gens 1–6, one row each')
  assert.deepEqual(
    blob.rows.map((r) => r.target).sort(),
    [
      'a deadly black widow', 'a deadly black widow (2)', 'a deadly black widow (3)',
      'a deadly black widow (4)', 'a deadly black widow (5)', 'a deadly black widow (6)'
    ],
    'gen 1 keeps the bare name by design (world.label) — it is a REAL instance, not a ghost'
  )
  assert.equal(blob.rows.reduce((s, r) => s + r.misses, 0), 108, 'miss count conserved, now attributed')
  assert.ok(blob.rows.every((r) => r.total > 0 && r.misses > 0), 'every widow both took hits and was whiffed at')
})

test('W25: damage is byte-identical — relabelling misses moves no points', { skip: SKIP }, () => {
  const { eng, lastTs } = replay(W25)
  const fs = fights(eng, lastTs)
  // Pre-fix baseline, captured from this exact window before either change landed.
  assert.deepEqual(fs.map((f) => f.total), [9052, 2600, 3045])
  assert.deepEqual(
    groupByTarget(timeline(eng, lastTs, fs[0].id)).rows.map((r) => r.total).sort((a, b) => b - a),
    [1536, 1529, 1522, 1522, 1475, 1468],
    'per-widow damage in the six-mob blob is unchanged'
  )
})

test('W25: a whiff at an UNENGAGED mob spawns nothing (no gen drift)', { skip: SKIP }, () => {
  const { eng, lastTs } = replay(W25)
  const fs = fights(eng, lastTs)
  // At 16:52:38 a widow whiff lands while the BAT encounter is still open; the widow's own
  // first damage is the next line. The widow is not engaged in the bat fight, so it keeps its
  // RAW name — the honest label when no instance is resolvable — and creates no instance.
  const bats = groupByTarget(timeline(eng, lastTs, fs[1].id))
  assert.deepEqual(
    bats.rows.map((r) => [r.target, r.total, r.misses]),
    [
      ['a vampire bat (2)', 1333, 14],
      ['a vampire bat', 1267, 13],
      ['a deadly black widow', 0, 1]
    ]
  )
  // THE PROOF: had that whiff resolved-and-spawned, the next fight's widows would be gens
  // 8 and 9. They are 7 and 8 — the user-visible labels never drift from a miss.
  const reported = groupByTarget(timeline(eng, lastTs, fs[2].id))
  assert.deepEqual(reported.rows.map((r) => r.target), [
    'a deadly black widow (8)', 'a deadly black widow (7)'
  ])
})
