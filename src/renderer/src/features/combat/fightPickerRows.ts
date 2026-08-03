// The FightPicker's ROW MODEL — the pure half of the selector: what a row is, how a frozen
// browse list and an all-time search hit both collapse to that one shape, and what the closed
// trigger states. No JSX, no MUI (FightPicker.tsx renders these; FightPickerRows.tsx draws one).

import { formatDate, formatTime } from '../../lib/formatDate'
import { formatRate } from '../../lib/formatRate'
import { fmtDur } from './copyText'
import type { CombatScope, ScopeOption, ScopeOptions } from './dashboardData'

/**
 * The search contract lives with the sibling-owned main/preload code. Deriving the shape from
 * the bridge method itself (rather than re-importing a named type) keeps this file honest about
 * where the truth is, and immune to where that type happens to be declared.
 */
export type FightHit = Awaited<ReturnType<typeof window.eq.searchFights>>['hits'][number]

/** How long a keystroke rests before it costs an IPC round-trip. */
export const DEBOUNCE_MS = 120
/** How many hits we ask the engine for. Beyond this the query is simply too broad to read. */
export const SEARCH_LIMIT = 500
/** How many result rows we actually MOUNT. The rest are a count, not a scroll marathon. */
export const RENDER_CAP = 100

/** One rendered row — browse and search rows collapse to the same shape, so the list is one list. */
export interface PickerRow {
  /** what `onSelect` receives: a segment id, or the `__live__` sentinel for the head row. */
  value: string
  label: string
  /** formatted rate, right-aligned on the main line. */
  rate: string
  /** dim second line: start clock · relative age · duration. */
  timing: string
  live: boolean
  /** the zone the fight happened in, when the engine knows it (a query spans every zone). */
  zone?: string
  /** the pinned current/last-fight row, which sits above a hairline. */
  head?: boolean
  /**
   * The row as a selector OPTION. A search hit can be a fight far older than anything the
   * snapshot's capped segment list carries, so picking one leaves the trigger with a selection
   * it cannot look up; the picker remembers this to keep the trigger stating the truth.
   */
  opt: ScopeOption
}

/**
 * The list as it was when the popover opened. `now` is frozen along with the rows: the relative
 * ages are part of a row's TEXT, and a row that relabels itself from 'just now' to '1m ago'
 * under the pointer is the same churn as one that moves.
 */
export interface FrozenList {
  head: ScopeOption | null
  rest: ScopeOption[]
  now: number
  /** the "Load more fights…" affordance was applicable at freeze time. */
  capped: boolean
}

export interface SearchState {
  /** the query these hits answer — the guard against rendering them under a newer one. */
  query: string
  hits: FightHit[]
  /** how many fights the engine searched, so an empty result can say what it looked through. */
  corpus: number
}

/**
 * Coarse, live-updating relative age for a selector row (Task #54 disambiguation timing):
 * 'just now' / '2m ago' / '3h ago' / '2d ago'. Kept intentionally coarse so five same-named
 * giant pulls are tellable apart by start clock + age + duration.
 */
export function relativeAge(ts: number, now: number): string {
  if (!ts) return ''
  const secs = Math.max(0, (now - ts) / 1000)
  if (secs < 45) return 'just now'
  const mins = secs / 60
  if (mins < 60) return `${Math.round(mins)}m ago`
  const hrs = mins / 60
  if (hrs < 36) return `${Math.round(hrs)}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** The disambiguation timing suffix for a selector row: 'start clock · age · duration'. */
export function timingLabel(startTs: number, durationSec: number, now: number): string {
  const bits: string[] = []
  if (startTs) bits.push(`${formatDate(startTs)} ${formatTime(startTs)}`)
  const age = relativeAge(startTs, now)
  if (age) bits.push(age)
  bits.push(fmtDur(durationSec))
  return bits.join(' · ')
}

/** The running zone session has no end yet, so it has no duration to disambiguate by. */
export function rowTiming(o: ScopeOption, scope: CombatScope, now: number): string {
  return o.live && scope === 'overall' ? 'live' : timingLabel(o.startTs, o.durationSec, now)
}

/** Deep copy — ScopeOption is flat, so a per-row spread genuinely detaches from the live array. */
export function freezeOptions(opts: ScopeOptions, now: number, capped: boolean): FrozenList {
  return {
    head: opts.head ? { ...opts.head } : null,
    rest: opts.rest.map((o) => ({ ...o })),
    now,
    capped
  }
}

/** The FROZEN browse list, head row pinned first. Empty until the popover opens. */
export function browseList(frozen: FrozenList | null, scope: CombatScope): PickerRow[] {
  if (!frozen) return []
  const toRow = (o: ScopeOption, head: boolean): PickerRow => ({
    value: o.value,
    label: o.label,
    rate: formatRate(o.dps),
    timing: rowTiming(o, scope, frozen.now),
    live: o.live,
    head,
    opt: o
  })
  return [...(frozen.head ? [toRow(frozen.head, true)] : []), ...frozen.rest.map((o) => toRow(o, false))]
}

/** A search hit, as a row. Zone rides along because a query spans every zone you have played. */
export function hitRow(h: FightHit): PickerRow {
  const s = h.summary
  const opt: ScopeOption = {
    value: s.id,
    label: s.name,
    name: s.name,
    dps: s.dps,
    startTs: s.startTs,
    durationSec: s.durationSec,
    live: s.kind === 'current'
  }
  return {
    value: opt.value,
    label: opt.label,
    rate: formatRate(opt.dps),
    timing: timingLabel(opt.startTs, opt.durationSec, Date.now()),
    live: opt.live,
    zone: s.zone,
    opt
  }
}

/**
 * The option the CLOSED trigger states. The live list wins whenever it holds the selection (so
 * the head row keeps re-labelling itself live/last, and ages keep ticking); `external` is the
 * fallback for a fight picked out of an all-time search that the capped list never carried.
 */
export function triggerRow(opts: ScopeOptions, selection: string, external: ScopeOption | null): ScopeOption | null {
  if (opts.head?.value === selection) return opts.head
  const listed = opts.rest.find((o) => o.value === selection)
  if (listed) return listed
  if (external?.value === selection) return external
  return opts.head
}

export function emptyRowText(scope: CombatScope, query: string, results: SearchState | null): string {
  if (!query.trim()) return scope === 'fight' ? 'No fights yet' : 'No zone sessions yet'
  if (scope === 'overall') return `No zone sessions match “${query.trim()}”.`
  if (!results) return 'Searching…'
  return results.corpus > 0
    ? `No fights match “${query.trim()}” — searched ${results.corpus} fights.`
    : `No fights match “${query.trim()}”.`
}
