// useNotablePickups (Task #53) — surface the last few looted items that are lore- or
// quest-relevant, for the "Notable pickups" strip + extending the row indicator beyond
// the local Plane of Sky set to any wiki-known quest item.
//
// Loot knowledge lives in MAIN (local-posky-first + cached wiki lookup). We can't know
// synchronously whether an arbitrary looted item is notable, so this hook lazily fetches
// knowledge for the most-recent distinct looted items (bounded), memoizes each result in
// a renderer-side map, and returns (a) that map for row indicators and (b) the ordered
// notable subset for the strip. Bounded + memoized so it never storms main: each distinct
// name is fetched at most once; main's serialized queue + persistent cache throttle the
// rest. Fully additive — no change to how loot is transported.

import { useEffect, useRef, useState } from 'react'
import type { ItemKnowledge, LootEvent } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'

/** How many most-recent distinct looted items to probe for notability. */
const PROBE_LIMIT = 40

export interface NotablePickup {
  /** display item name (most recent occurrence) */
  item: string
  /** most recent loot timestamp */
  ts: number
  knowledge: ItemKnowledge
}

export interface NotableState {
  /** knowledge keyed by itemCountKey — for per-row indicators (undefined = unknown yet) */
  byKey: Map<string, ItemKnowledge>
  /** the notable pickups (lore or quest-relevant), most-recent first */
  notable: NotablePickup[]
}

/** Is a knowledge record "notable" (worth flagging / listing)? */
export function isNotable(k: ItemKnowledge): boolean {
  return k.lore || k.quest || k.questUses.length > 0
}

/**
 * Probe the most-recent distinct looted items for lore/quest knowledge. `history` is the
 * full loot list (oldest→newest, as the loot module serves it). Returns a live-updating
 * map + the notable subset. Dismissed keys are filtered out of the strip.
 */
export function useNotablePickups(history: LootEvent[], dismissed: Set<string>): NotableState {
  const [byKey, setByKey] = useState<Map<string, ItemKnowledge>>(new Map())
  // Names we've already requested (dedupe across renders); persists for the component life.
  const requested = useRef<Set<string>>(new Set())

  // The most-recent distinct items (newest first), capped.
  const recent = useRef<{ item: string; ts: number; key: string }[]>([])
  {
    const seen = new Set<string>()
    const list: { item: string; ts: number; key: string }[] = []
    for (let i = history.length - 1; i >= 0 && list.length < PROBE_LIMIT; i--) {
      const e = history[i]
      const key = itemCountKey(e.item)
      if (seen.has(key)) continue
      seen.add(key)
      list.push({ item: e.item, ts: e.ts, key })
    }
    recent.current = list
  }

  useEffect(() => {
    let alive = true
    const toFetch = recent.current.filter((r) => !requested.current.has(r.key))
    if (toFetch.length === 0) return
    for (const r of toFetch) requested.current.add(r.key)
    void (async () => {
      for (const r of toFetch) {
        if (!alive) return
        try {
          const k = await window.eq.lookupItem(r.item)
          if (!alive) return
          setByKey((prev) => {
            const next = new Map(prev)
            next.set(r.key, k)
            return next
          })
        } catch {
          /* main never rejects; ignore */
        }
      }
    })()
    return () => {
      alive = false
    }
    // Re-run when the set of recent keys changes (join of the capped recent keys).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent.current.map((r) => r.key).join('|')])

  const notable: NotablePickup[] = []
  for (const r of recent.current) {
    if (dismissed.has(r.key)) continue
    const k = byKey.get(r.key)
    if (k && isNotable(k)) notable.push({ item: r.item, ts: r.ts, knowledge: k })
  }

  return { byKey, notable }
}
