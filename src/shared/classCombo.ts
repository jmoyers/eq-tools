// CLASS-COMBO INFERENCE — the shared data model (docs/plans/class-combo-inference.md § 3).
//
// EQ Legends runs UP TO THREE CLASSES AT ONCE and the log NEVER states a loadout swap. The
// character's own `/who` row is the only line that ever names the combo outright, and there
// are ELEVEN of them in 1.1M lines. Everything else in this model is INFERENCE, and world-model
// law 1 ("messages over inference; anything inferred is LABELED inferred") is why every type
// here carries provenance, a confidence, and an explicit representation of NOT KNOWING:
//   * a slot with several candidates is AMBIGUOUS — it says {CLR,PAL}, it does not pick PAL;
//   * a slot with no evidence at all is UNKNOWN — all 16 candidates, confidence 0;
//   * an interval boundary is a RANGE [startLo, startHi], never an instant, because a swap
//     prints nothing and the two events that bracket it can be 33.9 hours apart.
//
// Lives in shared/ (the shared/types.ts precedent) so preload and the renderer can import the
// types without crossing the main↔web tsconfig boundary; the pure read model that joins other
// records to these intervals is shared/comboIndex.ts.

/** The 16 EQ Legends classes, by their `/who` three-letter code. */
export type ClassAbbr =
  | 'BER'
  | 'BRD'
  | 'BST'
  | 'CLR'
  | 'DRU'
  | 'ENC'
  | 'MAG'
  | 'MNK'
  | 'NEC'
  | 'PAL'
  | 'RNG'
  | 'ROG'
  | 'SHD'
  | 'SHM'
  | 'WAR'
  | 'WIZ'

/**
 * Every class code, sorted — the closed set behind `isClassAbbr` (IPC validation) and the
 * candidate list of an UNKNOWN slot. Note SHD, not SHK: the wiki spells the class both
 * "Shadow Knight" and "Shadowknight" and both canonicalize here.
 */
export const CLASS_ABBRS: readonly ClassAbbr[] = [
  'BER',
  'BRD',
  'BST',
  'CLR',
  'DRU',
  'ENC',
  'MAG',
  'MNK',
  'NEC',
  'PAL',
  'RNG',
  'ROG',
  'SHD',
  'SHM',
  'WAR',
  'WIZ'
]

const ABBR_SET: ReadonlySet<string> = new Set<string>(CLASS_ABBRS)

/** Type guard over the closed set. The IPC handler validates renderer input with this. */
export function isClassAbbr(v: unknown): v is ClassAbbr {
  return typeof v === 'string' && ABBR_SET.has(v)
}

/** A loadout holds at most three classes (Primary + Secondary; Tertiary unlocks at level 10). */
export const MAX_COMBO_SLOTS = 3

/** Where a statement about the combo came from. Ordered by authority. */
export type ComboProvenance =
  /** the user corrected it in the UI — authoritative until a LATER /who contradicts it */
  | 'user'
  /** the character's own /who row stated it — observed, timestamped, ground truth */
  | 'who'
  /** derived from casts / skill-ups / stances / poisons — NEVER presented as fact */
  | 'inferred'

/**
 * ONE slot's knowledge. `candidates` is the SET of classes still consistent with the evidence;
 * the slot is RESOLVED only when it holds exactly one. A 3-slot combo where two slots resolve
 * and one holds {CLR,PAL} is the normal, honest state — that is what "2 of 3 known" looks
 * like, and the UI renders it as such rather than guessing the third.
 */
export interface ComboSlot {
  /** 1 = resolved; >1 = ambiguous; 16 = unknown. Sorted and deduped. */
  candidates: ClassAbbr[]
  /** 0..1 — see `slotConfidence` in modules/comboScore.ts for the ladder. */
  confidence: number
  provenance: ComboProvenance
  /** Evidence keys that produced this slot, strongest first, capped at 8 (`skill:Frenzy`). */
  because: string[]
}

/** Why an interval OPENED. `logStart` is the first interval; the rest are swap detectors. */
export type ComboBoundaryReason =
  | 'who'
  | 'levelDrop'
  | 'evidenceShift'
  | 'overDetermined'
  | 'user'
  | 'logStart'

/**
 * A contiguous span during which we believe the loadout did not change.
 *
 * BOUNDARIES ARE FUZZY BY CONSTRUCTION — a swap prints nothing, so the honest statement is
 * "the swap happened somewhere in [startLo, startHi]" and `startTs` is only the best estimate
 * inside it. The real log's Aug 2 swap is bracketed by level dings 33.9 h apart and narrowed
 * to ~60 min by the evidence shift; both facts are modeled, never averaged away.
 */
export interface ComboInterval {
  /** `ci<n>` in time order. NOT stable across a recompute — see § 5.4 / `ComboDelta.removed`. */
  id: string
  /** best estimate of the start; always inside [startLo, startHi] */
  startTs: number
  /** null = the open / current interval */
  endTs: number | null
  startLo: number
  startHi: number
  endLo: number | null
  endHi: number | null
  /** the detector that produced the NARROWEST window for this boundary */
  startReason: ComboBoundaryReason
  /** other detectors that fired for the SAME swap (a level drop corroborating a shift). */
  startAlso?: ComboBoundaryReason[]
  /** 2 before the tertiary unlock, 3 after — a PRIOR, overridden by a /who row's own arity. */
  expectedSlots: 2 | 3
  /** length === expectedSlots; unfilled positions are explicit UNKNOWN slots, never dropped. */
  slots: ComboSlot[]
  /** level range observed inside the interval (min-of-loadout semantics). */
  levelLo: number | null
  levelHi: number | null
  /** how much evidence stands behind this interval, for the UI's "do we actually know" cue. */
  evidenceCount: number
  /** set ONLY by a user correction; suppresses re-inference of these slots. */
  userLocked: boolean
}

/** One atomic piece of evidence, before it is folded into a slot. */
export interface ClassObservation {
  ts: number
  seq: number
  source: 'who' | 'stance' | 'invocation' | 'poisonCoat' | 'skillUp' | 'cast'
  /** display key: 'Frenzy', 'berserker', 'Mesmerization' */
  label: string
  /** classes consistent with this observation. Exactly one ⇒ exclusive ⇒ decisive. */
  candidates: ClassAbbr[]
  /** source weight (§ 4.2), precomputed so scoring is a pure sum. */
  weight: number
}

export interface ComboSnap {
  /** time-ordered, non-overlapping; the last one may be open (`endTs === null`). */
  intervals: ComboInterval[]
  /** convenience: the last interval, or null. */
  current: ComboInterval | null
  /** false until the class tables are available — a data-availability flag, not an error. */
  ready: boolean
}

export interface ComboDelta {
  /** intervals added OR revised since the last flush; merge by id. */
  changed: ComboInterval[]
  /** ids that no longer exist after a recompute; drop them. */
  removed: string[]
}

/**
 * A user correction — the ONLY durable combo state (§ 7). Keyed by TIME, never by interval id:
 * a correction recomputes every interval and ids are recompute-unstable by design, so an
 * id-keyed correction would detach from the thing it corrected on the very next fold.
 */
export interface ComboCorrection {
  startTs: number
  /** null = "from startTs onward", i.e. the correction applies to the open interval too. */
  endTs: number | null
  classes: ClassAbbr[]
  /** when the user set it (epoch ms) — later corrections win over earlier overlapping ones. */
  setAt: number
}

/** The persisted, character-scoped combo state. Intervals are NEVER persisted (§ 7). */
export interface ComboProgress {
  corrections: ComboCorrection[]
}

/** The resolved classes of an interval — only slots that hold exactly one candidate. */
export function resolvedClasses(interval: ComboInterval): ClassAbbr[] {
  return interval.slots.filter((s) => s.candidates.length === 1).map((s) => s.candidates[0])
}

/** Interval confidence is the MIN over slots — a combo you only 2/3 know is 2/3 known. */
export function intervalConfidence(interval: ComboInterval): number {
  if (interval.slots.length === 0) return 0
  return Math.min(...interval.slots.map((s) => s.confidence))
}
