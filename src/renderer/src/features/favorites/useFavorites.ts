import { useSyncExternalStore } from 'react'

// A small localStorage-backed store of favorited item names (lowercased), shared
// across every list so a star toggled in one view updates everywhere at once.

const KEY = 'eq.favorites'

function load(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.map((s) => String(s).toLowerCase()) : [])
  } catch {
    return new Set()
  }
}

let favorites: Set<string> = load()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): Set<string> {
  return favorites
}

export function toggleFavorite(name: string): void {
  const key = name.toLowerCase()
  const next = new Set(favorites)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  favorites = next
  localStorage.setItem(KEY, JSON.stringify([...favorites]))
  emit()
}

export interface UseFavorites {
  favorites: Set<string>
  isFavorite: (name: string) => boolean
  toggle: (name: string) => void
}

export function useFavorites(): UseFavorites {
  const favs = useSyncExternalStore(subscribe, snapshot)
  return {
    favorites: favs,
    isFavorite: (name: string) => favs.has(name.toLowerCase()),
    toggle: toggleFavorite
  }
}
