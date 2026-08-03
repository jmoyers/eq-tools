/**
 * FightPicker — the Combat tab's fight/zone-session selector, as a searchable popover.
 *
 * It replaces the MUI `Select` that used to sit in the header's SUBJECT line. The trigger is
 * deliberately unchanged (the same dense two-line row: name + live dot over the dim
 * disambiguation timing, and no rate — the headline stat at the right edge of that line owns
 * the number). What changed is what opens: a browse list you can now TYPE into, so a fight from
 * earlier in the week is one query away instead of a scroll through a hundred rows.
 *
 * ── THE TWO PROBLEMS THIS SOLVES ─────────────────────────────────────────────────────────
 *
 * 1. LOOKUP. The snapshot only carries the newest `maxSegments` fights, so history beyond that
 *    cap was reachable only by paging "Load more" over and over. A non-empty query goes to the
 *    main process instead (`window.eq.searchFights`) and searches ALL-TIME fights — the browse
 *    list stays the recent-first list you already had, the query is the whole log.
 *
 * 2. CHURN — "when the fights are changing live in the game and I'm in the search menu it gets
 *    all confused as it's switching". The snapshot ticks ~4x/sec while you fight, and every tick
 *    rebuilds the option rows: a fight finalizes and the head row relabels itself from
 *    "Current fight (live)" to "Last fight — …", the previous head drops into the history under
 *    its own id, ages tick over, and every row below shifts down by one. Under a pointer that is
 *    a moving target; mid-keystroke it is a list that re-sorts under the caret.
 *
 * ── THE FREEZE (the fix) ─────────────────────────────────────────────────────────────────
 *
 * The moment the popover opens, the browse list is SNAPSHOT — head row, history rows, and the
 * `now` the relative ages are measured against — and only that frozen copy is rendered until
 * close. Nothing a live tick does can reorder, insert, remove or relabel a row while the list is
 * open. The TRIGGER behind the popover keeps updating (it is the app's live state readout, not a
 * hit target), and the list thaws on close, so the next open shows the world as it is then. If
 * fights finalized while you were looking, ONE quiet line at the top of the list says how many
 * are waiting — state, not an explanation of the mechanism.
 *
 * The one sanctioned thaw is explicit: clicking "Load more fights…" asks for a bigger page, so
 * the list re-freezes ONCE when that larger page arrives. That is the user moving the ground,
 * not the game.
 *
 * Selection is by id (or the `__live__` sentinel), never by list position, so a fight that
 * finalized while the menu was open still selects correctly — and the sentinel row keeps its
 * "whatever the head row is now" semantics untouched.
 *
 * ── STALE RESULTS ────────────────────────────────────────────────────────────────────────
 *
 * Search is async and debounced, so responses can land out of order ("giant" resolving after
 * "giant sk"). Every request carries a sequence number; a response whose sequence is not the
 * latest is DISCARDED rather than rendered. Closing the popover bumps the sequence too, so an
 * in-flight response can never repopulate a list that is no longer open.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, ButtonBase, ClickAwayListener, InputBase, Paper, Popper, Stack, Typography } from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import { formatDate, formatTime } from '../../lib/formatDate'
import { formatRate } from '../../lib/formatRate'
import { normalizeQuery } from '../../lib/search'
import { fmtDur } from './combatShared'
import type { CombatScope, ScopeOption, ScopeOptions } from './dashboardData'

/**
 * The search contract lives with the sibling-owned main/preload code. Deriving the shape from
 * the bridge method itself (rather than re-importing a named type) keeps this file honest about
 * where the truth is, and immune to where that type happens to be declared.
 */
type FightHit = Awaited<ReturnType<typeof window.eq.searchFights>>['hits'][number]

/** How long a keystroke rests before it costs an IPC round-trip. */
const DEBOUNCE_MS = 120
/** How many hits we ask the engine for. Beyond this the query is simply too broad to read. */
const SEARCH_LIMIT = 500
/** How many result rows we actually MOUNT. The rest are a count, not a scroll marathon. */
const RENDER_CAP = 100

// ── row model ──────────────────────────────────────────────────────────────────────────

/** One rendered row — browse and search rows collapse to the same shape, so the list is one list. */
interface PickerRow {
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

/**
 * A dense selector row (Task #54): fight/zone name + rate on the top line, disambiguation
 * timing (start clock · relative age · duration) on a small second line — so five same-named
 * giant pulls are tellable apart at a glance. Used BOTH as a menu row and as the CLOSED
 * trigger, so what you pick is exactly what you then read.
 *
 * `hideRate` is the one place the two uses diverge, and only because the SUBJECT line ends in a
 * headline stat block: inside the MENU the rate is load-bearing (it is how you compare one pull
 * against another before picking), but on the CLOSED trigger it would print the selected fight's
 * dps twice in the same bar, a few hundred pixels apart. The headline owns that number; the
 * trigger keeps identity + timing.
 *
 * The timing line is the dimmest text on screen. `live` gets the accent DOT the overlay's
 * OverlaySelect uses — it replaced a '▶' glyph that read as a play button, i.e. as a control.
 */
export function SelectorRow({
  name,
  rate,
  timing,
  live,
  hideRate
}: {
  name: string
  rate: string
  timing: string
  live?: boolean
  hideRate?: boolean
}): JSX.Element {
  return (
    <Box sx={{ minWidth: 0, width: '100%', py: 0.25 }}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
        {live && <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'success.main', flexShrink: 0 }} />}
        <Typography variant="body2" noWrap sx={{ fontWeight: 600, flexGrow: 1, minWidth: 0 }}>
          {name}
        </Typography>
        {!hideRate && (
          <Typography
            variant="caption"
            sx={{ whiteSpace: 'nowrap', color: 'primary.main', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
          >
            {rate}
          </Typography>
        )}
      </Stack>
      <Typography variant="caption" noWrap sx={{ display: 'block', color: 'text.disabled', fontSize: 10.5 }}>
        {timing}
      </Typography>
    </Box>
  )
}

// ── the frozen browse list ─────────────────────────────────────────────────────────────

/**
 * The list as it was when the popover opened. `now` is frozen along with the rows: the relative
 * ages are part of a row's TEXT, and a row that relabels itself from 'just now' to '1m ago'
 * under the pointer is the same churn as one that moves.
 */
interface FrozenList {
  head: ScopeOption | null
  rest: ScopeOption[]
  now: number
  /** the "Load more fights…" affordance was applicable at freeze time. */
  capped: boolean
}

/** Deep copy — ScopeOption is flat, so a per-row spread genuinely detaches from the live array. */
function freezeOptions(opts: ScopeOptions, now: number, capped: boolean): FrozenList {
  return {
    head: opts.head ? { ...opts.head } : null,
    rest: opts.rest.map((o) => ({ ...o })),
    now,
    capped
  }
}

interface SearchState {
  /** the query these hits answer — the guard against rendering them under a newer one. */
  query: string
  hits: FightHit[]
  /** how many fights the engine searched, so an empty result can say what it looked through. */
  corpus: number
}

// ── the picker ─────────────────────────────────────────────────────────────────────────

export interface FightPickerProps {
  /** the LIVE scope-filtered rows. Read for the trigger every tick; FROZEN for the open list. */
  opts: ScopeOptions
  scope: CombatScope
  /** the current selection value (a segment id, or the `__live__` sentinel). */
  selection: string
  onSelect: (value: string) => void
  /** bump the finalized-fight page size (the "Load more fights…" row). */
  onLoadMore: () => void
  /** the snapshot's fight list is at the cap, so history is probably being truncated. */
  capped: boolean
  /** hydrating — the list is a churning replay artifact, so don't invite a pick from it. */
  disabled: boolean
  /** the render's single `now`, so every age label in the header agrees. */
  now: number
}

export function FightPicker({
  opts,
  scope,
  selection,
  onSelect,
  onLoadMore,
  capped,
  disabled,
  now
}: FightPickerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [frozen, setFrozen] = useState<FrozenList | null>(null)
  const [active, setActive] = useState(0)
  const [results, setResults] = useState<SearchState | null>(null)
  /** A pick the live option list cannot describe (a search hit older than the snapshot's cap). */
  const [external, setExternal] = useState<ScopeOption | null>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  /** Latest issued search. A response carrying anything else is stale and must be dropped. */
  const seqRef = useRef(0)
  /** An explicit "Load more" is the ONE sanctioned thaw; this arms the single re-freeze. */
  const wantMoreRef = useRef(false)
  // The live values are read through refs inside effects so a snapshot tick (which hands us a
  // brand-new `opts` object every ~250ms) can never re-run the effect that does the freezing.
  const optsRef = useRef(opts)
  const nowRef = useRef(now)
  const cappedRef = useRef(capped)
  optsRef.current = opts
  nowRef.current = now
  cappedRef.current = capped

  // THE FREEZE. Depends on `open` alone — opening takes exactly one snapshot, closing drops it.
  useEffect(() => {
    if (!open) {
      // A response still in flight must not repopulate a closed list.
      seqRef.current += 1
      wantMoreRef.current = false
      setFrozen(null)
      setResults(null)
      setQuery('')
      return
    }
    setActive(0)
    setFrozen(freezeOptions(optsRef.current, nowRef.current, cappedRef.current))
  }, [open])

  // The sanctioned thaw: after an explicit "Load more", adopt the bigger page ONCE.
  useEffect(() => {
    if (!open || !wantMoreRef.current) return
    if (opts.rest.length <= (frozen?.rest.length ?? 0)) return
    wantMoreRef.current = false
    setFrozen(freezeOptions(opts, nowRef.current, cappedRef.current))
  }, [open, opts, frozen])

  // Hydration can start under an open menu (a re-scan on character change); the list it was
  // showing is no longer meaningful, so close rather than sit on a replay artifact.
  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled, open])

  // SEARCH — fight scope only; see `overallMatches` for why Overall filters client-side.
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
          // STALE GUARD: an earlier query resolving after a later one is discarded outright.
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
  }, [open, scope, query])

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

  // What the CLOSED trigger states — read from the LIVE options, not the frozen copy, because
  // the trigger is a state readout and must stay honest while the menu is open above it.
  const current = triggerRow(opts, selection, external)
  const emptyLabel = scope === 'fight' ? 'No fights yet' : 'No zone sessions yet'

  return (
    <>
      <ButtonBase
        ref={anchorRef}
        data-testid="segment-select"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        sx={{
          minWidth: 0,
          flexShrink: 1,
          justifyContent: 'flex-start',
          textAlign: 'left',
          borderRadius: 1,
          py: 0.25,
          pl: 0.75,
          pr: '24px',
          // The caret sits where the Select's did, so the control's silhouette is unchanged.
          position: 'relative',
          '&::after': {
            content: '""',
            position: 'absolute',
            right: 7,
            top: '50%',
            marginTop: '-2px',
            borderLeft: '4px solid transparent',
            borderRight: '4px solid transparent',
            borderTop: '4px solid currentColor',
            opacity: 0.5
          },
          '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
          '&.Mui-disabled': { opacity: 0.5 }
        }}
      >
        {current ? (
          <SelectorRow
            name={current.label}
            rate={formatRate(current.dps)}
            timing={rowTiming(current, scope, now)}
            live={current.live}
            hideRate
          />
        ) : (
          <Typography variant="body2" sx={{ color: 'text.disabled', py: 0.25 }}>
            {emptyLabel}
          </Typography>
        )}
      </ButtonBase>

      <Popper
        open={open}
        anchorEl={anchorRef.current}
        placement="bottom-start"
        sx={{ zIndex: (t) => t.zIndex.modal }}
        modifiers={[{ name: 'offset', options: { offset: [0, 4] } }]}
      >
        <ClickAwayListener
          // The trigger owns its own toggle; letting click-away ALSO fire for it would race the
          // button's onClick and make the second click re-open what the first just closed.
          onClickAway={(e) => {
            if (anchorRef.current?.contains(e.target as Node)) return
            setOpen(false)
          }}
        >
          <Paper
            elevation={8}
            data-testid="fight-picker"
            onKeyDown={onKeyDown}
            sx={{
              width: 'min(480px, 90vw)',
              maxHeight: '60vh',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              border: '1px solid',
              borderColor: 'divider'
            }}
          >
            <Stack
              direction="row"
              spacing={0.75}
              alignItems="center"
              sx={{ px: 1, py: 0.5, borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }}
            >
              <SearchIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
              <InputBase
                autoFocus
                fullWidth
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={scope === 'fight' ? 'Search fights — mob or zone…' : 'Filter zone sessions…'}
                inputProps={{
                  'data-testid': 'fight-search',
                  role: 'combobox',
                  'aria-expanded': true,
                  'aria-controls': 'fight-picker-list',
                  'aria-autocomplete': 'list',
                  'aria-activedescendant': clampedActive >= 0 ? `fight-picker-row-${clampedActive}` : undefined
                }}
                sx={{ fontSize: 13 }}
              />
            </Stack>

            <Box sx={{ overflowY: 'auto', flexGrow: 1, minHeight: 0, opacity: stale ? 0.55 : 1 }}>
              {!inSearch && <FreezeNote frozen={frozen} live={opts} />}
              <Box
                component="ul"
                ref={listRef}
                id="fight-picker-list"
                role="listbox"
                data-testid="fight-picker-list"
                sx={{ listStyle: 'none', m: 0, p: 0.5 }}
              >
                {rows.map((r, i) => (
                  <Row
                    key={`${r.value}|${i}`}
                    row={r}
                    idx={i}
                    active={i === clampedActive}
                    selected={r.value === selection}
                    onHover={() => setActive(i)}
                    onPick={() => commit(r)}
                  />
                ))}
                {rows.length === 0 && (
                  <Box component="li" sx={{ px: 1.25, py: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {emptyRowText(scope, query, results)}
                    </Typography>
                  </Box>
                )}
                {/* Housekeeping rows carry NO `data-value` — they are not segments, and both the
                    e2e harness and the overlay read the selectable set as `li[data-value]`. */}
                {!inSearch && frozen?.capped && (
                  <Box
                    component="li"
                    data-testid="fight-loadmore"
                    onClick={() => {
                      wantMoreRef.current = true
                      onLoadMore()
                    }}
                    sx={{ px: 1.25, py: 0.75, borderRadius: 1, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                  >
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                      Load more fights…
                    </Typography>
                  </Box>
                )}
              </Box>
              {scope === 'fight' && inSearch && results && results.hits.length > RENDER_CAP && (
                <Box data-testid="fight-search-more" sx={{ px: 1.25, py: 0.75 }}>
                  <Typography variant="caption" sx={{ color: 'text.disabled' }}>
                    +{results.hits.length - RENDER_CAP}
                    {results.hits.length >= SEARCH_LIMIT ? '+' : ''} more — refine your search
                  </Typography>
                </Box>
              )}
            </Box>
          </Paper>
        </ClickAwayListener>
      </Popper>
    </>
  )
}

/**
 * The quiet line at the top of a FROZEN list, and only when the world has actually moved on: it
 * states what is waiting (N new fights), never how the freeze works. When nothing has changed
 * there is nothing to say, so nothing is rendered.
 */
function FreezeNote({ frozen, live }: { frozen: FrozenList | null; live: ScopeOptions }): JSX.Element | null {
  if (!frozen) return null
  const known = new Set(frozen.rest.map((o) => o.value))
  if (frozen.head) known.add(frozen.head.value)
  const fresh = live.rest.filter((o) => !known.has(o.value)).length
  if (fresh === 0) return null
  return (
    <Box sx={{ px: 1.25, pt: 0.75, pb: 0.25 }}>
      <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: 10.5 }}>
        {fresh} new fight{fresh === 1 ? '' : 's'} — they appear when you close this list.
      </Typography>
    </Box>
  )
}

function Row({
  row,
  idx,
  active,
  selected,
  onHover,
  onPick
}: {
  row: PickerRow
  idx: number
  active: boolean
  selected: boolean
  onHover: () => void
  onPick: () => void
}): JSX.Element {
  return (
    <Box
      component="li"
      id={`fight-picker-row-${idx}`}
      role="option"
      aria-selected={selected}
      data-value={row.value}
      data-idx={idx}
      onMouseEnter={onHover}
      onClick={onPick}
      sx={{
        px: 1,
        py: 0.25,
        borderRadius: 1,
        cursor: 'pointer',
        bgcolor: active ? 'action.hover' : selected ? 'action.selected' : 'transparent',
        // The pinned head row is separated from history by a hairline — the Select's menu implied
        // that boundary by ordering alone, which a searchable list can no longer rely on.
        ...(row.head ? { mb: 0.5, pb: 0.5, borderBottom: '1px solid', borderColor: 'divider' } : null)
      }}
    >
      <SelectorRow name={row.label} rate={row.rate} timing={row.timing} live={row.live} />
      {row.zone && (
        <Typography variant="caption" noWrap sx={{ display: 'block', color: 'text.disabled', fontSize: 10.5 }}>
          {row.zone}
        </Typography>
      )}
    </Box>
  )
}

// ── row derivation ─────────────────────────────────────────────────────────────────────

/** The running zone session has no end yet, so it has no duration to disambiguate by. */
function rowTiming(o: ScopeOption, scope: CombatScope, now: number): string {
  return o.live && scope === 'overall' ? 'live' : timingLabel(o.startTs, o.durationSec, now)
}

/** The FROZEN browse list, head row pinned first. Empty until the popover opens. */
function browseList(frozen: FrozenList | null, scope: CombatScope): PickerRow[] {
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
function hitRow(h: FightHit): PickerRow {
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
function triggerRow(opts: ScopeOptions, selection: string, external: ScopeOption | null): ScopeOption | null {
  if (opts.head?.value === selection) return opts.head
  const listed = opts.rest.find((o) => o.value === selection)
  if (listed) return listed
  if (external?.value === selection) return external
  return opts.head
}

function emptyRowText(scope: CombatScope, query: string, results: SearchState | null): string {
  if (!query.trim()) return scope === 'fight' ? 'No fights yet' : 'No zone sessions yet'
  if (scope === 'overall') return `No zone sessions match “${query.trim()}”.`
  if (!results) return 'Searching…'
  return results.corpus > 0
    ? `No fights match “${query.trim()}” — searched ${results.corpus} fights.`
    : `No fights match “${query.trim()}”.`
}
