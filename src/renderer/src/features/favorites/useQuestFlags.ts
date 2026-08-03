import { useSyncExternalStore } from 'react'

// QUEST-LEVEL flags — favorite (star) and permanently ignored — as two small
// localStorage-backed sets, siblings of the ITEM-level `useFavorites` store and
// deliberately NOT overloading it: starring a quest and starring one of its drops are
// different intents, and conflating them is exactly the indirection that made quest
// favoriting undiscoverable.
//
// Renderer-local on purpose (same as `eq.favorites`): these never touch the main
// electron-store, so no persisted-store schema migration is involved.
//
// Entries are keyed by the app's canonical quest key (`questKey()` — `Class::Name`,
// the same key persisted completions use), lowercased here so a future casing drift in
// the bundled data can't silently orphan someone's stars. Never key by quest NAME
// alone: Sky quest names repeat across classes, so a name-keyed flag would star or
// hide every class's copy at once.

const FAVORITES_KEY = 'eq.questFavorites'
const IGNORED_KEY = 'eq.questIgnored'

export interface QuestFlagSet {
  /** Raw lowercased keys — stable identity, so it is a sound useMemo dependency. */
  keys: Set<string>
  has: (questKey: string) => boolean
  toggle: (questKey: string) => void
  /** How many quests carry the flag. */
  size: number
}

interface QuestFlagStore {
  subscribe: (listener: () => void) => () => void
  snapshot: () => Set<string>
  toggle: (questKey: string) => void
}

function load(storageKey: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    return new Set(Array.isArray(v) ? v.map((s) => String(s).toLowerCase()) : [])
  } catch {
    return new Set()
  }
}

function createQuestFlagStore(storageKey: string): QuestFlagStore {
  let current = load(storageKey)
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot() {
      return current
    },
    toggle(questKey) {
      const key = questKey.toLowerCase()
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      current = next
      localStorage.setItem(storageKey, JSON.stringify([...current]))
      for (const l of listeners) l()
    }
  }
}

const favoriteStore = createQuestFlagStore(FAVORITES_KEY)
const ignoredStore = createQuestFlagStore(IGNORED_KEY)

function useQuestFlagSet(store: QuestFlagStore): QuestFlagSet {
  const keys = useSyncExternalStore(store.subscribe, store.snapshot)
  return {
    keys,
    has: (questKey: string) => keys.has(questKey.toLowerCase()),
    toggle: store.toggle,
    size: keys.size
  }
}

/** Quests the user starred outright (pins them to the top of the list). */
export function useQuestFavorites(): QuestFlagSet {
  return useQuestFlagSet(favoriteStore)
}

/** Quests the user hid permanently (excluded from the list, filters and counts). */
export function useQuestIgnored(): QuestFlagSet {
  return useQuestFlagSet(ignoredStore)
}
