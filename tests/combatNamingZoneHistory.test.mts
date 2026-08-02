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
// Task #56 — LIVE selection resolution + hydration signal.
//
// "Current fight (live)" must mean the OPEN fight, or — when there is none — the live ZONE
// session, never the most recent FINISHED fight (which the UI would then present as current,
// silently re-labelling itself as fights closed). `liveFallback` is the flag that lets the UI
// say which of the two it's showing. `hydrating` marks the historical-replay phase, where
// every snapshot describes a moment in the past.
// ============================================================================

const ONE_PULL: string[] = [
  '[Sun Jul 19 12:00:00 2026] You have entered Befallen.',
  '[Sun Jul 19 12:00:01 2026] You crush a skeleton for 100 points of damage.',
  '[Sun Jul 19 12:00:02 2026] You crush a skeleton for 100 points of damage.'
]

test('L1: LIVE with an OPEN fight selects that fight (no fallback)', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const lastTs = feed(eng, ONE_PULL)
  const snap = eng.snapshot(lastTs + 500, {})
  assert.equal(snap.liveFallback, false)
  assert.equal(snap.selected!.kind, 'fight')
  assert.ok(snap.selected!.outTotal > 0)
})

test('L2: LIVE with NO open fight falls back to the live zone session, flagged + populated', () => {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  const lastTs = feed(eng, ONE_PULL)
  // Far enough in the future that the fight closed on the idle fallback.
  const snap = eng.snapshot(lastTs + 120_000, {})
  assert.equal(snap.liveFallback, true, 'the UI is told it is showing the zone, not a fight')
  assert.equal(snap.selectedId, 'zone')
  assert.equal(snap.selected!.kind, 'zone')
  // The whole point: the dashboard is never empty while the zone has data.
  assert.equal(snap.selected!.outTotal, 200)
  assert.ok(snap.selected!.entities.length > 0)
  // An EXPLICIT pick is never a fallback, even when it resolves to the same zone session.
  assert.equal(eng.snapshot(lastTs + 120_000, { selectedId: 'zone' }).liveFallback, false)
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
