import { useEffect, useState } from 'react'
import type { CombatSnapshot } from '@shared/combat'

export const LIVE = '__live__'

/** Default cap on finalized-fight summaries fetched per snapshot (Task #17 wire
 *  payload cap). The zone summary + current fight are always included; a "Load
 *  more" affordance bumps this. */
const DEFAULT_MAX_SEGMENTS = 100

export interface UseCombat {
  snap: CombatSnapshot | null
  combinePets: boolean
  setCombinePets: (v: boolean) => void
  showUnparsed: boolean
  setShowUnparsed: (v: boolean) => void
  selection: string
  setSelection: (id: string) => void
  /** current finalized-fight cap in the fetched snapshot */
  maxSegments: number
  /** bump the cap by another page of fights (Load more) */
  loadMore: () => void
  /** when true, the snapshot includes the selected encounter's timeline (Task #51). */
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
  const [combinePets, setCombinePets] = useState(false)
  const [showUnparsed, setShowUnparsed] = useState(false)
  const [selection, setSelection] = useState<string>(LIVE)
  const [maxSegments, setMaxSegments] = useState(DEFAULT_MAX_SEGMENTS)
  const [wantTimeline, setWantTimeline] = useState(false)
  const [snap, setSnap] = useState<CombatSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      const s = await window.eq.getCombatSnapshot({
        combinePets,
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
  }, [combinePets, selection, showUnparsed, maxSegments, wantTimeline])

  const loadMore = (): void => setMaxSegments((n) => n + DEFAULT_MAX_SEGMENTS)

  return {
    snap,
    combinePets,
    setCombinePets,
    showUnparsed,
    setShowUnparsed,
    selection,
    setSelection,
    maxSegments,
    loadMore,
    wantTimeline,
    setWantTimeline
  }
}
