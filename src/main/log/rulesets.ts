import { DEFAULT_PROFILE } from '../../shared/profiles'

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
