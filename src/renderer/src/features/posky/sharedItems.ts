// "Shared items with" (Task #44). Plane of Sky quests overlap heavily: many
// distinct class Tests require the SAME drop (e.g. `Sphinx Claw` is needed by both
// Beastlord Test of Claw and Paladin Test of Love). Before turning a quest in, the
// user wants to see which OTHER quests contend for each of its required items so a
// single looted item isn't spent on the wrong Test.
//
// This derives, PER QUEST, the set of OTHER quests that share ≥1 required item —
// computed on NORMALIZED base item names (itemCountKey, so a `+N` variant folds onto
// its base, matching how held counts/quest matching already work, Task #42) and
// EXCLUDING currency (`Wind Rune ...`): every class Test also turns in a wind rune,
// so runes overlap universally and are not a meaningful "you might spend this on the
// wrong quest" signal. Per the user: "exclude the currency items though (wind runes)".
//
// Pure + side-effect-free (unit-tested in tests/sharedItems.test.mts). The UI layer
// (PoskyView) turns the returned map into a compact "Shared items" section + a quiet
// collapsed-row indicator.

import type { PoskyQuest } from '@shared/types'
import { itemCountKey, normalizeItemName } from '../../lib/itemName'
import { questKey } from './keys'

/** Wind runes are currency — every Test turns one in, so they overlap universally
 *  and carry no "contention" signal. Match on the normalized base name prefix. */
export function isCurrencyItem(name: string): boolean {
  return normalizeItemName(name).toLowerCase().startsWith('wind rune')
}

/** One other quest that shares a given item, with enough identity to render a chip. */
export interface SharingQuest {
  key: string
  className: string
  name: string
}

/** A single contested item within a quest: its display name + the OTHER quests that
 *  also require it (normalized). */
export interface SharedItem {
  /** normalized counting key (itemCountKey) — stable id */
  key: string
  /** display name (base, `+N` stripped) */
  name: string
  /** other quests requiring this same item (excludes the owning quest) */
  quests: SharingQuest[]
}

/** Map from questKey → the quest's contested items (only items shared with ≥1 other
 *  quest appear; a quest with no overlap maps to an empty array or is absent). */
export type SharedItemsMap = Map<string, SharedItem[]>

/** An item counting key paired with the display name that introduced it. */
interface ItemRef {
  key: string
  name: string
}

/**
 * A quest's required items reduced to DISTINCT non-currency counting keys, in listed
 * order. Both passes below walk exactly this sequence: de-duping by counting key is
 * what stops a quest that lists the same base item twice from appearing twice as its
 * own "sharer".
 */
function distinctItemRefs(q: PoskyQuest): ItemRef[] {
  const seen = new Set<string>()
  const out: ItemRef[] = []
  for (const it of q.items) {
    if (isCurrencyItem(it.name)) continue
    const key = itemCountKey(it.name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, name: normalizeItemName(it.name) })
  }
  return out
}

/** Pass 1: item counting key -> { display name, every quest requiring it }. */
function indexQuestsByItem(
  quests: PoskyQuest[]
): Map<string, { name: string; quests: SharingQuest[] }> {
  const byItem = new Map<string, { name: string; quests: SharingQuest[] }>()
  for (const q of quests) {
    const sq: SharingQuest = { key: questKey(q), className: q.className, name: q.name }
    for (const ref of distinctItemRefs(q)) {
      let entry = byItem.get(ref.key)
      if (!entry) {
        entry = { name: ref.name, quests: [] }
        byItem.set(ref.key, entry)
      }
      entry.quests.push(sq)
    }
  }
  return byItem
}

/** Pass 2, for one quest: the items it shares with at least one OTHER quest. */
function contestedItems(
  q: PoskyQuest,
  byItem: Map<string, { name: string; quests: SharingQuest[] }>
): SharedItem[] {
  const key = questKey(q)
  const shared: SharedItem[] = []
  for (const ref of distinctItemRefs(q)) {
    const entry = byItem.get(ref.key)
    if (!entry || entry.quests.length < 2) continue // shared by no one else
    const others = entry.quests.filter((x) => x.key !== key)
    if (others.length === 0) continue
    shared.push({ key: ref.key, name: entry.name, quests: others })
  }
  return shared
}

/**
 * Build the shared-items map for a quest set. For each normalized (non-currency)
 * required item, find every quest that requires it; any item required by ≥2 quests is
 * "contested" and is listed under each of those quests (pointing at the OTHERS).
 */
export function computeSharedItems(quests: PoskyQuest[]): SharedItemsMap {
  const byItem = indexQuestsByItem(quests)
  const out: SharedItemsMap = new Map()
  for (const q of quests) {
    const shared = contestedItems(q, byItem)
    if (shared.length > 0) out.set(questKey(q), shared)
  }
  return out
}

/**
 * Render a sharing quest's label. When the same quest NAME appears under multiple
 * classes we class-prefix it ("Monk · Test of ...") so chips stay unambiguous;
 * otherwise the bare quest name reads cleaner. `ambiguousNames` is the set of quest
 * names that occur under >1 class (precomputed once from the quest list).
 */
export function ambiguousQuestNames(quests: PoskyQuest[]): Set<string> {
  const byName = new Map<string, Set<string>>()
  for (const q of quests) {
    const s = byName.get(q.name) ?? new Set<string>()
    s.add(q.className)
    byName.set(q.name, s)
  }
  const out = new Set<string>()
  for (const [name, classes] of byName) if (classes.size > 1) out.add(name)
  return out
}

/** Chip label for a sharing quest, class-prefixed only when the name is ambiguous. */
export function sharingQuestLabel(sq: SharingQuest, ambiguousNames: Set<string>): string {
  return ambiguousNames.has(sq.name) ? `${sq.className} · ${sq.name}` : sq.name
}
