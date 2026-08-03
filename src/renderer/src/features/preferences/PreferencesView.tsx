// PreferencesView — the app's single settings surface (Task #55).
//
// Replaces the old SettingsDialog (EQ install folder) and the drawer's update-channel
// selector: everything app-level lives here, reached from the drawer's bottom-aligned
// "Preferences" item, the title-bar gear, and the fresh-machine empty state.
//
// Layout: a search field over a [section rail | sections] split. The search echoes
// instantly from local state and filters a DEFERRED copy (AGENTS.md search pattern);
// matches keep their section header, so a hit always carries its context. Section
// labels match too, so typing "updates" shows that whole section.
//
// Sections:
//   Game     — EverQuest install-folder discovery/override (effective path + how it
//             resolved + a folder picker + character-log validation).
//   Profiles — export your GLOBAL settings as a paste-safe share string / file, and import
//             someone else's ADDITIVELY (see src/shared/profiles.ts for the data model).
//   Updates — app version, last-checked time, a manual check, background download
//             progress, and the "Relaunch to update" action when one is waiting.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import SportsEsportsIcon from '@mui/icons-material/SportsEsports'
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt'
import RefreshIcon from '@mui/icons-material/Refresh'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import IosShareIcon from '@mui/icons-material/IosShare'
import { ExportSettingsSetting, ImportSettingsSetting } from '../profiles/ProfileSharing'
import type { EqConfig, UpdateStatus } from '@shared/types'
import { updateChipState } from '@shared/update'
import { formatDateTime } from '../../lib/formatDate'
import { normalizeQuery } from '../../lib/search'

// ---------------------------------------------------------------- Game section

const SOURCE_CHIP: Record<EqConfig['source'], { label: string; color: 'success' | 'info' | 'warning' }> = {
  manual: { label: 'manual', color: 'info' },
  auto: { label: 'auto-detected', color: 'success' },
  default: { label: 'default (unverified)', color: 'warning' }
}

/**
 * EverQuest install folder: the effective path, a chip saying how it resolved, the
 * folder picker + auto-detection reset, and validation feedback (how many character
 * logs are under <root>\Logs). Changes apply live — main re-lists characters, re-tails
 * if the active log moved, and pushes eqconfig:changed, which we listen to so this
 * stays correct no matter who changed it.
 */
function EqFolderSetting(): JSX.Element {
  const [config, setConfig] = useState<EqConfig | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.eq.getEqConfig().then(setConfig)
    return window.eq.onEqConfigChanged(setConfig)
  }, [])

  const pick = useCallback(async () => {
    setBusy(true)
    try {
      const res = await window.eq.pickEqDir()
      setConfig(res.config)
    } finally {
      setBusy(false)
    }
  }, [])

  const reset = useCallback(async () => {
    setBusy(true)
    try {
      setConfig(await window.eq.resetEqDir())
    } finally {
      setBusy(false)
    }
  }, [])

  const found = config?.characterCount ?? 0
  const chip = config ? SOURCE_CHIP[config.source] : null

  return (
    <Stack spacing={1.5}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexWrap: 'wrap',
          p: 1.25,
          borderRadius: 1,
          border: 1,
          borderColor: 'divider',
          bgcolor: 'background.default'
        }}
      >
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Typography
            variant="body2"
            sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
            title={config?.root}
          >
            {config?.root ?? '—'}
          </Typography>
        </Box>
        {chip && <Chip size="small" label={chip.label} color={chip.color} variant="outlined" />}
      </Box>

      {config &&
        (found > 0 ? (
          <Alert severity="success" variant="outlined">
            Found {found} character log{found === 1 ? '' : 's'} in this folder.
          </Alert>
        ) : (
          <Alert severity="warning" variant="outlined">
            No character logs (eqlog_*.txt) found here. Make sure EverQuest logging is enabled
            (/log on) and pick the game&apos;s install folder.
          </Alert>
        ))}

      <Stack direction="row" spacing={1}>
        <Button
          variant="contained"
          size="small"
          startIcon={<FolderOpenIcon />}
          onClick={() => void pick()}
          disabled={busy}
        >
          Choose folder…
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={<AutoFixHighIcon />}
          onClick={() => void reset()}
          disabled={busy || !config?.overridden}
        >
          Use auto-detection
        </Button>
      </Stack>
    </Stack>
  )
}

// ------------------------------------------------------------- Updates section

const STATE_CHIP: Record<
  UpdateStatus['state'],
  { label: string; color: 'default' | 'success' | 'info' | 'warning' }
> = {
  idle: { label: 'up to date', color: 'default' },
  checking: { label: 'checking', color: 'info' },
  available: { label: 'update available', color: 'info' },
  downloading: { label: 'downloading', color: 'info' },
  ready: { label: 'update ready', color: 'success' },
  error: { label: 'check failed', color: 'warning' }
}

/** Shared status state: pull the last one (pushes predate this mount), then follow pushes. */
function useUpdateStatus(): UpdateStatus {
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

function VersionSetting({ version }: { version: string }): JSX.Element {
  return (
    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
      {version ? `v${version}` : '—'}
    </Typography>
  )
}

function UpdateSetting({ status, version }: { status: UpdateStatus; version: string }): JSX.Element {
  const [checking, setChecking] = useState(false)
  // Same post-check cooldown as the nav chip (10s): one answer is valid for at least
  // that long, and it keeps a rapid clicker from hammering the release feed.
  const [cooldown, setCooldown] = useState(false)
  // Same pure mapping the left-nav chip uses, so the two surfaces can never
  // disagree — in particular about the updated-away case (a 'ready' naming the
  // build we are ALREADY running is stale and must not offer a relaunch).
  const ui = updateChipState(status, version || undefined)
  // Dev build: the updater is off, so "up to date" would be a claim no check ever made.
  const chip = status.disabled
    ? { label: 'dev build — updates off', color: 'default' as const }
    : ui.kind === 'quiet' && status.state === 'ready'
      ? STATE_CHIP.idle
      : STATE_CHIP[status.state]
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

      {downloading && (
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
      )}

      {status.state === 'error' && status.message && (
        <Typography variant="caption" color="warning.main" sx={{ wordBreak: 'break-word' }}>
          {status.message}
        </Typography>
      )}

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
            onClick={() => void checkNow()}
            disabled={busy || cooldown || status.disabled}
          >
            Check for updates
          </Button>
        )}
      </Stack>
    </Stack>
  )
}

// ------------------------------------------------------------------- the view

interface PrefItem {
  id: string
  label: string
  /** Extra searchable words that aren't shown in the label. */
  keywords?: string
  content: JSX.Element
}

interface PrefSection {
  id: string
  label: string
  icon: JSX.Element
  items: PrefItem[]
}

const RAIL_WIDTH = 168

export default function PreferencesView(): JSX.Element {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const [active, setActive] = useState('game')
  const [version, setVersion] = useState('')
  const status = useUpdateStatus()
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({})

  useEffect(() => {
    let alive = true
    void window.eq.getAppVersion().then((v) => {
      if (alive) setVersion(v)
    })
    return () => {
      alive = false
    }
  }, [])

  const sections = useMemo<PrefSection[]>(
    () => [
      {
        id: 'game',
        label: 'Game',
        icon: <SportsEsportsIcon fontSize="small" />,
        items: [
          {
            id: 'eq-folder',
            label: 'EverQuest install folder',
            keywords: 'path directory logs eqlog character detect override install location',
            content: <EqFolderSetting />
          }
        ]
      },
      {
        id: 'profiles',
        label: 'Profiles',
        icon: <IosShareIcon fontSize="small" />,
        items: [
          {
            id: 'export-settings',
            label: 'Export your settings',
            keywords: 'share export copy backup string bundle profile send give clipboard file',
            content: <ExportSettingsSetting />
          },
          {
            id: 'import-settings',
            label: 'Import settings',
            keywords: 'share import paste restore string bundle profile receive add merge file',
            content: <ImportSettingsSetting />
          }
        ]
      },
      {
        id: 'updates',
        label: 'Updates',
        icon: <SystemUpdateAltIcon fontSize="small" />,
        items: [
          {
            id: 'version',
            label: 'Version',
            keywords: 'about build release app version',
            content: <VersionSetting version={version} />
          },
          {
            id: 'app-updates',
            label: 'App updates',
            keywords: 'update upgrade check relaunch restart install download automatic release',
            content: <UpdateSetting status={status} version={version} />
          }
        ]
      }
    ],
    [version, status]
  )

  // Lowercased search keys, recomputed only when the section set changes — the
  // per-keystroke filter is then a plain substring test.
  const keys = useMemo(() => {
    const m: Record<string, string> = {}
    for (const s of sections) {
      for (const i of s.items) m[`${s.id}/${i.id}`] = `${i.label} ${i.keywords ?? ''}`.toLowerCase()
    }
    return m
  }, [sections])

  const q = normalizeQuery(deferred)
  const visible = useMemo(() => {
    if (!q) return sections
    return sections
      .map((s) => {
        // A section-label match keeps the whole section (typing "updates" is a jump).
        if (s.label.toLowerCase().includes(q)) return s
        return { ...s, items: s.items.filter((i) => keys[`${s.id}/${i.id}`]?.includes(q)) }
      })
      .filter((s) => s.items.length > 0)
  }, [sections, keys, q])

  const jump = (id: string): void => {
    setActive(id)
    sectionRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          Preferences
        </Typography>
        <TextField
          size="small"
          placeholder="Search preferences…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ width: 280 }}
          InputProps={{
            startAdornment: <SearchIcon fontSize="small" sx={{ mr: 0.75, color: 'text.secondary' }} />
          }}
        />
      </Box>

      <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start' }}>
        <List
          dense
          disablePadding
          sx={{ width: RAIL_WIDTH, flexShrink: 0, position: 'sticky', top: 0 }}
        >
          {visible.map((s) => (
            <ListItemButton
              key={s.id}
              dense
              selected={active === s.id}
              onClick={() => jump(s.id)}
              sx={{ borderRadius: 1, gap: 1 }}
            >
              <Box sx={{ display: 'flex', color: 'text.secondary' }}>{s.icon}</Box>
              <ListItemText primaryTypographyProps={{ variant: 'body2' }} primary={s.label} />
            </ListItemButton>
          ))}
        </List>

        <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          {visible.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No preferences match “{query.trim()}”.
            </Typography>
          )}
          {visible.map((s) => (
            <Box
              key={s.id}
              ref={(el: HTMLDivElement | null) => {
                sectionRefs.current[s.id] = el
              }}
            >
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ display: 'block', letterSpacing: 1, mb: 0.5 }}
              >
                {s.label}
              </Typography>
              <Stack spacing={1.5}>
                {s.items.map((i) => (
                  <Paper key={i.id} variant="outlined" sx={{ p: 1.5 }}>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>
                      {i.label}
                    </Typography>
                    {i.content}
                  </Paper>
                ))}
              </Stack>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
