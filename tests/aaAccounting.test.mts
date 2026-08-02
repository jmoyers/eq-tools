// REFUND-PROOF AA ACCOUNTING TESTS (Task #48).
//
// The old headline "AA earned = Σ gain lines" double-counted every point refunded by a
// respec: a respec logs NO refund line, the refunded points re-enter the pool and re-fire
// as fresh gain lines, then re-fire as spend lines when re-bought. On the real log Σ gains
// == Σ spend costs == 228, but the game's true earned is 206 — the churn inflates both.
//
// The fix (src/shared/aa.ts): earned = allocated + unspent, where allocated is the latest
// purchase cost per DISTINCT (ability, rank), cost-0 auto-grants excluded. Latest-per-key
// collapses a respec re-buy of the same rank — the only refund signal the log carries.
//
// These tests pin the model to (1) a hand-verified respec golden window and (2) the full
// real log, asserting the identity the user validated Aug 1 (net 204 + unspent 2 = 206).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { LevelingModule } from '../src/main/modules/leveling'
import { computeAAAccounting } from '../src/shared/aa'
import type { LevelingSnap } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

/** Replay raw lines through the real parser + LevelingModule → snapshot state. */
function replayLeveling(lines: string[]): LevelingSnap {
  const mod = new LevelingModule()
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return mod.snapshot().state
}

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN WINDOW — the Mnemonic Retention respec (Jul 19–30).
// HAND-VERIFIED sequence (real eqlog lines 27709…482952, chat trimmed):
//   Jul 19–20  ranks 1–5 bought:        1 + 1 + 2 + 2 + 3 = 9 pts
//   Jul 28 19:06:36  gain → 6 unspent   (the refunded pool re-entering)
//   Jul 28 19:35:05  ranks 1–4 RE-BOUGHT after respec: 1+1+2+2 = 6 pts (drains the 6)
//   Jul 28 20:16:28  rank 5 re-bought:  3 pts
//   Jul 30 15:14:56  rank 6 added:      3 pts
// Σ of every Mnemonic cost = 9 + 6 + 3 + 3 = 21  ← what the naive sum reports.
// TRUE current allocation = ranks 1–6 latest costs = 1+1+2+2+3+3 = 12.
// The 9-pt gap is exactly the refund churn the fix must NOT double-count.
test('golden window: Mnemonic respec re-buy is not double-counted (allocated 12, not 21)', () => {
  const lines = readFileSync(join(HERE, 'fixtures', 'aa-mnemonic-respec.log'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
  const snap = replayLeveling(lines)

  // Naive Σ of every purchase cost (the double-counting figure) is 21.
  const lifetime = snap.aaSpends.reduce((s, x) => s + x.cost, 0)
  assert.equal(lifetime, 21, 'sanity: raw Σ of all Mnemonic costs (incl. respec re-buy) is 21')

  const acct = computeAAAccounting(snap.aaGains, snap.aaSpends)
  assert.equal(acct.allocated, 12, 'latest-epoch allocation across ranks 1–6 = 12 (refund churn removed)')
  assert.equal(acct.lifetimeCost, 21, 'lifetime cost retains the raw 21 as a diagnostic')
  assert.equal(acct.boughtCount, 6, 'six distinct (ability,rank) ranks are allocated')
})

// ─────────────────────────────────────────────────────────────────────────────
// FULL-LOG REPLAY — the identity against the real log. Skipped if the log is absent.
// The user validated on Aug 1: net 204 + unspent 2 = 206 earned. Replaying the log AS IT
// STANDS NOW (Aug 2, after more play) the identity still holds exactly:
//   allocated 219 + unspent 1 = earned 220, and Σ gains (228) runs AHEAD of earned — the
// refund double-count the fix removes. We assert the invariant (earned == allocated +
// unspent, and earned < Σ gains because respecs happened) rather than a frozen number, so
// the test survives further play; the exact current figures are pinned as a tripwire.
test('full-log replay: earned == allocated + unspent, and below Σ gains', { skip: !existsSync(LOG) }, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const snap = replayLeveling(lines)
  const acct = computeAAAccounting(snap.aaGains, snap.aaSpends)
  const sumGains = snap.aaGains.reduce((s, g) => s + g.amount, 0)

  // The core identity — the headline is self-consistent.
  assert.equal(acct.earned, acct.allocated + acct.unspent, 'earned = allocated + unspent')

  // The refund double-count is real and removed: Σ gains exceeds true earned.
  assert.ok(sumGains > acct.earned, `Σ gains (${sumGains}) should exceed earned (${acct.earned}) — respec churn`)

  // Current tripwire figure. NB the real log is the user's LIVE, actively-appended file, so
  // `unspent` / `earned` / Σ gains DRIFT as the user plays (they grew 1→3 / 220→222 / 228→230
  // between the Task #48 snapshot and now). `allocated` is the STABLE load-bearing number — no
  // new AA purchases move it — so it's the durable tripwire; the rest are asserted as
  // relationships, not frozen magnitudes.
  //
  // NB2 (Task #49): this figure is the pre-epoch, CONTAMINATED allocation. It sums the beta
  // character's AA on top of the current character's, because THIS test replays through the
  // LevelingModule WITHOUT the epoch detector (it pins the raw refund-proof math in isolation).
  // With character-epoch detection wired in (see tests/epochWindows.test.mts), the same log
  // yields the correct in-game allocated = 206.
  // The live log only ever grows allocation, so pin a monotonic floor rather than a
  // frozen value (219 was the contaminated figure when this test was written; the
  // epoch-anchored view in epochWindows.test.mts is the user-facing truth).
  assert.ok(acct.allocated >= 219, `contaminated (no-epoch) allocated (${acct.allocated}) >= 219`)
})
