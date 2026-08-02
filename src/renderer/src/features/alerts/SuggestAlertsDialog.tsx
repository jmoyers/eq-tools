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

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  InputAdornment,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import SearchIcon from '@mui/icons-material/Search'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import EditNoteIcon from '@mui/icons-material/EditNote'
import type { AlertDef, SpellCatalog, SpellCatalogEntry } from '@shared/types'
import {
  SUGGEST_TEMPLATES,
  illusionSuggestion,
  suggestionsFor,
  type Suggestion
} from './suggestions'

const MAX_ROWS = 200

/** Coarse relative-time label for the usage tooltip's "last seen" (Task #45 recency hint). */
function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}

export default function SuggestAlertsDialog({
  open,
  existingIds,
  onClose,
  onCreate,
  onDelete,
  onCreateManually
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
}): JSX.Element {
  const [catalog, setCatalog] = useState<SpellCatalog | null>(null)
  const [query, setQuery] = useState('')
  const [snack, setSnack] = useState<{ name: string; id: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    void window.eq.getSpellCatalog().then(setCatalog)
    // Focus the search box on open for search-to-select.
    const t = setTimeout(() => searchRef.current?.focus(), 120)
    return () => clearTimeout(t)
  }, [open])

  // Typing echoes immediately; filtering the 1,600+-spell catalog + re-rendering its
  // rows consumes a DEFERRED query so a keystroke never blocks (Task #41).
  const deferredQuery = useDeferredValue(query)

  // Precompute a lowercase search key ONCE per catalog load (not per keystroke).
  const keyed = useMemo(
    () => (catalog ? catalog.entries.map((e) => ({ e, key: e.name.toLowerCase() })) : []),
    [catalog]
  )

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    const rows = q ? keyed.filter((r) => r.key.includes(q)) : keyed
    return rows.slice(0, MAX_ROWS).map((r) => r.e)
  }, [keyed, deferredQuery])

  const create = useCallback(
    async (s: Suggestion) => {
      await onCreate(s.def)
      setSnack({ name: s.def.name, id: s.def.id })
    },
    [onCreate]
  )

  const undo = useCallback(async () => {
    if (!snack) return
    await onDelete(snack.id)
    setSnack(null)
  }, [snack, onDelete])

  const illusion = catalog?.hasIllusions ? illusionSuggestion() : null

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
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
      <DialogContent>
        <Stack spacing={1.5}>
          <TextField
            inputRef={searchRef}
            size="small"
            fullWidth
            placeholder="Search spells, debuffs, buffs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              )
            }}
          />

          {illusion && (
            <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  Illusions
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  one alert for any illusion click-off:
                </Typography>
                <TemplateChip
                  label="When your illusion fades"
                  created={existingIds.has(illusion.def.id)}
                  onClick={() => void create(illusion)}
                />
              </Stack>
            </Box>
          )}

          <Box sx={{ maxHeight: 420, overflow: 'auto' }}>
            <Stack spacing={0.75}>
              {filtered.map((e) => (
                <SpellRow
                  key={e.key}
                  entry={e}
                  existingIds={existingIds}
                  onCreate={(s) => void create(s)}
                />
              ))}
              {catalog && filtered.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
                  No spells match “{query}”.
                </Typography>
              )}
            </Stack>
          </Box>
        </Stack>
      </DialogContent>

      <Snackbar
        open={!!snack}
        autoHideDuration={6000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        message={snack ? `Alert created — ${snack.name}` : ''}
        action={
          <Button color="secondary" size="small" onClick={() => void undo()}>
            Undo
          </Button>
        }
      />
    </Dialog>
  )
}

/** A single spell row: name, buff/debuff + illusion chips, template chips, usage badge. */
function SpellRow({
  entry,
  existingIds,
  onCreate
}: {
  entry: SpellCatalogEntry
  existingIds: Set<string>
  onCreate: (s: Suggestion) => void
}): JSX.Element {
  const isDebuff = entry.spellType === 'Detrimental'
  const suggestions = suggestionsFor(entry)
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        flexWrap: 'wrap',
        px: 1,
        py: 0.5,
        borderRadius: 1,
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
      <Box sx={{ minWidth: 190, display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          {entry.name}
        </Typography>
      </Box>
      <Chip
        size="small"
        label={isDebuff ? 'debuff' : 'buff'}
        color={isDebuff ? 'error' : 'success'}
        variant="outlined"
        sx={{ height: 20 }}
      />
      {entry.illusion && (
        <Chip size="small" label="illusion" variant="outlined" sx={{ height: 20 }} />
      )}
      {entry.usageCount > 0 && (
        <Tooltip
          title={
            entry.lastSeenMs
              ? `Observed ${entry.usageCount}× · last seen ${relativeTime(entry.lastSeenMs)}`
              : `Observed ${entry.usageCount}× in your log`
          }
        >
          <Chip
            size="small"
            color="primary"
            label={`used ${entry.usageCount}×`}
            sx={{ height: 20 }}
          />
        </Tooltip>
      )}
      <Box sx={{ flexGrow: 1 }} />
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
        {suggestions.map((s) => (
          <TemplateChip
            key={s.def.id}
            label={s.template === 'illusion' ? 'When your illusion fades' : SUGGEST_TEMPLATES[s.template].chip}
            created={existingIds.has(s.def.id)}
            onClick={() => onCreate(s)}
          />
        ))}
      </Stack>
    </Box>
  )
}

/** A one-click template chip; renders checked + disabled once the alert exists. */
function TemplateChip({
  label,
  created,
  onClick
}: {
  label: string
  created: boolean
  onClick: () => void
}): JSX.Element {
  if (created) {
    return (
      <Chip
        size="small"
        icon={<CheckCircleIcon />}
        color="success"
        variant="filled"
        label={label}
        disabled
        sx={{ height: 24 }}
      />
    )
  }
  return (
    <Chip
      size="small"
      variant="outlined"
      clickable
      onClick={onClick}
      label={label}
      sx={{ height: 24 }}
    />
  )
}
