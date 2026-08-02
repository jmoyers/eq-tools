// useModule — the one hook every module-backed view uses to stay live.
//
// It replaces the hydrate/subscribe race each view used to hand-roll:
//   1. hydrate via getModuleSnapshot(moduleId) → { seq, state },
//   2. subscribe to module:delta filtered by moduleId,
//   3. apply deltas IN ORDER via the caller's applyDelta(state, delta),
//      rejecting dupes (delta.seq <= known seq),
//   4. re-hydrate on onCharacter (state was fully rebuilt in main). The only
//      real gap source is a remount/switch, and re-hydration covers it — so
//      instead of trying to detect a mid-stream gap (delta seqs batch many
//      events, so there's no reliable "expected next" to compare against) we
//      lean on the full-snapshot re-fetch that onCharacter already triggers.
//
// Deltas that arrive between the getModuleSnapshot call and the subscription are
// not lost: we subscribe BEFORE awaiting the snapshot and buffer, then replay the
// buffer (dropping anything already covered by the snapshot's seq).

import { useEffect, useRef, useState } from 'react'
import type { ModuleDelta } from '@shared/types'

export function useModule<Snap, Delta>(
  moduleId: string,
  applyDelta: (state: Snap, delta: Delta) => Snap
): Snap | null {
  const [state, setState] = useState<Snap | null>(null)
  // Latest applyDelta without making the effect depend on its identity.
  const applyRef = useRef(applyDelta)
  applyRef.current = applyDelta

  useEffect(() => {
    let cancelled = false
    // Known seq: the highest LogEvent seq folded into `state`. -1 until hydrated.
    let knownSeq = -1
    // Deltas that arrive before hydration completes, replayed after.
    const buffered: ModuleDelta<Delta>[] = []
    let hydrated = false

    const applyOne = (d: ModuleDelta<Delta>): void => {
      if (d.moduleId !== moduleId) return
      if (d.seq <= knownSeq) return // dupe or already-covered
      knownSeq = d.seq
      setState((prev) => (prev == null ? prev : applyRef.current(prev, d.delta)))
    }

    const hydrate = (): void => {
      hydrated = false
      buffered.length = 0
      void window.eq.getModuleSnapshot<Snap>(moduleId).then((snap) => {
        if (cancelled || !snap) return
        knownSeq = snap.seq
        setState(snap.state)
        hydrated = true
        // Replay anything that landed during the await, in seq order.
        for (const d of buffered.sort((a, b) => a.seq - b.seq)) applyOne(d)
        buffered.length = 0
      })
    }

    const offDelta = window.eq.onModuleDelta<Delta>((d) => {
      if (d.moduleId !== moduleId) return
      // Buffer until hydrated so a delta racing the snapshot isn't lost or applied
      // against null state; the hydrate replay drops any already covered by seq.
      if (!hydrated) {
        buffered.push(d)
        return
      }
      applyOne(d)
    })

    // Re-hydrate on a character switch (main rebuilt everything under a new ref).
    const offChar = window.eq.onCharacter(() => hydrate())

    hydrate()

    return () => {
      cancelled = true
      offDelta()
      offChar()
    }
  }, [moduleId])

  return state
}
