// SoundPackRow — one registry pack in the SoundPacksDialog list: name, size,
// category chips, install/uninstall with live progress, and the expandable
// per-sound preview panel. Extracted from SoundPacksDialog.tsx (Wave D
// factoring); the markup and the install/preview wiring are unchanged.

import type { JSX } from 'react'
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  LinearProgress,
  Stack,
  Typography
} from '@mui/material'
import DownloadIcon from '@mui/icons-material/Download'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import type { PackInstallProgress, PackPreviewSound, RegistryPackView } from '@shared/types'

/** Preview-listing fetch state for one expanded pack. */
export interface PreviewState {
  loading: boolean
  sounds?: PackPreviewSound[]
  error?: string
}

export function sizeMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`
}

/** Short human phase label for a row's live progress line. */
function phaseLabel(p: PackInstallProgress): string {
  switch (p.phase) {
    case 'downloading':
      return p.percent != null ? `Downloading… ${p.percent}%` : 'Downloading…'
    case 'extracting':
      return 'Extracting…'
    case 'converting':
      return 'Converting…'
    case 'done':
      return 'Installed'
    case 'error':
      return `Error: ${p.message ?? 'install failed'}`
    default:
      return ''
  }
}

/** The live phase line + bar for a row mid-install; nothing until a push arrives. */
function PackProgress({
  prog,
  isBusy
}: {
  prog: PackInstallProgress | undefined
  isBusy: boolean
}): JSX.Element | null {
  if (!prog) return null
  const installing = isBusy && prog.phase !== 'done' && prog.phase !== 'error'
  return (
    <Box sx={{ mt: 0.75 }}>
      <Typography variant="caption" color={prog.phase === 'error' ? 'error' : 'text.secondary'}>
        {phaseLabel(prog)}
      </Typography>
      {installing && (
        <LinearProgress
          variant={prog.percent != null ? 'determinate' : 'indeterminate'}
          value={prog.percent ?? undefined}
          sx={{ mt: 0.25 }}
        />
      )}
    </Box>
  )
}

/** One previewable sound: play/stop button + label. */
function PreviewSoundRow({
  sound,
  isLoading,
  isPlaying,
  onPlay
}: {
  sound: PackPreviewSound
  isLoading: boolean
  isPlaying: boolean
  onPlay: () => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 0.25 }}>
      <IconButton
        size="small"
        color={isPlaying ? 'primary' : 'default'}
        onClick={onPlay}
        title="Play preview"
        sx={{ p: 0.25 }}
      >
        {isLoading ? <CircularProgress size={14} /> : <PlayArrowIcon fontSize="small" />}
      </IconButton>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {sound.label}
      </Typography>
    </Stack>
  )
}

/** The fetched sound listing for an expanded pack (loading / error / rows). */
function PackPreviewList({
  packName,
  preview,
  playingKey,
  loadingKey,
  onPlay
}: {
  packName: string
  preview: PreviewState | undefined
  playingKey: string | null
  loadingKey: string | null
  onPlay: (name: string, file: string) => void
}): JSX.Element | null {
  if (!preview || preview.loading || preview.error) return null
  const sounds = preview.sounds ?? []
  return (
    <Stack spacing={0}>
      {sounds.map((s) => {
        const k = `${packName}::${s.file}`
        return (
          <PreviewSoundRow
            key={s.soundId}
            sound={s}
            isLoading={loadingKey === k}
            isPlaying={playingKey === k}
            onPlay={() => onPlay(packName, s.file)}
          />
        )
      })}
      {sounds.length === 0 && (
        <Typography variant="caption" color="text.secondary">
          No previewable sounds.
        </Typography>
      )}
    </Stack>
  )
}

/** The collapsible preview panel under a row. */
function PackPreviewPanel({
  packName,
  isExpanded,
  preview,
  playingKey,
  loadingKey,
  onPlay
}: {
  packName: string
  isExpanded: boolean
  preview: PreviewState | undefined
  playingKey: string | null
  loadingKey: string | null
  onPlay: (name: string, file: string) => void
}): JSX.Element {
  return (
    <Collapse in={isExpanded} unmountOnExit>
      <Box sx={{ mt: 1, pl: 4.5 }}>
        {preview?.loading && (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={14} />
            <Typography variant="caption" color="text.secondary">
              Loading sounds…
            </Typography>
          </Stack>
        )}
        {preview?.error && (
          <Typography variant="caption" color="error">
            Couldn't load preview: {preview.error}
          </Typography>
        )}
        <PackPreviewList
          packName={packName}
          preview={preview}
          playingKey={playingKey}
          loadingKey={loadingKey}
          onPlay={onPlay}
        />
      </Box>
    </Collapse>
  )
}

/** Name + installed badge + counts + description + category chips + progress. */
function PackMeta({
  p,
  prog,
  isBusy
}: {
  p: RegistryPackView
  prog: PackInstallProgress | undefined
  isBusy: boolean
}): JSX.Element {
  return (
    <Box sx={{ flexGrow: 1, minWidth: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {p.display_name}
        </Typography>
        {p.installed && (
          <Chip
            size="small"
            color="success"
            variant="outlined"
            icon={<CheckCircleIcon />}
            label="Installed"
          />
        )}
        <Typography variant="caption" color="text.secondary">
          {p.sound_count} sounds · {sizeMb(p.total_size_bytes)}
        </Typography>
      </Stack>
      {p.description && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
          {p.description}
        </Typography>
      )}
      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
        {p.categories.map((c) => (
          <Chip key={c} size="small" variant="outlined" label={c} sx={{ height: 18, fontSize: 10 }} />
        ))}
      </Stack>
      <PackProgress prog={prog} isBusy={isBusy} />
    </Box>
  )
}

/** Install button / uninstall icon, whichever applies. */
function PackAction({
  p,
  isBusy,
  onInstall,
  onUninstall
}: {
  p: RegistryPackView
  isBusy: boolean
  onInstall: () => void
  onUninstall: () => void
}): JSX.Element {
  return (
    <Box sx={{ flexShrink: 0 }}>
      {p.installed ? (
        <IconButton
          size="small"
          color="error"
          disabled={isBusy}
          onClick={onUninstall}
          title="Uninstall"
        >
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      ) : (
        <Button
          size="small"
          variant="outlined"
          startIcon={<DownloadIcon />}
          disabled={isBusy}
          onClick={onInstall}
        >
          Install
        </Button>
      )}
    </Box>
  )
}

/** Everything the dialog hands each row: state slices + fire-and-forget actions. */
export interface SoundPackRowProps {
  p: RegistryPackView
  prog: PackInstallProgress | undefined
  isBusy: boolean
  isExpanded: boolean
  preview: PreviewState | undefined
  playingKey: string | null
  loadingKey: string | null
  onToggleExpand: (name: string) => void
  onInstall: (name: string) => void
  onUninstall: (name: string) => void
  onPlay: (name: string, file: string) => void
}

export default function SoundPackRow({
  p,
  prog,
  isBusy,
  isExpanded,
  preview,
  playingKey,
  loadingKey,
  onToggleExpand,
  onInstall,
  onUninstall,
  onPlay
}: SoundPackRowProps): JSX.Element {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 1.25
      }}
    >
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <IconButton
          size="small"
          onClick={() => onToggleExpand(p.name)}
          title={isExpanded ? 'Hide sounds' : 'Preview sounds'}
          sx={{ mt: -0.25, ml: -0.5 }}
        >
          {isExpanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        </IconButton>
        <PackMeta p={p} prog={prog} isBusy={isBusy} />
        <PackAction
          p={p}
          isBusy={isBusy}
          onInstall={() => onInstall(p.name)}
          onUninstall={() => onUninstall(p.name)}
        />
      </Stack>

      <PackPreviewPanel
        packName={p.name}
        isExpanded={isExpanded}
        preview={preview}
        playingKey={playingKey}
        loadingKey={loadingKey}
        onPlay={onPlay}
      />
    </Box>
  )
}
