// The Preferences > Updates section: app version, last-checked time, a manual
// check, background download progress, and the "Relaunch to update" action when
// one is waiting.
//
// Split out of PreferencesView.tsx for file mass — the section is self-contained:
// it owns the shared update-status subscription and every piece of UI that reads
// it, and PreferencesView only names the three exports in its section table.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Box, Button, Chip, LinearProgress, Stack, Typography } from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import type { UpdateStatus } from '@shared/types'
import { type UpdateChipState, updateChipState } from '@shared/update'
import { formatDateTime } from '../../lib/formatDate'

interface ChipLook {
  label: string
  color: 'default' | 'success' | 'info' | 'warning'
}

const STATE_CHIP: Record<UpdateStatus['state'], ChipLook> = {
  idle: { label: 'up to date', color: 'default' },
  checking: { label: 'checking', color: 'info' },
  available: { label: 'update available', color: 'info' },
  downloading: { label: 'downloading', color: 'info' },
  ready: { label: 'update ready', color: 'success' },
  error: { label: 'check failed', color: 'warning' }
}

/** Shared status state: pull the last one (pushes predate this mount), then follow pushes. */
export function useUpdateStatus(): UpdateStatus {
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
  return status
}

export function VersionSetting({ version }: { version: string }): JSX.Element {
  return (
    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
      {version ? `v${version}` : '—'}
    </Typography>
  )
}

/**
 * Which chip the headline shows. `ui` is the same pure mapping the left-nav chip
 * uses, so the two surfaces can never disagree — in particular about the
 * updated-away case (a 'ready' naming the build we are ALREADY running is stale,
 * so updateChipState demotes it to 'quiet' and we must not claim "update ready").
 */
function chipLook(status: UpdateStatus, ui: UpdateChipState): ChipLook {
  // Dev build: the updater is off, so "up to date" would be a claim no check ever made.
  if (status.disabled) return { label: 'dev build — updates off', color: 'default' }
  if (ui.kind === 'quiet' && status.state === 'ready') return STATE_CHIP.idle
  return STATE_CHIP[status.state]
}

/** The headline: state chip + when we last asked. */
function UpdateHeadline({
  status,
  chip,
  busy
}: {
  status: UpdateStatus
  chip: ChipLook
  busy: boolean
}): JSX.Element {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Chip
        size="small"
        variant="outlined"
        color={chip.color === 'default' ? undefined : chip.color}
        label={busy ? 'checking' : chip.label}
      />
      <Typography variant="caption" color="text.secondary">
        Last checked: {status.checkedAt ? formatDateTime(status.checkedAt) : 'never'}
      </Typography>
    </Box>
  )
}

/** Background download progress — nothing at all unless a download is actually running. */
function UpdateProgress({
  status,
  downloading
}: {
  status: UpdateStatus
  downloading: boolean
}): JSX.Element | null {
  if (!downloading) return null
  return (
    <Box sx={{ maxWidth: 360 }}>
      <LinearProgress
        variant={status.percent != null ? 'determinate' : 'indeterminate'}
        value={status.percent ?? 0}
        sx={{ borderRadius: 1 }}
      />
      <Typography variant="caption" color="text.secondary">
        {status.version ? `v${status.version} — ` : ''}
        {status.percent ?? 0}%
      </Typography>
    </Box>
  )
}

/** The failure message the quiet nav chip deliberately swallows — this is where it survives. */
function UpdateError({ status }: { status: UpdateStatus }): JSX.Element | null {
  if (status.state !== 'error' || !status.message) return null
  return (
    <Typography variant="caption" color="warning.main" sx={{ wordBreak: 'break-word' }}>
      {status.message}
    </Typography>
  )
}

/** Relaunch when a build is staged, otherwise the manual check. */
function UpdateActions({
  status,
  ui,
  ready,
  busy,
  cooldown,
  onCheck
}: {
  status: UpdateStatus
  ui: UpdateChipState
  ready: boolean
  busy: boolean
  cooldown: boolean
  onCheck: () => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1}>
      {ready ? (
        <Button
          variant="contained"
          color="success"
          size="small"
          startIcon={<RestartAltIcon />}
          onClick={() => void window.eq.installUpdate()}
        >
          Restart to update{ui.kind === 'ready' && ui.version ? ` — v${ui.version}` : ''}
        </Button>
      ) : (
        <Button
          variant="outlined"
          size="small"
          startIcon={<RefreshIcon />}
          onClick={onCheck}
          disabled={busy || cooldown || status.disabled}
        >
          Check for updates
        </Button>
      )}
    </Stack>
  )
}

export function UpdateSetting({
  status,
  version
}: {
  status: UpdateStatus
  version: string
}): JSX.Element {
  const [checking, setChecking] = useState(false)
  // Same post-check cooldown as the nav chip (10s): one answer is valid for at least
  // that long, and it keeps a rapid clicker from hammering the release feed.
  const [cooldown, setCooldown] = useState(false)
  const ui = updateChipState(status, version || undefined)
  const chip = chipLook(status, ui)
  const busy = checking || status.state === 'checking'
  const ready = ui.kind === 'ready'
  const downloading = ui.kind === 'downloading'

  const checkNow = useCallback(async () => {
    setChecking(true)
    try {
      await window.eq.checkForUpdates()
    } finally {
      setChecking(false)
      setCooldown(true)
      setTimeout(() => setCooldown(false), 10_000)
    }
  }, [])

  return (
    <Stack spacing={1.25}>
      <UpdateHeadline status={status} chip={chip} busy={busy} />
      <UpdateProgress status={status} downloading={downloading} />
      <UpdateError status={status} />
      <UpdateActions
        status={status}
        ui={ui}
        ready={ready}
        busy={busy}
        cooldown={cooldown}
        onCheck={() => void checkNow()}
      />
    </Stack>
  )
}
