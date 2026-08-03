// ClassComboChips — the chip vocabulary of the class-combo surface, in ONE place so the Overview
// card, the interval list and the editor cannot drift into three dialects.
//
// CHIPS CONVEY STATE (AGENTS.md, UI conventions). There are exactly four things a chip says here:
//   * a SLOT — the class (`PAL`), the candidate set we narrowed to (`CLR|PAL`), or an em-dash
//     when nothing narrowed it at all. An ambiguous slot is warning-coloured and an unknown one
//     is dimmed, so "we know two of three" is legible at a glance without reading a word.
//   * PROVENANCE — `inferred` unless the log or the user stated it outright. Never omitted for
//     an inferred combo (world-model law 1).
//   * CONFIDENCE — the MIN over slots, never the mean: a combo you 2/3 know is 2/3 known.
//   * LOCKED — you set this range, so re-inference leaves it alone.
//
// No methodology captions, no "how we inferred this" panel; the tooltips state facts about the
// data, not the algorithm that produced it.

import type { JSX } from 'react'
import { Chip, Stack, Tooltip } from '@mui/material'
import { intervalConfidence, type ComboInterval, type ComboSlot } from '@shared/classCombo'
import {
  confidenceText,
  intervalProvenance,
  provenanceLabel,
  slotKind,
  slotLabel
} from './ClassComboLabels'

const CHIP_SX = { height: 20 } as const

/** Tooltip for one slot, stated as a fact about what the log did or did not name. */
function slotTitle(slot: ComboSlot): string {
  const kind = slotKind(slot)
  if (kind === 'resolved') return `${slot.candidates[0]} — ${provenanceLabel(slot.provenance)}.`
  if (kind === 'unknown') return 'Nothing in this range named a class for this slot.'
  return `One of ${slot.candidates.join(', ')} — the log never named which.`
}

/** One slot. Colour carries the kind; the label carries the content. */
export function SlotChip({ slot }: { slot: ComboSlot }): JSX.Element {
  const kind = slotKind(slot)
  return (
    <Tooltip title={slotTitle(slot)}>
      <Chip
        size="small"
        variant="outlined"
        color={kind === 'ambiguous' ? 'warning' : 'default'}
        label={slotLabel(slot)}
        sx={{
          ...CHIP_SX,
          fontWeight: kind === 'resolved' ? 700 : 400,
          opacity: kind === 'unknown' ? 0.55 : 1
        }}
      />
    </Tooltip>
  )
}

/** The loadout as chips, slot order preserved. Zero slots renders nothing, not an empty box. */
export function SlotChips({ slots }: { slots: readonly ComboSlot[] }): JSX.Element {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
      {slots.map((slot, i) => (
        <SlotChip key={`${i}:${slot.candidates.join('|')}`} slot={slot} />
      ))}
    </Stack>
  )
}

/** `inferred` / `stated by /who` / `you set this` — the state, never the process. */
export function ProvenanceChip({ interval }: { interval: ComboInterval }): JSX.Element {
  const p = intervalProvenance(interval)
  return (
    <Tooltip
      title={
        p === 'inferred'
          ? 'The log never states a loadout swap, so this loadout is read from the classes that show up in it.'
          : p === 'who'
            ? 'Your own /who row named this loadout outright.'
            : 'You set this range yourself.'
      }
    >
      <Chip
        size="small"
        variant="outlined"
        color={p === 'inferred' ? 'default' : 'success'}
        label={provenanceLabel(p)}
        sx={CHIP_SX}
      />
    </Tooltip>
  )
}

/** Confidence, the MIN over slots. Absent slots ⇒ 0, which prints as 0% rather than hiding. */
export function ConfidenceChip({ interval }: { interval: ComboInterval }): JSX.Element {
  return (
    <Tooltip title="The least confident slot decides — a loadout you two-thirds know is two-thirds known.">
      <Chip
        size="small"
        variant="outlined"
        label={confidenceText(intervalConfidence(interval))}
        sx={{ ...CHIP_SX, opacity: 0.75 }}
      />
    </Tooltip>
  )
}

/** Shown only on a corrected interval: inference will not touch these slots. */
export function LockedChip(): JSX.Element {
  return (
    <Tooltip title="You set this range, so it is left exactly as you stated it.">
      <Chip size="small" variant="outlined" color="info" label="locked" sx={CHIP_SX} />
    </Tooltip>
  )
}
