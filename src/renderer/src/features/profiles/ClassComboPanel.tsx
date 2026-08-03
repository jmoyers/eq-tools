// ClassComboPanel — the class-loadout history and its correction surface (Preferences →
// Profiles). `profiles/` is the right neighbourhood: it already owns "who is this character"
// concerns, whereas `leveling/` owns a chart pinned by a golden window.
//
// WHAT IT SHOWS. Every interval the combo module believes in, NEWEST FIRST, in a fixed-height
// scroll box (a growing list lives in a bounded box — AGENTS.md; the list grows one row per
// detected swap and must never push the settings page taller). Each row states the span, the
// slots as chips, where the belief came from, how confident it is, and — when the boundary is
// fuzzy — a '~' whose tooltip gives the WINDOW and the detector.
//
// WHAT IT NEVER DOES. It does not explain the algorithm, and it does not smooth. A 33.9-hour
// swap window renders as 33.9 hours of not-knowing; a `{CLR,PAL}` slot renders as `CLR|PAL`
// forever rather than resolving to the likelier one.

import { type JSX, useMemo, useState } from 'react'
import { Box, Button, Chip, Paper, Stack, Tooltip, Typography } from '@mui/material'
import EditIcon from '@mui/icons-material/Edit'
import type { ComboInterval } from '@shared/classCombo'
import { useComboSnap } from './ClassComboData'
import { ConfidenceChip, LockedChip, ProvenanceChip, SlotChips } from './ClassComboChips'
import { levelRangeText, spanText, startFuzzText } from './ClassComboLabels'
import ClassComboEditor from './ClassComboEditor'

/** Explicit height + its own scroll, per the fixed-height law. Roughly four rows tall. */
const LIST_HEIGHT = 268

/** The '~' marker: the start is a RANGE, and the tooltip says how wide and why. */
function FuzzyMark({ interval }: { interval: ComboInterval }): JSX.Element | null {
  const text = startFuzzText(interval)
  if (!text) return null
  return (
    <Tooltip title={text}>
      <Typography component="span" variant="caption" color="warning.main" sx={{ cursor: 'help' }}>
        ~
      </Typography>
    </Tooltip>
  )
}

/** One interval. Everything on this row is a fact about the data, never about the method. */
function IntervalRow({
  interval,
  onEdit
}: {
  interval: ComboInterval
  onEdit: (i: ComboInterval) => void
}): JSX.Element {
  const levels = levelRangeText(interval)
  return (
    <Paper variant="outlined" sx={{ p: 1, mb: 0.75 }} data-testid="combo-interval-row">
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
        <SlotChips slots={interval.slots} />
        <Box sx={{ flexGrow: 1 }} />
        <ProvenanceChip interval={interval} />
        <ConfidenceChip interval={interval} />
        {interval.userLocked && <LockedChip />}
        <Button
          size="small"
          startIcon={<EditIcon sx={{ fontSize: 14 }} />}
          onClick={() => onEdit(interval)}
          sx={{ minWidth: 0, py: 0, px: 0.75 }}
        >
          Edit
        </Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25, display: 'block' }}>
        <FuzzyMark interval={interval} /> {spanText(interval)}
        {levels && ` · ${levels}`}
        {interval.evidenceCount > 0 && ` · ${interval.evidenceCount} signals`}
      </Typography>
    </Paper>
  )
}

/** The head line: what you are running NOW, or the honest reason there is no answer. */
function CurrentLine({ current }: { current: ComboInterval | null }): JSX.Element {
  if (!current) {
    return (
      <Typography variant="caption" color="text.disabled">
        No loadout read yet — one appears as soon as the log names classes you played.
      </Typography>
    )
  }
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <Typography variant="caption" color="text.secondary">
        Now
      </Typography>
      <SlotChips slots={current.slots} />
      <ProvenanceChip interval={current} />
      <ConfidenceChip interval={current} />
      {current.userLocked && <LockedChip />}
    </Stack>
  )
}

/**
 * The Preferences → Profiles item. One component, so PreferencesView gains a single entry —
 * the same shape ProfileSharing's two settings take.
 */
export function ClassComboSetting(): JSX.Element {
  const snap = useComboSnap()
  const [editing, setEditing] = useState<ComboInterval | null>(null)
  // NEWEST FIRST: the loadout you care about is the one you are wearing.
  const newestFirst = useMemo(() => [...snap.intervals].reverse(), [snap.intervals])

  return (
    <Stack spacing={1}>
      <CurrentLine current={snap.current} />
      {!snap.ready && (
        <Tooltip title="The class knowledge tables this build ships with are empty, so nothing can be read from stances, skills or spells.">
          <Chip size="small" variant="outlined" color="warning" label="class tables unavailable" sx={{ alignSelf: 'flex-start', height: 20 }} />
        </Tooltip>
      )}
      <Box
        data-testid="combo-interval-list"
        sx={{ height: LIST_HEIGHT, overflow: 'auto', pr: 0.5 }}
      >
        {newestFirst.length === 0 ? (
          <Typography variant="caption" color="text.disabled">
            Nothing recorded yet.
          </Typography>
        ) : (
          newestFirst.map((interval) => (
            <IntervalRow key={interval.id} interval={interval} onEdit={setEditing} />
          ))
        )}
      </Box>
      <Typography variant="caption" color="text.secondary">
        Edit any range you know better — your correction wins until a /who row says otherwise.
      </Typography>
      <ClassComboEditor interval={editing} onClose={() => setEditing(null)} />
    </Stack>
  )
}
