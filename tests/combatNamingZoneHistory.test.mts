// Task #54 golden-window tests: fight NAMING (live vs finalized) + ZONE-SESSION history.
//
// Naming rule (Task #54):
//   - LIVE (current open fight) name = the CURRENT target — the most recent target of YOUR
//     (or your pet's) outgoing damage. A multi-add pull is labeled by the mob in front of you.
//   - FINALIZED name = the LARGEST target — the mob that absorbed the most damage (a labeled
//     proxy for "the thing we were killing"; the log has no HP — AGENTS.md world-model law 6).
//   - Both keep the '+N' others suffix (count of the OTHER distinct engaged targets).
//
// Zone-session history (Task #54): a zone change FINALIZES the live zone aggregate into a capped
// ring (last 20) instead of discarding it, so a past zone's overall meter stays selectable. The
// snapshot exposes zoneSessions (live first, then finalized newest-first); buildSelected accepts a
// finalized zone-session id ('zs<n>').
//
// The lines below are shaped exactly like the real log (verb conjugation, "for N points of
// damage", "You have entered X."). Divergence between live and finalized names is demonstrated on
// the REAL multi-add log in the task report (e.g. enc e17: live "a greater mummy +1" while you
// were swinging the mummy, finalized "A necro theurgist (4) +1" once the theurgist absorbed most).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { LIVE_SELECTION, scopeOptions } from '../src/renderer/src/features/combat/dashboardData'

function feed(eng: CombatEngine, lines: string[]): number {
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      eng.ingestEvent(ev, false)
      lastTs = ev.ts
    }
  }
  return lastTs
}

// A multi-add pull: you hit a goblin a lot (largest target), then switch to a bat at the very end
// (most-recent target). While the fight is OPEN, the live name follows the last thing you swung at
// (the bat); once finalized, it names the largest-damage target (the goblin).
const MULTI_ADD: string[] = [
  '[Sun Jul 19 09:00:00 2026] You crush a cave goblin for 50 points of damage.',
  '[Sun Jul 19 09:00:01 2026] You crush a cave goblin for 60 points of damage.',
  '[Sun Jul 19 09:00:02 2026] You crush a cave goblin for 40 points of damage.',
  '[Sun Jul 19 09:00:03 2026] You slash a cave bat for 10 points of damage.'
]

test('N1: LIVE fight name = current (most-recent) target; +N counts the other engaged target', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const lastTs = feed(eng, MULTI_ADD)
  // Snapshot WHILE the fight is still open (just after the last hit, within the linger window).
  const snap = eng.snapshot(lastTs + 500, {})
  const cur = snap.segments.find((s) => s.kind === 'current')
  assert.ok(cur, 'a current encounter should be open')
  // Most-recent out target is the bat; the goblin is the other engaged target → "+1".
  assert.equal(cur!.name, 'a cave bat +1')
  // The selected (live) SegmentView carries the same live name.
  assert.equal(snap.selected!.name, 'a cave bat +1')
})

test('N2: FINALIZED fight name = largest-damage target (+N suffix preserved)', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const lastTs = feed(eng, MULTI_ADD)
  // Snapshot far in the future → the fight closes (death-linger/fallback), so it's finalized and
  // appears in the segments as a 'fight'. Largest target is the goblin (150 vs 10).
  const snap = eng.snapshot(lastTs + 120_000, {})
  const fight = snap.segments.find((s) => s.kind === 'fight')
  assert.ok(fight, 'the fight should be finalized into history')
  assert.equal(fight!.name, 'a cave goblin +1')
})

test('N3: single-target fight has no +N and live==finalized name', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const lines = [
    '[Sun Jul 19 09:10:00 2026] You crush a lone rat for 20 points of damage.',
    '[Sun Jul 19 09:10:01 2026] You crush a lone rat for 25 points of damage.'
  ]
  const lastTs = feed(eng, lines)
  const live = eng.snapshot(lastTs + 500, {}).segments.find((s) => s.kind === 'current')!
  assert.equal(live.name, 'a lone rat')
  const fin = eng.snapshot(lastTs + 120_000, {}).segments.find((s) => s.kind === 'fight')!
  assert.equal(fin.name, 'a lone rat')
})

test('Z1: a zone change finalizes the prior zone aggregate into a selectable session', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  feed(eng, [
    '[Sun Jul 19 09:20:00 2026] You have entered Befallen.',
    '[Sun Jul 19 09:20:01 2026] You crush a skeleton for 100 points of damage.',
    '[Sun Jul 19 09:20:02 2026] You crush a skeleton for 100 points of damage.',
    '[Sun Jul 19 09:25:00 2026] You have entered East Commonlands.',
    '[Sun Jul 19 09:25:01 2026] You crush a decaying skeleton for 10 points of damage.'
  ])
  const snap = eng.snapshot(Date.parse('Sun Jul 19 09:25:02 2026') + 500, {})
  // Live session is East Commonlands; the finalized session is Befallen (200 dmg).
  assert.equal(snap.zoneSessions[0].live, true)
  assert.equal(snap.zoneSessions[0].zone, 'East Commonlands')
  const befallen = snap.zoneSessions.find((z) => z.zone === 'Befallen' && !z.live)
  assert.ok(befallen, 'Befallen should be a finalized zone session')
  assert.equal(befallen!.total, 200)
  assert.ok(befallen!.startTs > 0 && befallen!.endTs >= befallen!.startTs, 'timing populated')

  // buildSelected can rebuild the finalized session's full breakdown by its id.
  const sel = eng.snapshot(Date.parse('Sun Jul 19 09:25:02 2026') + 500, { selectedId: befallen!.id })
  assert.equal(sel.selectedId, befallen!.id)
  assert.equal(sel.selected!.kind, 'zone')
  assert.equal(sel.selected!.outTotal, 200)
  assert.ok(sel.selected!.name.includes('Befallen'))
})

test('Z2: zone-session history is capped at 20 finalized sessions', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  const ing = (raw: string): void => {
    const ev = parseEvent(raw, seq++)
    if (ev) eng.ingestEvent(ev, false)
  }
  // 25 zones, each with one damage line, then a final zone to flush the 25th.
  for (let i = 0; i < 25; i++) {
    const mm = String(i).padStart(2, '0')
    ing(`[Sun Jul 19 10:${mm}:00 2026] You have entered Zone${i}.`)
    ing(`[Sun Jul 19 10:${mm}:01 2026] You crush a mob for 5 points of damage.`)
  }
  ing('[Sun Jul 19 11:00:00 2026] You have entered Final.')
  const snap = eng.snapshot(Date.parse('Sun Jul 19 11:00:01 2026'), {})
  const finalized = snap.zoneSessions.filter((z) => !z.live)
  assert.equal(finalized.length, 20, 'only the last 20 finalized zone sessions are retained')
  // Newest-first: the most recent finalized zone is Zone24.
  assert.equal(finalized[0].zone, 'Zone24')
})

// ============================================================================
// Task #56 (hydration) + Task #60 (Fight vs Overall is an explicit SCOPE).
//
// SUPERSEDED SEMANTICS — read this before "fixing" L2 back: the snapshot used to fall back to
// the live ZONE session whenever no fight was open, and flagged it with `liveFallback`. That
// made the meter switch itself between pulls (fight → zone-overall → fight), which is exactly
// what the user rejected. `liveFallback` is GONE.
//
// The default selection (no `selectedId`) is now the FIGHT scope's head row and stays inside
// the fight scope forever: the open fight while one is open, otherwise the most recent
// FINALIZED fight, otherwise nothing at all. The zone aggregate is reached ONLY by explicitly
// asking for a zone-session id ('zone' / 'zs<n>') — the renderer's Overall scope. Presenting a
// finished fight as the current one is prevented in the UI instead, by LABEL: the renderer
// finds the `kind: 'current'` segment to tell "Current fight (live)" from "Last fight — <name>"
// (dashboardData.fightScopeOptions), so the engine never has to lie or switch subjects.
//
// `hydrating` marks the historical-replay phase, where every snapshot describes the past.
// ============================================================================

const ONE_PULL: string[] = [
  '[Sun Jul 19 12:00:00 2026] You have entered Befallen.',
  '[Sun Jul 19 12:00:01 2026] You crush a skeleton for 100 points of damage.',
  '[Sun Jul 19 12:00:02 2026] You crush a skeleton for 100 points of damage.'
]

test('L1: the default selection with an OPEN fight is that fight', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const lastTs = feed(eng, ONE_PULL)
  const snap = eng.snapshot(lastTs + 500, {})
  assert.equal(snap.selected!.kind, 'fight')
  const cur = snap.segments.find((s) => s.kind === 'current')
  assert.ok(cur, 'an open fight is present, so the UI labels the head row "Current fight (live)"')
  assert.equal(snap.selectedId, cur!.id)
  assert.ok(snap.selected!.outTotal > 0)
})

test('L2: with NO open fight the default STAYS on the last fight — it never switches to the zone', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const lastTs = feed(eng, ONE_PULL)
  // Far enough in the future that the fight closed on the idle fallback.
  const snap = eng.snapshot(lastTs + 120_000, {})
  const lastFight = snap.segments.find((s) => s.kind === 'fight')
  assert.ok(lastFight, 'the pull finalized into history')
  assert.equal(snap.selectedId, lastFight!.id, 'the default is the most recent FIGHT, not "zone"')
  assert.equal(snap.selected!.kind, 'fight')
  assert.equal(snap.selected!.outTotal, 200)
  // No `kind: 'current'` segment ⇒ the renderer labels this row "Last fight — …", never "live".
  assert.equal(snap.segments.some((s) => s.kind === 'current'), false)
  // Overall is reachable only by ASKING for it (the renderer's Overall scope).
  const overall = eng.snapshot(lastTs + 120_000, { selectedId: 'zone' })
  assert.equal(overall.selectedId, 'zone')
  assert.equal(overall.selected!.kind, 'zone')
  assert.equal(overall.selected!.outTotal, 200)
})

test('L2b: with no fights at all the fight scope resolves to NOTHING (it never borrows the zone)', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  // A zone line only — no damage anywhere, so there is no fight to show.
  feed(eng, ['[Sun Jul 19 13:00:00 2026] You have entered Befallen.'])
  const snap = eng.snapshot(Date.parse('Sun Jul 19 13:00:01 2026'), {})
  assert.equal(snap.selected, null, 'a fresh session shows a quiet "no fights yet", not zone data')
  assert.equal(snap.segments.some((s) => s.kind === 'current' || s.kind === 'fight'), false)
})

// The selector's SCOPE filter (renderer-side, pure) — the one place that decides what each
// scope may list. Fight must never offer a zone session and Overall must never offer a fight.
test('S1: the Fight scope lists only fights and labels a finished head row honestly', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const lastTs = feed(eng, ONE_PULL)

  // While the pull is OPEN the head row is the live one.
  const openSnap = eng.snapshot(lastTs + 500, {})
  const open = scopeOptions('fight', openSnap.segments, openSnap.zoneSessions)
  assert.equal(open.head!.value, LIVE_SELECTION, 'the head row is the re-resolving sentinel, not a pinned id')
  assert.equal(open.head!.live, true)
  assert.equal(open.head!.label, 'Current fight (live)')

  // Once it closes the SAME row keeps showing that fight — but says it is the last one.
  const doneSnap = eng.snapshot(lastTs + 120_000, {})
  const done = scopeOptions('fight', doneSnap.segments, doneSnap.zoneSessions)
  assert.equal(done.head!.live, false)
  assert.match(done.head!.label, /^Last fight — /)
  assert.equal(done.head!.name, 'a skeleton')
  // …and it is not duplicated below itself.
  assert.equal(done.rest.length, 0)

  // No zone session may appear in the fight scope, ever.
  const ids = [done.head!.value, ...done.rest.map((r) => r.value)]
  assert.equal(ids.some((id) => id === 'zone' || /^zs\d+$/.test(id)), false, 'no zone sessions in the Fight scope')
})

test('S2: the Overall scope lists only zone sessions', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  feed(eng, [
    '[Sun Jul 19 14:00:00 2026] You have entered Befallen.',
    '[Sun Jul 19 14:00:01 2026] You crush a skeleton for 100 points of damage.',
    '[Sun Jul 19 14:05:00 2026] You have entered East Commonlands.',
    '[Sun Jul 19 14:05:01 2026] You crush a decaying skeleton for 10 points of damage.'
  ])
  const snap = eng.snapshot(Date.parse('Sun Jul 19 14:05:02 2026') + 500, {})
  const overall = scopeOptions('overall', snap.segments, snap.zoneSessions)
  assert.equal(overall.head!.value, 'zone', 'the live zone session heads the list')
  assert.equal(overall.head!.live, true)
  assert.match(overall.head!.label, /East Commonlands — overall/)
  assert.ok(overall.rest.length >= 1, 'the finalized Befallen session is selectable')
  // A fight id ('e<n>') must never leak into the Overall scope.
  const ids = [overall.head!.value, ...overall.rest.map((r) => r.value)]
  assert.equal(ids.every((id) => id === 'zone' || /^zs\d+$/.test(id)), true, 'no fights in the Overall scope')
})

test('L3: hydrating is true during the historical replay and false once the tail takes over', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  assert.equal(eng.snapshot(Date.now(), {}).hydrating, true, 'fresh engine = replay phase')
  const lastTs = feed(eng, ONE_PULL) // ingested with live:false — still replaying
  assert.equal(eng.snapshot(lastTs + 500, {}).hydrating, true)
  eng.setLive()
  assert.equal(eng.snapshot(lastTs + 500, {}).hydrating, false)
  // A character switch replays from scratch, so hydration starts over.
  eng.reset()
  assert.equal(eng.snapshot(Date.now(), {}).hydrating, true)
})
