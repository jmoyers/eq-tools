// Task #55 golden window: A MULTI-MOB PULL IS ONE ENCOUNTER.
//
// The report: the user pulled TWO mobs (Soldier of V`Zher + Baron Telyx V`Zher). When the
// Soldier died, the meter finalized the fight and opened a SECOND encounter holding the
// rest of the Baron fight. Details/WoW segmentation (and AGENTS.md law 7) says a pull ends
// when COMBAT ends — all engaged hostiles dead (+linger), a held CC expiring, or the
// fled-mob idle fallback — not when one add drops.
//
// ROOT CAUSE (verified against the engine): closure conflated two different clocks. An
// engaged instance was counted "gone" once LINGER_MS (5s) passed since the last ATTRIBUTED
// DAMAGE involving it — and only landed damage refreshed that clock. Misses, resists, mob
// cast phases and hostile-on-hostile heals refreshed nothing, so a second mob that was
// merely whiffing (or casting Stun/Root/Healing) looked dead within five seconds. The fix
// splits the axes: PRESENCE (any evidence the instance is still in the fight, with a 20s
// PRESENCE_GONE_MS leash for LIVE instances) vs TIMING (LINGER_MS, damage only — DPS and
// firstHit/lastHit stay damage-derived, AGENTS.md law 8).
//
// THE WINDOW — tests/fixtures/w24-multi-mob-no-split.log, raw log lines 991860..992222
// (Sun Aug 02 15:30:23 → 15:32:17), extracted verbatim by tests/extract-combat-fixtures.mjs
// (only player chat dropped). Hand-read; the load-bearing beats:
//   15:30:23  the PREVIOUS fight (a Teir`Dal rogue) is already underway…
//   15:30:27  …and is slain — then 12s of silence. The pull below provably opens its own
//             encounter, so this window must contain exactly TWO fights, not one blob.
//   15:30:39  the pull: Soldier of V`Zher lands on YOU; the Baron joins at 15:30:40.
//   15:31:01  "Baron Telyx V`Zher healed Soldier of V`Zher for 175 hit points by Healing."
//             — a hostile-on-hostile heal: presence evidence for BOTH mobs.
//   15:31:09  "You have slain Soldier of V`Zher!" — the reported split point.
//   15:31:11  the Baron fight continues unbroken (misses, a stun phase 15:31:20–24 where
//             YOU land nothing for 5s, two Root casts, two self-heals)…
//   15:32:00  "You have slain Baron Telyx V`Zher!" — the real end of the pull.
//
// HAND-COUNTED from the fixture's raw damage lines (regex over the text, no engine):
//   You → a Teir`Dal rogue      400  ( 7 hits)   [fight 1]
//   You → Soldier of V`Zher    1476  (33 hits)   [fight 2]
//   You → Baron Telyx V`Zher   2303  (54 hits)   [fight 2]  → pull total 3779
//   Soldier of V`Zher → You     323  (20 hits)
//   Baron Telyx V`Zher → You    455  (32 hits)
//   pull span: first damage 15:30:39 → last damage 15:32:00 = 81s.
//
// PRE-FIX this window produced THREE fights on a plain replay (the 15:31:20–25 stun gap
// alone split the Baron fight), and 146 fights once the snapshot poll ran a few seconds
// ahead of the ingested log lines — which is what the user actually saw, because the app
// polls snapshot(Date.now()) while the tailer delivers the log in multi-second batches.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import type { SegmentSummary } from '../src/shared/combat'

// Fixtures are gitignored (`*.log`) like every other window in tests/fixtures — regenerate
// with `node tests/extract-combat-fixtures.mjs <path to eqlog_Primitive_freeport.txt>`.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const W24_PATH = join(FIXTURES, 'w24-multi-mob-no-split.log')
const W24 = existsSync(W24_PATH)
  ? readFileSync(W24_PATH, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
  : []

const T = (clock: string): number => Date.parse(`Sun Aug 02 ${clock} 2026`)

/**
 * Replay lines through the real parser + engine.
 *
 * `pollLagMs` models the LIVE app: the renderer asks for snapshot(Date.now()) while the
 * tailer has only delivered log lines up to `ts`, so closure is evaluated with a wall
 * clock running ahead of the ingested log time. That skew is the tick race that turned the
 * user's pull into a shower of one-second "fights"; 0 = pure replay (no race at all).
 */
function replay(lines: string[], pollLagMs = 0): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
    if (pollLagMs > 0) eng.snapshot(ev.ts + pollLagMs, {})
  }
  return { eng, lastTs }
}

/** Finalized fights, oldest → newest, observed well after the window (everything closed). */
function fights(eng: CombatEngine, lastTs: number): SegmentSummary[] {
  return eng
    .snapshot(lastTs + 120_000, {})
    .segments.filter((s) => s.kind === 'fight')
    .reverse()
}

for (const lag of [0, 6_000]) {
  const label = lag === 0 ? 'plain replay' : 'with a 6s snapshot-poll lag (the tick race)'

  test(`W24 (${label}): the two-mob pull is ONE encounter spanning both deaths`, { skip: W24.length === 0 && 'fixture not present' }, () => {
    const { eng, lastTs } = replay(W24, lag)
    const fs = fights(eng, lastTs)
    assert.equal(fs.length, 2, 'the rogue fight, then the whole V`Zher pull — nothing else')

    const [rogue, pull] = fs
    assert.equal(rogue.name, 'a Teir`Dal rogue')
    assert.equal(rogue.total, 400, 'hand-counted rogue damage')

    // Finalized name = largest target (the Baron, 2303) + "+1" for the Soldier.
    assert.equal(pull.name, 'Baron Telyx V`Zher +1')
    assert.equal(pull.startTs, T('15:30:39'), 'opens at the pull FIRST DAMAGE, not the miss before it')
    assert.equal(pull.durationSec, 81, '15:30:39 → 15:32:00, damage-derived span')
    assert.equal(pull.total, 3779, '1476 (Soldier) + 2303 (Baron), hand-counted')
  })

  test(`W24 (${label}): the single encounter attributes damage to BOTH mobs, in and out`, { skip: W24.length === 0 && 'fixture not present' }, () => {
    const { eng, lastTs } = replay(W24, lag)
    const pull = fights(eng, lastTs)[1]
    const sel = eng.snapshot(lastTs + 120_000, { selectedId: pull.id }).selected
    assert.ok(sel, 'the pull encounter rebuilds a SegmentView')

    // Outgoing: one 'You' source, both mobs among the incoming attackers.
    const you = sel!.entities.find((e) => e.id === 'you')
    assert.equal(you?.total, 3779)
    const incoming = new Map(sel!.incoming.map((s) => [s.name, s.total]))
    assert.equal(incoming.get('Soldier of V`Zher'), 323, 'hand-counted incoming from the add')
    assert.equal(incoming.get('Baron Telyx V`Zher'), 455, 'hand-counted incoming from the boss')

    // Per-mob damage taken (the timeline's per-defender breakdown) covers both mobs, so the
    // dashboard's damage-by-mob view still separates them INSIDE the one fight.
    const tl = eng.snapshot(lastTs + 120_000, { selectedId: pull.id, timeline: true }).timeline
    const byMob = new Map<string, number>()
    for (const ev of tl!.events) {
      if (ev.kind === 'enemy' || !ev.target || ev.amount === 0) continue
      byMob.set(ev.target, (byMob.get(ev.target) ?? 0) + ev.amount)
    }
    assert.equal(byMob.get('Soldier of V`Zher'), 1476)
    assert.equal(byMob.get('Baron Telyx V`Zher'), 2303)
  })

  test(`W24 (${label}): segmentation moved, damage did not (the tripwire)`, { skip: W24.length === 0 && 'fixture not present' }, () => {
    const { eng, lastTs } = replay(W24, lag)
    const snap = eng.snapshot(lastTs + 120_000, { selectedId: 'zone' })
    const fightSum = snap.segments.filter((s) => s.kind === 'fight').reduce((n, s) => n + s.total, 0)
    // The zone aggregate is segmentation-INDEPENDENT (every attributed hit lands in it
    // regardless of where the fight boundaries fall), so it is the invariant the merge must
    // preserve: 400 (rogue) + 3779 (pull).
    assert.equal(snap.selected!.outTotal, 4179)
    assert.equal(fightSum, 4179, 'no damage was lost or double-counted by the merge')
    // And the category partition still re-sums exactly (AGENTS.md law 8 tripwire).
    for (const e of [...snap.selected!.entities, ...snap.selected!.incoming]) {
      assert.equal(e.categories.reduce((n, c) => n + c.total, 0), e.total, `${e.name}: category sum == total`)
    }
  })
}

// ============================================================================
// Axis isolation + the guards the fix must NOT break. Synthetic lines in the real log's
// shapes (verb conjugation, "for N points of damage", the miss family), because each of
// these needs a controlled gap length that no single real window happens to contain.
// ============================================================================

test('S1 (presence axis): a mob that only MISSES for 27s is still in the fight', () => {
  // The goblin dies early; the bat lands nothing for 27s — well past PRESENCE_GONE_MS (20s)
  // — but keeps swinging and missing. Whiffs are evidence of presence, so the pull stays
  // open and the bat's later hit belongs to the SAME fight.
  const lines = [
    '[Sun Jul 19 08:59:50 2026] A cave bat tries to hit YOU, but misses!', // before any damage
    '[Sun Jul 19 09:00:00 2026] You crush a cave goblin for 100 points of damage.',
    '[Sun Jul 19 09:00:00 2026] A cave bat hits YOU for 10 points of damage.',
    '[Sun Jul 19 09:00:02 2026] You crush a cave goblin for 100 points of damage.',
    '[Sun Jul 19 09:00:04 2026] You have slain a cave goblin!',
    '[Sun Jul 19 09:00:06 2026] A cave bat tries to hit YOU, but misses!',
    '[Sun Jul 19 09:00:12 2026] A cave bat tries to hit YOU, but misses!',
    '[Sun Jul 19 09:00:18 2026] You try to crush a cave bat, but miss!',
    '[Sun Jul 19 09:00:24 2026] A cave bat tries to hit YOU, but misses!',
    '[Sun Jul 19 09:00:30 2026] A cave bat tries to hit YOU, but misses!',
    '[Sun Jul 19 09:00:33 2026] You crush a cave bat for 50 points of damage.'
  ]
  const { eng, lastTs } = replay(lines)
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 1, 'one pull: goblin + bat')
  assert.equal(fs[0].total, 250)
  // Law 8: presence did NOT move the damage timeline. The fight opens at the first DAMAGE
  // (09:00:00), not at the 08:59:50 miss, and ends at the last damage (09:00:33).
  assert.equal(fs[0].startTs, Date.parse('Sun Jul 19 09:00:00 2026'))
  assert.equal(fs[0].durationSec, 33)
  assert.equal(fs[0].dps, 250 / 33)
})

test('S2 (presence leash): a LIVE mob that goes fully silent for 16s does not split the pull', () => {
  // No misses at all here — the second mob is simply casting (the real Baron spent
  // 15:31:19–15:31:25 on Stun while the player was stunned). Nothing refreshes presence, so
  // only the PRESENCE_GONE_MS leash keeps the fight together. Includes a snapshot poll in
  // the gap: the wall-clock tick must not close it either.
  const lines = [
    '[Sun Jul 19 09:10:00 2026] You crush a cave goblin for 100 points of damage.',
    '[Sun Jul 19 09:10:00 2026] A cave bat hits YOU for 10 points of damage.',
    '[Sun Jul 19 09:10:05 2026] You have slain a cave goblin!',
    '[Sun Jul 19 09:10:16 2026] A cave bat hits YOU for 10 points of damage.',
    '[Sun Jul 19 09:10:20 2026] You crush a cave bat for 50 points of damage.'
  ]
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    // Poll every ingested line the way the live app does, plus one extra poll deep in the
    // silent gap (7s after the last damage — past LINGER_MS, inside the presence leash).
    eng.snapshot(ev.ts + 500, {})
    if (ev.ts === Date.parse('Sun Jul 19 09:10:05 2026')) eng.snapshot(Date.parse('Sun Jul 19 09:10:12 2026'), {})
  }
  const fs = fights(eng, Date.parse('Sun Jul 19 09:10:20 2026'))
  assert.equal(fs.length, 1, 'the add dying mid-pull does not end the fight')
  assert.equal(fs[0].total, 150)
})

test('S3 (guard): a miss or a resist still NEVER opens an encounter', () => {
  const lines = [
    '[Sun Jul 19 09:30:00 2026] You try to crush a lone rat, but miss!',
    '[Sun Jul 19 09:30:02 2026] A lone rat resisted your Mesmerization III!',
    '[Sun Jul 19 09:30:04 2026] A lone rat tries to hit YOU, but misses!'
  ]
  const { eng, lastTs } = replay(lines)
  const snap = eng.snapshot(lastTs + 120_000, { selectedId: 'zone' })
  assert.equal(snap.segments.filter((s) => s.kind === 'fight').length, 0, 'no fight was ever opened')
  assert.equal(snap.segments.filter((s) => s.kind === 'current').length, 0, 'and none left open')
  // They still land in the zone aggregate (Task #51 v2 behavior, unchanged).
  const you = snap.selected!.entities.find((e) => e.id === 'you')!
  assert.equal(you.total, 0, 'damage-free')
  assert.equal(you.misses, 1)
  assert.equal(you.resists, 1)
})

test('S4 (guard): the fled-mob idle fallback still ends a fight', () => {
  // No death line, no further evidence — the mob deaggroed. FALLBACK_IDLE_MS (60s) is
  // untouched by the fix, so the next pull is a separate encounter.
  const lines = [
    '[Sun Jul 19 09:20:00 2026] You crush a fleeing gnoll for 100 points of damage.',
    '[Sun Jul 19 09:20:02 2026] You crush a fleeing gnoll for 100 points of damage.',
    '[Sun Jul 19 09:21:30 2026] You crush a wandering rat for 50 points of damage.',
    '[Sun Jul 19 09:21:31 2026] You crush a wandering rat for 50 points of damage.'
  ]
  const { eng, lastTs } = replay(lines)
  const fs = fights(eng, lastTs)
  assert.equal(fs.length, 2, 'the 88s gap with a fled mob closes the first fight')
  assert.equal(fs[0].name, 'a fleeing gnoll')
  assert.equal(fs[1].name, 'a wandering rat')
})
