import { useEffect, useState } from 'react'
import type { CombatSnapshot } from '@shared/combat'

/**
 * Views the main-process combat engine for the floating overlay (Task #52).
 *
 * This is the same event-driven poll pattern as the main app's `useCombat`
 * (immediate refresh on the throttled `combat:activity` nudge + a 1s fallback
 * poll for the idle "active" decay), but pared down to exactly what the overlay
 * needs: the LIVE current encounter only. It talks to the engine over the minimal
 * `window.eqOverlay` bridge — no selection/history/combine-pets state, since the
 * overlay always shows the current fight. Keeping this separate from `useCombat`
 * avoids threading overlay-only concerns through the main Combat tab hook.
 */
export function useOverlayCombat(): CombatSnapshot | null {
  const [snap, setSnap] = useState<CombatSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      // combinePets:true reads best for a compact meter (a charmed pet's damage
      // folds into you); no history needed, so cap segments low to keep the
      // payload tiny.
      const s = await window.eqOverlay.getCombatSnapshot({ combinePets: true, maxSegments: 1 })
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
  }, [])

  return snap
}
