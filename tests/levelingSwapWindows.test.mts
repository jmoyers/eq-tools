// LOADOUT-SWAP LEVEL SERIES TESTS.
//
// THE REPORT. The "Level over time" chart read as a solid plateau with a cliff: it drew a
// FILLED polygon with diagonal interpolation between level-up events, and the headline
// "Character level" was `Math.max(levels)`. Both are wrong under the EQ Legends loadout
// mechanic.
//
// WHAT THE REAL LOG ACTUALLY SAYS (verified against the live 985k-line
// eqlog_Primitive_freeport.txt on Aug 2 2026):
//   • The ONLY level line family is `You have gained a level! Welcome to level N!`
//     (parser.ts LEVEL_RE). 71 such lines in the whole log.
//   • There is NO loadout-swap / class-change line of ANY kind. Every occurrence of
//     "loadout", "swap" or "class" in the log is another player's chat.
//   • The self `/who` line is the only place the loadout is ever stated:
//       [Fri Jul 31 23:48:53 2026] [50 PAL/MNK/ENC] Primitive (Dark Elf)  ZONE: East Freeport
//     ONE level, THREE classes — the character does not carry three concurrent levels, it
//     carries one level shared by the trio, which is re-reported (down to the incoming
//     class's level 10) when a class is swapped in. Those lines are user-typed and sparse
//     (11 in 985k lines, NONE anywhere near the observed swap), so the active class trio is
//     NOT derivable at a level-up — hence one honest series, not three invented ones.
//   • The drop itself is UNOBSERVABLE: the log jumps straight from
//       [Fri Jul 31 16:19:04 2026] You have gained a level! Welcome to level 50!
//     to
//       [Sun Aug 02 02:13:34 2026] You have gained a level! Welcome to level 11!
//     with nothing in between. The level-10 state after the swap is never printed.
//
// So the display rules these tests pin:
//   currentLevel = LATEST by ts (13), never max (50 — a class no longer in the loadout);
//   the chart is disjoint step segments (no diagonal, no descending stroke, no fill spanning
//   the break); and the post-swap ding carries NO elapsed-time delta, because the gap back
//   to the previous ding spans the unlogged swap and is not a "time to level".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { EpochDetector } from '../src/main/log/epochDetector'
import { LevelingModule } from '../src/main/modules/leveling'
import {
  buildLevelSegments,
  latestLevel,
  levelFeedEntries,
  peakLevel,
  sortLevels,
  swapCount
} from '../src/renderer/src/features/leveling/levelSeries'
import type { LevelingSnap } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

/** Replay raw lines through the real parser + LevelingModule → snapshot state. */
function replayLeveling(lines: string[], withEpoch = false): LevelingSnap {
  const mod = new LevelingModule()
  mod.reset()
  const epoch = new EpochDetector()
  epoch.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    // Primary event first, then the derived epoch reset — the bus.emitDerived ordering
    // index.ts uses (mirrors tests/epochWindows.test.mts).
    mod.onEvent(ev)
    if (withEpoch) {
      const ep = epoch.observe(ev)
      if (ep) mod.onEvent(ep)
    }
  }
  return mod.snapshot().state
}

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN WINDOW WL1 — the real loadout swap (tests/fixtures/wl1-loadout-swap.log,
// extracted by tests/extract-leveling-fixtures.mjs from raw lines 669590…975780).
//
// HAND-READ expected level sequence, the complete set of level lines in that span:
//   Fri Jul 31 16:19:04  Welcome to level 50!   ← last ding of the PAL/MNK/ENC loadout
//   Fri Jul 31 23:48:53  [50 PAL/MNK/ENC] Primitive  (self /who — one level, three classes)
//   …  class swapped in; reported level falls to 10 with NO log line  …
//   Sun Aug 02 02:13:34  Welcome to level 11!   ← first ding of the NEW loadout
//   Sun Aug 02 02:20:00  Welcome to level 12!
//   Sun Aug 02 02:26:50  Welcome to level 13!
test('golden window WL1: the 50 → 11 drop is a class swap, not lost levels', () => {
  const lines = readFileSync(join(HERE, 'fixtures', 'wl1-loadout-swap.log'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
  const snap = replayLeveling(lines)
  const sorted = sortLevels(snap.levels)

  assert.deepEqual(
    sorted.map((p) => p.level),
    [50, 11, 12, 13],
    'the parser sees exactly these four dings — the drop to 10 is never logged'
  )

  // THE HEADLINE BUG. max() reports the pre-swap peak of a class that is no longer in the
  // loadout; the character is level 13.
  assert.equal(latestLevel(sorted), 13, 'current level = latest reported')
  assert.equal(peakLevel(sorted), 50, 'peak is a separate, separately-labeled fact')
  assert.notEqual(latestLevel(sorted), Math.max(...sorted.map((p) => p.level)), 'latest != max under a swap')

  // THE CHART. Two disjoint step segments — nothing interpolates or fills across the break.
  const segs = buildLevelSegments(sorted)
  assert.equal(segs.length, 2, 'one break at the swap')
  assert.equal(swapCount(segs), 1)
  assert.equal(segs[0].afterSwap, false)
  assert.deepEqual(segs[0].points.map((p) => p.level), [50])
  assert.equal(segs[1].afterSwap, true, 'the second segment opens after the swap')
  assert.deepEqual(segs[1].points.map((p) => p.level), [11, 12, 13])

  // THE FEED. The post-swap ding is labeled a swap and carries NO fabricated "+38.9h".
  const feed = levelFeedEntries(sorted)
  assert.deepEqual(
    feed.map((f) => f.afterSwap),
    [false, true, false, false]
  )
  assert.equal(feed[0].sinceMs, null, 'first ding has no predecessor')
  assert.equal(feed[1].sinceMs, null, 'the gap across the swap is NOT a time-to-level')
  assert.equal(feed[2].sinceMs, 6 * 60_000 + 26_000, '02:13:34 → 02:20:00 = 6m26s')
  assert.equal(feed[3].sinceMs, 6 * 60_000 + 50_000, '02:20:00 → 02:26:50 = 6m50s')
})

// ─────────────────────────────────────────────────────────────────────────────
// FULL-LOG REPLAY — invariants only (the log is LIVE and grows; frozen counts rot).
// Replayed WITH the EpochDetector so the dead beta character's levels are excluded and the
// only remaining downward transition is the genuine loadout swap. Everything asserted here
// is monotone under further play: more dings and more swaps can only add segments.
test('full-log replay: level series invariants under loadout swaps', { skip: !existsSync(LOG) }, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const snap = replayLeveling(lines, true)
  const sorted = sortLevels(snap.levels)
  assert.ok(sorted.length > 0, 'the current character has level-ups')

  // 1. Current level is the last one reported, by construction.
  assert.equal(latestLevel(sorted), sorted[sorted.length - 1].level)

  // 2. Peak is >= current, and a swap has been observed, so max() is NOT a valid headline.
  const peak = peakLevel(sorted)!
  assert.ok(peak >= latestLevel(sorted)!, 'peak never below current')
  const drops = sorted.filter((p, i) => i > 0 && p.level < sorted[i - 1].level)
  assert.ok(drops.length >= 1, 'at least one loadout swap is in the log (50 → 11 on Aug 2)')

  // 3. Segmentation is exact and lossless: segments partition the series, each one is
  //    monotonically non-decreasing (so a step chart never draws a descending stroke), and
  //    exactly the non-first segments are flagged as swaps.
  const segs = buildLevelSegments(sorted)
  assert.equal(segs.length, drops.length + 1, 'one segment per run between drops')
  assert.equal(swapCount(segs), segs.length - 1)
  assert.ok(segs.length >= 2, 'the swap splits the series')
  assert.equal(
    segs.reduce((n, s) => n + s.points.length, 0),
    sorted.length,
    'no ding is dropped or duplicated by segmentation'
  )
  for (const [i, s] of segs.entries()) {
    assert.equal(s.afterSwap, i > 0)
    for (let j = 1; j < s.points.length; j++) {
      assert.ok(s.points[j].level >= s.points[j - 1].level, 'segments never descend')
      assert.ok(s.points[j].ts >= s.points[j - 1].ts, 'segments are time-ordered')
    }
  }

  // 4. No feed entry ever reports an elapsed time that spans a swap.
  const feed = levelFeedEntries(sorted)
  assert.equal(feed.filter((f) => f.afterSwap).length, drops.length)
  for (const f of feed) if (f.afterSwap) assert.equal(f.sinceMs, null)
  for (const f of feed) if (f.sinceMs != null) assert.ok(f.sinceMs >= 0)
})
