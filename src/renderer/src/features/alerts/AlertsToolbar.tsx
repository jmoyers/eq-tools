// AlertsToolbar — the global controls strip above the alert list: volume + mute,
// the sound-pack registry browser, share copy/import, and "Reset to defaults".
// Extracted from AlertsView.tsx (Wave D factoring).

import type { JSX } from 'react'
import {
  Box,
  Button,
  FormControlLabel,
  Paper,
  Slider,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import VolumeUpIcon from '@mui/icons-material/VolumeUp'
import VolumeOffIcon from '@mui/icons-material/VolumeOff'
import LibraryMusicIcon from '@mui/icons-material/LibraryMusic'
import IosShareIcon from '@mui/icons-material/IosShare'
import FileUploadIcon from '@mui/icons-material/FileUpload'
import type { AlertPrefs } from '@shared/types'

export default function AlertsToolbar({
  prefs,
  onPrefsDrag,
  onPrefsCommit,
  hasAlerts,
  onOpenPacks,
  onCopyAll,
  onOpenImport,
  onReset
}: {
  prefs: AlertPrefs
  /** Local-only update while the volume slider is dragged. */
  onPrefsDrag: (next: AlertPrefs) => void
  /** Persisted update (slider release, mute toggle). */
  onPrefsCommit: (next: AlertPrefs) => void
  hasAlerts: boolean
  onOpenPacks: () => void
  onCopyAll: () => void
  onOpenImport: () => void
  onReset: () => void
}): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 240 }}>
          {prefs.muted ? <VolumeOffIcon color="disabled" /> : <VolumeUpIcon color="primary" />}
          <Typography variant="body2" sx={{ width: 90 }}>
            Global volume
          </Typography>
          <Slider
            size="small"
            min={0}
            max={1}
            step={0.05}
            value={prefs.globalVolume}
            onChange={(_e, v) => onPrefsDrag({ ...prefs, globalVolume: v as number })}
            onChangeCommitted={(_e, v) => onPrefsCommit({ ...prefs, globalVolume: v as number })}
            sx={{ width: 140 }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ width: 34 }}>
            {Math.round(prefs.globalVolume * 100)}%
          </Typography>
        </Stack>
        <FormControlLabel
          control={
            <Switch
              checked={prefs.muted}
              onChange={(e) => onPrefsCommit({ ...prefs, muted: e.target.checked })}
            />
          }
          label="Mute all"
        />
        <Box sx={{ flexGrow: 1 }} />
        <Button
          startIcon={<LibraryMusicIcon />}
          variant="outlined"
          size="small"
          onClick={onOpenPacks}
        >
          Sound packs…
        </Button>
        <Tooltip title="Copy every alert as one share string">
          <span>
            <Button
              startIcon={<IosShareIcon />}
              variant="outlined"
              size="small"
              disabled={!hasAlerts}
              onClick={onCopyAll}
            >
              Copy all
            </Button>
          </span>
        </Tooltip>
        <Button
          startIcon={<FileUploadIcon />}
          variant="outlined"
          size="small"
          onClick={onOpenImport}
        >
          Import…
        </Button>
        <Button
          startIcon={<RestartAltIcon />}
          variant="outlined"
          size="small"
          color="warning"
          onClick={onReset}
        >
          Reset to defaults
        </Button>
      </Stack>
    </Paper>
  )
}
