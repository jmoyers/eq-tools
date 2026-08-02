// CHARACTER-EPOCH DETECTION TESTS (Task #49).
//
// THE BETA-WIPE STORY. EQ Legends names its log `eqlog_<Char>_<server>.txt`, so a character
// deleted + recreated with the SAME name+server reuses the SAME file. The user's real log:
// a BETA character reached level 26 (Jul 19) / 30 (Jul 20), was WIPED at launch, and the log
// continues with `Welcome to level 2!` on Jul 28 12:32:09 (real line 172394), re-leveling as
// a fresh character. Everything before that boundary belongs to the dead beta character and
// CONTAMINATES every character-scoped tally (AA / loot / kills / turn-ins / quest progress).
//
// THE FIX. A decisive level REGRESSION (new ≤3 or a drop >5) synthesizes an `epoch` event
// (EpochDetector, mirrored here exactly as index.ts wires it onto the bus); each
// character-scoped module RESETS its live folded state on that event, so a rescan replaying
// the whole log leaves post-scan state reflecting ONLY the current character. Integrator
// ground truth: post-boundary AA allocated=206, unspent=1, Σ gains=207 — an EXACT in-game
// match with zero refund churn.
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
 * REAL EpochDetector exactly as index.ts's feeder subscription does: on a detected regression
 * a synthesized `epoch` event is delivered to every module (they reset their live state). When
 * `withEpoch` is false the detector is bypassed — the pre-fix behavior, for the contrast.
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
    // Fold the primary event FIRST, then (if it tripped a regression) deliver the derived
    // epoch reset — exactly the bus.emitDerived semantics index.ts uses: a derived event is
    // queued and drained AFTER the primary reaches every listener. So the `level` line that
    // TRIPS the epoch is folded then immediately reset (it's the boundary marker; the next
    // ding re-establishes the post-epoch timeline).
    for (const m of mods) m.onEvent(ev)
    if (withEpoch) {
      const epochEv = epoch.observe(ev)
      if (epochEv) {
        epochCount++
        for (const m of mods) m.onEvent(epochEv)
      }
    }
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
// The fixture is 12 VERBATIM real log lines: pre-boundary beta state (level 30, an AA gain to
// 3 unspent, a real 3-pt Steadfast Will spend, a beta kill, a beta loot) → the `level 2` line
// → post-boundary current-character state (kills, a loot, an AA gain to 1 unspent, a real 3-pt
// Slay Undead spend, level 3). Assert the epoch fires on the level-2 line and every
// pre-boundary tally is discarded, leaving only post-boundary data.
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
  assert.equal(after.epochCount, 1, 'the level-2 regression trips the epoch exactly once')

  // Levels: only the post-boundary 3 remains. The `level 2` line is the boundary marker —
  // it's folded then the epoch reset (delivered right after, emitDerived semantics) clears it,
  // so the post-epoch timeline starts at the NEXT ding (3). The beta level 30 is gone. This
  // one-entry boundary detail is intentional and harmless (the AA identity is unaffected).
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
// detector, the boundary fires ONCE (only the beta wipe is a decisive regression; the
// duplicate `Welcome to level 11!` on Jul 28 is NOT — 11 is not below 11) and the post-scan
// tallies drop to the current character's only.
//
// NB the real log is the user's LIVE, actively-appended file, so volatile counts (unspent,
// loot rows, kills) drift between runs as the user plays. We therefore assert the STABLE
// INVARIANTS: allocated == 206 (the in-game "allocated" number — no new AA purchases move it),
// the earned identity, epochCount == 1, and the contamination DIRECTION (after < before) — not
// the exact volatile magnitudes. `allocated` is the load-bearing figure; `unspent` grows live.
test('full-log replay: post-epoch AA allocated = 206 and contamination is removed', { skip: !existsSync(LOG) }, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const before = replay(lines, false)
  const after = replay(lines, true)

  assert.equal(after.epochCount, 1, 'exactly ONE decisive regression in the whole log (the beta wipe)')

  const acctBefore = computeAAAccounting(before.leveling.aaGains, before.leveling.aaSpends)
  const acct = computeAAAccounting(after.leveling.aaGains, after.leveling.aaSpends)
  const gainSum = after.leveling.aaGains.reduce((s, g) => s + g.amount, 0)

  // THE USER'S IN-GAME TRUTH (Task #49 REQUIRED): post-epoch AA allocated = 206. The beta
  // epoch's re-buys (the cross-epoch "respec" the pre-fix AA model mistook for a real respec)
  // are gone, so the contaminated 219-220 drops to the exact in-game 206.
  assert.equal(acct.allocated, 206, 'post-epoch AA allocated = 206 (the in-game number)')
  assert.ok(acctBefore.allocated > acct.allocated, `AA allocated ${acctBefore.allocated} → 206 (beta churn removed)`)
  // The earned identity holds, and Σ gains == earned post-epoch (zero cross-epoch refund churn:
  // pre-fix the log's Σ gains (228) ran ahead of earned; post-epoch there is no re-buy churn).
  assert.equal(acct.earned, acct.allocated + acct.unspent, 'earned = allocated + unspent')
  assert.equal(gainSum, acct.earned, 'post-epoch Σ gain lines == earned (no cross-epoch refund double-count)')

  // CONTAMINATION removal — the beta character was inflating every character-scoped tally.
  const betaKills = Object.values(before.kills).reduce((s, k) => s + k.count, 0)
  const curKills = Object.values(after.kills).reduce((s, k) => s + k.count, 0)
  assert.ok(after.loot.length < before.loot.length, `loot ${before.loot.length} → ${after.loot.length}`)
  assert.ok(curKills < betaKills, `kills ${betaKills} → ${curKills}`)
  // Turn-ins: 8 (all) → 3 (post-epoch). The 5 beta turn-ins are Gloomingdeep tutorial (Doug /
  // Dead Doug), which match NO Plane-of-Sky quest, so quest AUTO-completion was never
  // contaminated; the 3 post-epoch turn-ins are the current character's real quests.
  assert.equal(after.turnins.length, 3, 'post-epoch turn-ins = the current character\'s 3')
  assert.ok(before.turnins.length > after.turnins.length, `turn-ins ${before.turnins.length} → 3`)
})
