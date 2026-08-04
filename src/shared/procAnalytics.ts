// PROC ANALYTICS — the shapes for procs-per-minute, the active-state timeline, and the
// two-tier "how much does X add" attribution (docs/plans/proc-analytics.md).
//
// A NEW shared file rather than an extension of shared/combat.ts, deliberately: three plans
// are in flight against combat.ts at once, and this feature's whole type surface can live
// beside it instead of inside it. The shipped precedent is shared/poisons.ts (split out of
// logEvents.ts) and shared/buffTypes.ts (split out of types.ts).
//
// WORLD-MODEL POSITION (AGENTS.md):
//   law 1 — every count here comes from a line the game printed. The one derived judgement
//           ("this spell effect had no cast behind it, therefore it procced") is a LABELED
//           inference with a stated window, and it may never name a SOURCE — only a
//           co-occurrence. That is why `ProcLink` exists and `ProcSource` does not.
//   law 5 — every rate is ABSENT below its sample floor, never 0. `1 proc in a 2-second pull`
//           is not `30 ppm`.
//   law 6 — the log carries NO per-hit marker for any stance or invocation bonus, so most of
//           the roster's honest verdict is a sentence, not a number ('not-observable').
//   law 8 — everything here is an ADDITIVE index over damage already counted. Not one damage
//           total moves.

// ---------------------------------------------------------------------------------------
// The active-state timeline
// ---------------------------------------------------------------------------------------

/**
 * What kind of state a span describes.
 *
 * `disc` is deliberately ABSENT: this log's only "discipline" lines are
 * `You have been granted the following discipline: <Poison>` — the rogue poison grant list —
 * not an activated combat discipline. There is no disc state to track, and adding the kind
 * would invite someone to fill it.
 */
export type StateKind = 'stance' | 'invocation' | 'coat' | 'buff'

/**
 * How we know a span's edge. This is law 1 made into a field: a span's END is almost never
 * printed by the game (97 `Instrument of Nife` applies against ONE observed fade in the whole
 * 1.1M-line log), so an honest model has to carry the difference between "the game said so"
 * and "we worked it out".
 *
 *   'observed'  — a line said so (`The poison dries from the blade.`, a wears-off message).
 *   'inferred'  — a mutually-exclusive sibling replaced it (a new stance commit ends the
 *                 previous stance; a re-apply of a permanent buff supersedes its own span).
 *   'censored'  — the boundary is UNKNOWABLE: it was already active when the replay began, or
 *                 an epoch / reset / player death severed it. NEVER shown as an end time.
 *   'open'      — still active as of the last event.
 */
export type EdgeEvidence = 'observed' | 'inferred' | 'censored' | 'open'

/** One interval of "state X was on". */
export interface StateSpan {
  kind: StateKind
  /** Canonical join key — lowercased, rank-stripped (law 2: canonicalize at boundaries). */
  key: string
  /** Display name, raw casing (law 2: display raw). */
  name: string
  startTs: number
  /** Absent while `endEvidence === 'open'`. */
  endTs?: number
  startEvidence: EdgeEvidence
  endEvidence: EdgeEvidence
}

// ---------------------------------------------------------------------------------------
// Proc rates
// ---------------------------------------------------------------------------------------

/**
 * Where a counted proc came from.
 *   'poison' — a rogue Strike emote. ALREADY modeled by Task #64's ProcAccum.strikes; the
 *              unified lane list PROJECTS that map rather than counting it a second time.
 *   'spell'  — a spell-effect line with no own cast behind it (see PROC_CAST_WINDOW_MS).
 *   'slay'   — the `(Slay Undead)` melee paren modifier: a proc that rides a swing, so its
 *              damage is NOT the damage it added (see ProcLaneView.marginalDamage).
 */
export type ProcOrigin = 'poison' | 'spell' | 'slay'

/**
 * THREE denominators, all carried, none hidden. They answer different questions, and
 * collapsing them into one number is how a proc meter starts lying:
 *
 *   ppmActive    — the headline. Procs per minute of ACTIVE combat time, using the meter's
 *                  OWN active-time definition verbatim (capped 3s gaps between attributed
 *                  hits — INCOMING damage included, because that is what the shipped
 *                  `activeDps` already means; the UI states the caveat rather than silently
 *                  redefining a shipped number).
 *   ppmWall      — procs per minute of wall clock: "how often does this happen while I play".
 *   per100Swings — the only MECHANICALLY correct figure for a chance-on-hit proc, and the one
 *                  with no active-time ambiguity at all.
 *
 * Every rate is ABSENT (undefined) below its sample floor, never 0 (law 5).
 */
export interface ProcRateView {
  count: number
  ppmActive?: number
  ppmWall?: number
  /**
   * YOUR melee swing attempts in this segment: melee + slay hits, plus your misses. The
   * mechanical denominator. Main-hand vs off-hand and double/triple attack are
   * undistinguishable in this log (law 6), so this is swings-AS-LOGGED and the field name
   * says so.
   */
  swings: number
  per100Swings?: number
}

/**
 * ONE proc lane, unified across origins. A superset of the shipped `ProcLane` shape, so the
 * Procs tab's existing rows keep rendering unchanged while the new sections read from here.
 */
export interface ProcLaneView {
  name: string
  count: number
  origin: ProcOrigin
  /** True when the LABEL is uncertain (a shared emote, a shared dispel tier) — the shipped
   *  `~` treatment. The COUNT is always exact; only the name is in doubt. */
  ambiguous?: boolean
  rate: ProcRateView

  // ---- TIER A: DIRECT attribution. MEASURED, not estimated. -----------------------------
  /** Damage these proc lines carried. Already inside the segment's outgoing total. */
  directDamage: number
  /** Healing these proc lines carried (`You healed X for N hit points by Lifetap Strike.`). */
  directHeal: number
  /** `directDamage` as a percentage of the segment's outgoing total. */
  pctOfOut: number
  /** `directDamage / activeSec` — this proc's share of your DPS. EXACT for 'spell' and
   *  'poison' lanes. For a 'slay' lane it is the damage of swings that PROCCED, which is NOT
   *  the damage the proc ADDED — see `marginalDamage`. */
  dpsContribution: number
  /**
   * SLAY-ONLY, and an ESTIMATE with its assumption written into the type: a Slay Undead swing
   * would have landed anyway for something. This is
   *   slayTotal − slayHits × (mean melee hit in this segment)
   * i.e. the excess over an ordinary swing. Absent for every other origin, where the proc's
   * whole damage IS its marginal damage.
   */
  marginalDamage?: number

  /** Co-occurrence with tracked states. CORRELATION — see ProcLink. */
  linked: ProcLink[]
}

/**
 * How often a lane fired while a given state was active. THIS IS NOT CAUSATION, and the type
 * is shaped so a consumer cannot pretend otherwise: it carries both counts AND the
 * inactive-side EXPOSURE, because "it never fired without it" is only evidence when there was
 * a meaningful chance to fire without it.
 */
export interface ProcLink {
  kind: StateKind
  key: string
  name: string
  withCount: number
  withoutCount: number
  /** `withCount / (withCount + withoutCount)`, 0..1. */
  concentration: number
  /** YOUR swing attempts logged while the state was INACTIVE in this segment. The denominator
   *  of the claim "it never fired without it". */
  inactiveSwings: number
  /**
   * 'exclusive'    — withoutCount === 0 AND the inactive exposure predicts >=
   *                  MIN_EXPECTED_INACTIVE_PROCS firings at the lane's own active
   *                  rate (the rate-aware gate; a flat swing floor could not tell
   *                  "never fires without it" from "too few swings to expect one").
   * 'correlated'   — concentration >= 0.8 with both sides sampled.
   * 'weak'         — both sides sampled, concentration < 0.8.
   * 'inconclusive' — the inactive side was never meaningfully sampled. The DEFAULT, and the
   *                  honest answer for Instrument of Nife (289 inactive swings in 1.1M lines).
   */
  strength: 'exclusive' | 'correlated' | 'weak' | 'inconclusive'
}

// ---------------------------------------------------------------------------------------
// TIER B: the counterfactual (a LATER wave — the shapes land here so the interval-query
// surface below can be built against them, and so nothing has to reshape combat.ts twice)
// ---------------------------------------------------------------------------------------

/**
 * The FOUR verdicts. Exactly four, and none may be rendered as another — the same discipline
 * the shipped `SlowRollup` enforces for time-to-slow:
 *   'measured'            — Tier A only. An exact number; no comparison was needed.
 *   'estimate'            — Tier B cleared every gate. Rendered `~`, as a RANGE, with its
 *                           confounds printed beside it.
 *   'insufficient-sample' — the gates failed. Says WHICH arm is short, and by how much.
 *   'not-observable'      — the effect has no per-hit marker AND no exclusive proc lane.
 *                           Every stance, and most invocations. The honest answer is a
 *                           sentence, not a number.
 */
export type AttributionVerdict = 'measured' | 'estimate' | 'insufficient-sample' | 'not-observable'

export interface MarginalEstimate {
  nActive: number
  nInactive: number
  /** MEDIAN outgoing DPS per eligible window, active arm vs inactive arm. Median, not mean:
   *  one 8-minute boss window must not set the headline (the SlowRollup precedent). */
  medDpsActive: number
  medDpsInactive: number
  iqrActive: [number, number]
  iqrInactive: [number, number]
  deltaDps: number
  deltaPct: number
  /** The same comparison on PROC damage alone, and on damage-per-swing alone. Reported
   *  SEPARATELY on purpose: for spellblade the real log shows damage/swing flat (26.2 vs
   *  26.3) while proc damage per minute is up ~40% (727.8 vs 518.5). Averaging those two into
   *  one headline would hide the entire mechanism. */
  medProcDpsActive: number
  medProcDpsInactive: number
  medDmgPerSwingActive: number
  medDmgPerSwingInactive: number
}

export interface EffectAttribution {
  kind: StateKind
  key: string
  name: string
  verdict: AttributionVerdict
  /** Tier A. `lanes` names the proc lanes rolled in, so the number is auditable. */
  direct: { damage: number; heal: number; hits: number; dpsContribution: number; lanes: string[] }
  /** Tier B. Present ONLY when `verdict === 'estimate'`. */
  marginal?: MarginalEstimate
  /** DECLARED, never corrected. Regression-adjusting an observational comparison over
   *  uncontrolled EQ content would manufacture confidence; the UI prints the list. */
  confounds: string[]
  /** Why it is insufficient / not observable, in the words the UI prints. */
  note?: string
}

export interface AttributionReport {
  /** The zone-session id this describes. Tier B is Overall-scope only: a single pull has no
   *  inactive sample, and a per-fight counterfactual would be an invitation to read noise. */
  sessionId: string
  windowSec: number
  windowsTotal: number
  windowsEligible: number
  effects: EffectAttribution[]
}
