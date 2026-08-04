import { useEffect, useState } from 'react'
import type { CombatSnapshot } from '@shared/combat'
import { LIVE_SELECTION, defaultSelection, type CombatScope } from './dashboardData'
import type { CombatFocus } from './combatFocus'

/** Re-export: the sentinel lives with the scope helpers (dashboardData) so the overlay entry —
 *  which never imports this hook — can share one definition. */
export const LIVE = LIVE_SELECTION

/** Renderer-local view pref, same shape as App.tsx's saved view / BossView's density. */
const SCOPE_KEY = 'eq.combat.scope'

function loadScope(): CombatScope {
  const v = localStorage.getItem(SCOPE_KEY)
  return v === 'overall' ? 'overall' : 'fight'
}

/** Default cap on finalized-fight summaries fetched per snapshot (Task #17 wire
 *  payload cap). The zone summary + current fight are always included; a "Load
 *  more" affordance bumps this. */
const DEFAULT_MAX_SEGMENTS = 100

export interface UseCombat {
  snap: CombatSnapshot | null
  showUnparsed: boolean
  setShowUnparsed: (v: boolean) => void
  selection: string
  setSelection: (id: string) => void
  /**
   * Fight vs Overall — an EXPLICIT scope, never an automatic switch. It decides both what the
   * body shows and what the selector may list (fights only / zone sessions only). Persisted
   * renderer-side like the other view prefs.
   */
  scope: CombatScope
  setScope: (s: CombatScope) => void
  /**
   * Jump to an explicit scope + selection (a deep link from another tab). Distinct from
   * `setScope`, which deliberately resets the selection to that scope's head row: here the
   * caller has already decided what it wants selected. The scope is persisted, exactly as a
   * manual scope change is — arriving via "see this fight in Combat" is a real scope choice.
   */
  focusFight: (f: CombatFocus) => void
  /** current finalized-fight cap in the fetched snapshot */
  maxSegments: number
  /** bump the cap by another page of fights (Load more) */
  loadMore: () => void
  /**
   * When true, the snapshot includes the selected encounter's timeline (Task #51).
   * Defaults to TRUE now that the combat DASHBOARD derives its DPS curve and per-mob
   * breakdown from the same event ring — the payload is needed for every ring-backed
   * selection, not just while the Timeline chart is on screen. The engine caps a
   * serialized timeline at 2k events (uniform-stride downsample above that), so the
   * cost is bounded; ring-less selections (zone sessions) return null for free.
   */
  wantTimeline: boolean
  setWantTimeline: (v: boolean) => void
}

/**
 * Views the main-process combat engine. The engine owns all state (it's seeded
 * from the full log and fed the live tail), so the UI is a pure view.
 *
 * FIX 4: refresh is event-driven — a fresh snapshot is fetched immediately on the
 * main-side `onCombatActivity` ping (throttled to ~4x/sec there), giving sub-second
 * meter updates during a fight. A slow 1s fallback poll remains for timer-driven UI
 * (the "active" state decay) and to cover any missed event.
 */
export function useCombat(): UseCombat {
  const [showUnparsed, setShowUnparsed] = useState(false)
  const [scope, setScopeState] = useState<CombatScope>(loadScope)
  const [selection, setSelection] = useState<string>(() => defaultSelection(loadScope()))
  const [maxSegments, setMaxSegments] = useState(DEFAULT_MAX_SEGMENTS)
  const [wantTimeline, setWantTimeline] = useState(true)
  const [snap, setSnap] = useState<CombatSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      const s = await window.eq.getCombatSnapshot({
        // The engine-side pet fold is retired UI: pet presentation is the renderer's
        // nesting pref (eq.combat.petRow); the snapshot always carries separate sources.
        combinePets: false,
        selectedId: selection === LIVE ? undefined : selection,
        showUnparsed,
        maxSegments,
        timeline: wantTimeline
      })
      if (alive) setSnap(s)
    }
    void tick()
    const off = window.eq.onCombatActivity(() => void tick())
    const iv = setInterval(() => void tick(), 1000)
    return () => {
      alive = false
      off()
      clearInterval(iv)
    }
  }, [selection, showUnparsed, maxSegments, wantTimeline])

  const loadMore = (): void => setMaxSegments((n) => n + DEFAULT_MAX_SEGMENTS)

  /** Switching scope always lands on that scope's head row — the previous scope's selection is
   *  not even listable in the new one, so carrying it over would leave the selector blank. */
  const setScope = (s: CombatScope): void => {
    setScopeState(s)
    localStorage.setItem(SCOPE_KEY, s)
    setSelection(defaultSelection(s))
  }

  /** See UseCombat.focusFight — a deep link decides BOTH halves, so the selection survives. */
  const focusFight = (f: CombatFocus): void => {
    setScopeState(f.scope)
    localStorage.setItem(SCOPE_KEY, f.scope)
    setSelection(f.selection)
  }

  return {
    snap,
    showUnparsed,
    setShowUnparsed,
    selection,
    setSelection,
    scope,
    setScope,
    focusFight,
    maxSegments,
    loadMore,
    wantTimeline,
    setWantTimeline
  }
}
