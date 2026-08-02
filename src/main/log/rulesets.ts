import { DEFAULT_PROFILE } from '../../shared/profiles'
import type { SpellDb } from '../data/spellDb'

/**
 * Per-profile parser configuration. Different EQ servers/emulators can differ in
 * log wording, so the single parse pass (see parser.ts) is parameterized by a
 * config looked up per profile. Today the only genuine per-profile knob is the
 * charm-spell stem set (which "worn off" lines count as un-charm vs MEZ); the bulk
 * of the grammar is shared "classic" EQ. Add fields here as real divergences show
 * up rather than forking whole regex batteries.
 */
export interface ParserConfig {
  id: string
  /**
   * Optional injected spell database (Task #34). When present, the parser emits PRECISE,
   * message-driven buffApply / buffWearOff events by matching a line against the DB's
   * cast-on-you / cast-on-other / wears-off message tables. Injected at main startup via
   * installSpellDb(); ABSENT by default so parser purity holds — a profile with no DB
   * installed emits none of the new events and behaves exactly as before. This is the
   * ruleset/config injection path the buffs DB uses (never a direct module import in the
   * parser).
   */
  spellDb?: SpellDb
  /**
   * Matches the spell name from "Your <spell> spell has worn off of <mob>." to
   * decide whether it un-charms a pet. True charm spells only — MEZ spells also
   * wear off but must NOT uncharm. Stems audited against real worn-off lines.
   */
  charmSpell: RegExp
  /**
   * Matches the spell name from "Your <spell> spell has worn off of <mob>." to
   * decide whether it is a CROWD-CONTROL (mez/root) spell — as opposed to a charm
   * spell (handled by charmSpell) or an unrelated buff/debuff. A CC spell wearing
   * off means the mob was mez'd/rooted right up to that moment, so the engine treats
   * it as a keep-alive CC refresh. Stems audited against real worn-off lines:
   * Mesmerization/Mesmerize/Enthrall/Entrance/Dazzle (mez), Largo's Melodic Binding
   * & Screaming Terror (bard/enchanter mez), Ensnare/Immobilize/Suffocate (root).
   * Deliberately EXCLUDES pacify/lull/calm (aggro-reduction, not a hold).
   */
  ccSpell: RegExp
}

const classic: ParserConfig = {
  id: 'classic',
  charmSpell: /\bcharm\b|beguile|allure|cajol|dictate|besiege|agacerie|beckon|command of druzzil|dominate|boltran/i,
  ccSpell: /mesmeriz|enthrall|entranc|dazzle|largo's melodic binding|screaming terror|ensnar|immobiliz|suffocat/i
}

export const PARSER_CONFIGS: Record<string, ParserConfig> = {
  eqlegends: classic,
  p99: classic // classic format; refine if P99 diverges
}

export function getParserConfig(profileId: string = DEFAULT_PROFILE): ParserConfig {
  return PARSER_CONFIGS[profileId] ?? classic
}

/**
 * Inject a spell database into a profile's parser config (Task #34), enabling the
 * message-driven buffApply / buffWearOff events. Called once at main startup after the DB
 * is loaded. Applies to ALL configs by default (they share the same message grammar); pass
 * a profileId to scope it. Idempotent — re-installing replaces the DB.
 */
export function installSpellDb(db: SpellDb | undefined, profileId?: string): void {
  if (profileId) {
    const cfg = PARSER_CONFIGS[profileId]
    if (cfg) cfg.spellDb = db
    return
  }
  for (const cfg of Object.values(PARSER_CONFIGS)) cfg.spellDb = db
  classic.spellDb = db
}
