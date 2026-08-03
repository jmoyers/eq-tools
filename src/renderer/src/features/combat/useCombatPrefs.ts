// Renderer-local COMBAT view preferences — the same idiom as `eq.combat.scope` in useCombat.ts
// (localStorage, renderer-side, no store/IPC round trip), with one addition it needs and that
// one didn't: these prefs are read by surfaces that never share a mount.
//
// The Preferences tab writes them; the Combat tab and the Overview card read them. App.tsx's
// `ViewContent` mounts exactly ONE feature view at a time, so a plain `useState` initialised
// from localStorage would already be correct on the next mount — but a same-document
// `localStorage.setItem` fires no 'storage' event, so anything that IS mounted alongside the
// writer (a preference and its own live example, today or tomorrow) would go stale. The tiny
// subscription below closes that: one write notifies every reader in this window, so "changing
// it applies live" is structural instead of incidental.

import { useCallback, useSyncExternalStore } from 'react'

/**
 * Nest the pet as ONE line item inside your damage breakdown (drillable to the pet's own
 * skills) instead of listing it as a separate source. Default ON: the game is mostly played
 * solo, so "you and your pet" is the shape of nearly every fight (owner direction, 2026-08-03).
 */
export const COMBINE_PET_ROW_KEY = 'eq.combat.petRow'

/**
 * Does the Combat dashboard OPEN on your damage breakdown (level 2) rather than the source
 * list (level 1)? Default ON, for the same reason: with one or two sources, the source list is
 * a lid on the only list worth reading. Un-drilling is unchanged, and this key is what makes
 * that choice stick across fights and sessions.
 */
export const DRILL_KEY = 'eq.combat.drill'

const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** '1'/'0' rather than JSON: these are one-bit view prefs and the value should be readable in
 *  devtools at a glance. An absent key is the DEFAULT, never `false` — a user who has never
 *  touched the setting has not turned it off. */
function read(key: string, dflt: boolean): boolean {
  const v = localStorage.getItem(key)
  return v === null ? dflt : v === '1'
}

function write(key: string, v: boolean): void {
  localStorage.setItem(key, v ? '1' : '0')
  for (const l of [...listeners]) l()
}

/** One persisted boolean view pref, live across every mounted reader in this window. */
export function useBoolPref(key: string, dflt: boolean): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, dflt),
    () => dflt
  )
  const set = useCallback((v: boolean) => write(key, v), [key])
  return [value, set]
}

/** See COMBINE_PET_ROW_KEY. Read by the Combat dashboard AND the Overview DPS card. */
export function useCombinePetRow(): [boolean, (v: boolean) => void] {
  return useBoolPref(COMBINE_PET_ROW_KEY, true)
}

/** See DRILL_KEY. Read (and written) by the Combat dashboard only — the Overview card's drill
 *  is card-local by design and must never move the Combat tab's. */
export function useStartDrilled(): [boolean, (v: boolean) => void] {
  return useBoolPref(DRILL_KEY, true)
}
