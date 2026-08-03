// THE PROC-BUFF CATALOG (docs/plans/proc-analytics.md §3.2) — the curated set of self-buffs
// whose up/down span is worth tracking as an active state.
//
// CURATED, NOT THE WHOLE SPELL DB, and the gate is the same one `DISPEL_FAMILY` applies to
// dispel landings, for the same reason: feeding 1,926 spells into a span tracker would flood
// the model with irrelevant states and make every co-occurrence number meaningless. A state
// earns a row here only when (a) it plausibly modulates a proc rate and (b) its landing and
// wear-off messages are UNAMBIGUOUS in the shipped spell DB — otherwise the span edges would
// be guesses and law 1 would be broken at the very first field.
//
// Every field below is copied VERBATIM from src/main/data/spells.json. Nothing here is
// invented, and `grantsProc` is the one wiki-sourced field — see its doc comment.

/** One tracked self-buff. */
export interface ProcBuffDef {
  /** DB spell name, display casing. */
  name: string
  /** DB `classes` string, for provenance. */
  classes: string
  /** DB `msg_cast_on_you` — the landing line. Verified UNIQUE in the DB. */
  applyMsg: string
  /** DB `msg_wears_off` — the fade line. Verified UNIQUE in the DB. */
  wearOffMsg: string
  /**
   * The proc this buff GRANTS, per the wiki ("Add Melee Proc: Condemnation of Nife").
   *
   * A HINT ONLY. It pre-seeds a `ProcLink` LABEL so the UI can put the two rows next to each
   * other; it is NEVER used to attribute a proc. A proc line in this log names no source
   * (law 6), so the link's STRENGTH always comes from the observed co-occurrence counts and
   * the inactive-side exposure — never from this string.
   */
  grantsProc?: string
}

/**
 * v1 is ONE entry, and that is the honest state of the evidence rather than a stub.
 *
 * `Instrument of Nife` is the Paladin L15 self-buff (`Permanent`, `Add Melee Proc:
 * Condemnation of Nife`). Both of its messages are unique in the DB — exactly one candidate
 * each — so its span edges are unambiguous, which is the entry condition for this table.
 *
 * It is also the feature's HONEST-LIMITS case, and worth stating where the data lives: the
 * real log carries 97 landings against ONE observed fade, and 261,505 melee swings with the
 * aura up against 289 with it down. Tier A (direct damage of the granted proc) is exact;
 * Tier B (a counterfactual comparison) is impossible, because 289 swings is not a control
 * group. That asymmetry is the result, not a defect to engineer around.
 */
export const PROC_BUFF_CATALOG: ProcBuffDef[] = [
  {
    name: 'Instrument of Nife',
    classes: '* Paladin - Level 15',
    applyMsg: 'A brilliant blue aura surrounds your weapon.',
    wearOffMsg: 'The brilliant blue aura fades.',
    grantsProc: 'Condemnation of Nife'
  }
]

/** Canonical join keys of the catalog (lowercased names), for the O(1) ingest gate. */
export const PROC_BUFF_KEYS: ReadonlySet<string> = new Set(
  PROC_BUFF_CATALOG.map((b) => b.name.toLowerCase())
)

/** The catalog entry a candidate spell name names, or undefined. Case-insensitive: buff
 *  landing candidates arrive in DB display casing, wears-off candidates need not. */
export function procBuffFor(name: string): ProcBuffDef | undefined {
  const key = name.toLowerCase()
  return PROC_BUFF_CATALOG.find((b) => b.name.toLowerCase() === key)
}

/** The FIRST catalog entry named by a candidate list, or undefined when none is. Buff
 *  landings and wear-offs both arrive as CANDIDATE LISTS (law 3: shared messages are the
 *  norm), so the gate has to be a set intersection, never a single-name equality. */
export function procBuffInCandidates(candidates: readonly string[]): ProcBuffDef | undefined {
  for (const c of candidates) {
    const hit = procBuffFor(c)
    if (hit) return hit
  }
  return undefined
}
