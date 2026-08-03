// EVIDENCE INTAKE for the class-combo model (docs/plans/class-combo-inference.md § 2 / § 4.2).
//
// PURE: one LogEvent in, at most one ClassObservation out, plus the two committed tables it
// looks classes up in. No Electron, no state — the module shell (combo.ts) owns the ring and
// the one bit of context this needs (when an item last fired).
//
// THE TABLES ARE NOT INTERCHANGEABLE, and that is the single most load-bearing rule in this
// file. Wave 2 measured that `Frenzy`, `Smite` and `Feign Death` are BOTH client skill names
// AND Template:Spellpage spell names with DIFFERENT class sets (Frenzy: a BER skill, a SHM/BST
// spell; Feign Death: a MNK skill, a NEC/SHD spell) — so:
//   * a `skillUp` resolves against classes.json `skills`, and ONLY that,
//   * a `castBegin` resolves against spells.json (then classes.json `abilities`), and ONLY that.
// Unioning them would hand MNK's Feign Death skill-ups to NEC and SHD and quietly destroy the
// one signal that dates the Aug 2 swap. classes.json's `disputed[]` records all three rows.
//
// CLICKY SUPPRESSION (the wave-1 correction, and the reason cast evidence is usable at all).
// Design § 4.2 proposed rejecting item-cast noise with "evidence must span ≥2 hourly buckets".
// MEASURED: that fails. After the Aug 2 swap — a period where every other signal says the
// loadout is PAL/ROG/BER — ENC still shows SEVEN distinct exclusive labels (illusion spells,
// Rampage I) fired entirely by item clickies, across many buckets. The game does print the
// tell, though: `Your <item> shimmers briefly.` lands immediately before the cast it caused
// (ItemActivateEvent, added in this wave; 7,921 lines, two message families, two items each).
// So a castBegin within CLICKY_SUPPRESSION_MS after an item activation contributes NO class
// evidence at all. Hand-casts are untouched.

import classesJson from '../data/classes.json'
import { classesForSpell } from '../data/spellClasses'
import { spellCanonKey } from '../log/parseCommon'
import type { LogEvent } from '../../shared/logEvents'
import { isClassAbbr, type ClassAbbr, type ClassObservation } from '../../shared/classCombo'

/**
 * How long after an item activation a cast is attributed to the ITEM rather than the player.
 * The real log prints both lines in the SAME second (ts resolution is 1s), so any positive
 * window works; 2.5 s covers a cast whose begin-line slips a second and stays far below the
 * ~6 s median gap between an unrelated hand-cast and the nearest clicky.
 */
export const CLICKY_SUPPRESSION_MS = 2500

/**
 * Source weights (§ 4.2). `who` is absent on purpose: a `/who` row is not scored, it OVERRIDES
 * (§ 4.4). The ordering encodes how much each family can lie — a poison coat is ROG by game
 * design, a stance/skill is class-gated by the client, an invocation is class-gated but three
 * of the nine span twelve classes and the wiki contradicts itself on two rows, and a cast is
 * the weakest of all (items cast, charmed pets cast, volume overwhelms truth).
 */
export const SOURCE_WEIGHT = {
  who: 0,
  poisonCoat: 3,
  stance: 2.5,
  skillUp: 2.5,
  invocation: 1.5,
  cast: 1
} as const

/** classes.json list → the closed ClassAbbr set. An unknown code is dropped, never coerced. */
function abbrs(list: readonly string[] | undefined): ClassAbbr[] {
  return list === undefined ? [] : list.filter(isClassAbbr)
}

const STANCES: Record<string, string[]> = classesJson.stances
const INVOCATIONS: Record<string, string[]> = classesJson.invocations
const SKILLS: Record<string, string[]> = classesJson.skills

/**
 * Abilities that are NOT Template:Spellpage pages — `Lay on Hands`, `Holy Steed`, `Harm Touch`,
 * 76 of them. They print an ordinary `You begin casting …` line, so without this table the 441
 * Lay on Hands casts in the real log (the strongest PAL signal there is) resolve to nothing.
 * Keyed by spellCanonKey because casts carry a Roman rank the table does not.
 */
const ABILITIES: ReadonlyMap<string, ClassAbbr[]> = new Map(
  Object.entries(classesJson.abilities as Record<string, string[]>).map(([name, list]) => [
    spellCanonKey(name),
    abbrs(list)
  ])
)

/** A trailing Roman rank, stripped for DISPLAY (spellCanonKey does the same, lowercased). */
const RANK_TAIL_RE = / (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/

/**
 * The classes that can cast `spell`. spells.json FIRST (it is the authority on anything that
 * has a spell page, and its class list is per-rank-family), then the ability table. Never a
 * union: where both know a name they agree, and where they disagree the spell page wins.
 */
function castCandidates(spell: string): ClassAbbr[] {
  const fromDb = classesForSpell(spell)
  if (fromDb.length > 0) return fromDb
  return ABILITIES.get(spellCanonKey(spell)) ?? []
}

/** One observation, or null when the event says nothing about class. */
function make(
  ev: LogEvent,
  source: ClassObservation['source'],
  label: string,
  candidates: ClassAbbr[]
): ClassObservation | null {
  if (candidates.length === 0) return null
  return {
    ts: ev.ts,
    seq: ev.seq,
    source,
    label,
    candidates: [...new Set(candidates)].sort(),
    weight: SOURCE_WEIGHT[source]
  }
}

/**
 * Turn one event into class evidence.
 *
 * `lastItemActivateTs` is the timestamp of the most recent `itemActivate` (null if none yet) —
 * the ONLY context this function needs, and the reason it can stay pure. A castBegin inside the
 * suppression window returns null: not "weak evidence", NO evidence. An item's spell says
 * nothing whatsoever about what the wearer's classes are.
 */
export function classObservation(
  ev: LogEvent,
  lastItemActivateTs: number | null
): ClassObservation | null {
  switch (ev.kind) {
    case 'selfWho':
      return make(ev, 'who', 'who', ev.classes.filter(isClassAbbr))
    case 'stanceChange':
      return make(ev, 'stance', ev.stance, abbrs(STANCES[ev.stance]))
    case 'invocationChange':
      return make(ev, 'invocation', ev.invocation, abbrs(INVOCATIONS[ev.invocation]))
    case 'skillUp':
      // `skills` ONLY — see the header. An unlisted skill (every `Specialize <school>`, which
      // the wiki carries as one "Specialization" row) yields nothing rather than a guess.
      return make(ev, 'skillUp', ev.skill, abbrs(SKILLS[ev.skill]))
    case 'poisonCoat':
      // eqlwiki Disciplines: "only Rogue poison disciplines are on Legends". Somebody ELSE's
      // blades (the third-person shapes) say nothing about this character.
      return ev.who === 'you' ? make(ev, 'poisonCoat', ev.poison, ['ROG']) : null
    case 'castBegin': {
      if (lastItemActivateTs !== null && ev.ts - lastItemActivateTs <= CLICKY_SUPPRESSION_MS) {
        return null
      }
      return make(ev, 'cast', ev.spell.replace(RANK_TAIL_RE, '').trim(), castCandidates(ev.spell))
    }
    default:
      return null
  }
}
