// useBossKills — kills module → roster boss statuses, plus two callbacks fired
// live (never for the historical baseline loaded on character load). Used by both
// BossView (cards + confetti + card flash) and App (the app-wide snackbar + the
// bossDefeat alert sound) so they share one definition of "kill" vs "new defeat".
//
// Two-tier detection (Task #24):
//   - onKill      — ANY roster-boss kill, including a repeat at the same/lower
//                   tier. Drives confetti + card flash + snackbar on every kill.
//   - onNewDefeat — the subset that's a FIRST defeat at a new tier for that boss.
//                   Drives the bossDefeat app-signal sound ONLY, so repeat kills
//                   stay silent.
//
// The baseline problem: the first snapshot already contains every boss killed in
// the past. If we compared that against an empty `prev`, every historical kill
// would look "new" and fire confetti on launch. So we seed the baseline silently
// on the first state we see and only emit for changes after that.

import { useEffect, useRef, useState } from 'react'
import type { KillMap, KillsDelta, RaidTarget } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { allStatuses, bossKills, newDefeats, type TargetStatus } from './bossStatus'

function applyKillsDelta(state: KillMap, delta: KillsDelta): KillMap {
  return { ...state, ...delta.changed }
}

export interface BossKillCallbacks {
  /** Fired for ANY roster-boss kill seen live (incl. repeats) — confetti/snackbar. */
  onKill?: (s: TargetStatus) => void
  /** Fired only for a first defeat at a new tier — the bossDefeat sound. */
  onNewDefeat?: (s: TargetStatus) => void
}

export function useBossKills(
  targets: RaidTarget[],
  cbs?: BossKillCallbacks
): { kills: KillMap; statuses: TargetStatus[] } {
  const kills = useModule<KillMap, KillsDelta>('kills', applyKillsDelta)
  const [statuses, setStatuses] = useState<TargetStatus[]>([])
  // Previous per-target status; seeded silently on first snapshot.
  const prevRef = useRef<Map<string, TargetStatus> | null>(null)
  const cbsRef = useRef(cbs)
  cbsRef.current = cbs

  // Reset the baseline when the kills state is replaced wholesale (character
  // switch re-hydrates to a fresh object). We detect that by identity: a delta
  // mutates via spread into a new object too, so instead we clear the baseline
  // whenever the character changes.
  useEffect(() => {
    const off = window.eq.onCharacter(() => {
      prevRef.current = null
    })
    return off
  }, [])

  useEffect(() => {
    if (!kills) return
    const next = allStatuses(targets, kills)
    setStatuses(next)
    const prev = prevRef.current
    if (prev != null) {
      // Any kill (incl. repeats) → confetti/snackbar; new-tier subset → sound.
      for (const s of bossKills(prev, next)) cbsRef.current?.onKill?.(s)
      for (const s of newDefeats(prev, next)) cbsRef.current?.onNewDefeat?.(s)
    }
    prevRef.current = new Map(next.map((s) => [s.target.name, s]))
  }, [kills, targets])

  return { kills: kills ?? {}, statuses }
}
