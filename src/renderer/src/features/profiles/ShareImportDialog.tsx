// ShareImportDialog — paste (or open) a share string, SEE what it would add, then apply.
//
// Used by both surfaces: Preferences → Profiles (settings bundles) and Alerts (alert sets).
// The same dialog serves both because a settings bundle is just an alert set plus a handful
// of scalar rows.
//
// The contract this UI exists to make visible (src/shared/profiles.ts):
//   - imports are ADDITIVE: alerts you already have are listed as "already have this" and
//     nothing is ever overwritten. An id collision imports ALONGSIDE, under a new id.
//   - scalar settings (volume, mute, overlay opacity, UI prefs) CANNOT be additive, so each
//     is its own opt-in row showing yours vs theirs, unticked by default. List-shaped prefs
//     (favorites, class filter) are unions and start ticked.
//   - a missing sound pack does NOT silently mute or silently re-point the alert: it's
//     imported, flagged, and the pack name is named so it can be installed from the registry.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import ContentPasteIcon from '@mui/icons-material/ContentPaste'
import type { SharePreview, ShareApplyResult } from '@shared/profiles'
import { describeTrigger } from '@shared/profiles'
import { formatDateTime } from '../../lib/formatDate'
import { readUiPrefs, writeUiPrefs } from '../../lib/uiPrefs'

export interface ShareImportDialogProps {
  open: boolean
  /** Heading + empty-state wording; the payload itself decides what actually gets applied. */
  scope: 'settings' | 'alerts'
  onClose: () => void
  /** Fired after a successful apply so the caller can reload its lists + snackbar. */
  onApplied: (result: ShareApplyResult) => void
}

const ACTION_CHIP: Record<string, { label: string; color: 'success' | 'info' | 'default' }> = {
  add: { label: 'add', color: 'success' },
  rekey: { label: 'add (new id)', color: 'info' },
  skip: { label: 'already have', color: 'default' }
}

export default function ShareImportDialog({
  open,
  scope,
  onClose,
  onApplied
}: ShareImportDialogProps): JSX.Element {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<SharePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [alertSel, setAlertSel] = useState<Set<string>>(new Set())
  const [scalarSel, setScalarSel] = useState<Set<string>>(new Set())

  // Reset every time the dialog opens so a previous paste never leaks into a new import.
  useEffect(() => {
    if (!open) return
    setText('')
    setPreview(null)
    setBusy(false)
    setAlertSel(new Set())
    setScalarSel(new Set())
  }, [open])

  const adopt = useCallback((p: SharePreview | null) => {
    setPreview(p)
    if (!p?.ok) {
      setAlertSel(new Set())
      setScalarSel(new Set())
      return
    }
    setText(p.text)
    // Everything importable starts ticked; scalar REPLACEMENTS start unticked (they're the
    // only rows that can take something away from you).
    setAlertSel(new Set(p.alerts.filter((a) => a.action !== 'skip').map((a) => a.finalId)))
    setScalarSel(new Set(p.scalars.filter((s) => s.merge === 'union').map((s) => s.id)))
  }, [])

  const runPreview = useCallback(
    async (value: string) => {
      if (!value.trim()) {
        setPreview(null)
        return
      }
      setBusy(true)
      try {
        adopt(await window.eq.previewShare(value, readUiPrefs()))
      } finally {
        setBusy(false)
      }
    },
    [adopt]
  )

  const openFile = useCallback(async () => {
    setBusy(true)
    try {
      const p = await window.eq.openShareFile(readUiPrefs())
      if (p) adopt(p)
    } finally {
      setBusy(false)
    }
  }, [adopt])

  const apply = useCallback(async () => {
    if (!preview?.ok) return
    setBusy(true)
    try {
      const res = await window.eq.applyShare(preview.text, readUiPrefs(), {
        alertIds: [...alertSel],
        scalarIds: [...scalarSel]
      })
      // Main can't touch localStorage; it hands back the merged values for us to write.
      if (res.ok) writeUiPrefs(res.ui)
      onApplied(res)
      onClose()
    } finally {
      setBusy(false)
    }
  }, [preview, alertSel, scalarSel, onApplied, onClose])

  const toggle = (set: Set<string>, id: string, apply2: (s: Set<string>) => void): void => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    apply2(next)
  }

  const importable = useMemo(
    () => preview?.alerts.filter((a) => a.action !== 'skip') ?? [],
    [preview]
  )
  const alreadyHave = (preview?.alerts.length ?? 0) - importable.length
  const nothingSelected = alertSel.size === 0 && scalarSel.size === 0

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        {scope === 'alerts' ? 'Import alerts' : 'Import settings'}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5}>
          <TextField
            multiline
            minRows={2}
            maxRows={5}
            size="small"
            fullWidth
            autoFocus
            placeholder="Paste a share string (EQC1-…) here"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => void runPreview(text)}
            inputProps={{ style: { fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' } }}
          />
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              size="small"
              variant="contained"
              startIcon={<ContentPasteIcon />}
              disabled={busy || !text.trim()}
              onClick={() => void runPreview(text)}
            >
              Preview
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<FolderOpenIcon />}
              disabled={busy}
              onClick={() => void openFile()}
            >
              Open file…
            </Button>
            <Box sx={{ flexGrow: 1 }} />
            {preview?.ok && (
              <Typography variant="caption" color="text.secondary">
                {preview.kind === 'alerts' ? 'Alert set' : 'Settings bundle'}
                {preview.appVersion ? ` · made with v${preview.appVersion}` : ''}
                {preview.createdAt ? ` · ${formatDateTime(Date.parse(preview.createdAt))}` : ''}
              </Typography>
            )}
          </Stack>

          {preview && !preview.ok && (
            <Alert severity="warning" variant="outlined">
              {preview.error}
            </Alert>
          )}

          {preview?.ok && (
            <>
              {preview.missingPacks.length > 0 && (
                <Alert severity="info" variant="outlined">
                  {preview.missingPacks.length === 1 ? 'A sound pack' : 'Some sound packs'} used by
                  these alerts {preview.missingPacks.length === 1 ? 'is' : 'are'} not installed here:{' '}
                  <b>{preview.missingPacks.join(', ')}</b>. The alerts still import — install the
                  pack from Alerts → “Sound packs…” and they&apos;ll play.
                </Alert>
              )}

              {preview.alerts.length > 0 && (
                <Box>
                  <Typography variant="overline" color="text.secondary">
                    Alerts — {importable.length} to add
                    {alreadyHave > 0 ? `, ${alreadyHave} you already have` : ''}
                  </Typography>
                  <Stack spacing={0.25} sx={{ maxHeight: 260, overflow: 'auto', mt: 0.5 }}>
                    {preview.alerts.map((item) => {
                      const chip = ACTION_CHIP[item.action]
                      const disabled = item.action === 'skip'
                      return (
                        <Box
                          key={`${item.finalId}-${item.behaviorKey}`}
                          sx={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 1,
                            px: 0.5,
                            py: 0.4,
                            borderRadius: 1,
                            opacity: disabled ? 0.55 : 1,
                            '&:hover': { bgcolor: 'action.hover' }
                          }}
                        >
                          <Checkbox
                            size="small"
                            sx={{ p: 0.25, mt: 0.2 }}
                            disabled={disabled}
                            checked={!disabled && alertSel.has(item.finalId)}
                            onChange={() => toggle(alertSel, item.finalId, setAlertSel)}
                          />
                          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                            <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
                              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                                {item.finalName}
                              </Typography>
                              <Chip
                                size="small"
                                variant="outlined"
                                label={chip.label}
                                color={chip.color === 'default' ? undefined : chip.color}
                              />
                              {item.missingPackId && !disabled && (
                                <Tooltip title="This alert's sound pack isn't installed here">
                                  <Chip
                                    size="small"
                                    color="warning"
                                    variant="outlined"
                                    label={`needs ${item.missingPackId}`}
                                  />
                                </Tooltip>
                              )}
                            </Stack>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ fontFamily: 'monospace', wordBreak: 'break-all', display: 'block' }}
                            >
                              {describeTrigger(item.incoming.trigger)} · {item.incoming.sound.packId}/
                              {item.incoming.sound.soundId}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {item.reason}
                            </Typography>
                          </Box>
                        </Box>
                      )
                    })}
                  </Stack>
                </Box>
              )}

              {preview.scalars.length > 0 && (
                <Box>
                  <Divider sx={{ mb: 1 }} />
                  <Typography variant="overline" color="text.secondary">
                    Settings — these REPLACE your value, so they&apos;re opt-in
                  </Typography>
                  <Stack spacing={0.25} sx={{ maxHeight: 200, overflow: 'auto', mt: 0.5 }}>
                    {preview.scalars.map((s) => (
                      <FormControlLabel
                        key={s.id}
                        sx={{ ml: 0, alignItems: 'flex-start' }}
                        control={
                          <Checkbox
                            size="small"
                            sx={{ p: 0.25, mt: 0.2 }}
                            checked={scalarSel.has(s.id)}
                            onChange={() => toggle(scalarSel, s.id, setScalarSel)}
                          />
                        }
                        label={
                          <Box>
                            <Typography variant="body2">
                              {s.label}
                              {s.merge === 'union' && (
                                <Chip size="small" variant="outlined" color="success" label="adds only" sx={{ ml: 0.75 }} />
                              )}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                            >
                              {s.current || '—'} → {s.incoming}
                            </Typography>
                          </Box>
                        }
                      />
                    ))}
                  </Stack>
                </Box>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={busy || !preview?.ok || nothingSelected}
          onClick={() => void apply()}
        >
          Add {alertSel.size > 0 ? `${alertSel.size} alert${alertSel.size === 1 ? '' : 's'}` : ''}
          {alertSel.size > 0 && scalarSel.size > 0 ? ' + ' : ''}
          {scalarSel.size > 0 ? `${scalarSel.size} setting${scalarSel.size === 1 ? '' : 's'}` : ''}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
