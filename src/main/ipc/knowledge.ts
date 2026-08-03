// IPC: the reference-data lookups — spells, items, mobs. All cache-first and local-first in
// main, none of them ever reject: a failed fetch degrades to a cached/negative record so the
// renderer is never left hanging.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { buildSpellCatalog } from '../data/spellDb'
import { lookupItem } from '../itemLookup'
import { lookupMob } from '../mobLookup'
import { registry, spellDb } from '../pipeline'
import type { BuffsSnap } from '../../shared/types'

export function registerKnowledgeIpc(): void {
  // ---- suggested-alerts wizard (Task #38) ----
  // Return the slim, searchable spell catalog: the effective DB (spells.json + overlay
  // corrections applied at startup) joined with live per-spell usage read straight off the
  // buffs module's snapshot stats (`n` = observed land→fade samples). Read-only w.r.t. the
  // buffs module — we never mutate it.
  ipcMain.handle(IPC.spellsCatalog, () => {
    const usage = new Map<string, number>()
    const lastSeen = new Map<string, number>()
    const snap = registry.get('buffs')?.snapshot()?.state as BuffsSnap | undefined
    if (snap)
      for (const [key, stat] of Object.entries(snap.stats)) {
        usage.set(key, stat.n)
        if (stat.lastSeenMs != null) lastSeen.set(key, stat.lastSeenMs)
      }
    return buildSpellCatalog(spellDb, usage, lastSeen)
  })

  // ---- item knowledge ("what's this lore/quest item for", Task #53) ----
  // Local posky-first, then a cached, politely-throttled wiki lookup. lookupItem never
  // rejects (degrades to a cached negative/offline record that still carries local posky
  // associations), so a failure here never leaves the renderer hanging.
  ipcMain.handle(IPC.itemsLookup, (_e, name: string) => lookupItem(name))
  // Mob knowledge (Task #63) — "what does this thing drop". Cache-first + local-first in main,
  // so the hover card is usually answered without touching the network. Never rejects.
  ipcMain.handle(IPC.mobsLookup, (_e, name: string) => lookupMob(name))
}
