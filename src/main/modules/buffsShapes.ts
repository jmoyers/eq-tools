// Shared vocabulary of the buffs model (see buffs.ts for the model itself): the tuning
// constants every part of it is calibrated against, the instance/cast record shapes, and
// the pure helpers (key canonicalization, percentile, landing-message shape test). Nothing
// here holds state, so it is safe to import from any of the buffs modules.

import { spellCanonKey } from '../log/parser'
import type { EntityDisposition } from '../combat/entityRules'

/** Land a pending cast this many ms after castBegin if nothing cleared it first. */
export const LAND_TIMEOUT_MS = 15_000

/**
 * Sanity ceiling on a mined duration sample. No EQ Legends buff lasts anywhere near this
 * long. A land→fade gap beyond this is DEFINITIONALLY a missed censor and is DROPPED.
 */
export const MAX_SAMPLE_MS = 3 * 60 * 60_000 // 3 hours

/**
 * Session-gap boundary (Task #33, finding #5). An event-time gap ≥ this = logout/AFK past
 * any buff duration → ALL actives cleared + open casts censored + pets retired.
 */
export const SESSION_GAP_MS = 30 * 60_000 // 30 minutes

/** Active-buff HYGIENE cap (Task #33, finding #6). An active past this auto-retires. */
const HYGIENE_ABSOLUTE_MS = 90 * 60_000 // 90 minutes when no/low stats
export function hygieneCapMs(p75: number | null, n: number): number {
  const stat = p75 != null && n >= 2 ? 2 * p75 : 0
  return Math.max(stat, HYGIENE_ABSOLUTE_MS)
}

/** Window after a castBegin within which a landing emote is attributed to that cast. */
export const EMOTE_WINDOW_MS = 5_000
/** How many times an emote TEXT must appear adjacent to a cast before it's TRUSTED. */
export const EMOTE_MIN_OBSERVATIONS = 2

/** Recency-weighted MAX window (Task #34): estimate = MAX over the most recent K samples. */
export const RECENT_SAMPLE_WINDOW = 5

/** The activated-AA name whose burst of self-buff landing messages is trusted confident. */
export const QUICK_BUFF = 'quick buff'
/** How long after a Quick Buff activation its burst applies are attributed to it. */
export const QUICK_BUFF_WINDOW_MS = 5_000

/**
 * OWN-CAST landing window (Task #45). A message-driven apply (buffApply) is attributed to the
 * player only when their OWN castBegin of that spell landed within this window before the
 * emote — mirrors the emote-mining window. Cast times run up to ~8s (Swift is 8s) plus the
 * short travel to the landing line, so a slightly generous window avoids dropping real
 * self/pet casts while still rejecting a stranger's buff (no own castBegin at all).
 */
export const OWN_CAST_WINDOW_MS = 10_000

/** The AA that makes self-cast illusion buffs PERMANENT (Task #34). */
export const PERMANENT_ILLUSION = 'permanent illusion'

/** The sentinel entity key for a buff on the PLAYER. */
export const SELF_KEY = 'self'
/** Instance-key separator  a NUL, which can never appear in a spell/entity name. */
const SEP = String.fromCharCode(0)

/** The instance key for a (spell, entity) pair — the buff-instance identity (Task #35). */
export function instanceKey(spellKeyOf: string, entityKey: string): string {
  return spellKeyOf + SEP + entityKey
}

/** Extract the entity key from an instance key. */
export function instanceEntityKey(iKey: string): string {
  const i = iKey.indexOf(SEP)
  return i >= 0 ? iKey.slice(i + 1) : SELF_KEY
}

/** A cast that has landed (produced a buff instance) and is awaiting its next fade. */
export interface OpenCast {
  spell: string
  /** rank-stripped spell key. */
  spellKey: string
  /** the entity this instance is on ('self' or a canonical name key). */
  entityKey: string
  landedTs: number
  /** The entity disposition this cast is bound to (for censoring on zone/death). */
  disp: EntityDisposition
  /**
   * True once an `offlineGap` has passed over this open cast. The instance SURVIVES (EQ
   * saves buffs across a camp and resumes their timers on login — measured, see
   * BuffInstances.onOfflineGap), but its eventual land→fade span is no longer a clean
   * observation of the spell's duration: it is stretched by an absence we only know to
   * within ~30s. Such a sample is CENSORED rather than corrected — world-model law 5's
   * recency-weighted MAX is chosen precisely because it is sensitive to over-long samples,
   * and our offline estimate is a lower bound, so any correction would bias the MAX upward.
   */
  spannedGap?: boolean
}

/** A cast in flight (You begin casting …) not yet landed/cleared. */
export interface Pending {
  spell: string
  key: string
  beganTs: number
  /** Refresh whose new startedTs is staged until confirmation (per matching instance). */
  stagedRefresh: boolean
  /** The landing emote's subject key ('self' or a name key), once its text is recognized. */
  emoteSubjectKey?: string
}

/** Per-spell accumulated duration samples + display name. */
export interface SpellSamples {
  spell: string
  samples: number[]
}

/** Canonical spell key (case-stable, RANK-STRIPPED). */
export function spellKey(s: string): string {
  return spellCanonKey(s)
}

/**
 * True when an un-catalogued line is SHAPED like a spell-landing flavor message (Task #36):
 * a short-ish sentence ending in a period, not a numeric/combat/system line. Used to feed
 * candidate landing messages the DB missed (e.g. Symbol of Pinzarn's real landing line,
 * whose wiki msg_cast_on_you is wrong) into the overlay miner. Deliberately permissive — the
 * miner's unambiguous-anchor + repeat-count rules reject coincidental pairings, so a
 * false candidate never earns a VERIFIED verdict.
 */
// Casting-system / UI feedback lines that are SELF-directed ("you"/"your") in shape but are
// never a spell-landing emote (they recur across every spell → pure noise). Rejected so a
// coincidental burst pairing can't verify them.
const CASTING_SYSTEM_RE =
  /can't use that command|regain your concentration|change your invocation|begin reciting|cannot see your target|Auto attack|mend your wounds|shimmers briefly|feels alive with power|begins casting|begin singing|You must|Insufficient|You do not|not ready yet|too far|out of range|You have entered|received any tells|cannot reply|mostly successful|has been overwritten|You forget |memoriz|You can(not| ?'?t)|Your target|Your spell|Your .* spell|You have finished|Beginning to|You are (?:no longer|now)|not enough|you cannot reply/i

/** The chat/combat/system markers that disqualify an otherwise landing-SHAPED line. */
function hasNonLandingMarker(text: string): boolean {
  if (text.includes("' told you") || text.includes(' tells ') || text.includes(' says')) return true
  if (text.includes(' by ') || text.includes(' from ')) return true
  if (text.includes(' spell ') || text.includes('attention')) return true // combat cast spam
  return CASTING_SYSTEM_RE.test(text)
}

/**
 * True when an un-catalogued line is plausibly a SELF spell-landing flavor message the DB
 * missed (Task #36) — the ONLY unknown-line class worth mining. It must be about the CASTER
 * (contain "you"/"your" or start with "You"/"Your"), a short sentence ending in a period,
 * with no numbers (damage/heal), no chat/tell/"by"/"from" markers, and not a casting-system
 * / UI line. This deliberately EXCLUDES third-person mob-subject lines ("a revenant
 * staggers.", "…spell is interrupted.") — those are combat spam that would poison the
 * overlay with coincidental burst pairings. Symbol of Pinzarn's real "The symbol of Pinzarn
 * flashes before your eyes." passes (it names "your eyes"); a mob effect line does not.
 */
export function looksLandingMessage(text: string): boolean {
  if (text.length < 6 || text.length > 90) return false
  if (!text.endsWith('.')) return false
  if (/\d/.test(text)) return false // damage/heal/point lines carry numbers
  // Must reference the caster — a genuine cast-on-YOU line is about the player.
  if (!/\byou\b|\byour\b/i.test(text)) return false
  return !hasNonLandingMarker(text)
}

export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  if (sortedAsc.length === 1) return sortedAsc[0]
  const idx = (sortedAsc.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedAsc[lo]
  const frac = idx - lo
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac
}
