import { readFile } from 'fs/promises'
import { parseLine, matchLoot } from './parse'
import type { LootEvent } from '../../shared/types'

/**
 * Scan the entire log file once and return every self-loot event, oldest first.
 * This gives a complete "what have I ever picked up" record from the log — more
 * reliable than an inventory dump when items may sit in an un-exported bank
 * (e.g. the Dragonhoard), which is why log parsing is the default count source.
 */
export async function scanLootHistory(logPath: string): Promise<LootEvent[]> {
  let text: string
  try {
    text = await readFile(logPath, 'utf8')
  } catch {
    return []
  }
  const events: LootEvent[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.includes('looted')) continue // cheap pre-filter before regex
    const line = parseLine(raw)
    if (!line) continue
    const loot = matchLoot(line)
    if (loot) events.push(loot)
  }
  return events
}
