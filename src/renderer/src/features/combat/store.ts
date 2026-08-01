import { CombatEngine } from './engine'

// A single engine for the whole app so combat is tracked continuously (and
// history is retained) regardless of which tab is open.
let engine: CombatEngine | null = null

export function getCombatEngine(): CombatEngine {
  if (!engine) {
    engine = new CombatEngine()
    window.eq.onLine((line) => engine!.ingest(line.text, line.ts))
  }
  return engine
}

/** Call once at app start so tracking begins immediately. */
export function initCombat(): void {
  getCombatEngine()
}
