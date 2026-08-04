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

/**
 * ONE FIRING CAN PRINT TWO LINES, and counting both is how a tap lane starts reporting double.
 *
 * `Lifetap Strike` fires once and the game prints `You hit <mob> … by Lifetap Strike.` AND
 * `You healed Primitive for N hit points by Lifetap Strike.` — two events, one proc. A single
 * `count` bumped from both ingest paths read 24 for w39's twelve firings (the defect wave 2
 * pinned with a deliberate warning assertion).
 *
 * So the two sides are counted SEPARATELY and the lane's count is `max` of them, never the sum:
 *   - a damage-only proc (Smiting Strike) counts its damage lines,
 *   - a heal-only proc (Center, delivered inside a Quick Buff burst) still counts once,
 *   - a tap that prints both counts each firing exactly once.
 * `max` and not `damageHits` alone precisely because of the third case above and because a tick
 * can print no heal line at all (w41's Blood Siphon: 14 ticks, 13 heals) — the larger side is
 * the number of firings we actually observed.
 */
export interface LaneSides {
  /** Firings that printed a DAMAGE line. */
  damage: number
  /** Firings that printed a HEAL line. */
  heal: number
}

/** One accumulated proc lane of `origin: 'spell'`: exact counts and the damage/healing those
 *  lines carried. Keyed by `spellCanonKey`, displayed by the raw name we first saw. */
export interface SpellProcLane {
  name: string
  /** Firings, split by which line carried them — see LaneSides. */
  hits: LaneSides
  damage: number
  heal: number
  /**
   * THE PER-STATE FIRING SPLIT (proc-analytics §2.1 `ProcLink`), folded on INGEST because it can never be
   * folded later: the encounter event ring is capped, truncated on finalize, and absent
   * ENTIRELY for zone sessions, so a link derived from it would be silently wrong exactly where
   * the sample is biggest.
   *
   * `<kind>:<key>` (stateKeyOf) → the firings observed while that state was open, split by side
   * under the same rule the lane's own count uses. States OVERLAP, so these never sum to the
   * lane count and are not meant to: each entry answers one question, "how many of this lane's
   * firings happened with X on".
   */
  byState: Map<string, LaneSides>
}

/** Firings on a side pair: `max`, never the sum — see LaneSides. */
export function sidesCount(s: LaneSides | undefined): number {
  return s ? Math.max(s.damage, s.heal) : 0
}

/** One lane's firings, the number every rate and every link is built from. */
export function laneCount(l: SpellProcLane): number {
  return sidesCount(l.hits)
}

/** Everything one detected proc contributes. An args object: five positional parameters would
 *  blow `max-params`, and the active set is not optional — a firing with no state open folds an
 *  EMPTY set, which is a real observation ("nothing was on"), not a missing argument. */
export interface SpellProcFold {
  spell: string
  amount: number
  isHeal: boolean
  /** `<kind>:<key>` of every state open at the firing instant (StateTimeline.active). */
  active: ReadonlySet<string>
}

/** Fold one detected proc into a lane map. `amount` lands in `damage` or `heal` per `isHeal`;
 *  a proc that carries neither (none exist today) still counts, because the COUNT is the
 *  measurement and the amount is the annotation. */
export function addSpellProc(lanes: Map<string, SpellProcLane>, f: SpellProcFold): void {
  const key = spellCanonKey(f.spell)
  const lane = lanes.get(key) ?? {
    name: f.spell,
    hits: { damage: 0, heal: 0 },
    damage: 0,
    heal: 0,
    byState: new Map<string, LaneSides>()
  }
  bumpSide(lane.hits, f.isHeal)
  if (f.isHeal) lane.heal += f.amount
  else lane.damage += f.amount
  for (const stateKey of f.active) {
    const sides = lane.byState.get(stateKey) ?? { damage: 0, heal: 0 }
    bumpSide(sides, f.isHeal)
    lane.byState.set(stateKey, sides)
  }
  lanes.set(key, lane)
}

function bumpSide(s: LaneSides, isHeal: boolean): void {
  if (isHeal) s.heal++
  else s.damage++
}
