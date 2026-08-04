// EqFolderSetting — the Preferences "Game" section's one card: the EverQuest install folder.
//
// Moved out of PreferencesView.tsx unchanged, for the same reason UpdateSetting.tsx already
// lives beside it: that file is the settings TABLE plus the rail/search shell, and a section's
// actual UI belongs next to it, not inside it. Behaviour, copy and markup are byte-identical to
// what was there before — this is a factoring move, nothing else.
//
// The effective path, a chip saying how it resolved, the folder picker + auto-detection reset,
// and validation feedback (how many character logs are under <root>\Logs). Changes apply live —
// main re-lists characters, re-tails if the active log moved, and pushes eqconfig:changed, which
// we listen to so this stays correct no matter who changed it.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import type { EqConfig } from '@shared/types'

const SOURCE_CHIP: Record<EqConfig['source'], { label: string; color: 'success' | 'info' | 'warning' }> = {
  manual: { label: 'manual', color: 'info' },
  auto: { label: 'auto-detected', color: 'success' },
  default: { label: 'default (unverified)', color: 'warning' }
}

/**
 * The effective path, plus a chip saying how it resolved. Set off by a background
 * fill, NOT a border: the item card around it is the one border level in this view
 * (no boxes in boxes).
 */
function EqFolderPath({ config }: { config: EqConfig | null }): JSX.Element {
  const chip = config ? SOURCE_CHIP[config.source] : null
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        flexWrap: 'wrap',
        p: 1.25,
        borderRadius: 1,
        bgcolor: 'action.hover'
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
  )
}

/**
 * Validation feedback: how many character logs are under `<root>\Logs`. Nothing is
 * claimed until the config has actually arrived, so a fresh mount shows no verdict
 * rather than a momentary "no logs found" that is only true because we haven't looked.
 */
function EqFolderCheck({ config }: { config: EqConfig | null }): JSX.Element | null {
  if (!config) return null
  const found = config.characterCount
  // variant="standard": a tonal fill, no border ring — same no-boxes-in-boxes rule.
  return found > 0 ? (
    <Alert severity="success" variant="standard">
      Found {found} character log{found === 1 ? '' : 's'} in this folder.
    </Alert>
  ) : (
    <Alert severity="warning" variant="standard">
      No character logs (eqlog_*.txt) found here. Make sure EverQuest logging is enabled
      (/log on) and pick the game&apos;s install folder.
    </Alert>
  )
}

export function EqFolderSetting(): JSX.Element {
  const [config, setConfig] = useState<EqConfig | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.eq.getEqConfig().then(setConfig)
    return window.eq.onEqConfigChanged(setConfig)
  }, [])

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

  return (
    <Stack spacing={1.5}>
      <EqFolderPath config={config} />

      <EqFolderCheck config={config} />

      <Stack direction="row" spacing={1}>
        <Button
          variant="contained"
          size="small"
          startIcon={<FolderOpenIcon />}
          onClick={() => void pick()}
          disabled={busy}
        >
          Choose folder…
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={<AutoFixHighIcon />}
          onClick={() => void reset()}
          disabled={busy || !config?.overridden}
        >
          Use auto-detection
        </Button>
      </Stack>
    </Stack>
  )
}
