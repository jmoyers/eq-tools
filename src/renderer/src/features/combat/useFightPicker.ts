// The FightPicker's STATE: the freeze, the debounced all-time search with its stale guard, the
// keyboard model, and the rows that fall out of all three. Split out of FightPicker.tsx, whose
// header holds the full rationale (THE FREEZE / STALE RESULTS) this implements.

import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeQuery } from '../../lib/search'
import type { CombatScope, ScopeOption } from './dashboardData'
import {
  DEBOUNCE_MS,
  RENDER_CAP,
  SEARCH_LIMIT,
  browseList,
  freezeOptions,
  hitRow,
  triggerRow,
  type FrozenList,
  type PickerRow,
  type SearchState
} from './fightPickerRows'
import type { FightPickerProps } from './FightPicker'

export interface PickerState {
  open: boolean
  setOpen: (o: boolean) => void
  query: string
  setQuery: (q: string) => void
  frozen: FrozenList | null
  results: SearchState | null
  /** the rows actually rendered — search results when searching, else the frozen browse list. */
  rows: PickerRow[]
  /** the list is showing SEARCH results (so the freeze note and housekeeping rows stand down). */
  inSearch: boolean
  /** a newer keystroke is still resting out its debounce — dim, never blank. */
  stale: boolean
  clampedActive: number
  setActive: (i: number) => void
  listRef: React.RefObject<HTMLUListElement>
  commit: (row: PickerRow) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  /** the sanctioned thaw: ask for a bigger page and arm the single re-freeze. */
  requestMore: () => void
  /** what the CLOSED trigger states. */
  current: ScopeOption | null
}

/** The two setters the freeze resets when the popover opens or closes. */
interface ResetFns {
  setActive: (i: number) => void
  setQuery: (q: string) => void
}

/**
 * THE FREEZE, plus its one sanctioned thaw. Opening takes exactly one snapshot of the live
 * option list; closing drops it. An explicit "Load more" arms a SINGLE re-freeze, so the bigger
 * page is adopted once and nothing else can move the ground under an open list.
 */
function useFrozenList(
  { opts, capped, now, onLoadMore }: FightPickerProps,
  open: boolean,
  reset: ResetFns
): { frozen: FrozenList | null; requestMore: () => void } {
  const [frozen, setFrozen] = useState<FrozenList | null>(null)
  /** An explicit "Load more" is the ONE sanctioned thaw; this arms the single re-freeze. */
  const wantMoreRef = useRef(false)
  // The live values are read through refs inside effects so a snapshot tick (which hands us a
  // brand-new `opts` object every ~250ms) can never re-run the effect that does the freezing.
  const optsRef = useRef(opts)
  const nowRef = useRef(now)
  const cappedRef = useRef(capped)
  const resetRef = useRef(reset)
  optsRef.current = opts
  nowRef.current = now
  cappedRef.current = capped
  resetRef.current = reset

  // Depends on `open` alone.
  useEffect(() => {
    if (!open) {
      wantMoreRef.current = false
      setFrozen(null)
      resetRef.current.setQuery('')
      return
    }
    resetRef.current.setActive(0)
    setFrozen(freezeOptions(optsRef.current, nowRef.current, cappedRef.current))
  }, [open])

  // The sanctioned thaw: after an explicit "Load more", adopt the bigger page ONCE.
  useEffect(() => {
    if (!open || !wantMoreRef.current) return
    if (opts.rest.length <= (frozen?.rest.length ?? 0)) return
    wantMoreRef.current = false
    setFrozen(freezeOptions(opts, nowRef.current, cappedRef.current))
  }, [open, opts, frozen])

  const requestMore = (): void => {
    wantMoreRef.current = true
    onLoadMore()
  }
  return { frozen, requestMore }
}

/**
 * The debounced ALL-TIME fight search, with its stale guard: every request carries a sequence
 * number and a response whose sequence is not the latest is DISCARDED. Closing the popover (or
 * emptying the query) bumps the sequence too, so an in-flight response can never repopulate a
 * list that is no longer open. Fight scope only — see `overallMatches` for why Overall filters
 * client-side.
 */
function useFightSearch(
  open: boolean,
  scope: CombatScope,
  query: string,
  setActive: (i: number) => void
): SearchState | null {
  const [results, setResults] = useState<SearchState | null>(null)
  /** Latest issued search. A response carrying anything else is stale and must be dropped. */
  const seqRef = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (!open || scope !== 'fight' || q === '') {
      seqRef.current += 1
      setResults(null)
      return
    }
    const seq = ++seqRef.current
    const t = setTimeout(() => {
      window.eq
        .searchFights(q, SEARCH_LIMIT)
        .then((res) => {
          if (seq !== seqRef.current) return
          setResults({ query: q, hits: res.hits, corpus: res.corpus })
          setActive(0)
        })
        .catch(() => {
          if (seq !== seqRef.current) return
          setResults({ query: q, hits: [], corpus: 0 })
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [open, scope, query, setActive])

  return results
}

export function useFightPicker(props: FightPickerProps): PickerState {
  const { opts, scope, selection, onSelect, disabled } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  /** A pick the live option list cannot describe (a search hit older than the snapshot's cap). */
  const [external, setExternal] = useState<ScopeOption | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const { frozen, requestMore } = useFrozenList(props, open, { setActive, setQuery })
  const results = useFightSearch(open, scope, query, setActive)

  // Hydration can start under an open menu (a re-scan on character change); the list it was
  // showing is no longer meaningful, so close rather than sit on a replay artifact.
  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  const browseRows = useMemo(() => browseList(frozen, scope), [frozen, scope])

  /**
   * OVERALL SCOPE FILTERS CLIENT-SIDE, ON PURPOSE. That scope lists zone SESSIONS — the live one
   * plus a capped history of at most 20 — and all of them are already in hand, so a query is a
   * substring test over ≤20 labels, not a round-trip. Sending it to the all-time FIGHT search
   * would also answer a different question with a different corpus: it returns fights, which
   * this scope may never list (dashboardData's scope law — one scope, one kind of row).
   */
  const overallMatches = useMemo(() => {
    const q = normalizeQuery(query)
    if (!q || scope !== 'overall') return null
    return browseRows.filter((r) => r.label.toLowerCase().includes(q))
  }, [query, scope, browseRows])

  const searchRows = useMemo(() => {
    if (scope === 'overall') return overallMatches
    if (!query.trim()) return null
    return results ? results.hits.slice(0, RENDER_CAP).map(hitRow) : []
  }, [scope, overallMatches, query, results])

  const rows = searchRows ?? browseRows
  const inSearch = searchRows !== null
  // A newer keystroke is still resting out its debounce: keep the last answer on screen (a list
  // that blanks between keystrokes is the churn this component exists to remove) but dim it, so
  // it never silently reads as the answer to what was just typed.
  const stale = scope === 'fight' && inSearch && results !== null && results.query !== query.trim()

  const clampedActive = rows.length === 0 ? -1 : Math.min(active, rows.length - 1)

  // Keep the keyboard highlight in view without stealing focus from the input.
  useEffect(() => {
    if (clampedActive < 0) return
    listRef.current?.querySelector(`[data-idx="${clampedActive}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [clampedActive])

  const commit = (row: PickerRow): void => {
    // Remember the pick only when the LIVE list can't describe it — everything else stays a
    // lookup, so the trigger keeps re-resolving (and re-labelling) against fresh data.
    const known = opts.head?.value === row.value || opts.rest.some((o) => o.value === row.value)
    setExternal(known ? null : { ...row.opt })
    onSelect(row.value)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length === 0) return
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (Math.min(i, rows.length - 1) + d + rows.length) % rows.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[clampedActive]
      if (row) commit(row)
    }
  }

  return {
    open,
    setOpen,
    query,
    setQuery,
    frozen,
    results,
    rows,
    inSearch,
    stale,
    clampedActive,
    setActive,
    listRef,
    commit,
    onKeyDown,
    requestMore,
    // What the CLOSED trigger states — read from the LIVE options, not the frozen copy, because
    // the trigger is a state readout and must stay honest while the menu is open above it.
    current: triggerRow(opts, selection, external)
  }
}
