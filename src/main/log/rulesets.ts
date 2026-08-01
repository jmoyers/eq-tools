import {
  matchAA,
  matchAASpend,
  matchKill,
  matchLevelUp,
  matchLoot,
  matchOffer,
  matchTradeComplete,
  matchZone
} from './parse'
import { DEFAULT_PROFILE } from '../../shared/profiles'
import type { LogLine, LootEvent } from '../../shared/types'

/**
 * A per-profile set of log-parsing rules. EQ servers/emulators can differ in how
 * loot, zones, kills, and trades appear in the log, so parsing is looked up by
 * profile. Add a new ruleset when adding a server whose log format differs.
 */
export interface LogRuleset {
  id: string
  matchLoot(line: LogLine): LootEvent | null
  matchZone(line: LogLine): string | null
  matchKill(line: LogLine): string | null
  matchOffer(line: LogLine): { item: string; npc: string } | null
  matchTradeComplete(line: LogLine): string | null
  matchLevelUp(line: LogLine): number | null
  matchAA(line: LogLine): { amount: number; nowHave: number } | null
  matchAASpend(line: LogLine): { ability: string; cost: number } | null
}

const classic: LogRuleset = {
  id: 'classic',
  matchLoot,
  matchZone,
  matchKill,
  matchOffer,
  matchTradeComplete,
  matchLevelUp,
  matchAA,
  matchAASpend
}

export const RULESETS: Record<string, LogRuleset> = {
  eqlegends: classic,
  p99: classic // classic format; refine if P99 differs
}

export function getRuleset(profileId: string = DEFAULT_PROFILE): LogRuleset {
  return RULESETS[profileId] ?? classic
}
