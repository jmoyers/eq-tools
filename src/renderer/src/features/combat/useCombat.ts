import { useEffect, useState } from 'react'
import type { CombatSnapshot } from '@shared/combat'

export const LIVE = '__live__'

export interface UseCombat {
  snap: CombatSnapshot | null
  combinePets: boolean
  setCombinePets: (v: boolean) => void
  showUnparsed: boolean
  setShowUnparsed: (v: boolean) => void
  selection: string
  setSelection: (id: string) => void
}

/**
 * Polls the main-process combat engine ~2x/sec. The engine owns all state (it's
 * seeded from the full log and fed the live tail), so the UI is a pure view.
 */
export function useCombat(): UseCombat {
  const [combinePets, setCombinePets] = useState(false)
  const [showUnparsed, setShowUnparsed] = useState(false)
  const [selection, setSelection] = useState<string>(LIVE)
  const [snap, setSnap] = useState<CombatSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      const s = await window.eq.getCombatSnapshot({
        combinePets,
        selectedId: selection === LIVE ? undefined : selection,
        showUnparsed
      })
      if (alive) setSnap(s)
    }
    void tick()
    const iv = setInterval(() => void tick(), 500)
    return () => {
      alive = false
      clearInterval(iv)
    }
  }, [combinePets, selection, showUnparsed])

  return { snap, combinePets, setCombinePets, showUnparsed, setShowUnparsed, selection, setSelection }
}
