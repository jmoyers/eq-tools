// Character-epoch detection (Task #49).
//
// THE BETA-WIPE STORY (grep-able for future same-name+server cases). EQ Legends names its
// log file `eqlog_<Char>_<server>.txt` — so a character that is DELETED and RECREATED with
// the SAME name on the SAME server reuses the SAME log file. The user's real log:
//   • A BETA character leveled to 26 (Jul 19) then 30 (Jul 20).
//   • At launch that beta character was WIPED.
//   • The log CONTINUES in the same file: `Welcome to EverQuest Legends!` logins, then a
//     `You have gained a level! Welcome to level 2!` on Jul 28 12:32:09 (real line 172394),
//     re-leveling 2→3→…→26→44→50 as a fresh character.
// Everything before that boundary belongs to the DEAD beta character and CONTAMINATES every
// character-scoped tally: AA (dashboard read 219-220 allocated vs the in-game 206), loot,
// kills, turn-ins, and Plane-of-Sky quest completions. Integrator-verified post-boundary
// ground truth: AA allocated=206, unspent=1, Σ gains=207 — an EXACT in-game match with zero
// refund churn (the Jul-28 "respec" the earlier AA model saw was cross-epoch contamination,
// not a respec).
//
// THE DETECTION. A `level` event whose new level is DECISIVELY below the highest level seen
// this epoch marks a rebirth:
//   • new level ≤ 3, OR
//   • a drop of MORE than 5 levels below the epoch high.
// Classic EQ death-deleveling loses at most a level or two around an XP threshold, so a
// SMALL regression is tolerated WITHOUT an epoch reset (e.g. the real log's duplicate
// `Welcome to level 11!` after XP loss at Jul 28 16:46 — 11 is not < 11, no drop, ignored).
// Only a decisive drop is a rebirth. The whole log implicitly starts in epoch 0; the first
// level-up (17 on this log) only RAISES the high, so it never trips.
//
// WHY NOT the `Welcome to EverQuest Legends!` login line? It prints on EVERY login (14× in
// the real log — every session start), so it is NOT an epoch signal. The decisive
// level-regression is the one unambiguous rebirth fingerprint.
//
// WHERE THIS RUNS. index.ts subscribes this to the bus alongside the other consumers and,
// on a detected regression, hands an `EpochEvent` back onto the SAME bus via emitDerived —
// the Task #47 derived-events path. The event is delivered to every consumer AFTER the
// current `level` event finishes, so the modules see the level THEN reset (order is
// harmless: the level module resets its own list on the epoch anyway). `live` is inherited
// from the primary event, so a replayed rebirth stays live:false.

import type { LogEvent, EpochEvent } from '../../shared/logEvents'

/** New level ≤ this is always a rebirth (a fresh character starts at 1). */
const REBIRTH_LEVEL_CEILING = 3
/** A drop of MORE than this many levels below the epoch high is a rebirth. */
const MAX_TOLERATED_REGRESSION = 5

/**
 * Stateful, single-character epoch detector. Feed it every LogEvent (in stream order); when a
 * `level` event is a decisive regression it returns the synthesized `EpochEvent` to emit
 * (else null). Reset per character (re)load — the detector's high resets with the log.
 */
export class EpochDetector {
  /** Highest level observed in the CURRENT epoch (0 = none yet / start of log). */
  private high = 0

  reset(): void {
    this.high = 0
  }

  /**
   * Observe one event. Returns an EpochEvent to emit (carrying the primary event's seq/ts) on
   * a decisive level regression, else null. Non-level events are ignored.
   */
  observe(ev: LogEvent): EpochEvent | null {
    if (ev.kind !== 'level') return null
    const level = ev.level
    const isRegression = level < this.high
    const decisive = level <= REBIRTH_LEVEL_CEILING || this.high - level > MAX_TOLERATED_REGRESSION
    if (isRegression && decisive) {
      // Rebirth: the new epoch's high starts at this (post-rebirth) level.
      this.high = level
      return { kind: 'epoch', reason: 'level-regression', level, seq: ev.seq, ts: ev.ts, raw: ev.raw }
    }
    if (level > this.high) this.high = level
    return null
  }
}
