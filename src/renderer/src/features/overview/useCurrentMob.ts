// useCurrentMob — `CombatSnapshot.currentTarget` → `MobKnowledge`, without storming main.
//
// RATE LIMIT IS THE WHOLE DESIGN (docs/plans/overview-tab.md §3.2). `Encounter.lastOutTarget` is
// re-stamped on EVERY outgoing hit (combat/routing.ts), so in a multi-mob pull the current target
// flips between mobs several times a second. A naive `useEffect(…, [target.name])` would issue a
// `lookupMob` per swing — and while main answers most calls from the committed 7,866-entry
// catalog offline, an uncatalogued mob falls through to the live wiki. Scraper etiquette is a
// LAW here (AGENTS.md → Data sources), so all THREE mitigations are present and none is optional:
//
//   1. CANONICAL KEY — `trim().toLowerCase()`, so 'A Sphinx' and 'a sphinx ' are one subject.
//      (Main's `mobKey` additionally folds backtick variants and whitespace runs; moving it to
//      src/shared is a named future seam. This key only has to dedupe lookups.)
//   2. DEBOUNCE — mid-pull target flapping resolves to ONE lookup.
//   3. PER-KEY MEMO for the component's life — the `requested` ref discipline
//      `features/loot/useNotablePickups.ts:54` already uses, so a mob is asked for at most once.
//
// INSTANT PAINT comes from the `consider` module's ring instead: if you conned this mob, its row
// already carries enriched knowledge, exactly as `MobTarget.seed` paints MobPage before its own
// refresh lands.

import { useEffect, useRef, useState } from 'react'
import type { CombatSnapshot, CurrentTarget } from '@shared/combat'
import type { ConsiderDelta, ConsiderSnap, MobKnowledge } from '@shared/types'
import { useModule } from '../../lib/useModule'

/** How long the target must hold still before we ask main about it. */
const LOOKUP_DEBOUNCE_MS = 750

/** The canonical dedupe key for a mob name. Display stays RAW (law 2). */
export function mobLookupKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Merge a consider delta by row id.
 *
 * Spelled here rather than imported from `features/mobs/RecentlyConsidered.tsx` on purpose: that
 * is a TSX view module, and this hook needs nothing from it but the transport rule. Order is
 * irrelevant to us — the ring is only ever read as a key→knowledge lookup — so this deliberately
 * does NOT re-sort, and cannot drift from the strip's own ordering because it makes no claim
 * about it.
 */
function applyConsiderDelta(state: ConsiderSnap, delta: ConsiderDelta): ConsiderSnap {
  const byId = new Map(state.map((r) => [r.id, r]))
  for (const row of delta.upserted) byId.set(row.id, row)
  return [...byId.values()]
}

export interface CurrentMobState {
  /** the mob, or undefined when no fight is open / nothing has been hit yet. */
  target?: CurrentTarget
  /** true while the fight naming it is still OPEN (`segments.some(s => s.kind === 'current')`). */
  live: boolean
  /** drops etc. Absent until the lookup lands — never a fabricated record (law 1). */
  knowledge?: MobKnowledge
  /** we have asked (or are about to ask) and have no answer yet. Never means "nothing there". */
  loading: boolean
}

/** What the debounce has settled on: the canonical key plus the RAW name to look up with. */
interface PendingLookup {
  key: string
  name: string
}

const NO_PENDING: PendingLookup = { key: '', name: '' }

/**
 * MITIGATION 2 — the target must hold still before it becomes a request. `lastOutTarget` flips
 * between mobs several times a second in a multi-mob pull; this collapses that flapping into one
 * lookup. It applies to the FIRST target too (there is no "leading edge" fast path): a 750ms wait
 * is invisible next to the wiki round trip it may be about to save, and the consider seed already
 * paints instantly for anything you conned.
 */
function useDebouncedTarget(targetName: string): PendingLookup {
  const [pending, setPending] = useState<PendingLookup>(NO_PENDING)
  useEffect(() => {
    const next = targetName ? mobLookupKey(targetName) : ''
    if (next === pending.key) return
    const t = setTimeout(() => setPending({ key: next, name: targetName }), LOOKUP_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [targetName, pending.key])
  return pending
}

/**
 * MITIGATION 3 — one lookup per canonical key for the component's life. `requested` is a ref, so
 * a re-render can never re-ask; `byKey` is state, so a landed answer repaints. The same
 * `requested`-set discipline `features/loot/useNotablePickups.ts:54` uses.
 */
function useMobKnowledgeMemo(pending: PendingLookup): Map<string, MobKnowledge> {
  const [byKey, setByKey] = useState<Map<string, MobKnowledge>>(new Map())
  const requested = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!pending.key || requested.current.has(pending.key)) return
    requested.current.add(pending.key)
    let alive = true
    void window.eq
      .lookupMob(pending.name)
      .then((k) => {
        if (alive) setByKey((prev) => new Map(prev).set(pending.key, k))
      })
      .catch(() => {
        /* main never rejects; a missing record renders the honest empty states */
      })
    return () => {
      alive = false
    }
  }, [pending])
  return byKey
}

export function useCurrentMob(snap: CombatSnapshot | null): CurrentMobState {
  const target = snap?.currentTarget
  const targetName = target?.name ?? ''
  // MITIGATION 1 — canonical key, so 'A Sphinx' and 'a sphinx ' are one subject.
  const key = targetName ? mobLookupKey(targetName) : ''

  const byKey = useMobKnowledgeMemo(useDebouncedTarget(targetName))

  // The consider ring paints instantly for a mob you sized up. Only ever read BY KEY, so a stale
  // row can never stand in for a DIFFERENT mob.
  const considered = useModule<ConsiderSnap, ConsiderDelta>('consider', applyConsiderDelta)
  const seed = key ? considered?.find((r) => mobLookupKey(r.mob) === key)?.knowledge : undefined

  return {
    target,
    live: snap?.segments.some((s) => s.kind === 'current') ?? false,
    // Never the previous mob's record: both halves are looked up by the CURRENT key.
    knowledge: byKey.get(key) ?? seed,
    // True through the debounce as well as the round trip — "we have not answered yet" is the
    // honest state for both, and it is never collapsed with "there is nothing".
    loading: !!key && !byKey.has(key)
  }
}
