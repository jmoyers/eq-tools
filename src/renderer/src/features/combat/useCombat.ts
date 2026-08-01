import { useEffect, useRef, useState } from 'react'
import { CombatEngine, type CombatSnapshot } from './engine'

export interface UseCombat {
  snap: CombatSnapshot | null
  combinePets: boolean
  setCombinePets: (v: boolean) => void
  showOthers: boolean
  setShowOthers: (v: boolean) => void
  reset: () => void
}

/**
 * Feeds the live log stream into the combat engine and snapshots it ~3x/sec.
 * The engine persists across the component's life so the meter keeps tracking
 * while the Combat tab is open.
 */
export function useCombat(): UseCombat {
  const engine = useRef<CombatEngine>(new CombatEngine())
  const [combinePets, setCombinePets] = useState(false)
  const [showOthers, setShowOthers] = useState(false)
  const [snap, setSnap] = useState<CombatSnapshot | null>(null)

  useEffect(() => {
    const off = window.eq.onLine((line) => engine.current.ingest(line.text, line.ts))
    return off
  }, [])

  useEffect(() => {
    const tick = (): void => setSnap(engine.current.snapshot(Date.now(), combinePets, showOthers))
    tick()
    const iv = setInterval(tick, 300)
    return () => clearInterval(iv)
  }, [combinePets, showOthers])

  const reset = (): void => {
    engine.current.reset()
    setSnap(engine.current.snapshot(Date.now(), combinePets, showOthers))
  }

  return { snap, combinePets, setCombinePets, showOthers, setShowOthers, reset }
}
