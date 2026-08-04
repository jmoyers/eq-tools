// Shared state chips for the triage tab. STATE, NEVER PROCESS (AGENTS.md UI conventions):
// each chip states what the record IS — its status, its severity, whether a log slice exists
// and whether it landed — and none of them describe how anything was computed.

import type { JSX } from 'react'
import { Chip, Tooltip } from '@mui/material'
import type { ReportStatus, Severity } from '@shared/feedback'
import type { TriageLogState } from '@shared/triage'

type ChipColor = 'default' | 'primary' | 'success' | 'info' | 'warning' | 'error'

/** The seven statuses, each with the colour it earns. `new` reads as "needs you". */
const STATUS_COLOR: Record<ReportStatus, ChipColor> = {
  new: 'info',
  triaged: 'primary',
  accepted: 'primary',
  shipped: 'success',
  wontfix: 'default',
  duplicate: 'warning',
  spam: 'error'
}

const SEVERITY_COLOR: Record<Severity, ChipColor> = {
  p0: 'error',
  p1: 'warning',
  p2: 'info',
  p3: 'default'
}

const CHIP_SX = { height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75 } } as const

export function StatusChip({ status }: { status: ReportStatus }): JSX.Element {
  return (
    <Chip
      size="small"
      label={status}
      color={STATUS_COLOR[status]}
      variant={status === 'new' ? 'filled' : 'outlined'}
      sx={CHIP_SX}
    />
  )
}

export function SeverityChip({ severity }: { severity?: Severity }): JSX.Element | null {
  if (!severity) return null
  return (
    <Chip size="small" label={severity} color={SEVERITY_COLOR[severity]} variant="outlined" sx={CHIP_SX} />
  )
}

/**
 * The log chip is TRI-STATE and says which state it is in.
 *
 * `declared` is what a LIST row can honestly claim: the report carries slice metadata. Only
 * the detail pane pays the HeadObject that upgrades it to `present` or `missing`, and
 * `missing` is a real, distinct outcome — an upload that failed or whose presign expired.
 */
export function LogChip({ state }: { state: TriageLogState }): JSX.Element | null {
  if (state === 'none') return null
  const spec = {
    declared: { label: 'log', color: 'default' as ChipColor, title: 'A log slice is attached to this report. Open it to check whether the upload actually landed.' },
    present: { label: 'log ✔', color: 'success' as ChipColor, title: 'The slice is in the bucket.' },
    missing: { label: 'log ✗', color: 'error' as ChipColor, title: 'Declared but never landed — the upload failed or the presigned POST expired.' }
  }[state]
  return (
    <Tooltip title={spec.title}>
      <Chip size="small" label={spec.label} color={spec.color} variant="outlined" sx={CHIP_SX} />
    </Tooltip>
  )
}

/** Spam score is only worth a chip when it is actually saying something. */
export function SpamChip({ score }: { score: number }): JSX.Element | null {
  if (score < 40) return null
  return (
    <Chip
      size="small"
      label={`spam ${String(score)}`}
      color={score >= 70 ? 'error' : 'warning'}
      variant="outlined"
      sx={CHIP_SX}
    />
  )
}
