// ============================================================================
// replaySlicer.ts — the cooperative scheduler behind the startup replay.
// ============================================================================
//
// docs/plans/chunked-replay.md §1. The historical fold runs ON THE MAIN PROCESS, and until this
// existed the unit of work between two event-loop turns was a 1 MB read chunk — MEASURED at
// 75 ms of main-loop stall on this machine's log (`.bench/replay.jsonl`, 2026-08-04), with four
// stalls past 50 ms in a single 8.6 s replay. Everything on main starves for that long: IPC, the
// perf HUD's own probe, timers.
//
// A TIME BUDGET, NEVER AN EVENT COUNT. Event cost varies by an order of magnitude — a
// combat-dense second is many times the work of a quiet one — so "yield every N events" bounds
// nothing in particular. `performance.now()` since the slice began bounds the block DIRECTLY,
// which is the only quantity anybody cares about.
//
// WHAT IT DELIBERATELY DOES NOT DO: reorder, batch, or parallelize anything. A slicer interleaves
// event-loop turns into the SAME sequential fold; every consumer still sees every event in file
// order with the same `live=false`. That is what makes the goldens a usable oracle for it
// (tests/replayChunking.test.mts folds the same fixtures with and without slicing and compares the
// event streams byte for byte).

import { setImmediate as yieldToLoop } from 'timers/promises'

/**
 * The slice budget, in milliseconds.
 *
 * 12 ms, chosen against the 50 ms invariant rather than against a frame: it leaves room for one
 * over-budget event (the check happens AFTER an event is folded, so a single expensive line can
 * overshoot) plus the scheduler's own latency, and still lands a whole binary order of magnitude
 * under the threshold the perf HUD calls "warn". Smaller would buy nothing a human can perceive
 * and would spend more of the replay in `setImmediate`.
 */
export const REPLAY_SLICE_MS = 12

/**
 * The cooperative scheduler the fold asks "may I keep going?".
 *
 * Deliberately an interface with an injectable clock: a budget is a claim about time, and a claim
 * about time that can only be tested by actually waiting is not tested at all.
 */
export interface Slicer {
  /** Has this slice used its budget? Cheap — one clock read; the fold calls it per event. */
  expired: () => boolean
  /** Yield the event loop, then begin a new slice. */
  yield: () => Promise<void>
  /** How many times this slicer has yielded (diagnostics; the bench does not read it). */
  readonly slices: number
}

export interface SlicerOptions {
  /** Milliseconds of work per slice. `Infinity` never yields — see `unchunkedSlicer`. */
  budgetMs?: number
  /** The clock. Injected so tests can drive the budget instead of waiting for it. */
  now?: () => number
  /** How to yield. `setImmediate` by design: it runs after the poll phase, so pending I/O and
   *  timers get their turn before the next slice starts. */
  yieldTo?: () => Promise<void>
}

/** A slicer that yields every `budgetMs` of folding. */
export function createSlicer(opts: SlicerOptions = {}): Slicer {
  const budgetMs = opts.budgetMs ?? REPLAY_SLICE_MS
  const now = opts.now ?? ((): number => performance.now())
  const yieldTo = opts.yieldTo ?? ((): Promise<void> => yieldToLoop())
  let deadline = now() + budgetMs
  let slices = 0
  return {
    expired: () => now() >= deadline,
    yield: async () => {
      slices += 1
      await yieldTo()
      // The new slice is measured from AFTER the yield returns, never from before it: the time
      // the event loop spent serving everyone else is not this fold's budget to spend.
      deadline = now() + budgetMs
    },
    get slices() {
      return slices
    }
  }
}

/**
 * THE CONTROL ARM: a slicer that never expires, so the fold runs exactly as it did before this
 * file existed. It is the equivalence oracle's other half and has no other caller.
 *
 * A function parameter rather than an `EQ_REPLAY_UNCHUNKED=1` environment variable (which the plan
 * allowed for) on purpose: an env var is a knob a user can find and a support answer can recommend,
 * and "turn off the thing that keeps the app responsive" must not be reachable from outside this
 * repo's tests. A seam in the signature is visible to the test and to nobody else.
 */
export function unchunkedSlicer(): Slicer {
  return createSlicer({ budgetMs: Number.POSITIVE_INFINITY })
}
