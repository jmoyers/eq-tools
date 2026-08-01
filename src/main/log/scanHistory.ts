import { readFile } from 'fs/promises'
import { parseLine } from './parse'
import { newLogState, processLine } from './process'
import type { KillCounts, LootEvent, TurnInEvent } from '../../shared/types'

export interface ScanResult {
  loot: LootEvent[]
  turnIns: TurnInEvent[]
  kills: KillCounts
}

/**
 * Scan the entire log once and extract loot (with source mob + zone), quest
 * turn-ins, and kill counts. Loot parsing from the full log is the default count
 * source — more reliable than an inventory dump when items sit in an un-exported
 * bank (e.g. the Dragonhoard).
 */
export async function scanLog(logPath: string): Promise<ScanResult> {
  let text: string
  try {
    text = await readFile(logPath, 'utf8')
  } catch {
    return { loot: [], turnIns: [], kills: {} }
  }

  const loot: LootEvent[] = []
  const turnIns: TurnInEvent[] = []
  const kills: KillCounts = {}
  const state = newLogState()

  for (const raw of text.split(/\r?\n/)) {
    // cheap pre-filter before the regex dispatch
    if (
      !raw.includes('looted') &&
      !raw.includes('entered') &&
      !raw.includes('slain') &&
      !raw.includes('offered') &&
      !raw.includes('complete the trade')
    ) {
      continue
    }
    const line = parseLine(raw)
    if (!line) continue
    processLine(line, state, {
      onLoot: (e) => loot.push(e),
      onTurnIn: (e) => turnIns.push(e),
      onKill: (mob) => {
        kills[mob] = (kills[mob] ?? 0) + 1
      }
    })
  }

  return { loot, turnIns, kills }
}
