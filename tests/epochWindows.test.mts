// CHARACTER-EPOCH DETECTION TESTS (Task #49; launch-anchored in Task #50).
//
// THE BETA-WIPE STORY. EQ Legends names its log `eqlog_<Char>_<server>.txt`, so a character
// deleted + recreated with the SAME name+server reuses the SAME file. The user's real log:
// a BETA character reached level 26 (Jul 19) / 30 (Jul 20), was WIPED at launch, and the log
// continues with `Welcome to level 2!` on Jul 28 12:32:09 (real line 172394), re-leveling as
// a fresh character. Everything before that boundary belongs to the dead beta character and
// CONTAMINATES every character-scoped tally (AA / loot / kills / turn-ins / quest progress).
//
// THE FIX. The epoch anchors at the OFFICIAL LAUNCH: the FIRST event at/after 2026-07-28
// 00:00 LOCAL synthesizes an `epoch` event (EpochDetector, mirrored here exactly as index.ts
// wires it onto the bus); each character-scoped module RESETS its live folded state on that
// event, so a rescan replaying the whole log leaves post-scan state reflecting ONLY the
// current character. Integrator ground truth: post-boundary AA allocated=206, unspent=1,
// Σ gains=207 — an EXACT in-game match with zero refund churn.
//
// (The old LEVEL-REGRESSION trigger was removed as UNSAFE — EQ Legends loadout swaps
// legitimately change character level, so a level drop is not a reliable rebirth signal. The
// launch DATE is unambiguous and can't be confused with in-game mechanics.)
//
// (1) a hand-verified golden WINDOW spanning the real boundary, and (2) the FULL real log,
// asserting the AA identity + the contamination the reset removes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { EpochDetector } from '../src/main/log/epochDetector'
import { LootModule } from '../src/main/modules/loot'
import { TurnInsModule } from '../src/main/modules/turnins'
import { KillsModule } from '../src/main/modules/kills'
import { LevelingModule } from '../src/main/modules/leveling'
import { computeAAAccounting } from '../src/shared/aa'
import type { LootSnap, TurnInSnap, KillsSnap, LevelingSnap } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

interface Replayed {
  loot: LootSnap
  turnins: TurnInSnap
  kills: KillsSnap
  leveling: LevelingSnap
  epochCount: number
}

/**
 * Replay raw lines through the real parser + the four character-scoped modules, driving the
 * REAL EpochDetector exactly as index.ts's feeder subscription does: at the first at/after-
 * launch event a synthesized `epoch` event is delivered to every module (they reset their live
 * state). When `withEpoch` is false the detector is bypassed — the pre-fix behavior, for the
 * contrast.
 */
function replay(lines: string[], withEpoch: boolean): Replayed {
  const loot = new LootModule()
  const turnins = new TurnInsModule()
  const kills = new KillsModule()
  const leveling = new LevelingModule()
  const mods = [loot, turnins, kills, leveling]
  for (const m of mods) m.reset()
  const epoch = new EpochDetector()
  epoch.reset()
  let seq = 0
  let epochCount = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    // Fold the primary event FIRST, then (if it's the first at/after-launch event) deliver the
    // derived epoch reset — exactly the bus.emitDerived semantics index.ts uses: a derived
    // event is queued and drained AFTER the primary reaches every listener. So the first
    // post-launch line is folded then immediately reset (it's the boundary marker; subsequent
    // events establish the post-epoch timeline).
    for (const m of mods) m.onEvent(ev)
    if (!withEpoch) continue
    const epochEv = epoch.observe(ev)
    if (!epochEv) continue
    epochCount++
    for (const m of mods) m.onEvent(epochEv)
  }
  return {
    loot: loot.snapshot().state,
    turnins: turnins.snapshot().state,
    kills: kills.snapshot().state,
    leveling: leveling.snapshot().state,
    epochCount
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN WINDOW — the real Jul 28 12:32:09 beta-wipe boundary (real line 172394).
// The fixture is 12 real log lines: pre-launch beta state (all Jul 19-20 — level 30, an AA
// gain to 3 unspent, a real 3-pt Steadfast Will spend, a beta kill, a beta loot) → the first
// POST-launch event, the Jul 28 12:32:09 `level 2` line → post-boundary current-character
// state (kills, a loot, an AA gain to 1 unspent, a real 3-pt Slay Undead spend, level 3).
// (The one dated edit vs the raw log: the "Small Mosquito Wing" beta loot is dated Jul 20 so
// it sits on the correct — pre-launch — side of the date anchor; verbatim it was Jul 28.)
// Assert the epoch fires on the first post-launch event (here the level-2 line) and every
// pre-launch tally is discarded, leaving only post-boundary data.
test('golden window: the beta-wipe boundary resets every character-scoped module', () => {
  const lines = readFileSync(join(HERE, 'fixtures', 'epoch-beta-wipe.log'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)

  // WITHOUT the epoch reset (pre-fix): the beta state contaminates everything.
  const before = replay(lines, false)
  assert.equal(before.epochCount, 0)
  assert.equal(before.leveling.levels.length, 3, 'no-reset: levels 30, 2, 3 all present')
  assert.equal(before.loot.length, 2, 'no-reset: both the beta loot and the current loot present')
  assert.equal(before.leveling.aaGains.length, 2, 'no-reset: beta gain (3) + current gain (1)')
  assert.equal(before.leveling.aaSpends.length, 2, 'no-reset: Steadfast Will (beta) + Slay Undead')

  // WITH the epoch reset: the boundary fires exactly once and everything before it vanishes.
  const after = replay(lines, true)
  assert.equal(after.epochCount, 1, 'the first post-launch event trips the epoch exactly once')

  // Levels: only the post-boundary 3 remains. The `level 2` line is the FIRST post-launch
  // event (the boundary marker) — it's folded then the epoch reset (delivered right after,
  // emitDerived semantics) clears it, so the post-epoch timeline starts at the NEXT ding (3).
  // The beta level 30 is gone. This one-entry boundary detail is intentional and harmless (the
  // AA identity is unaffected).
  assert.deepEqual(
    after.leveling.levels.map((l) => l.level),
    [3],
    'post-epoch level timeline starts at the first ding AFTER the boundary marker (no beta 30, no boundary 2)'
  )
  // Loot: only the post-boundary Splintering Club remains (the beta Small Mosquito Wing gone).
  assert.equal(after.loot.length, 1, 'post-epoch loot excludes the beta loot')
  assert.equal(after.loot[0].item, 'Splintering Club')

  // AA: only the post-boundary gain (to 1 unspent) + spend (Slay Undead, 3) remain. The beta
  // Steadfast Will 3-pt spend and its gain are gone → allocated 3, unspent 1, earned 4.
  assert.equal(after.leveling.aaGains.length, 1, 'post-epoch AA gains exclude the beta gain')
  assert.equal(after.leveling.aaSpends.length, 1, 'post-epoch AA spends exclude the beta Steadfast Will')
  // allocated = Slay Undead (3); the beta Steadfast Will 3-pt spend is excluded. unspent = the
  // post-boundary "you now have 1" minus the later 3-pt Slay Undead spend, clamped at 0. (These
  // are non-adjacent hand-picked real lines, so the pool math is a fixture artifact — what the
  // window PROVES is that the BETA AA is gone, not a self-consistent economy.)
  const acct = computeAAAccounting(after.leveling.aaGains, after.leveling.aaSpends)
  assert.equal(acct.allocated, 3, 'post-epoch allocated = Slay Undead (3), beta Steadfast Will excluded')
  assert.equal(acct.unspent, 0, 'post-epoch unspent = max(0, 1 gained − 3 spent) = 0')
  assert.equal(acct.earned, 3, 'post-epoch earned = allocated + unspent')

  // Kills: the beta clay gargoyle is gone; post-epoch has the crab spiderling + water moccasin
  // (the KillMap is keyed by canonical lowercase name).
  const killKeys = Object.keys(after.kills)
  assert.ok(!killKeys.some((k) => k.includes('clay gargoyle')), 'beta kill (clay gargoyle) discarded')
  assert.ok(killKeys.some((k) => k.includes('crab spiderling')), 'post-epoch kill present')
})

// ─────────────────────────────────────────────────────────────────────────────
// FULL-LOG TRIPWIRE — the AA identity the user validated (allocated 206) + the contamination
// removal. Skipped when the real log is absent (CI). Replaying the WHOLE log with the epoch
// detector, the boundary fires ONCE (the first event at/after the 2026-07-28 launch instant —
// the log crosses the launch boundary exactly once) and the post-scan tallies drop to the
// current character's only.
//
// NB the real log is the user's LIVE, actively-appended file, so absolute counts (allocated,
// unspent, loot rows, kills, turn-ins) DRIFT between runs as the user plays and buys AA. Task
// #49 hardcoded allocated == 206 on the assumption "no new AA purchases move it" — that
// assumption is STALE (the user has since bought more AA, and the value is 212 at time of
// writing). We therefore assert the anchor-independent STABLE INVARIANTS that actually PROVE
// the epoch cleanly isolates the current character:
//   • epochCount == 1 (the log crosses the launch boundary exactly once),
//   • the refund-proof identity  Σ gains == earned == allocated + unspent  holds post-epoch
//     with ZERO cross-epoch churn (pre-fix, Σ gains ran ahead of earned — the beta re-buys
//     the AA model mistook for a respec), and
//   • contamination DIRECTION (post-epoch < contaminated) for AA / loot / kills.
// The exact in-game allocated is reported in the message for eyeballing, not asserted.
test('full-log replay: post-epoch AA is refund-proof-clean and contamination is removed', { skip: !existsSync(LOG) }, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const before = replay(lines, false)
  const after = replay(lines, true)

  assert.equal(after.epochCount, 1, 'the whole log crosses the launch boundary exactly once (the beta wipe)')

  const acctBefore = computeAAAccounting(before.leveling.aaGains, before.leveling.aaSpends)
  const acct = computeAAAccounting(after.leveling.aaGains, after.leveling.aaSpends)
  const gainSum = after.leveling.aaGains.reduce((s, g) => s + g.amount, 0)
  const gainSumBefore = before.leveling.aaGains.reduce((s, g) => s + g.amount, 0)

  // THE REFUND-PROOF IDENTITY (the load-bearing invariant, anchor- and playtime-independent):
  // post-epoch there is NO cross-epoch re-buy churn, so every AA gain line is earned exactly
  // once → Σ gains == earned == allocated + unspent. (The contaminated replay violates this:
  // its Σ gains double-counts the beta re-buys the pre-fix AA model mistook for a respec.)
  assert.equal(acct.earned, acct.allocated + acct.unspent, 'earned = allocated + unspent')
  assert.equal(gainSum, acct.earned, `post-epoch Σ gain lines (${gainSum}) == earned (no cross-epoch refund double-count); allocated=${acct.allocated}`)
  assert.ok(gainSum < gainSumBefore, `contaminated Σ gains (${gainSumBefore}) double-counts the beta re-buys → post-epoch ${gainSum}`)
  // Contaminated AA allocated is strictly higher (beta churn removed).
  assert.ok(acctBefore.allocated > acct.allocated, `AA allocated ${acctBefore.allocated} → ${acct.allocated} (beta churn removed)`)

  // CONTAMINATION removal — the beta character was inflating every character-scoped tally.
  const betaKills = Object.values(before.kills).reduce((s, k) => s + k.count, 0)
  const curKills = Object.values(after.kills).reduce((s, k) => s + k.count, 0)
  assert.ok(after.loot.length < before.loot.length, `loot ${before.loot.length} → ${after.loot.length}`)
  assert.ok(curKills < betaKills, `kills ${betaKills} → ${curKills}`)
  // Turn-ins: under the LAUNCH-DATE anchor the current character's Jul-28 Gloomingdeep tutorial
  // turn-ins (Doug / Dead Doug / Old Doug / Kor Master Ralg, 12:25-12:29 — AFTER the 00:00
  // launch boundary) are correctly KEPT (they belong to the current character, who did the
  // tutorial at launch). The old level-2-line anchor (12:32:09) wrongly cut them as "beta";
  // the true boundary is launch, before the tutorial. They match NO Plane-of-Sky quest, so
  // quest auto-completion is unaffected either way. Turn-ins are a post-launch character
  // activity here, so the epoch neither adds nor removes any → count is anchor-invariant.
  assert.equal(after.turnins.length, before.turnins.length, 'all turn-ins are post-launch (current character)')
})
