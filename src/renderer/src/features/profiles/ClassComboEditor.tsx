// ClassComboEditor — "that span was these classes", the one WRITE in the class-combo feature.
//
// IT EDITS A TIME RANGE, NOT AN INTERVAL. The dialog is opened from an interval row, but what it
// sends is `[startTs, endTs]` and nothing else (docs/plans/class-combo-inference.md §5.4/§7):
// setting a correction recomputes every interval from the retained observations, so the id the
// row was keyed by may not exist a moment later. That is why the Save button says "applies to
// this time range" — if the range later splits, the correction applies to both halves, and the
// user is told so in the label instead of in a paragraph they will not read.
//
// AT MOST THREE CLASSES, because a loadout holds at most three (Primary + Secondary, Tertiary
// unlocked at level 10). Main re-validates all of it — the closed class set, the count, the
// ordering of the timestamps — because a renderer string is a renderer string.

import { type JSX, useState } from 'react'
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'
import { CLASS_ABBRS, MAX_COMBO_SLOTS, resolvedClasses, type ClassAbbr, type ComboInterval } from '@shared/classCombo'
import { spanText } from './ClassComboLabels'

export interface ClassComboEditorProps {
  /** The interval whose SPAN is being corrected; null = closed. */
  interval: ComboInterval | null
  onClose: () => void
}

/** The 16 codes as toggles. Selection is capped at three; a full selection dims the rest. */
function ClassPicker({
  picked,
  onToggle
}: {
  picked: ClassAbbr[]
  onToggle: (c: ClassAbbr) => void
}): JSX.Element {
  const full = picked.length >= MAX_COMBO_SLOTS
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      {CLASS_ABBRS.map((abbr) => {
        const on = picked.includes(abbr)
        return (
          <Chip
            key={abbr}
            size="small"
            label={abbr}
            color={on ? 'primary' : 'default'}
            variant={on ? 'filled' : 'outlined'}
            onClick={() => onToggle(abbr)}
            disabled={!on && full}
            sx={{ height: 24, fontWeight: on ? 700 : 400 }}
          />
        )
      })}
    </Stack>
  )
}

/**
 * The dialog body. Mounted with `key={interval.id}` so every row opens a FRESH selection —
 * carrying the previous row's picks into a different time range is exactly the kind of quiet
 * mis-attribution this feature exists to avoid.
 */
function EditorBody({ interval, onClose }: { interval: ComboInterval; onClose: () => void }): JSX.Element {
  // Seeded from what we currently believe, so "the middle slot is wrong" is two clicks. An
  // ambiguous or unknown slot seeds NOTHING — it would be a guess wearing the user's name.
  const [picked, setPicked] = useState<ClassAbbr[]>(() => resolvedClasses(interval))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const range = { startTs: interval.startTs, endTs: interval.endTs }

  const toggle = (c: ClassAbbr): void => {
    setPicked((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : prev.length < MAX_COMBO_SLOTS ? [...prev, c] : prev
    )
  }

  const write = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true)
    try {
      const res = await fn()
      if (res.ok) onClose()
      else setError(res.error ?? 'That correction could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DialogTitle sx={{ pb: 1 }}>Set the loadout for this time range</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary" data-testid="combo-editor-span">
            {spanText(interval)}
          </Typography>
          <ClassPicker picked={picked} onToggle={toggle} />
          <Typography variant="caption" color="text.secondary">
            {picked.length === 0
              ? 'Pick 1 to 3 classes.'
              : `${picked.join(' / ')} — ${picked.length} of ${MAX_COMBO_SLOTS} slots.`}
          </Typography>
          {error && <Alert severity="warning">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          size="small"
          color="inherit"
          disabled={busy || !interval.userLocked}
          onClick={() => void write(() => window.eq.clearComboCorrection(range))}
        >
          Reset to detected
        </Button>
        <Stack sx={{ flexGrow: 1 }} />
        <Button size="small" color="inherit" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          disabled={busy || picked.length === 0}
          data-testid="combo-editor-save"
          onClick={() => void write(() => window.eq.setComboCorrection({ ...range, classes: picked }))}
        >
          Save — applies to this time range
        </Button>
      </DialogActions>
    </>
  )
}

export default function ClassComboEditor({ interval, onClose }: ClassComboEditorProps): JSX.Element {
  return (
    <Dialog open={interval !== null} onClose={onClose} maxWidth="sm" fullWidth>
      {interval && <EditorBody key={interval.id} interval={interval} onClose={onClose} />}
    </Dialog>
  )
}
