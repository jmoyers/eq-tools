// SuggestAlertsDialog — the one-click "add an alert" surface (Task #38, redesigned).
//
// The user's intent: "integrate spell database info into alerts — discover frequently used
// spells, debuffs, buffs, and suggest the exact setup for how they can use alerts. Easy to
// use, search-to-select, one-click." Then, after living with it (docs/plans/
// suggest-dialog-redesign.md): "rogue slows should not be exceptional — part of add
// suggestion; search should be comprehensive (level, type, name, spell text); group results
// sensibly; more compact so things fit on screen."
//
// So this dialog is now ONE box over EVERYTHING the app can offer:
//   - a TOKENIZED search (shared/spellSearch.ts): bare text matches the spell's own words —
//     name, rank names and its three message texts — so "slower" finds a spell by its landing
//     emote; `level:25` / `level:20-30`, `class:shm`, `type:buff|debuff|illusion|poison|seen`
//     narrow it, AND-composed. No invented effect taxonomy anywhere (world-model law 1).
//   - SECTIONS in the order that matches how you actually pick an alert (SuggestResults.tsx):
//     "From your fights" (what the log has seen, plus the observed rogue-slow offer that used
//     to be a strip in AlertsView), "Ready-made sets", then Buffs · Debuffs · Illusions ·
//     Poisons.
//   - DENSE single-line rows (SpellSuggestionRow.tsx) with the one-click template chips —
//     each chip authors the EXACT alert whose trigger the spell DB can actually fire
//     (suggestions.ts), saves it immediately, and offers an Undo on the snackbar.
//
// GEOMETRY THAT HOLDS STILL (the search-perf fix, kept intact): the paper has a FIXED height,
// the result list scrolls inside it, rows answer a DEFERRED query and are memoized, and at most
// MAX_ROWS of them are mounted across all sections. Everything above is built ON those rules.
//
// Idempotency: each suggestion has a STABLE id (`suggest:<spellKey>:<template>`, illusion is
// the shared `suggest:illusion:fade`). An already-created suggestion renders as a checked,
// disabled chip so re-opening the wizard shows what's done.

import {
  type JSX,
  type RefObject,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  InputAdornment,
  Snackbar,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import EditNoteIcon from '@mui/icons-material/EditNote'
import type { AlertDef, PoisonSlowRecency, SpellCatalog } from '@shared/types'
import { VERIFIED_ALERT_GROUPS, type AlertGroup } from '@shared/alertGroups'
import { tokenizeSpellQuery, type SpellSearchToken } from '@shared/spellSearch'
import { illusionSuggestion, type Suggestion } from './suggestions'
import type { RowContext } from './SpellSuggestionRow'
import SuggestResults, { type ResultsHandlers, type SectionState } from './SuggestResults'
import { buildSuggestResults, filterAlertGroups } from './resultSections'
import { usePoisonSlowOffers, useResolvedClasses, useSpellLines } from './lineIntel'

/** Title row: what this dialog is, how big the catalog is, and the manual escape hatch. */
function SuggestHeader({
  catalog,
  onCreateManually
}: {
  catalog: SpellCatalog | null
  onCreateManually: () => void
}): JSX.Element {
  return (
    <DialogTitle sx={{ pb: 0.5, pt: 1.5 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <AutoAwesomeIcon fontSize="small" color="primary" />
        <span>Add an alert</span>
        {catalog && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
            {catalog.total} spells · {catalog.withUsage} you&apos;ve used
          </Typography>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Button size="small" variant="outlined" startIcon={<EditNoteIcon />} onClick={onCreateManually}>
          Create manually
        </Button>
      </Stack>
    </DialogTitle>
  )
}

/** The search-to-select box. Typing echoes here; filtering consumes a deferred copy. */
function SearchBox({
  inputRef,
  query,
  onQuery
}: {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  onQuery: (v: string) => void
}): JSX.Element {
  return (
    <TextField
      inputRef={inputRef}
      size="small"
      fullWidth
      placeholder="Search name, spell text, level:25, class:shm, type:debuff…"
      value={query}
      onChange={(e) => onQuery(e.target.value)}
      slotProps={{
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          )
        }
      }}
    />
  )
}

/** "Alert created" confirmation with the Undo affordance. */
function CreatedSnackbar({
  snack,
  onClose,
  onUndo
}: {
  snack: { name: string; id: string } | null
  onClose: () => void
  onUndo: () => void
}): JSX.Element {
  return (
    <Snackbar
      open={!!snack}
      autoHideDuration={6000}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      message={snack ? `Alert created — ${snack.name}` : ''}
      action={
        <Button color="secondary" size="small" onClick={onUndo}>
          Undo
        </Button>
      }
    />
  )
}

/** The catalog fetch plus the search box's state and the TOKENS the rows are filtered by. */
interface SpellSearch {
  catalog: SpellCatalog | null
  searchRef: RefObject<HTMLInputElement | null>
  /** what the input echoes — updates on every keystroke. */
  query: string
  setQuery: (v: string) => void
  /** what the rows answer — React lets this lag while a keystroke is being absorbed. */
  deferredQuery: string
  /** the rows are answering an older query than the box shows. */
  catchingUp: boolean
  /** the DEFERRED query, tokenized once per deferred change (never per row). */
  tokens: SpellSearchToken[]
}

/**
 * Catalog + search. Loads the catalog on open, echoes typing instantly, and tokenizes a
 * DEFERRED copy of the query so a keystroke never waits on the rows (Task #41). The lowercase
 * search surface (`searchText`) is built ONCE in main, so the per-row work stays a substring
 * test — never a per-keystroke lowercase of 1.6k strings.
 */
function useSpellSearch(open: boolean): SpellSearch {
  const [catalog, setCatalog] = useState<SpellCatalog | null>(null)
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    void window.eq.getSpellCatalog().then(setCatalog)
    // Focus the search box on open for search-to-select.
    const t = setTimeout(() => searchRef.current?.focus(), 120)
    return () => clearTimeout(t)
  }, [open])

  const deferredQuery = useDeferredValue(query)
  const tokens = useMemo(() => tokenizeSpellQuery(deferredQuery), [deferredQuery])

  return { catalog, searchRef, query, setQuery, deferredQuery, catchingUp: query !== deferredQuery, tokens }
}

/** No section is collapsed to begin with — the redesign's point is that everything is visible. */
const NONE: ReadonlySet<string> = new Set<string>()

/** Per-section fold state. A live search overrides it (SuggestResults `isOpen`). */
function useSectionState(searching: boolean): SectionState {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NONE)
  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])
  return { collapsed, toggle, searching }
}

export default function SuggestAlertsDialog({
  open,
  alerts,
  poisonSlowSeen,
  onClose,
  onCreate,
  onDelete,
  onCreateManually,
  spellLastCast
}: {
  open: boolean
  /** every stored alert: the created/checked state AND the poison-slow offer's coverage test. */
  alerts: readonly AlertDef[]
  /** the alerts module's rogue-slow observation, or null — drives the offer in "From your fights". */
  poisonSlowSeen: PoisonSlowRecency | null
  onClose: () => void
  /** Persist a new alert (returns after the write). */
  onCreate: (def: AlertDef) => Promise<void>
  /** Delete an alert by id (the Undo path). */
  onDelete: (id: string) => Promise<void>
  /** The 'create manually' escape hatch (Task #54): close the picker + open the blank editor. */
  onCreateManually: () => void
  /** rank-preserving cast recency from the alerts module — picks each row's target rank. */
  spellLastCast: Record<string, number>
}): JSX.Element {
  const [snack, setSnack] = useState<{ name: string; id: string } | null>(null)
  // Everything downstream of the search box reads the DEFERRED tokens — a single raw-`query`
  // read would put the whole row subtree back on the keystroke's critical path.
  const { catalog, searchRef, query, setQuery, deferredQuery, catchingUp, tokens } =
    useSpellSearch(open)
  const state = useSectionState(tokens.length > 0)
  const poisonSlow = usePoisonSlowOffers(alerts, poisonSlowSeen)

  const existingIds = useMemo(() => new Set(alerts.map((a) => a.id)), [alerts])

  const create = useCallback(
    async (s: Suggestion) => {
      await onCreate(s.def)
      setSnack({ name: s.def.name, id: s.def.id })
    },
    [onCreate]
  )

  // One click on a ready-made SET writes every alert it is missing (never re-writes one the
  // user already has), then reports the set — the Undo affordance stays per-click, so it
  // removes the set's first alert; the alert list is the full editor for the rest.
  const createGroup = useCallback(
    async (group: AlertGroup, defs: AlertDef[]) => {
      for (const def of defs) await onCreate(def)
      if (defs[0]) setSnack({ name: `${group.title} (${defs.length})`, id: defs[0].id })
    },
    [onCreate]
  )

  const undo = useCallback(async () => {
    if (!snack) return
    await onDelete(snack.id)
    setSnack(null)
  }, [snack, onDelete])

  // Stable handlers + context: SpellRow is memoized, and a fresh closure or object literal per
  // render would defeat its shallow compare for every mounted row.
  const handlers = useMemo<ResultsHandlers>(
    () => ({
      onCreate: (s) => void create(s),
      onCreateGroup: (g, defs) => void createGroup(g, defs),
      onPersist: (def) => void onCreate(def),
      onDismissOffer: poisonSlow.dismiss
    }),
    [create, createGroup, onCreate, poisonSlow.dismiss]
  )

  const illusion = catalog?.hasIllusions ? illusionSuggestion() : null
  const lines = useSpellLines(catalog, spellLastCast)
  const resolved = useResolvedClasses()
  const ctx = useMemo<RowContext>(() => ({ lines, resolved }), [lines, resolved])

  // A COLLAPSED section mounts no rows and spends none of the shared MAX_ROWS budget, so the
  // fold state is an input to the result build, not just to the render.
  const results = useMemo(
    () => buildSuggestResults(catalog?.entries ?? [], tokens, state.searching ? NONE : state.collapsed),
    [catalog, tokens, state.searching, state.collapsed]
  )
  const groups = useMemo(() => filterAlertGroups(VERIFIED_ALERT_GROUPS, tokens), [tokens])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      // FIXED paper height. The result list swings between MAX_ROWS rows and none as the user
      // types; a content-sized, vertically centred paper re-sizes and re-centres on every
      // keystroke. Height here + a scrolling result list = geometry that never moves.
      slotProps={{ paper: { sx: { height: 'min(85vh, 760px)' } } }}
    >
      <SuggestHeader catalog={catalog} onCreateManually={onCreateManually} />
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, pt: 1 }}>
        <Stack spacing={1} sx={{ flexGrow: 1, minHeight: 0 }}>
          <SearchBox inputRef={searchRef} query={query} onQuery={setQuery} />
          <SuggestResults
            results={results}
            groups={groups}
            offers={poisonSlow.offers}
            illusion={illusion}
            existingIds={existingIds}
            ctx={ctx}
            handlers={handlers}
            state={state}
            query={deferredQuery}
            loaded={catalog != null}
            stale={catchingUp}
          />
        </Stack>
      </DialogContent>

      <CreatedSnackbar snack={snack} onClose={() => setSnack(null)} onUndo={() => void undo()} />
    </Dialog>
  )
}
