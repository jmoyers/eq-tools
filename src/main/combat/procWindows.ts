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

import { stateKeyOf } from './stateTimeline'
import type {
  AttributionReport,
  EffectAttribution,
  MarginalEstimate,
  ProcLaneView,
  ProcLink,
  ProcRateView,
  StateKind,
  StateSpan
} from '../../shared/procAnalytics'

// ---------------------------------------------------------------------------------------
// Sample floors. Below each of these a number is ABSENT, never 0.
// ---------------------------------------------------------------------------------------

/** Below this much active time, `ppmActive` and `ppmWall` are absent. */
export const MIN_ACTIVE_SEC = 10
/** Below this many logged swings, `per100Swings` is absent. */
export const MIN_SWINGS = 20
/**
 * THE RATE-AWARE EXPOSURE GATE, and the number is a count of PROCS, not of swings.
 *
 * ⚠ THIS REPLACES THE PLAN'S `MIN_INACTIVE_SWINGS = 200` (§4.3), which contradicted the plan's
 * own narrative and was shipped in wave 1 with the contradiction written down rather than
 * silently resolved. docs/plans/proc-analytics.md fixed a FLAT floor of 200 inactive swings
 * while ALSO stating that Instrument of Nife — 289 inactive swings against 261,505 active ones
 * — must come out 'inconclusive' (§0.3, §2.1). 289 > 200, so as specified it came out
 * 'exclusive': the exact claim the plan spent a section refusing to make.
 *
 * A flat swing floor cannot express the judgement, because the judgement is not about swings at
 * all. "It never fired without it" is evidence only in proportion to how many firings the
 * inactive arm SHOULD have produced. So the gate is the lane's OWN observed rate, projected
 * onto the inactive exposure:
 *
 *     expected = inactiveSwings × (withCount / activeSwings)
 *
 * and the link may leave 'inconclusive' only when that expectation reaches this many procs. On
 * the real log the two named cases separate cleanly and for the right reason:
 *
 *   Instrument of Nife  1,084 procs / 261,505 active swings = 0.41 per 100 swings.
 *                       289 inactive swings ⇒ ~1.2 expected procs. Seeing zero is barely
 *                       evidence at all ⇒ 'inconclusive'. (A flat 200-swing floor said
 *                       'exclusive'.)
 *   Spellblade (w39)    14 procs / 406 active swings = 3.4 per 100 swings.
 *                       225 inactive swings ⇒ ~7.8 expected procs. Seeing zero is a real
 *                       measurement ⇒ 'exclusive'.
 *
 * Three, not five or ten: below three expected firings a null result is ordinary luck (at
 * λ = 3 a Poisson zero still happens 5% of the time — which is about as far as an
 * observational co-occurrence count deserves to be pushed), and raising it further would
 * silence the one genuine exclusivity this log contains.
 *
 * TIER B IS INDEPENDENT of this and reaches the same verdict for Nife by a different route: 289
 * swings cannot fill 20 eligible 60-second windows, so the counterfactual reports
 * 'insufficient-sample' whatever this gate says.
 */
export const MIN_EXPECTED_INACTIVE_PROCS = 3

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
 * `stateKey` is `<kind>:<key>`; `group` is the exclusivity group that state commits under, and
 * it is matched as a PREFIX. Exact match is the normal case ('stance', 'invocation',
 * `buff:<key>`); the prefix exists for COATS, whose exclusivity groups are 'coat:utility' and
 * `coat:combat:<venom>` and whose projected `StateSpan` cannot say which of the two it was
 * (law 6 — the dry line names a family, never a venom). So a coat study reads `'coat:'` and any
 * coat commit disqualifies the minute: it discards MORE windows than a per-venom rule would,
 * which is the safe direction for a purity gate.
 *
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
    if (impureFor(w, group)) continue
    if (w.swings < MIN_WINDOW_SWINGS || w.activeMs < MIN_WINDOW_ACTIVE_MS) continue
    arms.eligible++
    if (w.stateKeys.has(stateKey)) arms.active.push(w)
    else arms.inactive.push(w)
  }
  return arms
}

/** True when a commit of `group` (prefix-matched — see partitionWindows) landed in this minute. */
function impureFor(w: ProcWindow, group: string): boolean {
  for (const g of w.transitionGroups) {
    if (g.startsWith(group)) return true
  }
  return false
}

/** Windows that clear the VOLUME gates alone. State-independent, so it is the honest
 *  denominator for `AttributionReport.windowsEligible` — purity is decided per state. */
export function volumeEligible(windows: readonly ProcWindow[]): number {
  let n = 0
  for (const w of windows) {
    if (w.swings >= MIN_WINDOW_SWINGS && w.activeMs >= MIN_WINDOW_ACTIVE_MS) n++
  }
  return n
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
  /** The lane's SOURCE window, when one is modeled — see `ProcSourceWindow`. */
  source?: ProcSourceWindow
  /**
   * The caller is a LANE whose source window it could not resolve. The segment's own active
   * time is used and `sourceAmbiguous` is set, so the assumption travels with the number.
   *
   * Distinct from passing neither field, which is what the OVERALL headline does: "every proc
   * in this selection per minute of it" is a question about the selection, so the segment is
   * not an assumption there — it is the subject.
   */
  sourceUnknown?: boolean
}

/**
 * How long the thing that FIRES a lane was actually present, and what it was called.
 *
 * A proc cannot fire while its source is off: a rogue Strike needs the coat on the blades, an
 * aura-granted proc needs the aura up. `ppmActive` over the whole segment therefore answers a
 * question nobody asked ("how often did this fire per minute of a fight it was mostly unable to
 * fire in"), and the answer is systematically low. Where the model KNOWS the window — coat
 * spans and tracked proc-buff spans are both already on the state timeline, with active-time
 * exposure folded per state on ingest — the rate is over that window instead.
 */
export interface ProcSourceWindow {
  /** Active seconds the source was present for, inside the segment. */
  activeSec: number
  /** The span's display name, for the hover ('Neurotoxic Poison', 'Instrument of Nife'). */
  name: string
}

/**
 * The three denominators, each ABSENT below its floor.
 *
 * `count` and `swings` are always present and always exact — they are counts of lines the game
 * printed. Only the RATES can be missing, and they are missing precisely when dividing would
 * manufacture a number the sample cannot support.
 *
 * `ppmActive` divides by the SOURCE window when one is known and by the segment otherwise, and
 * says which it did (`sourceSec` / `sourceAmbiguous` / `sourceName`). The floor applies to
 * whichever denominator is actually used — a coat that was on for four seconds of a ten-minute
 * session yields no rate at all, which is the honest answer and not a 15-ppm headline.
 *
 * `ppmWall` and `per100Swings` are UNCHANGED. Wall clock is wall clock; and swings are the
 * mechanical denominator whose whole virtue is having no window ambiguity in it — a
 * chance-on-hit proc that could not fire on a swing still had that swing counted against every
 * other lane, so re-basing it per source would make the lanes incomparable.
 */
export function procRate(i: RateInput): ProcRateView {
  const view: ProcRateView = { count: i.count, swings: i.swings }
  const sec = i.source ? i.source.activeSec : i.activeSec
  // The window is declared whether or not it clears the floor — the ABSENCE message has to be
  // able to say "this coat was on for 4 seconds", not quote the segment it did not divide by.
  if (i.source) {
    view.sourceSec = sec
    view.sourceName = i.source.name
  } else if (i.sourceUnknown) {
    view.sourceSec = sec
    view.sourceAmbiguous = true
  }
  if (sec >= MIN_ACTIVE_SEC) {
    view.ppmActive = i.count / (sec / 60)
    if (i.durationSec > 0) view.ppmWall = i.count / (i.durationSec / 60)
  }
  if (i.swings >= MIN_SWINGS) view.per100Swings = (100 * i.count) / i.swings
  return view
}

/** Co-occurrence counts + BOTH swing exposures. The active-side count is what turns the gate
 *  from a flat swing floor into the lane's own observed rate — see MIN_EXPECTED_INACTIVE_PROCS. */
export interface LinkInput {
  withCount: number
  withoutCount: number
  /** YOUR swing attempts logged while the state was ACTIVE. The denominator of the lane's own
   *  proc rate, and the only reason this classifier can tell a rare proc from a common one. */
  activeSwings: number
  /** YOUR swing attempts logged while the state was INACTIVE. The exposure the claim rests on. */
  inactiveSwings: number
}

/**
 * How many firings the INACTIVE arm was worth, in procs.
 *
 * `max` of two estimates, and neither may be dropped:
 *   - what the arm ACTUALLY produced (`withoutCount`). Direct observation beats any model: a
 *     lane that fired six times without the state has demonstrably been sampled without it,
 *     whatever the active arm's rate would have predicted.
 *   - what the active arm's own rate PREDICTS for that many swings. This is the only estimate
 *     available in the case that matters — `withoutCount === 0`, where the whole question is
 *     whether the zero means anything.
 *
 * With `withCount === 0` the rate is 0 and the first term carries it, which is correct: a lane
 * that only ever fired WITHOUT the state is not evidence about the state's exposure, it is
 * evidence against the state entirely.
 */
export function expectedInactiveProcs(i: LinkInput): number {
  const rate = i.activeSwings > 0 ? i.withCount / i.activeSwings : 0
  return Math.max(i.withoutCount, i.inactiveSwings * rate)
}

/**
 * Classify a `ProcLink`. THE DEFAULT IS 'inconclusive', and that is the point: a lane that never
 * fired without a state is only evidence when the inactive arm had a real chance to produce
 * firings. Concentration alone can never reach 'exclusive' — a 100% concentration measured
 * against 36 swings of exposure (the w40 Instrument of Nife case) is not a measurement.
 */
export function linkStrength(i: LinkInput): ProcLink['strength'] {
  const total = i.withCount + i.withoutCount
  if (total === 0) return 'inconclusive'
  if (expectedInactiveProcs(i) < MIN_EXPECTED_INACTIVE_PROCS) return 'inconclusive'
  if (i.withoutCount === 0) return 'exclusive'
  return i.withCount / total >= 0.8 ? 'correlated' : 'weak'
}

/** `withCount / (withCount + withoutCount)`, 0 when the lane never fired at all (never NaN —
 *  a 0/0 that reaches a percentage formatter is how a meter prints "NaN%"). */
export function concentrationOf(withCount: number, withoutCount: number): number {
  const total = withCount + withoutCount
  return total === 0 ? 0 : withCount / total
}

// ---------------------------------------------------------------------------------------
// TIER B — the matched-window counterfactual (§5)
//
// MEDIANS, NEVER MEANS (law 5). One eight-minute boss window must not set the headline, and a
// mean over uncontrolled EQ content is exactly the aggregate that lies. Every arm reports its
// median, its IQR and its own n, and the two arms are never pooled.
//
// CONFOUNDS ARE DECLARED, NEVER CORRECTED (§5.4). Regression-adjusting an observational
// comparison over content nobody randomised would manufacture confidence the data cannot
// support. The list is printed beside the number, and the two confounds this ledger CANNOT test
// are declared as untested rather than omitted — an omitted check reads as a passed one.
// ---------------------------------------------------------------------------------------

/** A co-state is declared a confound when its active fraction differs between the arms by more
 *  than this (§5.4: "differs by >20 percentage points"). */
export const CO_STATE_GAP = 0.2

/** The §5.5 sentence, verbatim, for every effect with no per-hit marker — which per the wiki is
 *  17 of the 18 stances and invocations. It rides the row whatever the verdict is: an 'estimate'
 *  for a stance is still an estimate ABOUT something the log never marks. */
export const NO_PER_HIT_MARKER_NOTE =
  'A stance that boosts base melee has no per-hit marker in the log. Nothing distinguishes a ' +
  'swing under Offensive from a swing under Balanced except the swing’s number — and ' +
  'the mob, your level and your gear all changed too. The window comparison is the closest ' +
  'honest answer, and it is an estimate.'

/** Neither is recorded in the minute ledger, so neither can be tested. DECLARED, because a
 *  confound list that silently omits the checks it could not run reads as a clean bill. */
export const UNTESTED_CONFOUNDS =
  'not tested — level drift and mob mix are not carried in the minute ledger'

/** The exclusivity group a projected `StateSpan` commits under. Coats collapse to the family
 *  prefix: the shared span shape cannot say utility from combat (see partitionWindows). */
export function groupOf(kind: StateKind, key: string): string {
  if (kind === 'stance' || kind === 'invocation') return kind
  if (kind === 'coat') return 'coat:'
  return `buff:${key}`
}

/** Linear-interpolated quantile (the PERCENTILE.INC / type-7 definition) over an ASCENDING
 *  array. One definition, stated, so the IQR the UI prints is reproducible. */
function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = p * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** The three per-window statistics of one arm, each sorted ascending. Kept SEPARATE on purpose
 *  (§2.1 MarginalEstimate): on the real log spellblade moves proc damage ~40% while leaving
 *  damage-per-swing flat, and one blended headline would hide the entire mechanism. */
interface ArmSeries {
  dps: number[]
  procDps: number[]
  perSwing: number[]
}

function seriesOf(ws: readonly ProcWindow[]): ArmSeries {
  const s: ArmSeries = { dps: [], procDps: [], perSwing: [] }
  for (const w of ws) {
    const sec = w.activeMs / 1000
    if (sec > 0) {
      s.dps.push(w.outDamage / sec)
      s.procDps.push(w.procDamage / sec)
    }
    if (w.swings > 0) s.perSwing.push(w.outDamage / w.swings)
  }
  s.dps.sort((a, b) => a - b)
  s.procDps.sort((a, b) => a - b)
  s.perSwing.sort((a, b) => a - b)
  return s
}

/** The matched-window comparison. Both arms' n's ride along: a delta with one n hidden is a
 *  precision claim, and the renderer needs both to draw the estimate as a RANGE. */
export function marginalOf(arms: WindowArms): MarginalEstimate {
  const a = seriesOf(arms.active)
  const i = seriesOf(arms.inactive)
  const medA = quantile(a.dps, 0.5)
  const medI = quantile(i.dps, 0.5)
  return {
    nActive: arms.active.length,
    nInactive: arms.inactive.length,
    medDpsActive: medA,
    medDpsInactive: medI,
    iqrActive: [quantile(a.dps, 0.25), quantile(a.dps, 0.75)],
    iqrInactive: [quantile(i.dps, 0.25), quantile(i.dps, 0.75)],
    deltaDps: medA - medI,
    deltaPct: medI > 0 ? ((medA - medI) / medI) * 100 : 0,
    medProcDpsActive: quantile(a.procDps, 0.5),
    medProcDpsInactive: quantile(i.procDps, 0.5),
    medDmgPerSwingActive: quantile(a.perSwing, 0.5),
    medDmgPerSwingInactive: quantile(i.perSwing, 0.5)
  }
}

const pct = (f: number): string => `${Math.round(f * 100)}%`

function fractionActive(ws: readonly ProcWindow[], key: string): number {
  if (ws.length === 0) return 0
  let n = 0
  for (const w of ws) {
    if (w.stateKeys.has(key)) n++
  }
  return n / ws.length
}

/** Every OTHER tracked state whose presence differs materially between the arms. This is the
 *  one confound the ledger can actually measure, and it is the one that matters most: a
 *  "spellblade adds 90 dps" that is really "you happened to be in offensive stance for those
 *  minutes" is the failure mode this list exists to expose. */
function coStateConfounds(arms: WindowArms, selfKey: string): string[] {
  const keys = new Set<string>()
  for (const w of [...arms.active, ...arms.inactive]) {
    for (const k of w.stateKeys) keys.add(k)
  }
  keys.delete(selfKey)
  const out: string[] = []
  for (const k of [...keys].sort()) {
    const fa = fractionActive(arms.active, k)
    const fi = fractionActive(arms.inactive, k)
    if (Math.abs(fa - fi) <= CO_STATE_GAP) continue
    out.push(`co-state — ${k} was active in ${pct(fa)} of active windows but ${pct(fi)} of inactive ones`)
  }
  return out
}

/** True when the arms are temporally separated — every window of one precedes every window of
 *  the other. Gear, level and content all drift with time, so a separated comparison is a
 *  before/after, not a controlled one. */
function separated(a: readonly ProcWindow[], b: readonly ProcWindow[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  const aMin = Math.min(...a.map((w) => w.minute))
  const aMax = Math.max(...a.map((w) => w.minute))
  const bMin = Math.min(...b.map((w) => w.minute))
  const bMax = Math.max(...b.map((w) => w.minute))
  return aMax < bMin || bMax < aMin
}

/**
 * The declared confound list (§5.4). NOTHING here adjusts a number.
 *
 * `zone-mix` is deliberately absent and its absence is not an oversight: the ledger lives on the
 * `Agg`, and a zone change starts a new `Agg`, so every window in a report is from ONE zone by
 * construction. The two confounds the ledger genuinely cannot see (level drift, mob mix) are
 * declared as UNTESTED instead — see UNTESTED_CONFOUNDS.
 */
export function declareConfounds(arms: WindowArms, selfKey: string): string[] {
  const out = coStateConfounds(arms, selfKey)
  if (separated(arms.active, arms.inactive)) {
    out.push('not-interleaved — the two arms do not overlap in time; gear, level and content all drift with it')
  }
  out.push(UNTESTED_CONFOUNDS)
  return out
}

/** One effect to attribute: a state observed in this session, plus the ledger to test it in. */
export interface EffectInput {
  kind: StateKind
  key: string
  name: string
  windows: readonly ProcWindow[]
  /** TIER A, when a lane earned it — see `directFor`. Present ⇒ the verdict is 'measured' and
   *  no counterfactual is attempted, because none is needed. */
  direct?: DirectRollup
}

/** A Tier-A roll-up plus the states it CANNOT be told apart from. */
export interface DirectRollup {
  direct: EffectAttribution['direct']
  /** Display names of the other states the same lanes fired exclusively under. Two states
   *  switched on together own one body of evidence between them, and both rows must say so. */
  shared: string[]
}

/** The confound a shared roll-up declares. Two states committed together (w39 commits
 *  spellblade and offensive three seconds apart) leave the same lane exclusive to BOTH, and each
 *  row reports the full damage — so each row must name the other, or two rows silently claim one
 *  body of evidence twice. */
function sharedConfound(shared: readonly string[]): string {
  return (
    `co-exclusive — ${shared.join(', ')} ${shared.length > 1 ? 'were' : 'was'} active for exactly ` +
    'the same firings; the log cannot say which state the proc belongs to'
  )
}

/** The EMPTY Tier-A roll-up — the honest default for a state no lane fired exclusively under.
 *  The per-LANE Tier-A numbers are exact regardless and live in `ProcsView.lanes`.
 *  A fresh object every call: `lanes` is the audit list, and one shared array across every
 *  effect in every report is a mutation waiting to happen. */
const noDirect = (): EffectAttribution['direct'] => ({
  damage: 0,
  heal: 0,
  hits: 0,
  dpsContribution: 0,
  lanes: []
})

/**
 * THE TIER-A ROLL-UP: every lane whose link to this state came back 'exclusive'.
 *
 * 'exclusive' is not "100% of firings were under it" — that is `concentration`, and it is worth
 * nothing on its own. It is the rate-aware gate in `linkStrength`: the lane's own observed rate,
 * projected onto the swings logged WITHOUT the state, predicted at least
 * MIN_EXPECTED_INACTIVE_PROCS firings, and none happened. Only then is the lane's damage that
 * state's damage, exactly, with no window comparison needed at all.
 *
 * `damage` / `heal` are the lane's WHOLE totals and that is not a shortcut: `withoutCount === 0`
 * is what 'exclusive' means, so every firing the lane had happened with the state on.
 *
 * It remains a CO-OCCURRENCE (law 1). The log never names what fired a proc, so this measures
 * "these firings all happened with X on", never "X fired them" — which is why the note says so
 * and why no other number here is adjusted by it.
 */
export function directFor(
  lanes: readonly ProcLaneView[] | undefined,
  stateKey: string
): DirectRollup | undefined {
  if (!lanes) return undefined
  const d = noDirect()
  const shared = new Set<string>()
  for (const l of lanes) {
    const link = l.linked.find((k) => stateKeyOf(k.kind, k.key) === stateKey)
    if (link?.strength !== 'exclusive') continue
    d.damage += l.directDamage
    d.heal += l.directHeal
    d.hits += link.withCount
    d.dpsContribution += l.dpsContribution
    d.lanes.push(l.name)
    for (const other of l.linked) {
      if (other.strength === 'exclusive' && stateKeyOf(other.kind, other.key) !== stateKey) shared.add(other.name)
    }
  }
  return d.lanes.length > 0 ? { direct: d, shared: [...shared].sort() } : undefined
}

/** Kept SHORT on purpose: it rides every effect row of a 4×/sec snapshot, and a paragraph
 *  repeated twenty-five times is payload, not honesty. */
const DIRECT_NOTE = 'No lane is attributed to this state; the exact per-lane numbers are in the lane list.'

/** The measured row's own note, held to the same length budget. Names the lanes so the number
 *  is auditable, and states the co-occurrence limit so it cannot travel without it. */
function measuredNote(d: EffectAttribution['direct']): string {
  return (
    `${d.hits} firings of ${d.lanes.join(', ')} landed only while this state was active, ` +
    `for ${d.damage} damage and ${d.heal} healing — counted, not estimated. A co-occurrence: ` +
    'the log never names what fired a proc.'
  )
}

/**
 * One state's counterfactual verdict.
 *
 * THE FOUR VERDICTS, and none may be rendered as another:
 *   'estimate'            — both arms cleared MIN_ARM_WINDOWS. `marginal` present, confounds
 *                           declared beside it, and the renderer draws it as a RANGE.
 *   'insufficient-sample' — a real contrast exists (both arms have eligible windows) but at
 *                           least one is short. The note says WHICH arm and by how much.
 *   'not-observable'      — one arm is structurally empty: the state was on in every eligible
 *                           minute, or off in every one. No comparison is possible at all. This
 *                           is Instrument of Nife's answer, and it is the RESULT, not a defect.
 *   'measured'            — a state with an EXCLUSIVE proc lane behind it (`directFor`). An
 *                           exact count, so it takes precedence over every window verdict: a
 *                           measurement never yields to an estimate of the same thing.
 */
export function attributeEffect(i: EffectInput): EffectAttribution {
  const stateKey = stateKeyOf(i.kind, i.key)
  const base = { kind: i.kind, key: i.key, name: i.name, direct: noDirect() }
  // The stance/invocation sentence rides the row WHATEVER the verdict is (§5.5): an exclusive
  // proc lane measures that lane, and says nothing about the base-melee bonus the log never marks.
  const marker = i.kind === 'stance' || i.kind === 'invocation' ? ` ${NO_PER_HIT_MARKER_NOTE}` : ''
  if (i.direct) {
    const { direct, shared } = i.direct
    return {
      ...base,
      direct,
      verdict: 'measured',
      confounds: shared.length > 0 ? [sharedConfound(shared)] : [],
      note: `${measuredNote(direct)}${marker}`
    }
  }
  const arms = partitionWindows(i.windows, stateKey, groupOf(i.kind, i.key))
  const nA = arms.active.length
  const nI = arms.inactive.length
  if (nA >= MIN_ARM_WINDOWS && nI >= MIN_ARM_WINDOWS) {
    return {
      ...base,
      verdict: 'estimate',
      marginal: marginalOf(arms),
      confounds: declareConfounds(arms, stateKey),
      note: `${DIRECT_NOTE}${marker}`
    }
  }
  return { ...base, verdict: shortVerdict(nA, nI), confounds: [], note: `${shortNote(nA, nI)} ${DIRECT_NOTE}${marker}` }
}

function shortVerdict(nA: number, nI: number): EffectAttribution['verdict'] {
  return nA > 0 && nI > 0 ? 'insufficient-sample' : 'not-observable'
}

/** Says which arm is short and by how much — never a bare "not enough data". */
function shortNote(nA: number, nI: number): string {
  if (nA === 0 && nI === 0) return 'No minute of this session cleared the volume gates, so no comparison was attempted.'
  if (nA === 0) return `This state was never active in an eligible minute (${nI} inactive windows). No comparison is possible.`
  if (nI === 0) return `This state was active in every one of the ${nA} eligible minutes. No comparison is possible — there is no control group.`
  const shortArm = nA < nI ? 'active' : 'inactive'
  const have = Math.min(nA, nI)
  return `The ${shortArm} arm has ${have} eligible 60-second windows; ${MIN_ARM_WINDOWS} are needed (${nA} active / ${nI} inactive).`
}

const KIND_ORDER: StateKind[] = ['buff', 'invocation', 'stance', 'coat']

/** Everything the report needs. The state list is the SPANS of this segment, so the report
 *  covers exactly the states this session actually saw — none omitted, none invented. */
export interface ReportInput {
  sessionId: string
  windows: readonly ProcWindow[]
  states: readonly StateSpan[]
  /** This segment's proc lanes, carrying their per-state links. The TIER-A feed: a lane that
   *  fired only while a state was open (at real exposure) makes that state's contribution an
   *  exact count. Optional so a caller with no lane list still gets the Tier-B half. */
  lanes?: readonly ProcLaneView[]
}

/**
 * The Tier-B report for one zone session. EVERY state observed gets a row, including — and
 * especially — the ones whose honest answer is "no comparison is possible": omitting them would
 * leave the UI looking like the feature simply had nothing to say about stances, when what it
 * has to say is that the log never marks them.
 */
export function buildAttributionReport(i: ReportInput): AttributionReport {
  const seen = new Map<string, StateSpan>()
  for (const s of i.states) {
    const k = stateKeyOf(s.kind, s.key)
    if (!seen.has(k)) seen.set(k, s)
  }
  const effects = [...seen.entries()]
    .map(([k, s]) =>
      attributeEffect({
        kind: s.kind,
        key: s.key,
        name: s.name,
        windows: i.windows,
        direct: directFor(i.lanes, k)
      })
    )
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name))
  return {
    sessionId: i.sessionId,
    windowSec: WINDOW_MS / 1000,
    windowsTotal: i.windows.length,
    windowsEligible: volumeEligible(i.windows),
    effects
  }
}
