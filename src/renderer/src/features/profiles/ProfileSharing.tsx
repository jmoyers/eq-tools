// ProfileSharing — the Preferences → Profiles section: export your settings, import someone
// else's. Lives in its own file so PreferencesView only gains two section entries.
//
// A settings bundle is GLOBAL by construction (src/shared/profiles.ts): it carries alerts,
// alert prefs, overlay look, and a short whitelist of UI prefs. It carries no file paths, no
// window positions, and no character progress — those are machine/character state and the
// exporter never reads them.

import { useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, Chip, Snackbar, Stack, Typography } from '@mui/material'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import SaveAltIcon from '@mui/icons-material/SaveAlt'
import FileUploadIcon from '@mui/icons-material/FileUpload'
import type { ShareApplyResult } from '@shared/profiles'
import { copyText } from '../../lib/clipboard'
import { readUiPrefs } from '../../lib/uiPrefs'
import ShareImportDialog from './ShareImportDialog'

/** What a bundle contains, stated as fact so the user knows what they're handing over. */
const INCLUDES = ['alerts', 'alert volume + mute', 'overlay look', 'view preferences', 'favorites']
const EXCLUDES = ['EverQuest folder', 'window positions', 'character progress', 'sound pack files']

export function ExportSettingsSetting(): JSX.Element {
  const [alertCount, setAlertCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ severity: 'success' | 'warning'; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    void window.eq.listAlerts().then((a) => {
      if (alive) setAlertCount(a.length)
    })
    return () => {
      alive = false
    }
  }, [])

  const copy = useCallback(async () => {
    setBusy(true)
    try {
      const text = await window.eq.exportSettingsShare(readUiPrefs())
      const ok = await copyText(text)
      setToast(
        ok
          ? { severity: 'success', text: `Copied — ${text.length} characters. Paste it anywhere.` }
          : { severity: 'warning', text: 'Could not reach the clipboard. Save to a file instead.' }
      )
    } finally {
      setBusy(false)
    }
  }, [])

  const save = useCallback(async () => {
    setBusy(true)
    try {
      const text = await window.eq.exportSettingsShare(readUiPrefs())
      const res = await window.eq.saveShareFile(text, 'eq-companion-settings.eqshare')
      if (res.ok) setToast({ severity: 'success', text: `Saved to ${res.path}` })
      else if (res.error) setToast({ severity: 'warning', text: res.error })
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <Stack spacing={1.25}>
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
        {INCLUDES.map((w) => (
          <Chip
            key={w}
            size="small"
            variant="outlined"
            color="success"
            label={w === 'alerts' ? `${alertCount} alerts` : w}
          />
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary">
        Not included: {EXCLUDES.join(' · ')}.
      </Typography>
      <Stack direction="row" spacing={1}>
        <Button
          size="small"
          variant="contained"
          startIcon={<ContentCopyIcon />}
          disabled={busy}
          onClick={() => void copy()}
        >
          Copy share string
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<SaveAltIcon />}
          disabled={busy}
          onClick={() => void save()}
        >
          Save to file…
        </Button>
      </Stack>
      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={toast?.severity ?? 'success'} variant="filled" onClose={() => setToast(null)}>
          {toast?.text}
        </Alert>
      </Snackbar>
    </Stack>
  )
}

export function ImportSettingsSetting(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<ShareApplyResult | null>(null)

  const summary = (r: ShareApplyResult): string => {
    if (!r.ok) return r.error ?? 'Import failed.'
    const bits: string[] = []
    if (r.added) bits.push(`added ${r.added} alert${r.added === 1 ? '' : 's'}`)
    if (r.rekeyed) bits.push(`${r.rekeyed} kept alongside an existing id`)
    if (r.scalarsApplied) bits.push(`${r.scalarsApplied} setting${r.scalarsApplied === 1 ? '' : 's'}`)
    if (r.skipped) bits.push(`${r.skipped} skipped`)
    return bits.length ? `Imported — ${bits.join(', ')}.` : 'Nothing to add — you already have it all.'
  }

  return (
    <Stack spacing={1.25}>
      <Typography variant="caption" color="text.secondary">
        Imports only ever ADD. Anything you already have is left exactly as it is.
      </Typography>
      <Stack direction="row" spacing={1}>
        <Button size="small" variant="contained" startIcon={<FileUploadIcon />} onClick={() => setOpen(true)}>
          Import settings…
        </Button>
      </Stack>
      <ShareImportDialog
        open={open}
        scope="settings"
        onClose={() => setOpen(false)}
        onApplied={setResult}
      />
      <Snackbar
        open={!!result}
        autoHideDuration={6000}
        onClose={() => setResult(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={result?.ok ? 'success' : 'warning'}
          variant="filled"
          onClose={() => setResult(null)}
        >
          {result ? summary(result) : ''}
        </Alert>
      </Snackbar>
    </Stack>
  )
}
