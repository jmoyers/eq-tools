import { useEffect, useState } from 'react'
import { Alert, Button, Snackbar, Typography } from '@mui/material'
import type { UpdateStatus } from '@shared/types'

/**
 * UpdateToast (Task #27; reworked in Task #55) — the always-mounted, bottom-left
 * update notice. It surfaces EXACTLY ONE state: an update is downloaded and waiting,
 * with a "Relaunch to update" action (Claude Code's model).
 *
 * Downloads happen quietly in the background (autoDownload) and are NOT toasted —
 * a background download isn't the user's problem and a progress snackbar just nags.
 * Progress, last-checked time and a manual check live in Preferences > Updates.
 *
 * It hydrates from the `update:getStatus` pull (a push fired before this mounted
 * would be lost) and then follows live pushes. In dev the status is a benign idle,
 * so nothing ever shows.
 */
export function UpdateToast(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    let alive = true
    void window.eq.getUpdateStatus().then((s) => {
      if (alive) setStatus(s)
    })
    const off = window.eq.onUpdateStatus(setStatus)
    return () => {
      alive = false
      off()
    }
  }, [])

  if (status.state !== 'ready') return null

  return (
    <Snackbar open anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }} sx={{ maxWidth: 360 }}>
      <Alert
        severity="success"
        variant="filled"
        icon={false}
        sx={{ width: '100%', alignItems: 'center' }}
        action={
          <Button
            color="inherit"
            size="small"
            onClick={() => void window.eq.installUpdate()}
            sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}
          >
            Relaunch to update
          </Button>
        }
      >
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Update ready{status.version ? ` — v${status.version}` : ''}
        </Typography>
      </Alert>
    </Snackbar>
  )
}

export default UpdateToast
