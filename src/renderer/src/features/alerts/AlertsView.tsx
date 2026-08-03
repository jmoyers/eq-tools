// AlertsView — manage triggered-sound alerts + global sound preferences.
//
// Layout (dense, dark, matches the app):
//   - a top bar with the global volume slider + mute toggle, "Sound packs…"
//     (opens the openpeon.com registry browser — Task #29), "Add alert", and a
//     "Reset to defaults" button (restores the seeded built-in set, confirmed)
//     — AlertsToolbar.tsx,
//   - a list of alerts, each with an enable switch, per-alert volume, a
//     pack→sound picker, a compact trigger chip, Test / Edit / Delete, and an
//     expandable "recent fires" panel (time + the actual matched log line)
//     — AlertList.tsx,
//   - an add/EDIT dialog: every alert — including the seeded built-ins — opens in
//     it (name, trigger type/kind/where, raw regex with live validation, sound,
//     volume, cooldown). Built-ins are just stored defs with stable ids
//     — AlertDialog.tsx (+ ConditionEditor.tsx / conditionDraft.ts).
//
// This file is now the composition root: dialog open/close state, the share
// toast, and wiring the pieces to useAlertsStore.ts (defs/prefs/packs over IPC
// plus the live recent-fires history from the alerts module).

import { type JSX, useCallback, useMemo, useState } from 'react'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography
} from '@mui/material'
import Snackbar from '@mui/material/Snackbar'
import MuiAlert from '@mui/material/Alert'
import type { AlertDef } from '@shared/types'
import type { ShareApplyResult } from '@shared/profiles'
import { playAlertNow, refreshAlertStore } from './player'
import SoundPacksDialog from './SoundPacksDialog'
import SuggestAlertsDialog from './SuggestAlertsDialog'
import AlertDialog from './AlertDialog'
import AlertList from './AlertList'
import AlertsToolbar from './AlertsToolbar'
import { useAlertsStore } from './useAlertsStore'
import ShareImportDialog from '../profiles/ShareImportDialog'
import { copyText } from '../../lib/clipboard'

interface Toast {
  severity: 'success' | 'warning'
  text: string
}

/**
 * Play an alert directly at the current global × per-alert volume (ignores mute so
 * the user can hear what they're configuring).
 */
function testAlert(def: AlertDef): void {
  playAlertNow({ ...def, enabled: true })
}

/** Toast for a share-string copy of one alert (`ids:[id]`) or every alert. */
function shareToast(ok: boolean, ids: string[] | undefined, len: number): Toast {
  const what = ids?.length === 1 ? 'Alert' : 'All alerts'
  return ok
    ? { severity: 'success', text: `${what} copied — paste it to share (${len} chars).` }
    : { severity: 'warning', text: 'Could not reach the clipboard.' }
}

/** Toast for an applied (additive) share import. */
function importToast(res: ShareApplyResult): Toast {
  return {
    severity: res.ok ? 'success' : 'warning',
    text: res.ok
      ? res.added
        ? `Added ${res.added} alert${res.added === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped} you already had` : ''}.`
        : 'Nothing to add — you already have every alert in that string.'
      : res.error ?? 'Import failed.'
  }
}

function AlertsToast({ toast, onClose }: { toast: Toast | null; onClose: () => void }): JSX.Element {
  return (
    <Snackbar
      open={!!toast}
      autoHideDuration={5000}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <MuiAlert severity={toast?.severity ?? 'success'} variant="filled" onClose={onClose}>
        {toast?.text}
      </MuiAlert>
    </Snackbar>
  )
}

/** Open/close + "add vs edit" state for the one AlertDialog instance. */
interface EditDialog {
  open: boolean
  target: AlertDef | null
  openAdd: () => void
  openEdit: (def: AlertDef) => void
  close: () => void
}

function useEditDialog(): EditDialog {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState<AlertDef | null>(null)
  return {
    open,
    target,
    openAdd: () => {
      setTarget(null)
      setOpen(true)
    },
    openEdit: (def) => {
      setTarget(def)
      setOpen(true)
    },
    close: () => setOpen(false)
  }
}

function ConfirmResetDialog({
  open,
  onCancel,
  onConfirm
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs">
      <DialogTitle>Reset alerts to defaults?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">
          This replaces all alerts — including any you added or edited — with the
          seeded built-in set (Charm break + Raid target defeated). This can&apos;t be undone.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button color="warning" variant="contained" onClick={onConfirm}>
          Reset
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default function AlertsView(): JSX.Element {
  const store = useAlertsStore()
  const { alerts, prefs, sortedPacks, history, persistAlerts, removeAlert } = store

  const edit = useEditDialog()
  const [confirmReset, setConfirmReset] = useState(false)
  const [packsDialogOpen, setPacksDialogOpen] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  // Sharing (src/shared/profiles.ts): copy one/all alerts as a paste-safe EQC1- string, or
  // import someone else's ADDITIVELY through the shared preview dialog.
  const [importOpen, setImportOpen] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)

  /** Copy a share string for one alert (`ids:[id]`) or every alert (`ids` omitted). */
  const copyShare = useCallback(async (ids?: string[]) => {
    const text = await window.eq.exportAlertsShare(ids)
    const ok = await copyText(text)
    setToast(shareToast(ok, ids, text.length))
  }, [])

  const doReset = useCallback(async () => {
    await store.resetAlerts()
    setConfirmReset(false)
  }, [store])

  // ids of alerts that already exist — the Suggest wizard renders those suggestions as
  // checked/disabled (match by the stable `suggest:<key>:<template>` id convention).
  const existingIds = useMemo(() => new Set(alerts.map((a) => a.id)), [alerts])

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      {/* Global controls */}
      <AlertsToolbar
        prefs={prefs}
        onPrefsDrag={store.setPrefs}
        onPrefsCommit={(next) => void store.persistPrefs(next)}
        hasAlerts={alerts.length > 0}
        onOpenPacks={() => setPacksDialogOpen(true)}
        onCopyAll={() => void copyShare()}
        onOpenImport={() => setImportOpen(true)}
        onReset={() => setConfirmReset(true)}
      />

      {/* Alert list */}
      <AlertList
        alerts={alerts}
        history={history}
        packs={sortedPacks}
        onAddSuggestion={() => setSuggestOpen(true)}
        handlers={{
          onPersist: (def) => void persistAlerts(def),
          onVolumeDrag: store.setAlertVolume,
          onTest: testAlert,
          onCopyShare: (ids) => void copyShare(ids),
          onEdit: edit.openEdit,
          onRemove: (id) => void removeAlert(id)
        }}
      />

      <AlertDialog
        open={edit.open}
        initial={edit.target}
        packs={sortedPacks}
        onClose={edit.close}
        onSave={(def) => {
          void persistAlerts(def)
          edit.close()
        }}
      />

      <SoundPacksDialog
        open={packsDialogOpen}
        onClose={() => setPacksDialogOpen(false)}
        onInstalledChange={() => void store.refreshPacks()}
      />

      <SuggestAlertsDialog
        open={suggestOpen}
        existingIds={existingIds}
        onClose={() => setSuggestOpen(false)}
        onCreate={persistAlerts}
        onDelete={removeAlert}
        onCreateManually={() => {
          // Escape hatch: close the picker and open the blank manual editor.
          setSuggestOpen(false)
          edit.openAdd()
        }}
      />

      <ShareImportDialog
        open={importOpen}
        scope="alerts"
        onClose={() => setImportOpen(false)}
        onApplied={(res) => {
          void store.reload()
          void refreshAlertStore()
          setToast(importToast(res))
        }}
      />

      <AlertsToast toast={toast} onClose={() => setToast(null)} />

      <ConfirmResetDialog
        open={confirmReset}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void doReset()}
      />
    </Stack>
  )
}
