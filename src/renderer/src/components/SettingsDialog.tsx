// SettingsDialog — compact settings for the EQ install-dir discovery/override.
//
// Opened from the TitleBar gear. Shows the effective EQ install folder + a chip
// saying how it resolved ('auto-detected' vs 'manual'), a folder-picker to point
// at a non-standard install, a "Use auto-detection" reset, and validation feedback
// (found N character logs / no logs found here). Changes apply live: main re-lists
// characters + re-tails if the active log moved, and pushes eqconfig:changed so
// this dialog (and the TitleBar selector) refresh.

import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import type { EqConfig } from '@shared/types'

export interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

const SOURCE_CHIP: Record<EqConfig['source'], { label: string; color: 'success' | 'info' | 'warning' }> = {
  manual: { label: 'manual', color: 'info' },
  auto: { label: 'auto-detected', color: 'success' },
  default: { label: 'default (unverified)', color: 'warning' }
}

export default function SettingsDialog({ open, onClose }: SettingsDialogProps): JSX.Element {
  const [config, setConfig] = useState<EqConfig | null>(null)
  const [busy, setBusy] = useState(false)

  // Load on open + stay in sync with main's eqconfig:changed pushes (which also
  // fire when the change originated here — a single source of truth).
  useEffect(() => {
    if (!open) return
    void window.eq.getEqConfig().then(setConfig)
    return window.eq.onEqConfigChanged(setConfig)
  }, [open])

  const pick = useCallback(async () => {
    setBusy(true)
    try {
      const res = await window.eq.pickEqDir()
      setConfig(res.config)
    } finally {
      setBusy(false)
    }
  }, [])

  const reset = useCallback(async () => {
    setBusy(true)
    try {
      setConfig(await window.eq.resetEqDir())
    } finally {
      setBusy(false)
    }
  }, [])

  const found = config?.characterCount ?? 0
  const chip = config ? SOURCE_CHIP[config.source] : null

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        Settings
        <IconButton aria-label="Close" onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
          EverQuest install folder
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
          The app auto-detects your EverQuest Legends folder. Override it here only if your
          install lives somewhere unusual.
        </Typography>

        <Stack spacing={1.5}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              flexWrap: 'wrap',
              p: 1.25,
              borderRadius: 1,
              border: 1,
              borderColor: 'divider',
              bgcolor: 'background.default'
            }}
          >
            <Box sx={{ minWidth: 0, flexGrow: 1 }}>
              <Typography
                variant="body2"
                sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                title={config?.root}
              >
                {config?.root ?? '—'}
              </Typography>
            </Box>
            {chip && <Chip size="small" label={chip.label} color={chip.color} variant="outlined" />}
          </Box>

          {/* Validation feedback: how many character logs are under <root>\Logs. */}
          {config &&
            (found > 0 ? (
              <Alert severity="success" variant="outlined">
                Found {found} character log{found === 1 ? '' : 's'} in this folder.
              </Alert>
            ) : (
              <Alert severity="warning" variant="outlined">
                No character logs (eqlog_*.txt) found here. Make sure EverQuest logging is
                enabled (/log on) and pick the game&apos;s install folder.
              </Alert>
            ))}

          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              startIcon={<FolderOpenIcon />}
              onClick={() => void pick()}
              disabled={busy}
            >
              Choose folder…
            </Button>
            <Button
              variant="outlined"
              startIcon={<AutoFixHighIcon />}
              onClick={() => void reset()}
              disabled={busy || !config?.overridden}
            >
              Use auto-detection
            </Button>
          </Stack>
        </Stack>
      </DialogContent>
    </Dialog>
  )
}
