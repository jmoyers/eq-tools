// SoundPacksDialog — browse + install openpeon.com registry sound packs (Task #29).
//
// Opens from the "Sound packs" section in AlertsView. Lists the registry (fetched
// over `packs:registry`, 24h cached main-side), searchable by name/description,
// with each row showing the display name, sound count, size in MB, category chips,
// an installed badge, and Install/Uninstall with per-row progress. Install streams
// `packs:progress` pushes; on completion we invalidate the renderer sound-pack
// caches (so the pack shows up in the alert sound pickers immediately) and notify
// the parent to refresh its pack list.
//
// The row markup lives in SoundPackRow.tsx; this file is the dialog chrome plus
// the three state machines behind it (registry fetch, install/uninstall, preview).

import {
  type JSX,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState
} from 'react'
import {
  Alert,
  Box,
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
import RefreshIcon from '@mui/icons-material/Refresh'
import type { PackInstallProgress, RegistryPackView } from '@shared/types'
import { currentPrefs } from './player'
import { invalidateSoundCaches, playPreviewSound, revokePreviewCache, stopPreview } from './soundCache'
import SoundPackRow, { type PreviewState } from './SoundPackRow'

interface RegistryState {
  packs: RegistryPackView[]
  loading: boolean
  error: string | null
  fromCache: boolean
  load: (force?: boolean) => Promise<void>
}

/** The registry listing itself: fetched on open, re-fetchable with `force`. */
function useRegistryPacks(open: boolean): RegistryState {
  const [packs, setPacks] = useState<RegistryPackView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fromCache, setFromCache] = useState(false)

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

  return { packs, loading, error, fromCache, load }
}

interface InstallState {
  progress: Record<string, PackInstallProgress>
  busy: Set<string>
  install: (name: string) => Promise<void>
  uninstall: (name: string) => Promise<void>
}

/** Per-pack live progress + busy flags, keyed by pack name. */
function usePackInstall(
  load: (force?: boolean) => Promise<void>,
  onInstalledChange: () => void
): InstallState {
  const [progress, setProgress] = useState<Record<string, PackInstallProgress>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())

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
          // Drop this pack's stale progress line by REBUILDING the map without it
          // (a dynamic `delete` on a computed key is banned, and the state object
          // must not be mutated in place anyway).
          setProgress((prev) => {
            const { [name]: _gone, ...rest } = prev
            return rest
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

  return { progress, busy, install, uninstall }
}

interface PreviewsState {
  expanded: Set<string>
  previews: Record<string, PreviewState>
  playingKey: string | null
  loadingKey: string | null
  toggleExpand: (name: string) => void
  playPreview: (name: string, file: string) => Promise<void>
}

/**
 * Preview: which packs are expanded, their fetched sound listings, and which
 * single (pack,file) preview is currently loading its bytes / playing.
 */
function usePackPreviews(open: boolean): PreviewsState {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({})
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const [loadingKey, setLoadingKey] = useState<string | null>(null)

  // Revoke preview Blob URLs + stop playback whenever the dialog closes.
  useEffect(() => {
    if (open) return
    revokePreviewCache()
    setExpanded(new Set())
    setPlayingKey(null)
    setLoadingKey(null)
  }, [open])

  // Toggle a pack's preview panel; fetch its sound listing on first expand.
  const toggleExpand = useCallback((name: string) => {
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
          .catch((e: unknown) => {
            setPreviews((p) => ({
              ...p,
              [name]: { loading: false, error: e instanceof Error ? e.message : String(e) }
            }))
          })
        return { ...cur, [name]: { loading: true } }
      })
      return next
    })
  }, [])

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

  return { expanded, previews, playingKey, loadingKey, toggleExpand, playPreview }
}

/**
 * Typing echoes immediately; filtering + re-rendering the pack list consumes a
 * DEFERRED query so a keystroke never blocks (Task #41).
 */
function usePackSearch(packs: RegistryPackView[]): {
  search: string
  setSearch: (v: string) => void
  filtered: RegistryPackView[]
} {
  const [search, setSearch] = useState('')
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

  return { search, setSearch, filtered }
}

/** The registry error banner — cached-list warning vs. a hard failure. */
function RegistryError({
  error,
  fromCache
}: {
  error: string | null
  fromCache: boolean
}): JSX.Element | null {
  if (!error) return null
  return (
    <Alert severity={fromCache ? 'warning' : 'error'} variant="outlined">
      {fromCache
        ? `Showing cached list — couldn't reach the registry (${error}).`
        : `Couldn't load the registry: ${error}`}
    </Alert>
  )
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
  const registry = useRegistryPacks(open)
  const installer = usePackInstall(registry.load, onInstalledChange)
  const preview = usePackPreviews(open)
  const { search, setSearch, filtered } = usePackSearch(registry.packs)

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flexGrow: 1 }}>Sound pack registry</Box>
        <Typography variant="caption" color="text.secondary">
          {registry.packs.length} packs
        </Typography>
        <IconButton
          size="small"
          onClick={() => void registry.load(true)}
          disabled={registry.loading}
          title="Refresh"
        >
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

          <RegistryError error={registry.error} fromCache={registry.fromCache} />
          {registry.loading && <LinearProgress />}

          <Box sx={{ maxHeight: '55vh', overflow: 'auto' }}>
            <Stack spacing={1}>
              {filtered.map((p) => (
                <SoundPackRow
                  key={p.name}
                  p={p}
                  prog={installer.progress[p.name]}
                  isBusy={installer.busy.has(p.name)}
                  isExpanded={preview.expanded.has(p.name)}
                  preview={preview.previews[p.name]}
                  playingKey={preview.playingKey}
                  loadingKey={preview.loadingKey}
                  onToggleExpand={preview.toggleExpand}
                  onInstall={(name) => void installer.install(name)}
                  onUninstall={(name) => void installer.uninstall(name)}
                  onPlay={(name, file) => void preview.playPreview(name, file)}
                />
              ))}
              {!registry.loading && filtered.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
                  {registry.packs.length === 0 ? 'No packs available.' : 'No packs match your search.'}
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
