// Offline-gap detection (login/logout in the world model) — the sibling of epochDetector.ts,
// and wired the same way: index.ts subscribes it to the bus AFTER the modules and the combat
// engine have folded each event, and it hands its synthesized `offlineGap` back onto the SAME
// bus via `bus.emitDerived` (the Task #47 derived path). The bus drains derived events after
// the primary one finishes reaching every listener, so consumers see the `sessionStart` line
// first and the gap it implies second. Replay and live are IDENTICAL — nothing here reads the
// wall clock, so a rescan reconstructs every historical gap for free.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MEASUREMENT THAT SHAPES THIS FILE (real log, 1,152,483 lines, 2026-08-03).
//
// The obvious rule — "fromTs is the last event before the Welcome" — DOES NOT WORK, and
// fails silently rather than loudly. Every login prints a RECONNECT PREAMBLE *before* the
// `Welcome to EverQuest Legends!` line, because the client is already connected to the chat
// servers while the character is still being placed in the world:
//
//   [Fri Jul 31 01:05:43] It will take you about 30 seconds to prepare your camp.   ← logout
//   [Fri Jul 31 01:06:07] It will take about 5 more seconds to prepare your camp.
//   [Fri Jul 31 14:49:09] You are not currently assigned to an adventure.           ← preamble
//   [Fri Jul 31 14:49:13] Channel General was too full to join
//   [Fri Jul 31 14:49:13] Channels: 1=General1(400)
//   [Fri Jul 31 14:49:15] Welcome to EverQuest Legends!                             ← login
//
// Measured across ALL 19 logins in the log, the newest event before the Welcome is 0–2
// seconds older than it — every time, without exception. A last-event anchor would have
// reported that 13h43m absence as SIX SECONDS and would have emitted zero gaps, ever.
//
// Classifying the preamble instead was considered and REJECTED: it is not a closed set. The
// burst also carries other players' CHANNEL CHAT (`Ankhos tells NewPlayers:1, '…'` lands one
// second before the Jul 19 15:30:24 Welcome), which is ordinary chat by every other measure.
//
// So the anchor is a MEASURED WINDOW. `fromTs` is the newest event at least
// RECONNECT_WINDOW_MS older than the Welcome. The complete preamble fits inside 22 seconds in
// 19/19 logins (longest: Jul 19 22:12:49 → 22:13:01), so 30s clears every observed one with
// margin while staying far below the 60s emit threshold. This is the same species of constant
// as the model's other measured windows (the ~5s encounter linger of law 7, the ~2.5s clicky
// window) — derived from the log, not chosen.
//
// The cost is honest and bounded: `fromTs` is a LOWER bound on the absence. Up to 30s of real
// in-world time immediately before a logout is discarded, so every reported gap is at most
// 30s SHORTER than the truth. Nothing downstream may treat it as exact — see the mining
// censor in buffsInstances.ts, which drops (rather than adjusts) any duration sample that
// spans a gap precisely because of this.
//
// VERIFICATION of the whole rule against the 19 real logins: 15 gaps emitted (2m15s … 183h),
// 4 suppressed (30s / 31s / 31s / 34s — all genuine sub-minute relogs); `camped` true for 17
// and false for the 2 crashes (Jul 28 13:37, Jul 31 22:07), matching a hand read of the log.

import type { LogEvent, OfflineGapEvent } from '../../shared/logEvents'

/**
 * How far back from a `sessionStart` the reconnect preamble is assumed to reach. MEASURED:
 * the longest observed preamble in the real log spans 22s (Jul 19 22:12:49 → 22:13:01); all
 * 19 fit inside it. See the module header for why a window, and not a line list, is the rule.
 */
export const RECONNECT_WINDOW_MS = 30_000

/**
 * Minimum absence worth reporting. Below this a relog is a BLIP, not an absence: nothing in
 * the world model changes meaningfully across a minute, and the 4 sub-minute relogs in the
 * real log (30–34s of measured gap) are exactly the noise this suppresses.
 */
export const OFFLINE_GAP_MIN_MS = 60_000

/**
 * How close a non-aborted `campStart` must sit to `fromTs` for the logout to count as CAMPED.
 * A camp takes ~30s (the initiation line says so and five ticks count it down), and `fromTs`
 * lands on one of those ticks, so the true separation is well under a minute; 60s is the
 * comfortable read of "these two describe the same logout".
 */
export const CAMP_PAIRING_MS = 60_000

/**
 * Stateful, single-character offline-gap detector. Feed it every LogEvent in stream order;
 * a `sessionStart` returns the `OfflineGapEvent` to emit, or null when the absence was too
 * short to be worth reporting (or when this is the first login of the log, which has no
 * observed "before"). Reset per character (re)load, exactly like EpochDetector.
 */
export class SessionDetector {
  /**
   * DISTINCT recent event timestamps, oldest-first, trimmed so that AT MOST ONE entry is
   * older than `newest - RECONNECT_WINDOW_MS`. That surviving front entry IS `fromTs` — the
   * newest event outside the reconnect window — so the answer is available in O(1) with no
   * scan back through the stream.
   *
   * Distinct-only is what keeps this bounded: EQ timestamps are second-resolution, so a 30s
   * window holds at most 31 numbers no matter how dense the combat is (the busiest second in
   * this log carries ~40 lines, all collapsing to one entry).
   */
  private recent: number[] = []

  /** ts of the most recent `campStart` that has not been abandoned, or 0. */
  private campTs = 0

  reset(): void {
    this.recent = []
    this.campTs = 0
  }

  /**
   * Observe one event. Returns an `OfflineGapEvent` to emit at a `sessionStart` whose implied
   * absence exceeds {@link OFFLINE_GAP_MIN_MS}, else null.
   *
   * The derived events of OTHER producers are ignored: an `offlineGap` is our own output (a
   * feedback loop), and an `epoch` / `buffExpired` is a synthesized restatement of a primary
   * event whose timestamp we have already recorded — folding them would double-count nothing
   * but is still a second opinion on "when was the character last seen".
   */
  observe(ev: LogEvent): OfflineGapEvent | null {
    if (ev.kind === 'offlineGap' || ev.kind === 'epoch' || ev.kind === 'buffExpired') return null
    // An unparseable timestamp (0) can neither anchor a gap nor advance the window.
    if (ev.ts <= 0) return null

    if (ev.kind === 'campStart') this.campTs = ev.ts
    // The game states the cancellation outright (law 1) — an abandoned camp is not a logout.
    if (ev.kind === 'campAbort') this.campTs = 0

    const gap = ev.kind === 'sessionStart' ? this.buildGap(ev.ts, ev.seq, ev.raw) : null
    this.push(ev.ts)
    return gap
  }

  /**
   * Record one event timestamp into the rolling window. Timestamps arrive non-decreasing (the
   * feeders preserve strict file order), so a duplicate of the newest is a no-op and every
   * push can only ever retire entries from the front.
   */
  private push(ts: number): void {
    const n = this.recent.length
    if (n > 0 && this.recent[n - 1] === ts) return
    this.recent.push(ts)
    // Keep exactly one entry older than the window — that one is the answer; the rest are
    // superseded by it and can never be needed again.
    const cut = ts - RECONNECT_WINDOW_MS
    while (this.recent.length >= 2 && this.recent[1] <= cut) this.recent.shift()
  }

  /**
   * Build the gap implied by a login at `toTs`, or null when there is nothing to report.
   *
   * Returns null when the log has no event outside the reconnect window yet — the first login
   * in a freshly-started log has no observed "before", and inventing one from the preamble is
   * exactly the mistake this file exists to avoid.
   */
  private buildGap(toTs: number, seq: number, raw: string): OfflineGapEvent | null {
    // The NEWEST retained timestamp outside the window. Scanning forward (rather than taking
    // recent[0]) matters because the window was trimmed against the previous event's ts, and
    // the Welcome may be much later — after a 13-hour absence every retained entry is outside
    // it, and the front one is the OLDEST of them, not the answer. Bounded by 31 entries and
    // reached once per login, so the scan is free.
    const cut = toTs - RECONNECT_WINDOW_MS
    let fromTs = -1
    for (const t of this.recent) {
      if (t > cut) break
      fromTs = t
    }
    if (fromTs < 0) return null
    if (toTs - fromTs <= OFFLINE_GAP_MIN_MS) return null
    const camped = this.campTs > 0 && Math.abs(fromTs - this.campTs) <= CAMP_PAIRING_MS
    return { kind: 'offlineGap', seq, ts: toTs, raw, fromTs, toTs, camped }
  }
}
