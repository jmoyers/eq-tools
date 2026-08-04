// SuggestResults — the suggest dialog's scrolling body: six sections in one scroll box.
//
// docs/plans/suggest-dialog-redesign.md §2. Order is the point: what the app has SEEN, then
// what it can offer ready-made, then the whole spell book by type. Everything below the search
// box lives inside ONE scroller so the sticky section headers work and the dialog's fixed-height
// paper (the search-perf fix) never re-sizes — the geometry is identical with 200 rows or none.
//
// THE STALE DIM IS THE PERF FIX'S, KEPT VERBATIM: the rows answer the DEFERRED query, so while
// React is absorbing a keystroke the list on screen is one query behind. Dimming it says so.

import type { JSX } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import type { AlertDef } from '@shared/types'
import type { AlertGroup } from '@shared/alertGroups'
import type { PoisonSlowOffer as Offer } from '@shared/spellLines'
import AlertGroupsPanel from './AlertGroupsPanel'
import PoisonSlowOffer from './PoisonSlowOffer'
import { IllusionAction, SectionShell, SpellRows } from './SuggestSections'
import type { RowContext } from './SpellSuggestionRow'
import type { Suggestion } from './suggestions'
import type { ResultSection, SuggestResults as Results } from './resultSections'

/** Everything the sections can DO, gathered so each section takes one stable prop. */
export interface ResultsHandlers {
  /** create one suggested alert (a row's template chip, the illusion chip). */
  onCreate: (s: Suggestion) => void
  /** create every alert a ready-made set is missing. */
  onCreateGroup: (group: AlertGroup, defs: AlertDef[]) => void
  /** persist one def verbatim (the poison-slow offer's idempotent create). */
  onPersist: (def: AlertDef) => void
  /** hide an offer for good. */
  onDismissOffer: (id: string) => void
}

/** Collapse state, shared by every section. */
export interface SectionState {
  collapsed: ReadonlySet<string>
  toggle: (id: string) => void
  /** a live query forces every matching section open and hides the empty ones (§2). */
  searching: boolean
}

/** Is this section open right now? A search overrides the user's manual folds. */
function isOpen(state: SectionState, id: string): boolean {
  return state.searching || !state.collapsed.has(id)
}

/**
 * "From your fights" — the observation-driven top of the dialog: the offers the app has earned
 * by watching (today, the rogue-slow one) and every spell the log has actually seen, in the
 * catalog's recency order.
 *
 * The OFFER is hidden while a query is active: a search is a question about spells, and an
 * offer card sitting above the answer is noise. It is never dismissed by that — it comes back
 * the moment the box is cleared.
 */
function FightsSection({
  section,
  offers,
  existingIds,
  ctx,
  handlers,
  state
}: {
  section: ResultSection
  offers: Offer[]
  existingIds: Set<string>
  ctx: RowContext
  handlers: ResultsHandlers
  state: SectionState
}): JSX.Element | null {
  const showOffer = !state.searching && offers.length > 0
  if (section.total === 0 && !showOffer) return null
  return (
    <SectionShell
      title={section.title}
      count={section.total}
      open={isOpen(state, section.id)}
      onToggle={() => state.toggle(section.id)}
    >
      {showOffer && (
        <Box sx={{ px: 0.5, pb: 0.5 }}>
          <PoisonSlowOffer
            offers={offers}
            onPersist={handlers.onPersist}
            onDismiss={handlers.onDismissOffer}
          />
        </Box>
      )}
      <SpellRows
        rows={section.rows}
        total={section.total}
        existingIds={existingIds}
        onCreate={handlers.onCreate}
        ctx={ctx}
        showType
      />
    </SectionShell>
  )
}

/** The four type sections. Empty ones are not rendered at all (§2). */
function SpellSections({
  sections,
  existingIds,
  ctx,
  handlers,
  state,
  illusion,
  illusionCreated
}: {
  sections: ResultSection[]
  existingIds: Set<string>
  ctx: RowContext
  handlers: ResultsHandlers
  state: SectionState
  /** the ONE alert that covers every illusion click-off, offered on the Illusions header. */
  illusion: Suggestion | null
  illusionCreated: boolean
}): JSX.Element {
  return (
    <>
      {sections
        .filter((s) => s.total > 0)
        .map((s) => (
          <SectionShell
            key={s.id}
            title={s.title}
            count={s.total}
            open={isOpen(state, s.id)}
            onToggle={() => state.toggle(s.id)}
            action={
              s.id === 'illusions' && illusion ? (
                <IllusionAction
                  created={illusionCreated}
                  onCreate={() => handlers.onCreate(illusion)}
                />
              ) : undefined
            }
          >
            <SpellRows
              rows={s.rows}
              total={s.total}
              existingIds={existingIds}
              onCreate={handlers.onCreate}
              ctx={ctx}
            />
          </SectionShell>
        ))}
    </>
  )
}

export default function SuggestResults({
  results,
  groups,
  offers,
  illusion,
  existingIds,
  ctx,
  handlers,
  state,
  query,
  loaded,
  stale
}: {
  results: Results
  /** the ready-made sets that survive the query (empty ⇒ the section is hidden). */
  groups: AlertGroup[]
  offers: Offer[]
  illusion: Suggestion | null
  existingIds: Set<string>
  ctx: RowContext
  handlers: ResultsHandlers
  state: SectionState
  /** the DEFERRED query — the one the rows actually answer, so the empty line can't lie. */
  query: string
  loaded: boolean
  stale: boolean
}): JSX.Element {
  const empty = loaded && results.matched === 0 && groups.length === 0
  return (
    <Box
      sx={{
        flexGrow: 1,
        minHeight: 0,
        overflow: 'auto',
        opacity: stale ? 0.6 : 1,
        transition: 'opacity 120ms ease-out'
      }}
    >
      <Stack spacing={0.5}>
        <FightsSection
          section={results.fights}
          offers={offers}
          existingIds={existingIds}
          ctx={ctx}
          handlers={handlers}
          state={state}
        />
        {groups.length > 0 && (
          <SectionShell
            title="Ready-made sets"
            count={groups.length}
            open={isOpen(state, 'sets')}
            onToggle={() => state.toggle('sets')}
          >
            <AlertGroupsPanel
              groups={groups}
              existingIds={existingIds}
              onCreate={handlers.onCreateGroup}
            />
          </SectionShell>
        )}
        <SpellSections
          sections={results.sections}
          existingIds={existingIds}
          ctx={ctx}
          handlers={handlers}
          state={state}
          illusion={illusion}
          illusionCreated={illusion ? existingIds.has(illusion.def.id) : false}
        />
        {empty && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            Nothing matches “{query}”.
          </Typography>
        )}
      </Stack>
    </Box>
  )
}
