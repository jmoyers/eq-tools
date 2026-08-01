import { matchLoot as classicMatchLoot } from './parse'
import { DEFAULT_PROFILE } from '../../shared/profiles'
import type { LogLine, LootEvent } from '../../shared/types'

/**
 * A per-profile set of log-parsing rules. EQ servers/emulators can differ in how
 * loot, combat, etc. appear in the log, so parsing is looked up by profile. Add a
 * new ruleset here when adding a server whose log format differs.
 */
export interface LogRuleset {
  id: string
  matchLoot(line: LogLine): LootEvent | null
}

const classic: LogRuleset = { id: 'classic', matchLoot: classicMatchLoot }

export const RULESETS: Record<string, LogRuleset> = {
  eqlegends: classic,
  p99: classic // classic format; refine if P99 differs
}

export function getRuleset(profileId: string = DEFAULT_PROFILE): LogRuleset {
  return RULESETS[profileId] ?? classic
}
