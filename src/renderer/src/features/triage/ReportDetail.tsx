// ============================================================================
// ReportDetail — one report, whole: what was sent, what the client was, what we decided.
// ============================================================================
//
// Three blocks in the order an operator reads them: the DRAFT (what the human typed), the ENV
// (what the client says it was), and the TRIAGE fields (what we have decided so far), then the
// actions, then the log slice — which is loaded ON DEMAND, because downloading and gunzipping
// somebody's log window is not something a click on a table row should do silently.

import { type JSX, useCallback, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Link,
  Stack,
  Typography
} from '@mui/material'
import DescriptionIcon from '@mui/icons-material/Description'
import type { TriageDetail, TriageSlice } from '@shared/triage'
import { formatDateTime } from '../../lib/formatDate'
import { LogChip, SeverityChip, SpamChip, StatusChip } from './triageChips'
import SliceBox from './SliceBox'
import TriageActions from './TriageActions'
import { useTriageCall } from './useTriage'

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Stack direction="row" spacing={1}>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 108, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ wordBreak: 'break-word' }}>
        {value}
      </Typography>
    </Stack>
  )
}

/** `env_json`, parsed in main and total by construction — an unparseable blob arrives as {}. */
function EnvBlock({ env }: { env: Record<string, string> }): JSX.Element {
  const keys = Object.keys(env).sort()
  if (keys.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        No environment recorded on this report.
      </Typography>
    )
  }
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 0.25 }}>
      {keys.map((k) => (
        <Field key={k} label={k} value={env[k]} />
      ))}
    </Box>
  )
}

/** The "not asked yet" call: a module-level identity, so the effect does not refire every
 *  render while the button is still un-clicked. */
const NEVER = (): Promise<{ ok: true; value: null }> => Promise.resolve({ ok: true, value: null })

/**
 * The slice, on demand.
 *
 * `log: 'missing'` is its own answer and gets its own sentence: the report DECLARED a slice and
 * the object is not in the bucket, which means the presigned upload failed or expired. That is
 * a real outcome and must not read as "no log attached".
 */
function SliceSection({ detail }: { detail: TriageDetail }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const run = useCallback(() => window.eq.triageSlice(detail.row.reportId), [detail.row.reportId])
  const slice = useTriageCall<TriageSlice | null>(open ? run : NEVER)

  if (detail.log === 'none') return null
  if (detail.log === 'missing') {
    return (
      <Alert severity="warning" data-testid="triage-slice-missing">
        This report declared a log slice
        {detail.logLines === undefined ? '' : ` (${detail.logLines.toLocaleString()} lines)`} but the
        object is not in the bucket — the upload failed or the presigned POST expired.
      </Alert>
    )
  }
  if (!open) {
    return (
      <Button
        size="small"
        variant="outlined"
        startIcon={<DescriptionIcon />}
        onClick={() => setOpen(true)}
        data-testid="triage-load-slice"
      >
        Load log slice
        {detail.logLines === undefined ? '' : ` — ${detail.logLines.toLocaleString()} lines`}
      </Button>
    )
  }
  if (slice.loading) return <CircularProgress size={18} />
  if (slice.error) return <Alert severity="error">{slice.error}</Alert>
  if (!slice.data) return <Alert severity="info">No slice came back for this report.</Alert>
  return <SliceBox slice={slice.data} />
}

export default function ReportDetail({
  detail,
  onChanged
}: {
  detail: TriageDetail
  onChanged: () => void
}): JSX.Element {
  const r = detail.row
  return (
    <Stack spacing={2} data-testid="triage-detail">
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
        <Typography variant="subtitle1">{r.title ?? '(no title)'}</Typography>
        <StatusChip status={r.status} />
        <SeverityChip severity={r.severity} />
        <LogChip state={detail.log} />
        <SpamChip score={r.spamScore} />
      </Stack>

      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
        {r.description}
      </Typography>

      <Divider />
      <Stack spacing={0.25}>
        <Field label="Report" value={r.reportId} />
        <Field label="Install" value={detail.installId} />
        <Field label="Received" value={formatDateTime(r.receivedAt)} />
        <Field label="Client clock" value={formatDateTime(detail.clientTs)} />
        <Field label="Type / channel" value={`${r.type} · ${r.channel}`} />
        {detail.contact !== undefined && <Field label="Contact" value={detail.contact} />}
        {detail.redactedAt !== undefined && (
          <Field label="Redacted" value={formatDateTime(detail.redactedAt)} />
        )}
        {detail.dupeOf !== undefined && <Field label="Duplicate of" value={detail.dupeOf} />}
        {r.triagedAt !== undefined && <Field label="Triaged" value={formatDateTime(r.triagedAt)} />}
        {detail.note !== undefined && <Field label="Note" value={detail.note} />}
        {detail.issueUrl !== undefined && (
          <Stack direction="row" spacing={1}>
            <Typography variant="caption" color="text.secondary" sx={{ minWidth: 108 }}>
              Issue
            </Typography>
            <Link variant="caption" href={detail.issueUrl} target="_blank" rel="noreferrer">
              {detail.issueUrl}
            </Link>
          </Stack>
        )}
      </Stack>

      <Divider />
      <EnvBlock env={detail.env} />

      <Divider />
      <TriageActions detail={detail} onChanged={onChanged} />

      <SliceSection detail={detail} />
    </Stack>
  )
}
