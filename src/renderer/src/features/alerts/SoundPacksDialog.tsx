// SoundPacksDialog — browse + install openpeon.com registry sound packs (Task #29).
//
// Opens from the "Sound packs" section in AlertsView. Lists the registry (fetched
// over `packs:registry`, 24h cached main-side), searchable by name/description,
// with each row showing the display name, sound count, size in MB, category chips,
// an installed badge, and Install/Uninstall with per-row progress. Install streams
// `packs:progress` pushes; on completion we invalidate the renderer sound-pack
// caches (so the pack shows up in the alert sound pickers immediately) and notify
// the parent to refresh its pack list.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
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
import type { PackInstallProgress, RegistryPackView } from '@shared/types'
import { invalidateSoundCaches } from './soundCache'

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return packs
    return packs.filter(
      (p) =>
        p.display_name.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.description ?? '').toLowerCase().includes(q) ||
        p.categories.some((c) => c.toLowerCase().includes(q))
    )
  }, [packs, search])

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
                    <Stack direction="row" spacing={1.5} alignItems="flex-start">
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
