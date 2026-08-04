// SuggestAlertsDialog — the one-click "suggested alerts" wizard (Task #38).
//
// The user's intent: "integrate spell database info into alerts — discover frequently used
// spells, debuffs, buffs, and suggest the exact setup for how they can use alerts. Easy to
// use, search-to-select, one-click."
//
// So this dialog:
//   - loads a slim spell CATALOG from main (spells.json + live usage from the buffs model),
//   - lists spells RECENCY-first (Task #45 — used spells sorted by when you last saw them,
//     most recent at the top; tie-broken by usage), a usage badge, then the never-used
//     alphabetical tail, filtered by a fuzzy-ish substring search box,
//   - each row shows the spell name, a buff/debuff chip (+ illusion), and small one-click
//     TEMPLATE chips — each chip authors the EXACT alert whose trigger the spell DB can
//     actually fire (validated against logEvents.ts + the AlertsModule matcher):
//       "wears off (you or pet)" → { event, buffExpired, where:{spell} }  (Beneficial + wears-off
//                                    msg) — the DUAL DEFAULT (Task #47): the buffs module emits a
//                                    RESOLVED buffExpired for a self wears-off AND a pet/target
//                                    fade, so ONE simple trigger covers both sides by default.
//       "fades on pet/target only" → { event, buffFade,   where:{spell} }  (Beneficial, pet side only)
//       "lands on a target"      → { event, buffApply,   where:{spell} }  (Detrimental + cast-on-other)
//       "illusion fades"         → { event, illusionFade }                (shared, illusion spells)
//   - clicking a chip saves the alert immediately and shows an "Alert created — <name>"
//     snackbar with an UNDO (deletes it) — no multi-step forms.
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
import type { AlertDef, SpellCatalog, SpellCatalogEntry } from '@shared/types'
import type { AlertGroup } from '@shared/alertGroups'
import { illusionSuggestion, type Suggestion } from './suggestions'
import AlertGroupsPanel from './AlertGroupsPanel'
import SpellRow, { TemplateChip, type RowContext } from './SpellSuggestionRow'
import { useResolvedClasses, useSpellLines } from './lineIntel'

const MAX_ROWS = 200

/** Title row: what this dialog is, how big the catalog is, and the manual escape hatch. */
function SuggestHeader({
  catalog,
  onCreateManually
}: {
  catalog: SpellCatalog | null
  onCreateManually: () => void
}): JSX.Element {
  return (
    <DialogTitle sx={{ pb: 1 }}>
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
      <Typography variant="caption" color="text.secondary">
        Pick a suggested alert below, or create one manually for full control.
      </Typography>
    </DialogTitle>
  )
}

/** The ONE alert that covers every illusion click-off — offered above the per-spell rows. */
function IllusionBanner({
  created,
  onCreate
}: {
  created: boolean
  onCreate: () => void
}): JSX.Element {
  return (
    <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Illusions
        </Typography>
        <Typography variant="caption" color="text.secondary">
          one alert for any illusion click-off:
        </Typography>
        <TemplateChip label="When your illusion fades" created={created} onClick={onCreate} />
      </Stack>
    </Box>
  )
}

/**
 * The scrolling result list. It fills the dialog's fixed-height paper and scrolls inside, so the
 * paper's geometry is the same whether the list holds MAX_ROWS rows or none.
 *
 * `loaded` gates the "no match" line so an un-hydrated catalog reads as empty, never as "nothing
 * matches". `query` is the DEFERRED query — the one `entries` was actually filtered by, so the
 * empty-state line can never name a string the list has not caught up to. `stale` marks exactly
 * that lag: the rows on screen answer an older query than the box shows.
 */
function SpellResults({
  entries,
  existingIds,
  onCreate,
  query,
  loaded,
  stale,
  ctx
}: {
  entries: SpellCatalogEntry[]
  existingIds: Set<string>
  onCreate: (s: Suggestion) => void
  query: string
  loaded: boolean
  stale: boolean
  ctx: RowContext
}): JSX.Element {
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
      <Stack spacing={0.75}>
        {entries.map((e) => (
          <SpellRow key={e.key} entry={e} existingIds={existingIds} onCreate={onCreate} ctx={ctx} />
        ))}
        {loaded && entries.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
            No spells match “{query}”.
          </Typography>
        )}
      </Stack>
    </Box>
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
      placeholder="Search spells, debuffs, buffs…"
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

/** The catalog fetch plus the search box's state and its filtered result set. */
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
  entries: SpellCatalogEntry[]
}

/**
 * Catalog + search. Loads the catalog on open, echoes typing instantly, and filters the
 * 1,600+-spell list from a DEFERRED copy of the query so a keystroke never waits on the rows
 * (Task #41). The lowercase search key is computed once per catalog load, never per keystroke.
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

  const keyed = useMemo(
    () => (catalog ? catalog.entries.map((e) => ({ e, key: e.name.toLowerCase() })) : []),
    [catalog]
  )

  const entries = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    const rows = q ? keyed.filter((r) => r.key.includes(q)) : keyed
    return rows.slice(0, MAX_ROWS).map((r) => r.e)
  }, [keyed, deferredQuery])

  return {
    catalog,
    searchRef,
    query,
    setQuery,
    deferredQuery,
    catchingUp: query !== deferredQuery,
    entries
  }
}

export default function SuggestAlertsDialog({
  open,
  existingIds,
  onClose,
  onCreate,
  onDelete,
  onCreateManually,
  spellLastCast
}: {
  open: boolean
  /** ids of alerts that already exist — for the checked/disabled state. */
  existingIds: Set<string>
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
  // Everything downstream of the search box reads `deferredQuery` — a single raw-`query` read
  // would put the whole row subtree back on the keystroke's critical path.
  const { catalog, searchRef, query, setQuery, deferredQuery, catchingUp, entries } =
    useSpellSearch(open)

  const create = useCallback(
    async (s: Suggestion) => {
      await onCreate(s.def)
      setSnack({ name: s.def.name, id: s.def.id })
    },
    [onCreate]
  )

  // Stable handler + context: SpellRow is memoized, and a fresh closure or object literal per
  // render would defeat its shallow compare for every mounted row.
  const createNow = useCallback(
    (s: Suggestion) => {
      void create(s)
    },
    [create]
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

  const illusion = catalog?.hasIllusions ? illusionSuggestion() : null
  const lines = useSpellLines(catalog, spellLastCast)
  const resolved = useResolvedClasses()
  const ctx = useMemo<RowContext>(() => ({ lines, resolved }), [lines, resolved])

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
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Stack spacing={1.5} sx={{ flexGrow: 1, minHeight: 0 }}>
          <SearchBox inputRef={searchRef} query={query} onQuery={setQuery} />

          <AlertGroupsPanel
            existingIds={existingIds}
            onCreate={(g, defs) => void createGroup(g, defs)}
          />

          {illusion && (
            <IllusionBanner
              created={existingIds.has(illusion.def.id)}
              onCreate={() => void create(illusion)}
            />
          )}

          <SpellResults
            entries={entries}
            existingIds={existingIds}
            onCreate={createNow}
            query={deferredQuery}
            loaded={catalog != null}
            stale={catchingUp}
            ctx={ctx}
          />
        </Stack>
      </DialogContent>

      <CreatedSnackbar snack={snack} onClose={() => setSnack(null)} onUndo={() => void undo()} />
    </Dialog>
  )
}
