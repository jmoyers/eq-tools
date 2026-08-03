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

import { type JSX, useCallback, useEffect, useState } from 'react'
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
import type {
  SharePreview,
  ShareApplyResult,
  AlertMergeItem,
  ScalarChange
} from '@shared/profiles'
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

/**
 * One incoming alert: what it will be stored as, whether it is an add / a re-keyed add / a
 * skip, and the reason — the whole point of the preview is that nothing is ever overwritten
 * silently, so the disposition is shown per row.
 */
function AlertPreviewRow({
  item,
  checked,
  onToggle
}: {
  item: AlertMergeItem
  checked: boolean
  onToggle: () => void
}): JSX.Element {
  const chip = ACTION_CHIP[item.action]
  const disabled = item.action === 'skip'
  return (
    <Box
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
        checked={!disabled && checked}
        onChange={onToggle}
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
              <Chip size="small" color="warning" variant="outlined" label={`needs ${item.missingPackId}`} />
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
}

/** The alerts block: header count + the scrolling per-alert rows. */
function AlertsSection({
  alerts,
  selected,
  onToggle
}: {
  alerts: AlertMergeItem[]
  selected: Set<string>
  onToggle: (id: string) => void
}): JSX.Element | null {
  if (alerts.length === 0) return null
  const importable = alerts.filter((a) => a.action !== 'skip').length
  const alreadyHave = alerts.length - importable
  return (
    <Box>
      <Typography variant="overline" color="text.secondary">
        Alerts — {importable} to add
        {alreadyHave > 0 ? `, ${alreadyHave} you already have` : ''}
      </Typography>
      <Stack spacing={0.25} sx={{ maxHeight: 260, overflow: 'auto', mt: 0.5 }}>
        {alerts.map((item) => (
          <AlertPreviewRow
            key={`${item.finalId}-${item.behaviorKey}`}
            item={item}
            checked={selected.has(item.finalId)}
            onToggle={() => onToggle(item.finalId)}
          />
        ))}
      </Stack>
    </Box>
  )
}

/** Scalar settings: each REPLACES your value, so each is its own opt-in row (yours → theirs). */
function ScalarsSection({
  scalars,
  selected,
  onToggle
}: {
  scalars: ScalarChange[]
  selected: Set<string>
  onToggle: (id: string) => void
}): JSX.Element | null {
  if (scalars.length === 0) return null
  return (
    <Box>
      <Divider sx={{ mb: 1 }} />
      <Typography variant="overline" color="text.secondary">
        Settings — these REPLACE your value, so they&apos;re opt-in
      </Typography>
      <Stack spacing={0.25} sx={{ maxHeight: 200, overflow: 'auto', mt: 0.5 }}>
        {scalars.map((s) => (
          <FormControlLabel
            key={s.id}
            sx={{ ml: 0, alignItems: 'flex-start' }}
            control={
              <Checkbox
                size="small"
                sx={{ p: 0.25, mt: 0.2 }}
                checked={selected.has(s.id)}
                onChange={() => onToggle(s.id)}
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
  )
}

/** Provenance line: what kind of payload this is and where it came from. */
function PreviewMeta({ preview }: { preview: SharePreview }): JSX.Element {
  return (
    <Typography variant="caption" color="text.secondary">
      {preview.kind === 'alerts' ? 'Alert set' : 'Settings bundle'}
      {preview.appVersion ? ` · made with v${preview.appVersion}` : ''}
      {preview.createdAt ? ` · ${formatDateTime(Date.parse(preview.createdAt))}` : ''}
    </Typography>
  )
}

/** A missing sound pack does NOT silently mute the alert — it imports, flagged and named. */
function MissingPacksNotice({ packs }: { packs: string[] }): JSX.Element | null {
  if (packs.length === 0) return null
  const one = packs.length === 1
  return (
    <Alert severity="info" variant="outlined">
      {one ? 'A sound pack' : 'Some sound packs'} used by these alerts {one ? 'is' : 'are'} not
      installed here: <b>{packs.join(', ')}</b>. The alerts still import — install the pack from
      Alerts → “Sound packs…” and they&apos;ll play.
    </Alert>
  )
}

/** Add/remove one id from a selection set, immutably. */
function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** The apply button's label — "Add 3 alerts + 2 settings", omitting either empty half. */
function applyLabel(alerts: number, scalars: number): string {
  const a = alerts > 0 ? `${alerts} alert${alerts === 1 ? '' : 's'}` : ''
  const s = scalars > 0 ? `${scalars} setting${scalars === 1 ? '' : 's'}` : ''
  return `Add ${a}${a && s ? ' + ' : ''}${s}`
}

/**
 * The import state machine: pasted text → preview → per-row selection → apply. Held apart
 * from the render so the dialog below is only markup.
 */
function useShareImport(props: ShareImportDialogProps): {
  text: string
  setText: (t: string) => void
  preview: SharePreview | null
  busy: boolean
  alertSel: Set<string>
  scalarSel: Set<string>
  canApply: boolean
  runPreview: (value: string) => Promise<void>
  openFile: () => Promise<void>
  apply: () => Promise<void>
  toggleAlert: (id: string) => void
  toggleScalar: (id: string) => void
} {
  const { open, onApplied, onClose } = props
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

  return {
    text,
    setText,
    preview,
    busy,
    alertSel,
    scalarSel,
    canApply: !busy && !!preview?.ok && (alertSel.size > 0 || scalarSel.size > 0),
    runPreview,
    openFile,
    apply,
    toggleAlert: (id) => setAlertSel((s) => toggled(s, id)),
    toggleScalar: (id) => setScalarSel((s) => toggled(s, id))
  }
}

export default function ShareImportDialog(props: ShareImportDialogProps): JSX.Element {
  const { open, scope, onClose } = props
  const {
    text,
    setText,
    preview,
    busy,
    alertSel,
    scalarSel,
    canApply,
    runPreview,
    openFile,
    apply,
    toggleAlert,
    toggleScalar
  } = useShareImport(props)

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
            slotProps={{
              htmlInput: { style: { fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' } }
            }}
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
            {preview?.ok && <PreviewMeta preview={preview} />}
          </Stack>

          {preview && !preview.ok && (
            <Alert severity="warning" variant="outlined">
              {preview.error}
            </Alert>
          )}

          {preview?.ok && (
            <>
              <MissingPacksNotice packs={preview.missingPacks} />
              <AlertsSection alerts={preview.alerts} selected={alertSel} onToggle={toggleAlert} />
              <ScalarsSection scalars={preview.scalars} selected={scalarSel} onToggle={toggleScalar} />
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!canApply} onClick={() => void apply()}>
          {applyLabel(alertSel.size, scalarSel.size)}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
