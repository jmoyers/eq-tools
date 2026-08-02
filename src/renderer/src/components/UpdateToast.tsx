import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  MenuItem,
  Select,
  Snackbar,
  Typography
} from '@mui/material'
import type { UpdateChannel, UpdateStatus } from '@shared/types'

/**
 * Auto-update UI (Task #27). Two self-contained, independently-mountable pieces:
 *
 *   <UpdateToast/>            — a bottom-left snackbar that appears only when an
 *                              update is downloading or ready; "Restart" applies it.
 *   <UpdateChannelSelector/> — a compact channel picker (main | stable) meant to be
 *                              embedded in a settings/alerts pane later.
 *
 * NOTHING here is mounted by this file — the integrator mounts <UpdateToast/> once
 * (e.g. alongside the always-on alerts player) and drops the selector into settings.
 * Both talk to main only through the preload bridge (window.eq.*), so they render
 * harmlessly in dev where the updater is a no-op (no status ever arrives → nothing
 * shows).
 */

export function UpdateToast(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => window.eq.onUpdateStatus(setStatus), [])

  const { state, version, percent } = status

  // Only surface the actionable/near-actionable states; stay invisible otherwise
  // (checking / idle / errors are silent — an update that isn't ready isn't the
  // user's problem, and a failed check shouldn't nag).
  const downloading = state === 'downloading'
  const ready = state === 'ready'
  if (!downloading && !ready) return null

  return (
    <Snackbar
      open
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      sx={{ maxWidth: 360 }}
    >
      <Alert
        severity={ready ? 'success' : 'info'}
        variant="filled"
        icon={false}
        sx={{ width: '100%', alignItems: 'center' }}
        action={
          ready ? (
            <Button
              color="inherit"
              size="small"
              onClick={() => void window.eq.installUpdate()}
              sx={{ fontWeight: 700 }}
            >
              Restart
            </Button>
          ) : undefined
        }
      >
        {ready ? (
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Update ready{version ? ` — v${version}` : ''}
          </Typography>
        ) : (
          <Box sx={{ minWidth: 200 }}>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              Downloading update{version ? ` v${version}` : ''}…
            </Typography>
            <LinearProgress
              variant={percent != null ? 'determinate' : 'indeterminate'}
              value={percent ?? 0}
              sx={{ borderRadius: 1 }}
            />
          </Box>
        )}
      </Alert>
    </Snackbar>
  )
}

/**
 * Channel selector — main (latest, updates on every push) vs. stable (tagged
 * releases only). Persists via window.eq.setUpdateChannel, which re-checks
 * immediately so switching to stable can find a tagged release right away.
 */
export function UpdateChannelSelector(): JSX.Element {
  const [channel, setChannel] = useState<UpdateChannel>('main')

  useEffect(() => {
    let alive = true
    void window.eq.getUpdateChannel().then((c) => {
      if (alive) setChannel(c)
    })
    return () => {
      alive = false
    }
  }, [])

  const onChange = (next: UpdateChannel): void => {
    setChannel(next)
    void window.eq.setUpdateChannel(next)
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Typography variant="body2" color="text.secondary">
        Update channel
      </Typography>
      <Select
        size="small"
        value={channel}
        onChange={(e) => onChange(e.target.value as UpdateChannel)}
        sx={{ minWidth: 140 }}
      >
        <MenuItem value="main">Main (latest)</MenuItem>
        <MenuItem value="stable">Stable (tagged)</MenuItem>
      </Select>
    </Box>
  )
}

export default UpdateToast
