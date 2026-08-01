import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { EQ_ROOT } from '../log/config'
import type { HeldCounts } from '../../shared/types'

/**
 * EQ's `/outputfile inventory` writes a tab-separated file named
 * "<Character>-Inventory.txt" with a header row:
 *   Location \t Name \t ID \t Count \t Slots
 * Rows include equipped, general inventory, and bank contents.
 */
export function parseInventoryText(text: string): HeldCounts {
  const counts: HeldCounts = {}
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    if (cols.length < 4) continue
    const location = cols[0].trim()
    const name = cols[1].trim()
    if (location === 'Location' || name === 'Name') continue // header
    if (!name || name === 'Empty') continue
    const count = Number.parseInt(cols[3], 10)
    const n = Number.isFinite(count) && count > 0 ? count : 1
    const key = name.toLowerCase()
    counts[key] = (counts[key] ?? 0) + n
  }
  return counts
}

export interface InventoryLoadResult {
  path: string
  counts: HeldCounts
  loadedAt: string
}

/** Find the newest "*-Inventory.txt" for the given character (or any). */
export function findInventoryFile(characterName?: string): string | null {
  if (!existsSync(EQ_ROOT)) return null
  const preferred = characterName ? `${characterName}-Inventory.txt`.toLowerCase() : null

  const files = readdirSync(EQ_ROOT)
    .filter((f) => /-Inventory\.txt$/i.test(f))
    .map((f) => ({ f, full: join(EQ_ROOT, f), mtime: statSync(join(EQ_ROOT, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)

  if (files.length === 0) return null
  if (preferred) {
    const match = files.find((x) => x.f.toLowerCase() === preferred)
    if (match) return match.full
  }
  return files[0].full
}

export function loadInventory(characterName?: string): InventoryLoadResult | null {
  const path = findInventoryFile(characterName)
  if (!path) return null
  const counts = parseInventoryText(readFileSync(path, 'utf8'))
  return { path, counts, loadedAt: new Date(statSync(path).mtimeMs).toISOString() }
}
