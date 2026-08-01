import { useEffect, useState } from 'react'
import { getCombatEngine } from './store'
import type { CombatSnapshot } from './engine'

export const LIVE = '__live__'

export interface UseCombat {
  snap: CombatSnapshot | null
  combinePets: boolean
  setCombinePets: (v: boolean) => void
  /** LIVE (follow current) or a specific segment id */
  selection: string
  setSelection: (id: string) => void
  reset: () => void
}

export function useCombat(): UseCombat {
  const [combinePets, setCombinePets] = useState(false)
  const [selection, setSelection] = useState<string>(LIVE)
  const [snap, setSnap] = useState<CombatSnapshot | null>(null)

  useEffect(() => {
    const eng = getCombatEngine()
    const tick = (): void =>
      setSnap(eng.snapshot(Date.now(), { combinePets, selectedId: selection === LIVE ? undefined : selection }))
    tick()
    const iv = setInterval(tick, 500)
    return () => clearInterval(iv)
  }, [combinePets, selection])

  const reset = (): void => {
    getCombatEngine().reset()
    setSelection(LIVE)
  }

  return { snap, combinePets, setCombinePets, selection, setSelection, reset }
}
