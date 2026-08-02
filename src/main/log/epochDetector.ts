// Character-epoch detection (Task #49; ANCHOR REPLACED in Task #50).
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
// THE DETECTION — anchored at the OFFICIAL LAUNCH, not a heuristic (Task #50, USER CORRECTION).
// The epoch fires once at the FIRST event whose timestamp is at/after the launch instant
// 2026-07-28 00:00 LOCAL. Everything before that instant is the dead beta character; the
// current character's life begins at launch. The first post-launch login on this log is
// Jul 28 12:21:25 and the first current-character level-up is 12:32 — both land on the
// correct side of the boundary. Pre-launch beta logs on OTHER servers are unaffected: the
// date anchor applies per-log, and any log with no post-launch event simply never fires
// (its whole span is one epoch), which is correct.
//
// WHY NOT the old LEVEL-REGRESSION trigger? It was UNSAFE. In EQ Legends, swapping LOADOUTS
// legitimately changes your character level ("when you switch loadouts, it uses the level of
// your loadout" — in-log chat evidence; there is NO explicit swap log line, verified), so a
// decisive downward level jump is NOT a reliable rebirth fingerprint — a loadout swap to a
// low-level loadout would falsely trip an epoch and wipe the current character's tallies. The
// launch DATE is the strictly better anchor the user mandated: it is unambiguous, needs no
// heuristic threshold, and can't be confused with in-game mechanics. The regression trigger
// is therefore REMOVED entirely (not merely disabled).
//
// WHY NOT the `Welcome to EverQuest Legends!` login line? It prints on EVERY login (14× in
// the real log — every session start), so it is NOT an epoch signal.
//
// SOURCES for the launch date (2026-07-28):
//   • massivelyop.com — EverQuest Legends launch coverage (Jul 28, 2026).
//   • monstervine.com — EverQuest Legends launch coverage (Jul 28, 2026).
//   • The user's own log corroborates: the launch-day login is Jul 28 12:21:25 and the first
//     current-character `Welcome to level 2!` is Jul 28 12:32:09.
//
// WHERE THIS RUNS. index.ts subscribes this to the bus alongside the other consumers and, at
// the first at/after-launch event, hands an `EpochEvent` back onto the SAME bus via
// emitDerived — the Task #47 derived-events path. The event is delivered to every consumer
// AFTER the current primary event finishes, so the modules see the event THEN reset. `live`
// is inherited from the primary event, so a replayed boundary stays live:false.

import type { LogEvent, EpochEvent } from '../../shared/logEvents'

/**
 * The EverQuest Legends OFFICIAL LAUNCH instant, 2026-07-28 00:00 LOCAL time. Character epochs
 * anchor here: every event at/after this instant belongs to the current (post-launch)
 * character; everything before is a WIPED pre-launch beta character sharing the same log file.
 *
 * LOCAL time is intentional and correct: the parser turns EQ's `Sat Jul 28 12:21:25 2026`
 * prefix into epoch millis via `Date.parse("Jul 28 2026 12:21:25")`, which the JS engine
 * interprets in the machine's LOCAL zone. Deriving the anchor with `new Date(y,m,d,…)` (also
 * local) keeps both sides on the same clock, so the comparison is zone-consistent on any
 * machine. Month is 0-indexed → 6 = July.
 */
export const LAUNCH_MS = new Date(2026, 6, 28, 0, 0, 0, 0).getTime()

/**
 * Stateful, single-character epoch detector. Feed it every LogEvent (in stream order); the
 * FIRST event whose ts is at/after {@link LAUNCH_MS} returns the synthesized `EpochEvent` to
 * emit (once), else null. Reset per character (re)load.
 */
export class EpochDetector {
  /** True once the launch-boundary epoch has fired for this log (fires at most once). */
  private fired = false

  reset(): void {
    this.fired = false
  }

  /**
   * Observe one event. Returns an EpochEvent to emit (carrying the primary event's seq/ts) at
   * the FIRST event at/after the official launch instant, else null. Fires at most once per
   * log. Events with an unparseable ts (0) never trip it.
   */
  observe(ev: LogEvent): EpochEvent | null {
    if (ev.kind === 'epoch') return null
    if (this.fired) return null
    if (ev.ts < LAUNCH_MS) return null
    this.fired = true
    return { kind: 'epoch', reason: 'launch', seq: ev.seq, ts: ev.ts, raw: ev.raw }
  }
}
