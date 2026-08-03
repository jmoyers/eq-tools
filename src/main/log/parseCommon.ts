// Shared vocabulary for the parse cascade (see parser.ts).
//
// The single parse pass is a CASCADE of per-family classifiers whose ORDER IS SEMANTIC
// (e.g. the resist family must test the possessive-YOUR form before the named-caster form
// because 712 spell names contain `'s`). Each classifier is a pure
// `(ClassifyCtx) => LogEvent | null`; parser.ts holds the one ordered list and runs it.
// This module carries the pieces every family needs: the context envelope and the
// name-normalization helpers (moved here verbatim from combat/parse.ts by way of parser.ts).

import type { LogEvent } from '../../shared/logEvents'
import type { ParserConfig } from './rulesets'

/**
 * One log line, pre-split, plus the profile's parser config — the argument every
 * classifier takes. `text` is the message with the `[timestamp] ` prefix removed.
 */
export interface ClassifyCtx {
  readonly text: string
  readonly ts: number
  readonly seq: number
  readonly raw: string
  readonly cfg: ParserConfig
}

/** A single line-family matcher: returns its event, or null to let the cascade continue. */
export type Classifier = (c: ClassifyCtx) => LogEvent | null

export function norm(name: string): string {
  const n = name.trim()
  const l = n.toLowerCase()
  if (l === 'you' || l === 'yourself' || l === 'your') return 'You'
  return n
}

/**
 * Canonical identity key for an entity name. EQ writes the same mob with
 * different casing (charm lines lowercase the article, damage lines capitalize
 * it); keying state by this lowercased form makes lookups case-stable. 'You'
 * stays special. (Re-exported here so consumers no longer import combat/parse.)
 */
export function idKey(name: string): string {
  const n = name.trim().toLowerCase()
  if (n === 'you' || n === 'yourself' || n === 'your') return 'you'
  return n
}

/**
 * Canonical SPELL key (Task #33): lowercase, trimmed, with a trailing rank token
 * stripped. EQ Legends suffixes current-session casts with a Roman-numeral RANK —
 * "You begin casting Swift Like the Wind I." / "Shiftless Deeds IV" / "Allure VI" —
 * but EVERY fade/fizzle/interrupt line DROPS the rank ("Your Swift Like the Wind spell
 * has worn off …", "Your Shiftless Deeds spell fizzles!"). Keying the buffs model by
 * the raw name breaks cast↔fade pairing (2,507/12,442 casts carry a rank tail).
 *
 * The stripped token is a trailing I–X Roman numeral at the END of the name only,
 * word-bounded. VERIFIED SAFE against the real log (2026-08-01): NO fade/fizzle/
 * interrupt line ever ends in a Roman numeral, and every one of the 16 distinct
 * rank-tailed base spells (Swift Like the Wind, Shiftless Deeds, Allure, Clarity,
 * Superior Healing, Lay on Hands, …) is a real spell whose identity does not include a
 * Roman-numeral word — so stripping the tail can never merge two genuinely-different
 * spells. The DISPLAY name keeps its suffix (callers pass the raw spell for display);
 * only the KEY is canonicalized.
 */
const RANK_TAIL_RE = / (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/
export function spellCanonKey(spell: string): string {
  return spell.trim().replace(RANK_TAIL_RE, '').trim().toLowerCase()
}

export function cleanMob(s?: string): string | undefined {
  if (!s) return undefined
  return s.replace(/['`’]s$/i, '').trim() || undefined
}

/** True if a line looks like damage but we couldn't classify it (for the miss log). */
export function looksDamage(text: string): boolean {
  return /\bfor \d+ points? of|\bhas taken \d+ damage/.test(text)
}
