// ============================================================================
// TriageActions — the writes: disposition, forget, block.
// ============================================================================
//
// Three of these change a row; two of them are destructive in a way no undo exists for, so
// both ask first and both say exactly what they are about to do:
//
//   * FORGET (§3.5) strips the contact and DELETES the S3 object. The description stays,
//     because the description IS the bug report — the confirm says so, so "we deleted your
//     contact details" never turns out to have meant something larger.
//   * BLOCK writes a per-install profile row; every future submit from that install 403s,
//     instantly, with no deploy. A reason is REQUIRED — the profile records why, and a block
//     with no stated reason is one nobody can review later.
//
// `issueUrl` is deliberately not editable here: it is stamped by `triage-feedback issue`,
// which is the command that ran `assertNoLogSlice` over the body it published. A URL written
// from this panel would claim something was published with no evidence that it was.

import { type JSX, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Stack,
  TextField
} from '@mui/material'
import BlockIcon from '@mui/icons-material/Block'
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep'
import { REPORT_STATUSES, SEVERITIES } from '@shared/feedback'
import type { TriageDetail, TriagePatch } from '@shared/triage'
import { useTriageMutation } from './useTriage'

/** What the four controls currently hold. */
interface DispositionDraft {
  status: TriageDetail['row']['status']
  severity: string
  cluster: string
  note: string
}

/**
 * ONLY WHAT CHANGED. `setTriage` writes exactly the fields it is handed, so sending a field
 * back unchanged would be a no-op write; sending an EMPTY patch would stamp `triaged_at` and
 * change nothing, which the handler rejects outright. So the patch is a diff, and `dirty` —
 * the Save button's gate — is simply "is the diff non-empty".
 */
function dispositionPatch(detail: TriageDetail, d: DispositionDraft): TriagePatch {
  const cluster = d.cluster.trim()
  const note = d.note.trim()
  return {
    ...(d.status === detail.row.status ? {} : { status: d.status }),
    ...(d.severity && d.severity !== detail.row.severity
      ? { severity: d.severity as TriagePatch['severity'] }
      : {}),
    ...(cluster && cluster !== detail.row.cluster ? { cluster } : {}),
    ...(note && note !== detail.note ? { note } : {})
  }
}

/** The disposition row: status, severity, cluster, note — one Save, one keyed UPDATE. */
function DispositionForm({
  detail,
  onSaved
}: {
  detail: TriageDetail
  onSaved: () => void
}): JSX.Element {
  const [status, setStatus] = useState(detail.row.status)
  const [severity, setSeverity] = useState(detail.row.severity ?? '')
  const [cluster, setCluster] = useState(detail.row.cluster ?? '')
  const [note, setNote] = useState(detail.note ?? '')
  const save = useTriageMutation(onSaved)

  const patch = dispositionPatch(detail, { status, severity, cluster, note })
  const dirty = Object.keys(patch).length > 0

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap">
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          sx={{ minWidth: 140 }}
          data-testid="triage-status-select"
        >
          {REPORT_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {s}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          sx={{ minWidth: 120 }}
        >
          {SEVERITIES.map((s) => (
            <MenuItem key={s} value={s}>
              {s}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="Cluster"
          value={cluster}
          onChange={(e) => setCluster(e.target.value)}
          sx={{ minWidth: 140 }}
        />
        <Box sx={{ flexGrow: 1 }} />
        <Button
          variant="contained"
          size="small"
          disabled={!dirty || save.busy}
          onClick={() => void save.run(() => window.eq.triagePatch(detail.row.reportId, patch))}
          data-testid="triage-save"
        >
          Save disposition
        </Button>
      </Stack>
      <TextField
        size="small"
        label="Note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        multiline
        minRows={2}
        fullWidth
      />
      {save.error && <Alert severity="error">{save.error}</Alert>}
    </Stack>
  )
}

/** A confirm that states the consequence, not "are you sure?". */
function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
  children
}: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
  children?: JSX.Element
}): JSX.Element {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ whiteSpace: 'pre-line' }}>{body}</DialogContentText>
        {children}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button color="error" variant="contained" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function DestructiveActions({
  detail,
  onChanged
}: {
  detail: TriageDetail
  onChanged: () => void
}): JSX.Element {
  const [forgetOpen, setForgetOpen] = useState(false)
  const [blockOpen, setBlockOpen] = useState(false)
  const [reason, setReason] = useState('')
  const mutate = useTriageMutation(onChanged)

  return (
    <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" alignItems="center">
      <Button
        size="small"
        color="error"
        variant="outlined"
        startIcon={<DeleteSweepIcon />}
        onClick={() => setForgetOpen(true)}
        data-testid="triage-forget"
      >
        Forget contact + slice
      </Button>
      <Button
        size="small"
        color="error"
        variant="outlined"
        startIcon={<BlockIcon />}
        onClick={() => setBlockOpen(true)}
      >
        Block this install
      </Button>
      {mutate.error && <Alert severity="error">{mutate.error}</Alert>}

      <ConfirmDialog
        open={forgetOpen}
        title="Forget this reporter's details?"
        body={
          `The contact field is cleared and the log slice object is deleted from the bucket.\n\n` +
          `The report itself STAYS — the description is the bug report, and keeping it is why ` +
          `"we deleted your contact details" is not a claim about the rest. A redaction timestamp ` +
          `is recorded. This cannot be undone.`
        }
        confirmLabel="Forget"
        busy={mutate.busy}
        onCancel={() => setForgetOpen(false)}
        onConfirm={() => {
          void mutate.run(() => window.eq.triageForget(detail.row.reportId)).then(() => setForgetOpen(false))
        }}
      />

      <ConfirmDialog
        open={blockOpen}
        title="Block this install from submitting?"
        body={`Every future submit from install ${detail.installId} is refused with 403, from the next request onward. No deploy, no release. Unblock from the Ops tab.`}
        confirmLabel="Block"
        busy={mutate.busy || reason.trim().length === 0}
        onCancel={() => setBlockOpen(false)}
        onConfirm={() => {
          void mutate
            .run(() => window.eq.triageSetBlocked(detail.installId, true, reason.trim()))
            .then(() => setBlockOpen(false))
        }}
      >
        <TextField
          size="small"
          label="Reason (required — the profile records why)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          fullWidth
          sx={{ mt: 2 }}
        />
      </ConfirmDialog>
    </Stack>
  )
}

export default function TriageActions({
  detail,
  onChanged
}: {
  detail: TriageDetail
  onChanged: () => void
}): JSX.Element {
  return (
    <Stack spacing={2}>
      <DispositionForm detail={detail} onSaved={onChanged} />
      <DestructiveActions detail={detail} onChanged={onChanged} />
    </Stack>
  )
}
