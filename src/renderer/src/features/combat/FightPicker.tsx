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
 *
 * The pieces: `fightPickerRows.ts` (the row model + derivations), `useFightPicker.ts` (the
 * freeze, the search and the keyboard model), `FightPickerRows.tsx` (the rows themselves).
 */

import { useRef } from 'react'
import { Box, ButtonBase, ClickAwayListener, InputBase, Paper, Popper, Stack, Typography } from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import { formatRate } from '../../lib/formatRate'
import {
  EmptyRow,
  FreezeNote,
  LoadMoreRow,
  Row,
  SearchMoreNote,
  SelectorRow
} from './FightPickerParts'
import { rowTiming } from './fightPickerRows'
import { useFightPicker, type PickerState } from './useFightPicker'
import type { CombatScope, ScopeOptions } from './dashboardData'

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

/** The CLOSED trigger: a state readout of the selection, with the Select's old silhouette. */
function PickerTrigger({
  anchorRef,
  p,
  scope,
  disabled,
  now,
  emptyLabel
}: {
  anchorRef: React.RefObject<HTMLButtonElement>
  p: PickerState
  scope: CombatScope
  disabled: boolean
  now: number
  emptyLabel: string
}): React.JSX.Element {
  const current = p.current
  return (
    <ButtonBase
      ref={anchorRef}
      data-testid="segment-select"
      disabled={disabled}
      aria-haspopup="listbox"
      aria-expanded={p.open}
      onClick={() => p.setOpen(!p.open)}
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
  )
}

/** The query box. `autoFocus` is what makes the popover typeable the instant it opens. */
function PickerSearchBar({ p, scope }: { p: PickerState; scope: CombatScope }): React.JSX.Element {
  return (
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
        value={p.query}
        onChange={(e) => p.setQuery(e.target.value)}
        placeholder={scope === 'fight' ? 'Search fights — mob or zone…' : 'Filter zone sessions…'}
        inputProps={{
          'data-testid': 'fight-search',
          role: 'combobox',
          'aria-expanded': true,
          'aria-controls': 'fight-picker-list',
          'aria-autocomplete': 'list',
          'aria-activedescendant': p.clampedActive >= 0 ? `fight-picker-row-${p.clampedActive}` : undefined
        }}
        sx={{ fontSize: 13 }}
      />
    </Stack>
  )
}

/** The scrolling list: the freeze note, the rows, and the two housekeeping lines. */
function PickerList({
  p,
  opts,
  scope,
  selection
}: {
  p: PickerState
  opts: ScopeOptions
  scope: CombatScope
  selection: string
}): React.JSX.Element {
  return (
    <Box sx={{ overflowY: 'auto', flexGrow: 1, minHeight: 0, opacity: p.stale ? 0.55 : 1 }}>
      {!p.inSearch && <FreezeNote frozen={p.frozen} live={opts} />}
      <Box
        component="ul"
        ref={p.listRef}
        id="fight-picker-list"
        role="listbox"
        data-testid="fight-picker-list"
        sx={{ listStyle: 'none', m: 0, p: 0.5 }}
      >
        {p.rows.map((r, i) => (
          <Row
            key={`${r.value}|${i}`}
            row={r}
            idx={i}
            active={i === p.clampedActive}
            selected={r.value === selection}
            onHover={() => p.setActive(i)}
            onPick={() => p.commit(r)}
          />
        ))}
        {p.rows.length === 0 && <EmptyRow scope={scope} query={p.query} results={p.results} />}
        <LoadMoreRow show={!p.inSearch && !!p.frozen?.capped} onLoadMore={p.requestMore} />
      </Box>
      <SearchMoreNote scope={scope} inSearch={p.inSearch} results={p.results} />
    </Box>
  )
}

export function FightPicker(props: FightPickerProps): React.JSX.Element {
  const { opts, scope, selection, disabled, now } = props
  const anchorRef = useRef<HTMLButtonElement>(null)
  const p = useFightPicker(props)
  const emptyLabel = scope === 'fight' ? 'No fights yet' : 'No zone sessions yet'

  return (
    <>
      <PickerTrigger anchorRef={anchorRef} p={p} scope={scope} disabled={disabled} now={now} emptyLabel={emptyLabel} />

      <Popper
        open={p.open}
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
            p.setOpen(false)
          }}
        >
          <Paper
            elevation={8}
            data-testid="fight-picker"
            onKeyDown={p.onKeyDown}
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
            <PickerSearchBar p={p} scope={scope} />
            <PickerList p={p} opts={opts} scope={scope} selection={selection} />
          </Paper>
        </ClickAwayListener>
      </Popper>
    </>
  )
}
