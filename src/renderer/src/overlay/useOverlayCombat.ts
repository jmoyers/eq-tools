import { useEffect, useState } from 'react'
import type { CombatSnapshot } from '@shared/combat'

/**
 * Views the main-process combat engine for a floating overlay (Task #52; per-kind in Task #54).
 *
 * Same event-driven poll pattern as the main app's `useCombat` (immediate refresh on the throttled
 * `combat:activity` nudge + a 1s fallback poll for the idle "active" decay), pared down to what an
 * overlay needs. It talks to the engine over the minimal `window.eqOverlay` bridge.
 *
 * `selectedId` drives which segment the snapshot resolves (LIVE fight, a finalized fight, the live
 * zone, or a finalized zone session). `combinePets` folds pet damage into You for a compact meter.
 * No timeline is ever requested (overlays never show one).
 */
export function useOverlayCombat(selectedId: string | undefined, combinePets: boolean): CombatSnapshot | null {
  const [snap, setSnap] = useState<CombatSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      // maxSegments modest: the overlay's selector lists recent fights, but the payload stays small.
      const s = await window.eqOverlay.getCombatSnapshot({ combinePets, selectedId, maxSegments: 30 })
      if (alive) setSnap(s)
    }
    void tick()
    const off = window.eqOverlay.onCombatActivity(() => void tick())
    const iv = setInterval(() => void tick(), 1000)
    return () => {
      alive = false
      off()
      clearInterval(iv)
    }
  }, [selectedId, combinePets])

  return snap
}
