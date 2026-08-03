// THE PPM ENGINE + THE MINUTE-WINDOW LEDGER (docs/plans/proc-analytics.md §4.2–4.3, §5.1–5.2).
//
// Two things live here, and they share a file because they share every constant:
//
//   1. `procRate()` — the THREE denominators. All carried, none hidden, and every one of them
//      ABSENT below its sample floor rather than 0 (law 5). `1 proc in a 2-second pull` is not
//      `30 ppm`, and a meter that prints it once will print it forever.
//   2. `WindowAccum` — the wall-clock-minute ledger the Tier-B counterfactual needs. This
//      module builds and QUERIES the windows (the eligibility partition); the comparison
//      itself — medians, IQRs, verdicts, confounds — is a later wave and deliberately not
//      here.
//
// ACTIVE TIME IS REUSED, NEVER REDEFINED. `Encounter.activeMs` is Σ over consecutive
// ATTRIBUTED damage hits of `min(gap, ACTIVE_MS)` with the first hit adding 0 (routing.ts).
// The window ledger does not recompute that: ingest hands it the exact per-hit delta the
// engine just accrued, so the two can never drift.
//
// A CAVEAT THAT IS LABELED, NOT FIXED: route() accrues activeMs BEFORE the incoming/outgoing
// split, so incoming damage extends active time too — a pull where you are being beaten on
// while stunned accrues active seconds you did not swing in. Changing that would move
// `activeDps`, a SHIPPED number, and violate the byte-identical regression gate. So the number
// keeps the meter's meaning and the UI states it. `per100Swings` exists precisely because it
// has no such ambiguity.

import type { ProcLink, ProcRateView } from '../../shared/procAnalytics'

// ---------------------------------------------------------------------------------------
// Sample floors. Below each of these a number is ABSENT, never 0.
// ---------------------------------------------------------------------------------------

/** Below this much active time, `ppmActive` and `ppmWall` are absent. */
export const MIN_ACTIVE_SEC = 10
/** Below this many logged swings, `per100Swings` is absent. */
export const MIN_SWINGS = 20
/**
 * Below this much INACTIVE-side swing exposure, a `ProcLink` is 'inconclusive' and can never be
 * 'exclusive' — "it never fired without it" is only evidence when there was a meaningful chance
 * to fire without it.
 *
 * ⚠ THE PLAN CONTRADICTS ITSELF HERE, and the contradiction is left visible rather than
 * silently resolved (changing a measured threshold is the integrator's call, never an
 * executor's). docs/plans/proc-analytics.md fixes this constant at 200 (§4.3) but ALSO states
 * that Instrument of Nife — 289 inactive swings against 261,505 active ones — must come out
 * 'inconclusive' (§2.1 ProcLink, §0.3). 289 > 200, so as specified it comes out 'exclusive'.
 *
 * Both readings cannot hold. The narrative is the sounder one: at that lane's own observed rate
 * (1,084 procs / 261,505 swings ≈ 0.41 per 100), 289 inactive swings predict about ONE proc, so
 * seeing zero is barely evidence at all. Two ways to make the code say that — raise the floor,
 * or make it RATE-AWARE (require the inactive exposure to predict some minimum number of procs
 * at the lane's observed rate, which needs the active-side swing count in `LinkInput`). The
 * second is the principled one and is a design decision, so neither is taken here.
 *
 * TIER B IS UNAFFECTED and already reaches the right verdict for Nife by a different route:
 * 289 swings cannot fill 20 eligible 60-second windows, so the counterfactual reports
 * 'insufficient-sample' regardless of what this floor says.
 */
export const MIN_INACTIVE_SWINGS = 200

// ---------------------------------------------------------------------------------------
// The window ledger
// ---------------------------------------------------------------------------------------

/**
 * One wall-clock minute. Sixty seconds, chosen by MEASUREMENT rather than taste: on the real
 * log, minute windows yield 1,289 clean `inversion` windows against 324 clean `spellblade`
 * ones — both arms of the biggest comparison comfortably sampled, which a five-minute window
 * would not achieve for the smaller arm.
 */
export const WINDOW_MS = 60_000

/** Memory bound, drop-oldest. A long zone session is a few hundred windows; this is four
 *  thousand, i.e. ~2.8 days of continuous play, and exists only so an unbounded map can't. */
export const WINDOW_CAP = 4_000

/** Per-window volume gates (§5.2). A minute spent standing still is not evidence about
 *  anything, so it is DISCARDED from both arms rather than counted as a zero. */
export const MIN_WINDOW_SWINGS = 10
export const MIN_WINDOW_ACTIVE_MS = 20_000

/** Per-arm sample gate for a Tier-B estimate (§5.3). Below this the verdict is
 *  'insufficient-sample', naming which arm is short. */
export const MIN_ARM_WINDOWS = 20

/** One minute of combat, as the counterfactual sees it. */
export interface ProcWindow {
  /** `floor(ts / WINDOW_MS)` — the window's identity. */
  minute: number
  /** Capped-gap active time accrued in this window, using the ENGINE's own per-hit delta. */
  activeMs: number
  /** YOUR swing attempts: melee + slay hits, plus your misses. */
  swings: number
  /** YOUR outgoing damage. */
  outDamage: number
  /** Of that, the damage carried by detected proc lines. */
  procDamage: number
  /** State commits that landed INSIDE this window. */
  transitions: number
  /** The exclusivity GROUPS those commits belonged to. The plan's purity gate is per-STATE
   *  ("transitions === 0 for S's exclusive group"), so a bare count cannot implement it — an
   *  unrelated coat swap must not disqualify a window from the stance comparison. */
  transitionGroups: Set<string>
  /** `<kind>:<key>` of every state observed active at a combat event in this window. Sampled
   *  at accrual points on purpose: a state that was only ever on during a lull nobody swung
   *  in has no bearing on a comparison of swinging minutes. */
  stateKeys: Set<string>
}

/** One fold into the ledger. Every field optional because the three producers (damage, swing,
 *  commit) each move a different subset, and an args object keeps `max-params` honest. */
export interface WindowFold {
  ts: number
  /** The EXACT per-hit active-time delta the engine just accrued (never recomputed here). */
  activeDeltaMs?: number
  outDamage?: number
  procDamage?: number
  swings?: number
}

/**
 * The minute-window ledger. Lives on `Agg`, for the same reason the healing and proc ledgers
 * do: an encounter and a FINALIZED zone session then inherit it frozen, for free, and every
 * number is folded on INGEST so nothing here can ever depend on a capped or truncated event
 * ring.
 */
export class WindowAccum {
  windows = new Map<number, ProcWindow>()

  /** Fold combat activity into the window covering `f.ts`. `active` is the live set of
   *  `<kind>:<key>` from the state timeline; it is COPIED only when a window is first
   *  created, so this stays O(1) on the per-damage-event hot path. */
  fold(f: WindowFold, active: ReadonlySet<string>): void {
    const w = this.ensure(f.ts, active)
    w.activeMs += f.activeDeltaMs ?? 0
    w.outDamage += f.outDamage ?? 0
    w.procDamage += f.procDamage ?? 0
    w.swings += f.swings ?? 0
  }

  /** Record a state commit. The window it lands in is impure for that state's group — the
   *  boundary carries the reuse timer, the re-buff burst and the mid-window re-target, which
   *  is precisely the confound the purity gate exists to exclude. */
  noteTransition(ts: number, group: string, active: ReadonlySet<string>): void {
    const w = this.ensure(ts, active)
    w.transitions++
    w.transitionGroups.add(group)
    for (const k of active) w.stateKeys.add(k)
  }

  /** Windows in ascending minute order. */
  list(): ProcWindow[] {
    return [...this.windows.values()].sort((a, b) => a.minute - b.minute)
  }

  private ensure(ts: number, active: ReadonlySet<string>): ProcWindow {
    const minute = Math.floor(ts / WINDOW_MS)
    const found = this.windows.get(minute)
    if (found) {
      // A state can turn on mid-window; the set is a union over the window, not a snapshot.
      for (const k of active) found.stateKeys.add(k)
      return found
    }
    const w: ProcWindow = {
      minute,
      activeMs: 0,
      swings: 0,
      outDamage: 0,
      procDamage: 0,
      transitions: 0,
      transitionGroups: new Set(),
      stateKeys: new Set(active)
    }
    this.windows.set(minute, w)
    if (this.windows.size > WINDOW_CAP) {
      const oldest = this.windows.keys().next()
      if (!oldest.done) this.windows.delete(oldest.value)
    }
    return w
  }
}

// ---------------------------------------------------------------------------------------
// The eligibility partition — the interval-query surface Tier B consumes
// ---------------------------------------------------------------------------------------

/** The two arms of a matched-window comparison, plus the bookkeeping that makes the verdict
 *  auditable ("324 of 1,842 windows were eligible"). */
export interface WindowArms {
  /** Windows where the state was on for the whole minute. */
  active: ProcWindow[]
  /** Windows where it was off for the whole minute. */
  inactive: ProcWindow[]
  total: number
  eligible: number
}

/**
 * Split the ledger into the two arms for ONE state, applying both eligibility gates (§5.2):
 *
 *   1. PURITY — no commit of that state's exclusivity group landed inside the window. A
 *      window containing a switch is DISCARDED, not split: the boundary is the confound.
 *   2. VOLUME — `swings >= MIN_WINDOW_SWINGS` and `activeMs >= MIN_WINDOW_ACTIVE_MS`.
 *
 * `stateKey` is `<kind>:<key>`; `group` is the exclusivity group that state commits under.
 * This function makes no comparison and reaches no verdict — it only hands back the two
 * populations and how many windows survived.
 */
export function partitionWindows(
  windows: readonly ProcWindow[],
  stateKey: string,
  group: string
): WindowArms {
  const arms: WindowArms = { active: [], inactive: [], total: windows.length, eligible: 0 }
  for (const w of windows) {
    if (w.transitionGroups.has(group)) continue
    if (w.swings < MIN_WINDOW_SWINGS || w.activeMs < MIN_WINDOW_ACTIVE_MS) continue
    arms.eligible++
    if (w.stateKeys.has(stateKey)) arms.active.push(w)
    else arms.inactive.push(w)
  }
  return arms
}

// ---------------------------------------------------------------------------------------
// The three denominators
// ---------------------------------------------------------------------------------------

/** What a rate needs. `activeSec` is the SEGMENT's active time (the meter's own definition),
 *  `durationSec` its wall span, `swings` your logged swing attempts in it. */
export interface RateInput {
  count: number
  activeSec: number
  durationSec: number
  swings: number
}

/**
 * The three denominators, each ABSENT below its floor.
 *
 * `count` and `swings` are always present and always exact — they are counts of lines the game
 * printed. Only the RATES can be missing, and they are missing precisely when dividing would
 * manufacture a number the sample cannot support.
 */
export function procRate(i: RateInput): ProcRateView {
  const view: ProcRateView = { count: i.count, swings: i.swings }
  if (i.activeSec >= MIN_ACTIVE_SEC) {
    view.ppmActive = i.count / (i.activeSec / 60)
    if (i.durationSec > 0) view.ppmWall = i.count / (i.durationSec / 60)
  }
  if (i.swings >= MIN_SWINGS) view.per100Swings = (100 * i.count) / i.swings
  return view
}

/** Co-occurrence counts + the inactive-side exposure. */
export interface LinkInput {
  withCount: number
  withoutCount: number
  inactiveSwings: number
}

/**
 * Classify a `ProcLink`. THE DEFAULT IS 'inconclusive', and that is the point: a lane that
 * never fired without a state is only evidence when there were swings without that state to
 * fire on. Concentration alone can never reach 'exclusive'.
 */
export function linkStrength(i: LinkInput): ProcLink['strength'] {
  const total = i.withCount + i.withoutCount
  if (total === 0 || i.inactiveSwings < MIN_INACTIVE_SWINGS) return 'inconclusive'
  if (i.withoutCount === 0) return 'exclusive'
  return i.withCount / total >= 0.8 ? 'correlated' : 'weak'
}

/** `withCount / (withCount + withoutCount)`, 0 when the lane never fired at all (never NaN —
 *  a 0/0 that reaches a percentage formatter is how a meter prints "NaN%"). */
export function concentrationOf(withCount: number, withoutCount: number): number {
  const total = withCount + withoutCount
  return total === 0 ? 0 : withCount / total
}
