import type { CountSource, PoskyQuest } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'
import { questKey } from '../posky/keys'

export interface InventoryRow {
  key: string
  name: string
  /** times looted (from the log) */
  log: number
  /** count in the inventory export */
  inv: number
  /** base held per the active count source */
  base: number
  /** consumed by turned-in quests */
  consumed: number
  /** net available after turn-ins */
  net: number
  /** names of completed quests that consumed this item */
  consumedBy: string[]
}

export interface ReconcileInput {
  /** loot counts keyed by lowercased item name */
  log: Record<string, number>
  /** inventory-export counts keyed by lowercased item name */
  inv: Record<string, number>
  /** display names keyed by lowercased item name (from loot events) */
  lootNames: Record<string, string>
  countSource: CountSource
  completedKeys: string[]
  quests: PoskyQuest[]
}

export interface ReconcileResult {
  rows: InventoryRow[]
  /** net held counts (base minus turn-in consumption), keyed lowercased */
  net: Record<string, number>
}

/**
 * Reconcile held items from the loot log and the inventory export, then subtract
 * everything consumed by quests the user has marked as turned in — so a drop that
 * was handed in for one quest no longer counts toward another quest that needs it.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { log, inv, lootNames, countSource, completedKeys, quests } = input
  const completed = new Set(completedKeys)

  const nameByKey: Record<string, string> = { ...lootNames }

  // Re-key the inventory-export counts onto the normalized counting key so a
  // `Sphinx Claw +1` in the export pools with a base `Sphinx Claw` (Task #42). The
  // `log` map arrives already normalized (useProgress.logCounts), but the raw
  // inventory export names do not, so fold them here (summing collisions).
  const invByKey: Record<string, number> = {}
  for (const [rawK, n] of Object.entries(inv)) {
    const k = itemCountKey(rawK)
    invByKey[k] = (invByKey[k] ?? 0) + n
    nameByKey[k] ??= rawK
  }

  // base held per the active source
  const base: Record<string, number> = {}
  const keysUnion = new Set([...Object.keys(log), ...Object.keys(invByKey)])
  for (const k of keysUnion) {
    const l = log[k] ?? 0
    const i = invByKey[k] ?? 0
    base[k] = countSource === 'log' ? l : countSource === 'inventory' ? i : Math.max(l, i)
  }

  // consumption from turned-in quests
  const consumed: Record<string, number> = {}
  const consumedBy: Record<string, string[]> = {}
  for (const q of quests) {
    if (!completed.has(questKey(q))) continue
    for (const it of q.items) {
      const k = itemCountKey(it.name)
      const need = it.count > 0 ? it.count : 1
      consumed[k] = (consumed[k] ?? 0) + need
      ;(consumedBy[k] ??= []).push(q.name)
      nameByKey[k] ??= it.name
    }
  }

  const net: Record<string, number> = {}
  const allKeys = new Set([...Object.keys(base), ...Object.keys(consumed)])
  const rows: InventoryRow[] = []
  for (const k of allKeys) {
    const b = base[k] ?? 0
    const c = consumed[k] ?? 0
    const n = Math.max(0, b - c)
    net[k] = n
    if (b === 0 && c === 0) continue
    rows.push({
      key: k,
      name: nameByKey[k] ?? k,
      log: log[k] ?? 0,
      inv: invByKey[k] ?? 0,
      base: b,
      consumed: c,
      net: n,
      consumedBy: consumedBy[k] ?? []
    })
  }
  rows.sort((a, b) => b.net - a.net || a.name.localeCompare(b.name))
  return { rows, net }
}
