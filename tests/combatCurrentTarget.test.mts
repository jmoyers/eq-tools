// CombatSnapshot.currentTarget — the mob in front of you, exposed as a FACT.
//
// World-model law 6 gives fight naming two halves: a LIVE fight is named after the CURRENT
// target (the most recent outgoing target — the mob you are presently swinging at), and on
// FINALIZE the name switches to the LARGEST target ("most damage absorbed", a labeled proxy,
// because the log has no HP). `SegmentSummary.name` composes that with a '+N others' suffix,
// so it is a SENTENCE. `currentTarget` is the fact underneath it: the raw mob name, the
// others count, and the encounter's last-damage ts — the shape a mob lookup can consume
// without regex-stripping '+N' back out of a display string (law 2 — canonicalize at
// boundaries, display raw).
//
// The three things this pins:
//   1. It is the MOST RECENT outgoing target, never the largest. Those genuinely differ
//      mid-pull, and the largest-target rule must not leak backwards into a live fight.
//   2. `others` = distinct engaged targets − 1 (the same count the '+N' suffix shows).
//   3. It is UNDEFINED whenever the answer is not known: no encounter open (between pulls,
//      and after finalize), or an encounter that opened on the mob hitting YOU first and has
//      not yet taken an outgoing hit. Never a guess (law 1).
//
// THE WINDOW — tests/fixtures/w24-multi-mob-no-split.log, the same committed multi-mob pull
// Task #55's segmentation window uses (Soldier of V`Zher + Baron Telyx V`Zher, Sun Aug 02
// 15:30:23 → 15:32:17, extracted through tests/fixture-scrub.mjs by
// tests/extract-combat-fixtures.mjs). Hand-read, the beats this test stands on:
//   15:30:39  the pull OPENS on incoming damage — "Soldier of V`Zher slashes YOU for 25".
//             Your only outgoing line in that second is a MISS, which carries no target.
//   15:30:40  the Baron joins, also with incoming damage. Still no outgoing hit.
//   15:30:41  your first landed swing: "You slash Soldier of V`Zher for 85 points of damage."
//   15:30:41 → 15:31:09  every outgoing hit lands on the Soldier (1476 damage over 33 hits).
//   15:31:12 → 15:32:00  every outgoing hit lands on the Baron (2303 over 54 hits).
// So anywhere in 15:31:12..15:31:48 the current target is the BARON while the largest target
// is still the SOLDIER — the Baron only passes 1476 cumulative at 15:31:49. That divergence
// window is what makes assertion 1 meaningful on real data.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { readFixture } from './harness.mts'
import type { CombatSnapshot } from '../src/shared/combat'

const W24 = readFixture('w24-multi-mob-no-split.log')

const T = (clock: string): number => Date.parse(`Sun Aug 02 ${clock} 2026`)

/**
 * Replay the fixture up to and including every line stamped `untilTs`, then observe.
 *
 * `observeAt` defaults to 500ms after the cutoff — inside LINGER_MS, so the pull is still
 * open. Passing a far-future instant instead lets the same helper observe the finalized
 * world (closure is time-driven and evaluated inside snapshot()).
 */
function replayUntil(untilTs: number, observeAt = untilTs + 500, opts = {}): CombatSnapshot {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  for (const raw of W24) {
    const ev = parseEvent(raw, seq++)
    if (!ev || ev.ts > untilTs) continue
    eng.ingestEvent(ev, false)
  }
  return eng.snapshot(observeAt, opts)
}

/** Damage YOU/your pet landed per defender, read off the timeline — an INDEPENDENT path to
 *  "which target is largest", so the largest-vs-most-recent claim isn't self-referential. */
function damageByTarget(snap: CombatSnapshot): Map<string, number> {
  const byMob = new Map<string, number>()
  for (const ev of snap.timeline!.events) {
    if (ev.kind === 'enemy' || !ev.target || ev.amount === 0) continue
    byMob.set(ev.target, (byMob.get(ev.target) ?? 0) + ev.amount)
  }
  return byMob
}

test('CT1: an encounter opened by INCOMING damage has no current target yet', () => {
  // 15:30:39–40: both mobs have hit YOU, your only swing missed. The fight is demonstrably
  // OPEN — and the honest answer to "what are you swinging at" is still nothing.
  const snap = replayUntil(T('15:30:40'))
  assert.ok(snap.segments.some((s) => s.kind === 'current'), 'the pull is open')
  assert.equal(snap.currentTarget, undefined, 'no outgoing hit has landed — never a guess')
})

test('CT2: the first landed swing names the target, with others=0 and the damage ts', () => {
  const snap = replayUntil(T('15:30:41'))
  assert.deepEqual(snap.currentTarget, {
    name: 'Soldier of V`Zher',
    others: 0,
    // The Baron has hit YOU, but only OUTGOING targets are counted (agg.targets is bumped
    // by your damage) — "+N others" counts mobs you have swung at, matching the fight name.
    lastTs: T('15:30:41')
  })
  const cur = snap.segments.find((s) => s.kind === 'current')
  assert.equal(cur!.name, 'Soldier of V`Zher', 'and the live fight name agrees, suffix-free')
})

test('CT3: mid-pull it is the MOST RECENT target, not the largest', () => {
  // 15:31:16 — you switched to the Baron four seconds ago. Soldier 1476, Baron 191.
  const snap = replayUntil(T('15:31:16'), T('15:31:16') + 500, { timeline: true })
  assert.equal(snap.currentTarget?.name, 'Baron Telyx V`Zher')
  assert.equal(snap.currentTarget?.others, 1, 'the Soldier is the one other engaged target')

  const byMob = damageByTarget(snap)
  const largest = [...byMob.entries()].sort((a, b) => b[1] - a[1])[0]
  assert.equal(largest[0], 'Soldier of V`Zher', 'the largest target is still the dead add')
  assert.equal(largest[1], 1476, 'hand-counted: every outgoing hit 15:30:41–15:31:09')
  // 32+28+3+1+116+11 — the 1 is "You bash … for 1 POINT of damage", singular, the shape a
  // "points of damage" sweep silently drops.
  assert.equal(byMob.get('Baron Telyx V`Zher'), 191, 'hand-counted from the fixture')
  assert.notEqual(snap.currentTarget?.name, largest[0], 'the two rules genuinely diverge here')

  // The LIVE fight name is built from the same fact, plus the suffix currentTarget avoids.
  assert.equal(snap.segments.find((s) => s.kind === 'current')!.name, 'Baron Telyx V`Zher +1')
})

test('CT4: once the encounter finalizes, currentTarget is gone — not the largest target', () => {
  // Observed two minutes after the last line: both mobs are dead, the pull is finalized.
  const last = T('15:32:17')
  const snap = replayUntil(last, last + 120_000)
  assert.equal(snap.segments.some((s) => s.kind === 'current'), false, 'nothing left open')
  assert.equal(snap.currentTarget, undefined)
  // The finalized fight still exists and still renames itself to the largest target — that
  // rule is untouched; it simply must not resurface as a "current" target.
  // `segments` is newest-first after the current entry, so [0] is the pull (the rogue fight
  // that precedes it in this window is [1]).
  const fight = snap.segments.filter((s) => s.kind === 'fight')[0]
  assert.equal(fight.name, 'Baron Telyx V`Zher +1')
})

test('CT5: it tracks the switch back and forth within one open pull', () => {
  // Synthetic, in the real log's shapes: a controlled A→B→A sequence no single real window
  // happens to contain. The goblin stays the largest target throughout (150 vs 10), so every
  // observation here is also a most-recent-vs-largest check.
  const lines = [
    '[Sun Jul 19 09:00:00 2026] You crush a cave goblin for 50 points of damage.',
    '[Sun Jul 19 09:00:01 2026] You crush a cave goblin for 60 points of damage.',
    '[Sun Jul 19 09:00:02 2026] You slash a cave bat for 10 points of damage.',
    '[Sun Jul 19 09:00:03 2026] You crush a cave goblin for 40 points of damage.'
  ]
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const seen: (string | undefined)[] = []
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    seen.push(eng.snapshot(ev.ts + 500, {}).currentTarget?.name)
  }
  assert.deepEqual(seen, ['a cave goblin', 'a cave goblin', 'a cave bat', 'a cave goblin'])

  const open = eng.snapshot(Date.parse('Sun Jul 19 09:00:03 2026') + 500, {})
  assert.equal(open.currentTarget?.others, 1)
  assert.equal(open.segments.find((s) => s.kind === 'current')!.name, 'a cave goblin +1')

  // Finalized: the name is the largest target (still the goblin), and currentTarget is gone.
  const done = eng.snapshot(Date.parse('Sun Jul 19 09:00:03 2026') + 120_000, {})
  assert.equal(done.currentTarget, undefined)
  assert.equal(done.segments.find((s) => s.kind === 'fight')!.name, 'a cave goblin +1')
})

test('CT6 (tripwire): the accessor is READ-ONLY — no total moves, no segment moves', () => {
  // AGENTS.md law 8: anything that touches snapshot() proves the damage dimension is
  // byte-identical. currentTarget reads three fields and copies them; observing it — twice,
  // three times, interleaved with a zone-scoped snapshot — must change nothing at all.
  const last = T('15:32:17')
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  for (const raw of W24) {
    const ev = parseEvent(raw, seq++)
    if (ev) eng.ingestEvent(ev, false)
  }
  const first = eng.snapshot(last + 120_000, { selectedId: 'zone' })
  for (let i = 0; i < 3; i++) assert.ok(eng.currentTarget() === undefined)
  const again = eng.snapshot(last + 120_000, { selectedId: 'zone' })

  assert.equal(first.selected!.outTotal, 4179, 'the window total, hand-counted (400 + 3779)')
  assert.equal(again.selected!.outTotal, first.selected!.outTotal)
  assert.deepEqual(
    again.segments.map((s) => [s.id, s.kind, s.total, s.durationSec]),
    first.segments.map((s) => [s.id, s.kind, s.total, s.durationSec])
  )
})
