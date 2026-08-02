// Damage taxonomy (Task #51) — parse-time categorization of damage events by
// SOURCE MECHANIC, so the combat drill-down and timeline can group by category.
//
// This is the single source of truth for how a raw damage line maps to a
// DamageCategory + a modifier set. It's pure (no state) and shared by the parser
// (which stamps `category`/`modifiers` onto the canonical DamageEventE) and the
// engine (which rolls them into category aggregates). Keeping it here — not inline
// in the parser — lets the golden-window tests assert the mapping directly.
//
// VERIFIED vocabulary (full-log sweep of eqlog_Primitive_freeport.txt, 2026-08-02):
//
//   PAREN MODIFIERS (count) — a damage line's trailing "(...)" is a SPACE-SEPARATED
//   set, not a single token:
//     (Critical) 16534, (Riposte) 11002, (Slay Undead) 1258, (Finishing Blow) 376,
//     (Rampage) 208, (Flurry) 125, (Riposte Critical) 94, (Riposte Rampage) 9,
//     (Riposte Slay Undead) 8, (Crippling Blow) 4, (Riposte Flurry) 3,
//     (Strikethrough) 1, (Riposte Finishing Blow) 1.
//   So a modifier can COMPOUND (e.g. "Riposte Critical" = a riposte swing that also
//   critted). We split on whitespace and preserve every token; `crit` is the presence
//   of "Critical", `slay` the presence of "Slay Undead".
//
//   CATEGORY AXES (by line grammar, dtype from the parser):
//     'melee'  — "<A> <verb> <B> for N points of damage." (skill = Bash/Kick/Backstab/
//                Frenzy/Flurry/Melee). A melee hit carrying a "Slay Undead" modifier is
//                re-categorized 'slay' (the user's directive: Slay Undead is its own
//                category). All 1257 Slay Undead lines in the log are melee (0 spell).
//     'slay'   — a melee swing with the Slay Undead proc (holy melee proc vs undead).
//     'spell'  — "<A> hit <B> for N points of <class> damage by <Spell>." (direct nuke).
//     'dot'    — "<B> has taken N damage from [your] <Spell>." (damage over time tick).
//     'ds'     — "<B> is <verb> by <owner>'s <element> for N ... non-melee damage."
//                (damage shield, out and incoming).
//
// NON-DISTINGUISHABLES (documented honestly — the log does NOT carry these, so the
// taxonomy does NOT invent them):
//   - MAIN-HAND vs OFF-HAND: the melee line names no hand. Not derivable.
//   - DOUBLE / TRIPLE / multi-attack: never logged explicitly. The engine exposes a
//     HEURISTIC "melee rounds" stat (same-attacker same-skill hits clustered in one
//     second) rather than a fabricated double/triple flag — see engine.ts meleeRounds.
//   - ENVIRONMENTAL (fall/lava/drown): NOT PRESENT in this log family at all (a full
//     sweep for "You have taken … damage" / fall / drown / lava self-damage found zero
//     real lines). Left out until a log actually contains it.

import type { DamageType, DamageCategory } from '../../shared/combat'

export type { DamageCategory }

/**
 * Split a raw paren-modifier string ("Riposte Critical") into its tokens
 * (["Riposte","Critical"]). Returns [] for undefined/empty. The tokens are
 * space-separated in the log; multi-word modifiers ("Slay Undead", "Finishing Blow",
 * "Crippling Blow") are recombined by recognizing the known two-word forms.
 */
export function parseModifiers(modifier: string | undefined): string[] {
  if (!modifier) return []
  const raw = modifier.trim()
  if (!raw) return []
  // The log's compound modifiers are single-word tokens EXCEPT three two-word procs:
  // "Slay Undead", "Finishing Blow", "Crippling Blow". Recombine those; everything
  // else (Critical, Riposte, Rampage, Flurry, Strikethrough) is a single word.
  const TWO_WORD = ['Slay Undead', 'Finishing Blow', 'Crippling Blow']
  const mods: string[] = []
  let rest = raw
  // Greedily pull known two-word modifiers first, then split the remainder on spaces.
  for (const tw of TWO_WORD) {
    if (rest.includes(tw)) {
      mods.push(tw)
      rest = rest.replace(tw, ' ').trim()
    }
  }
  for (const tok of rest.split(/\s+/)) {
    if (tok) mods.push(tok)
  }
  return mods
}

/** True if the modifier set includes a Critical (crit-derivation is centralized here). */
export function hasCritical(mods: string[]): boolean {
  return mods.some((m) => /^critical$/i.test(m))
}

/** True if the modifier set includes the Slay Undead proc. */
export function hasSlayUndead(mods: string[]): boolean {
  return mods.some((m) => /^slay undead$/i.test(m))
}

/**
 * The taxonomy category for a damage event given its parser dtype + modifier set.
 * A melee swing with the Slay Undead modifier is re-categorized 'slay' (its own
 * category per the user); every other dtype maps 1:1 (melee/spell/dot/ds).
 */
export function damageCategory(dtype: DamageType, mods: string[]): DamageCategory {
  if (dtype === 'melee' && hasSlayUndead(mods)) return 'slay'
  return dtype
}
