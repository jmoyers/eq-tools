import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Snackbar, Typography } from '@mui/material'
import type { UpdateStatus } from '@shared/types'
import { updateChipState } from '@shared/update'

/**
 * UpdateToast (Task #27; reworked in #55, made non-nagging in #60) — a SINGLE,
 * self-dismissing announcement the moment a build finishes downloading.
 *
 * Task #60 turned this from a sticky snackbar into a one-shot: it appears once
 * per version, auto-hides after 8s, and can be closed. The persistent home for
 * "an update is waiting" is now the left-nav UpdateChip; this toast exists only
 * so the arrival is noticed by someone whose eyes are on the meter, not the nav.
 *
 * The rules it must never break (the user's complaint about other apps):
 *   - it NEVER re-appears for the same version, in this session or after a
 *     dismissal — no "over and over" prompting;
 *   - it is never modal and never blocks anything;
 *   - ignoring it is a valid choice: apply-on-quit installs silently anyway.
 *
 * It hydrates from the `update:getStatus` pull (a push fired before this mounted
 * would be lost) and then follows live pushes. In dev the status is a benign
 * idle, so nothing ever shows.
 */
export function UpdateToast(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })
  const [version, setVersion] = useState('')
  const [open, setOpen] = useState(false)
  /** Versions already announced — the "exactly once" guard. */
  const announced = useRef(new Set<string>())

  useEffect(() => {
    let alive = true
    void window.eq.getUpdateStatus().then((s) => {
      if (alive) setStatus(s)
    })
    void window.eq.getAppVersion().then((v) => {
      if (alive) setVersion(v)
    })
    const off = window.eq.onUpdateStatus(setStatus)
    return () => {
      alive = false
      off()
    }
  }, [])

  // `updateChipState` carries the updated-away guard: a 'ready' naming the build
  // we are already running is stale and must not be announced.
  const ui = updateChipState(status, version || undefined)
  const readyVersion = ui.kind === 'ready' ? (ui.version ?? 'unknown') : null

  useEffect(() => {
    if (!readyVersion || announced.current.has(readyVersion)) return
    announced.current.add(readyVersion)
    setOpen(true)
  }, [readyVersion])

  if (!readyVersion) return null

  return (
    <Snackbar
      open={open}
      autoHideDuration={8000}
      onClose={() => setOpen(false)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      sx={{ maxWidth: 380 }}
    >
      <Alert
        severity="success"
        variant="filled"
        icon={false}
        onClose={() => setOpen(false)}
        sx={{ width: '100%', alignItems: 'center' }}
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => void window.eq.installUpdate()}
            sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}
          >
            Restart now
          </Button>
        }
      >
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Update ready{ui.kind === 'ready' && ui.version ? ` — v${ui.version}` : ''}
        </Typography>
        <Typography variant="caption" sx={{ display: 'block', opacity: 0.85 }}>
          It will install on its own next time you quit.
        </Typography>
      </Alert>
    </Snackbar>
  )
}

export default UpdateToast
