// SoundPacksDialog — browse + install openpeon.com registry sound packs (Task #29).
//
// Opens from the "Sound packs" section in AlertsView. Lists the registry (fetched
// over `packs:registry`, 24h cached main-side), searchable by name/description,
// with each row showing the display name, sound count, size in MB, category chips,
// an installed badge, and Install/Uninstall with per-row progress. Install streams
// `packs:progress` pushes; on completion we invalidate the renderer sound-pack
// caches (so the pack shows up in the alert sound pickers immediately) and notify
// the parent to refresh its pack list.

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import DownloadIcon from '@mui/icons-material/Download'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RefreshIcon from '@mui/icons-material/Refresh'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import type { PackInstallProgress, PackPreviewSound, RegistryPackView } from '@shared/types'
import { currentPrefs } from './player'
import { invalidateSoundCaches, playPreviewSound, revokePreviewCache, stopPreview } from './soundCache'

/** Preview-listing fetch state for one expanded pack. */
interface PreviewState {
  loading: boolean
  sounds?: PackPreviewSound[]
  error?: string
}

function sizeMb(bytes: number): string {
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

export default function SoundPacksDialog({
  open,
  onClose,
  onInstalledChange
}: {
  open: boolean
  onClose: () => void
  /** Called after a successful install/uninstall so the parent refreshes packs. */
  onInstalledChange: () => void
}): JSX.Element {
  const [packs, setPacks] = useState<RegistryPackView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fromCache, setFromCache] = useState(false)
  const [search, setSearch] = useState('')
  // Per-pack live progress + busy flags, keyed by pack name.
  const [progress, setProgress] = useState<Record<string, PackInstallProgress>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  // Preview: which packs are expanded, their fetched sound listings, and which
  // single (pack,file) preview is currently loading its bytes / playing.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({})
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)

  const load = useCallback(async (force = false) => {
    setLoading(true)
    try {
      const res = await window.eq.listRegistryPacks(force)
      setPacks(res.packs)
      setError(res.error ?? null)
      setFromCache(!!res.fromCache)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load(false)
  }, [open, load])

  // Subscribe to install progress pushes for the whole dialog lifetime.
  useEffect(() => {
    const off = window.eq.onPackProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.name]: p }))
    })
    return off
  }, [])

  const install = useCallback(
    async (name: string) => {
      setBusy((prev) => new Set(prev).add(name))
      try {
        const res = await window.eq.installPack(name)
        if (res.ok) {
          invalidateSoundCaches()
          onInstalledChange()
          await load(false)
        } else {
          setProgress((prev) => ({ ...prev, [name]: { name, phase: 'error', message: res.error } }))
        }
      } finally {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(name)
          return next
        })
      }
    },
    [load, onInstalledChange]
  )

  const uninstall = useCallback(
    async (name: string) => {
      setBusy((prev) => new Set(prev).add(name))
      try {
        const res = await window.eq.uninstallPack(name)
        if (res.ok) {
          invalidateSoundCaches()
          onInstalledChange()
          setProgress((prev) => {
            const next = { ...prev }
            delete next[name]
            return next
          })
          await load(false)
        } else {
          setProgress((prev) => ({ ...prev, [name]: { name, phase: 'error', message: res.error } }))
        }
      } finally {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(name)
          return next
        })
      }
    },
    [load, onInstalledChange]
  )

  // Revoke preview Blob URLs + stop playback whenever the dialog closes.
  useEffect(() => {
    if (open) return
    revokePreviewCache()
    setExpanded(new Set())
    setPlayingKey(null)
    setLoadingKey(null)
  }, [open])

  // Toggle a pack's preview panel; fetch its sound listing on first expand.
  const toggleExpand = useCallback(
    (name: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(name)) {
          next.delete(name)
          return next
        }
        next.add(name)
        // Fetch the listing lazily (only once per pack).
        setPreviews((cur) => {
          if (cur[name]) return cur
          void window.eq
            .previewPackSounds(name)
            .then((res) => {
              setPreviews((p) => ({
                ...p,
                [name]: { loading: false, sounds: res.sounds, error: res.error }
              }))
            })
            .catch((e) => {
              setPreviews((p) => ({
                ...p,
                [name]: { loading: false, error: e instanceof Error ? e.message : String(e) }
              }))
            })
          return { ...cur, [name]: { loading: true } }
        })
        return next
      })
    },
    []
  )

  // Play one preview sound at the global alert volume (respect mute; one at a time).
  const playPreview = useCallback(async (name: string, file: string) => {
    const k = `${name}::${file}`
    const prefs = currentPrefs()
    if (prefs.muted) return
    // Toggle-off if this exact one is already playing.
    if (playingKey === k) {
      stopPreview()
      setPlayingKey(null)
      return
    }
    setLoadingKey(k)
    const ok = await playPreviewSound(name, file, prefs.globalVolume)
    setLoadingKey((cur) => (cur === k ? null : cur))
    setPlayingKey(ok ? k : null)
  }, [playingKey])

  // Typing echoes immediately; filtering + re-rendering the pack list consumes a
  // DEFERRED query so a keystroke never blocks (Task #41).
  const deferredSearch = useDeferredValue(search)

  // Precompute one lowercase search key per pack ONCE per pack-list change, so the
  // per-keystroke filter is a single substring test (not 4 lowercasings × 350 packs).
  const keyed = useMemo(
    () =>
      packs.map((p) => ({
        p,
        key: [p.display_name, p.name, p.description ?? '', p.categories.join(' ')].join(' ').toLowerCase()
      })),
    [packs]
  )

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase()
    if (!q) return packs
    return keyed.filter((r) => r.key.includes(q)).map((r) => r.p)
  }, [keyed, packs, deferredSearch])

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flexGrow: 1 }}>Sound pack registry</Box>
        <Typography variant="caption" color="text.secondary">
          {packs.length} packs
        </Typography>
        <IconButton size="small" onClick={() => void load(true)} disabled={loading} title="Refresh">
          <RefreshIcon fontSize="small" />
        </IconButton>
        <IconButton size="small" onClick={onClose} title="Close">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="Search packs (name, description, category)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {error && (
            <Alert severity={fromCache ? 'warning' : 'error'} variant="outlined">
              {fromCache
                ? `Showing cached list — couldn't reach the registry (${error}).`
                : `Couldn't load the registry: ${error}`}
            </Alert>
          )}
          {loading && <LinearProgress />}

          <Box sx={{ maxHeight: '55vh', overflow: 'auto' }}>
            <Stack spacing={1}>
              {filtered.map((p) => {
                const prog = progress[p.name]
                const isBusy = busy.has(p.name)
                const installing =
                  isBusy && prog && prog.phase !== 'done' && prog.phase !== 'error'
                const isExpanded = expanded.has(p.name)
                const preview = previews[p.name]
                return (
                  <Box
                    key={p.name}
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
                        onClick={() => toggleExpand(p.name)}
                        title={isExpanded ? 'Hide sounds' : 'Preview sounds'}
                        sx={{ mt: -0.25, ml: -0.5 }}
                      >
                        {isExpanded ? (
                          <ExpandMoreIcon fontSize="small" />
                        ) : (
                          <ChevronRightIcon fontSize="small" />
                        )}
                      </IconButton>
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
                            <Chip
                              key={c}
                              size="small"
                              variant="outlined"
                              label={c}
                              sx={{ height: 18, fontSize: 10 }}
                            />
                          ))}
                        </Stack>
                        {prog && (
                          <Box sx={{ mt: 0.75 }}>
                            <Typography
                              variant="caption"
                              color={prog.phase === 'error' ? 'error' : 'text.secondary'}
                            >
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
                        )}
                      </Box>
                      <Box sx={{ flexShrink: 0 }}>
                        {p.installed ? (
                          <IconButton
                            size="small"
                            color="error"
                            disabled={isBusy}
                            onClick={() => void uninstall(p.name)}
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
                            onClick={() => void install(p.name)}
                          >
                            Install
                          </Button>
                        )}
                      </Box>
                    </Stack>

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
                        {preview && !preview.loading && !preview.error && (
                          <Stack spacing={0}>
                            {(preview.sounds ?? []).map((s) => {
                              const k = `${p.name}::${s.file}`
                              const isLoading = loadingKey === k
                              const isPlaying = playingKey === k
                              return (
                                <Stack
                                  key={s.soundId}
                                  direction="row"
                                  spacing={1}
                                  alignItems="center"
                                  sx={{ py: 0.25 }}
                                >
                                  <IconButton
                                    size="small"
                                    color={isPlaying ? 'primary' : 'default'}
                                    onClick={() => void playPreview(p.name, s.file)}
                                    title="Play preview"
                                    sx={{ p: 0.25 }}
                                  >
                                    {isLoading ? (
                                      <CircularProgress size={14} />
                                    ) : (
                                      <PlayArrowIcon fontSize="small" />
                                    )}
                                  </IconButton>
                                  <Typography
                                    variant="caption"
                                    color="text.secondary"
                                    sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                  >
                                    {s.label}
                                  </Typography>
                                </Stack>
                              )
                            })}
                            {(preview.sounds?.length ?? 0) === 0 && (
                              <Typography variant="caption" color="text.secondary">
                                No previewable sounds.
                              </Typography>
                            )}
                          </Stack>
                        )}
                      </Box>
                    </Collapse>
                  </Box>
                )
              })}
              {!loading && filtered.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
                  {packs.length === 0 ? 'No packs available.' : 'No packs match your search.'}
                </Typography>
              )}
            </Stack>
          </Box>

          <Typography variant="caption" color="text.secondary">
            Packs from openpeon.com (PeonPing/og-packs) — game-audio packs are typically
            CC-BY-NC; personal use.
          </Typography>
        </Stack>
      </DialogContent>
    </Dialog>
  )
}
