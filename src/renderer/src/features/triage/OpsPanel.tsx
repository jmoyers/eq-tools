// ============================================================================
// OpsPanel — the kill switch and the block list.
// ============================================================================
//
// ONE POLARITY, STATED IN THE LABEL. The CLI spells this `closed on|off`, which becomes
// `setAccepting(state === 'off')` — a double negative, and an inverted kill switch is the worst
// bug this panel could ship. So the switch is "Accepting reports", positive, and what it writes
// is literally that boolean. `closed on` == this switch OFF.
//
// The closed message is rendered VERBATIM to users by the client when the endpoint answers 503,
// which is why it is edited here beside the switch rather than buried in a settings pane: the
// operator who closes the door is the one who should be writing the note on it.

import { type JSX, useCallback, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import type { TriageOpsState } from '@shared/triage'
import { formatDateTime } from '../../lib/formatDate'
import { useTriageCall, useTriageMutation } from './useTriage'

function KillSwitch({ ops, onChanged }: { ops: TriageOpsState; onChanged: () => void }): JSX.Element {
  const [message, setMessage] = useState(ops.closedMessage)
  const mutate = useTriageMutation(onChanged)
  const messageDirty = message.trim().length > 0 && message.trim() !== ops.closedMessage

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={2} alignItems="center" useFlexGap flexWrap="wrap">
        <FormControlLabel
          control={
            <Switch
              checked={ops.accepting}
              disabled={mutate.busy}
              onChange={(e) =>
                void mutate.run(() => window.eq.triageSetAccepting(e.target.checked, undefined))
              }
              data-testid="triage-accepting"
            />
          }
          label="Accepting reports"
        />
        <Chip
          size="small"
          color={ops.accepting ? 'success' : 'error'}
          variant="outlined"
          label={ops.accepting ? 'open' : 'closed — every submit gets 503'}
        />
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {ops.maxPerInstallPerDay > 0
            ? `${String(ops.maxPerInstallPerDay)} reports per install per day`
            : 'no quota row on this cluster'}
        </Typography>
      </Stack>

      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <TextField
          size="small"
          label="Closed message (shown to users verbatim)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          fullWidth
          multiline
          minRows={2}
        />
        <Button
          size="small"
          variant="outlined"
          disabled={!messageDirty || mutate.busy}
          onClick={() =>
            void mutate.run(() => window.eq.triageSetAccepting(ops.accepting, message.trim()))
          }
        >
          Save message
        </Button>
      </Stack>
      {mutate.error && <Alert severity="error">{mutate.error}</Alert>}
    </Stack>
  )
}

/**
 * Every install that has ever been blocked OR unblocked — an unblock leaves the row behind
 * with `blocked: false`, so the list is a history, not a set, and it says which is which.
 */
function BlockList({ ops, onChanged }: { ops: TriageOpsState; onChanged: () => void }): JSX.Element {
  const mutate = useTriageMutation(onChanged)
  if (ops.blocked.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No install has ever been blocked.
      </Typography>
    )
  }
  return (
    <Stack spacing={1} data-testid="triage-blocklist">
      {ops.blocked.map((b) => (
        <Stack key={b.installId} direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
          <Chip
            size="small"
            color={b.blocked ? 'error' : 'default'}
            variant="outlined"
            label={b.blocked ? 'blocked' : 'allowed'}
          />
          <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
            {b.installId}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {b.reason ?? '(no reason recorded)'}
            {b.blockedAt === undefined ? '' : ` · ${formatDateTime(b.blockedAt)}`}
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            size="small"
            disabled={mutate.busy}
            onClick={() =>
              void mutate.run(() =>
                window.eq.triageSetBlocked(b.installId, !b.blocked, b.blocked ? 'unblocked' : 'blocked from Ops')
              )
            }
          >
            {b.blocked ? 'Unblock' : 'Block'}
          </Button>
        </Stack>
      ))}
      {mutate.error && <Alert severity="error">{mutate.error}</Alert>}
    </Stack>
  )
}

export default function OpsPanel(): JSX.Element {
  const run = useCallback(() => window.eq.triageOps(), [])
  const ops = useTriageCall<TriageOpsState>(run)

  if (ops.loading && !ops.data) return <CircularProgress size={20} />
  if (ops.error) return <Alert severity="error">{ops.error}</Alert>
  if (!ops.data) return <Alert severity="info">No feedback config row on this cluster yet.</Alert>

  return (
    <Stack spacing={3} data-testid="triage-ops">
      <Stack spacing={1}>
        <Typography variant="subtitle2">Ingest</Typography>
        <KillSwitch ops={ops.data} onChanged={ops.reload} />
      </Stack>
      <Divider />
      <Stack spacing={1}>
        <Typography variant="subtitle2">Blocked installs</Typography>
        <BlockList ops={ops.data} onChanged={ops.reload} />
      </Stack>
    </Stack>
  )
}
