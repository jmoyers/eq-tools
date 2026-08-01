import { readFile } from 'fs/promises'
import { parseLine } from './parse'
import { newLogState, processLine } from './process'
import type { AAEvent, AASpendEvent, KillMap, LevelEvent, LootEvent, TurnInEvent } from '../../shared/types'

export interface ScanResult {
  loot: LootEvent[]
  turnIns: TurnInEvent[]
  kills: KillMap
  levels: LevelEvent[]
  aas: AAEvent[]
  aaSpends: AASpendEvent[]
}

function recordKill(kills: KillMap, mob: string, tier: number, ts: number): void {
  const k = (kills[mob] ??= { count: 0, bestTier: 0, firstTs: 0, lastTs: 0 })
  k.count += 1
  k.bestTier = Math.max(k.bestTier, tier)
  k.firstTs = k.firstTs ? Math.min(k.firstTs, ts) : ts
  k.lastTs = Math.max(k.lastTs, ts)
}

/**
 * Scan the entire log once and extract loot (with source mob + zone), quest
 * turn-ins, kills (with best instance tier, for drop rates + boss progress), and
 * level-ups. Log parsing is the default count source — more reliable than an
 * inventory dump when items sit in an un-exported bank (e.g. the Dragonhoard).
 */
export async function scanLog(logPath: string): Promise<ScanResult> {
  let text: string
  try {
    text = await readFile(logPath, 'utf8')
  } catch {
    return { loot: [], turnIns: [], kills: {}, levels: [], aas: [], aaSpends: [] }
  }

  const loot: LootEvent[] = []
  const turnIns: TurnInEvent[] = []
  const kills: KillMap = {}
  const levels: LevelEvent[] = []
  const aas: AAEvent[] = []
  const aaSpends: AASpendEvent[] = []
  const state = newLogState()

  for (const raw of text.split(/\r?\n/)) {
    // cheap pre-filter before the regex dispatch
    if (
      !raw.includes('looted') &&
      !raw.includes('entered') &&
      !raw.includes('slain') &&
      !raw.includes('offered') &&
      !raw.includes('complete the trade') &&
      !raw.includes('gained a level') &&
      !raw.includes('ability point')
    ) {
      continue
    }
    const line = parseLine(raw)
    if (!line) continue
    processLine(line, state, {
      onLoot: (e) => loot.push(e),
      onTurnIn: (e) => turnIns.push(e),
      onKill: (mob, tier, ts) => recordKill(kills, mob, tier, ts),
      onLevelUp: (level, ts) => levels.push({ ts, level }),
      onAA: (amount, nowHave, ts) => aas.push({ ts, amount, nowHave }),
      onAASpend: (ability, cost, ts) => aaSpends.push({ ts, ability, cost })
    })
  }

  return { loot, turnIns, kills, levels, aas, aaSpends }
}
