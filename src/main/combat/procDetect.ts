// PROC DETECTION (docs/plans/proc-analytics.md §4.1) — "a spell effect line with no own cast
// line behind it".
//
// THE ONE INFERENCE IN THIS FEATURE, and it is labeled as one everywhere it surfaces. The log
// prints `You begin casting <Spell>.` for every hand-cast the player makes, and prints
// NOTHING at all when a weapon, a buff-granted melee proc or the Spellblade invocation fires
// the same spell. So a spell effect with no own cast behind it, inside a stated window, is a
// proc — and the inference may name a CO-OCCURRENCE, never a source (a proc line in this log
// says nothing about which weapon, buff or AA produced it).
//
// THE WINDOW IS MEASURED, NOT GUESSED. At 12 seconds the real log's partition is clean
// (read-only sweep, rank-normalized names): every pure proc scores cast = 0
// (`Smiting Strike` 9,633 / `Lifetap Strike` 1,814 / `Condemnation of Nife` 1,096 /
// `Vampiric Embrace` 586 / `Ignite` 148 / `Dismiss Summoned` 23 / `Asp Venom Strike` 15) and
// every hand-cast nuke scores proc = 0 (`Chaotic Feedback` 893, `Sanity Warp` 502, `Anarchy`
// 112, `Strike` 90). The residual mixed lanes — `Discordant Mind` (352/352) and `Siphon Life`
// (293/293) — are GENUINELY mixed: they are the player's gem-#1 spells, and every cast-less
// firing of either happened while the `spellblade` invocation was active.
//
// THE DoT GATE IS LOAD-BEARING. A DoT tick arriving more than 12 seconds after its cast would
// misclassify as a proc by construction — its ticks are cast-DETACHED. So detection is gated
// to `dtype === 'spell'` and to heals; `dot` is NEVER eligible, and `melee`/`ds` are not spell
// effects at all. (Slay Undead procs are counted from the taxonomy's own `slay` category, not
// from here — they carry no spell line.)

import { spellCanonKey } from '../log/parseCommon'
import type { DamageType } from '../../shared/combat'

/**
 * The cast-attribution window. See the file header for the measurement that fixes it at 12s;
 * do not change it without re-running that partition against the real log.
 */
export const PROC_CAST_WINDOW_MS = 12_000

/** Memory bound on the recent-cast map. Entries older than the window are pruned on write;
 *  this is the belt-and-braces cap for a pathological burst of distinct spell names. */
export const RECENT_CAST_CAP = 512

/** Rank-normalized recent own-casts: `spellCanonKey(spell)` → ts of the last `castBegin`. */
export type RecentCasts = Map<string, number>

/**
 * Record an own-cast (`You begin casting <Spell>.` / `You begin singing <Song>.`). Only the
 * PLAYER's casts produce that line, which is exactly the gate this detector needs — a mob's
 * or another player's cast of the same spell never suppresses one of our procs, because it
 * never enters this map.
 *
 * Rank-normalized via the repo's existing `spellCanonKey`: casts print `Swift Like the Wind I`
 * while effect lines are rank-less (law 2, at the COUNTING boundary).
 */
export function noteCast(recent: RecentCasts, spell: string, ts: number): void {
  recent.set(spellCanonKey(spell), ts)
  if (recent.size > RECENT_CAST_CAP) pruneCasts(recent, ts)
}

/** Drop cast records that can no longer suppress anything. */
export function pruneCasts(recent: RecentCasts, now: number): void {
  for (const [key, ts] of recent) {
    if (now - ts > PROC_CAST_WINDOW_MS) recent.delete(key)
  }
}

/**
 * True when `spell` had NO own cast behind it within the window — i.e. it procced.
 *
 * A cast in the FUTURE relative to this line (possible only on an out-of-order replay) is
 * treated as no cast at all: the window is `0 <= ts - castTs <= PROC_CAST_WINDOW_MS`, so the
 * test can never be satisfied by a cast that had not happened yet.
 */
export function isCastless(recent: RecentCasts, spell: string, ts: number): boolean {
  const castTs = recent.get(spellCanonKey(spell))
  if (castTs === undefined) return true
  const age = ts - castTs
  return age < 0 || age > PROC_CAST_WINDOW_MS
}

/**
 * Damage types eligible for cast-less detection. `spell` ONLY — see the DoT gate in the file
 * header. Expressed as a function rather than a Set so the exclusion reads as a rule with a
 * reason attached, not as a list somebody can extend without noticing what it costs.
 */
export function procEligibleDamage(dtype: DamageType): boolean {
  return dtype === 'spell'
}

/** One accumulated proc lane of `origin: 'spell'`: exact counts and the damage/healing those
 *  lines carried. Keyed by `spellCanonKey`, displayed by the raw name we first saw. */
export interface SpellProcLane {
  name: string
  count: number
  damage: number
  heal: number
}

/** Fold one detected proc into a lane map. `amount` lands in `damage` or `heal` per `isHeal`;
 *  a proc that carries neither (none exist today) still counts, because the COUNT is the
 *  measurement and the amount is the annotation. */
export function addSpellProc(
  lanes: Map<string, SpellProcLane>,
  spell: string,
  amount: number,
  isHeal: boolean
): void {
  const key = spellCanonKey(spell)
  const lane = lanes.get(key) ?? { name: spell, count: 0, damage: 0, heal: 0 }
  lane.count++
  if (isHeal) lane.heal += amount
  else lane.damage += amount
  lanes.set(key, lane)
}
