// The FightPicker's presentational rows: the dense selector row (used BOTH as a menu row and as
// the closed trigger), the <li> that wraps it, and the quiet housekeeping lines that ride above
// and below the list. Split out of FightPicker.tsx — the picker is then its state and its shell.

import { Box, Stack, Typography } from '@mui/material'
import type { CombatScope, ScopeOptions } from './dashboardData'
import {
  RENDER_CAP,
  SEARCH_LIMIT,
  emptyRowText,
  type FrozenList,
  type PickerRow,
  type SearchState
} from './fightPickerRows'

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
}): React.JSX.Element {
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

export function Row({
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
}): React.JSX.Element {
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

/**
 * The quiet line at the top of a FROZEN list, and only when the world has actually moved on: it
 * states what is waiting (N new fights), never how the freeze works. When nothing has changed
 * there is nothing to say, so nothing is rendered.
 */
export function FreezeNote({ frozen, live }: { frozen: FrozenList | null; live: ScopeOptions }): React.JSX.Element | null {
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

/** The empty-list line: what was searched, and through how much. */
export function EmptyRow({
  scope,
  query,
  results
}: {
  scope: CombatScope
  query: string
  results: SearchState | null
}): React.JSX.Element {
  return (
    <Box component="li" sx={{ px: 1.25, py: 1 }}>
      <Typography variant="caption" color="text.secondary">
        {emptyRowText(scope, query, results)}
      </Typography>
    </Box>
  )
}

/**
 * "Load more fights…" — the ONE sanctioned thaw of the frozen list. Housekeeping rows carry NO
 * `data-value`: they are not segments, and both the e2e harness and the overlay read the
 * selectable set as `li[data-value]`.
 */
export function LoadMoreRow({ show, onLoadMore }: { show: boolean; onLoadMore: () => void }): React.JSX.Element | null {
  if (!show) return null
  return (
    <Box
      component="li"
      data-testid="fight-loadmore"
      onClick={onLoadMore}
      sx={{ px: 1.25, py: 0.75, borderRadius: 1, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
    >
      <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
        Load more fights…
      </Typography>
    </Box>
  )
}

/** How many hits the query found beyond what the list actually mounts. */
export function SearchMoreNote({
  scope,
  inSearch,
  results
}: {
  scope: CombatScope
  inSearch: boolean
  results: SearchState | null
}): React.JSX.Element | null {
  if (scope !== 'fight' || !inSearch || !results || results.hits.length <= RENDER_CAP) return null
  return (
    <Box data-testid="fight-search-more" sx={{ px: 1.25, py: 0.75 }}>
      <Typography variant="caption" sx={{ color: 'text.disabled' }}>
        +{results.hits.length - RENDER_CAP}
        {results.hits.length >= SEARCH_LIMIT ? '+' : ''} more — refine your search
      </Typography>
    </Box>
  )
}
