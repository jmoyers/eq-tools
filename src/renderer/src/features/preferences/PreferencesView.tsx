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
//             Lives in ./UpdateSetting.tsx; this file only names it in the table.

import { type JSX, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
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
import IosShareIcon from '@mui/icons-material/IosShare'
import { ExportSettingsSetting, ImportSettingsSetting } from '../profiles/ProfileSharing'
import { UpdateSetting, VersionSetting, useUpdateStatus } from './UpdateSetting'
import type { EqConfig, UpdateStatus } from '@shared/types'
import { normalizeQuery } from '../../lib/search'

// ---------------------------------------------------------------- Game section

const SOURCE_CHIP: Record<EqConfig['source'], { label: string; color: 'success' | 'info' | 'warning' }> = {
  manual: { label: 'manual', color: 'info' },
  auto: { label: 'auto-detected', color: 'success' },
  default: { label: 'default (unverified)', color: 'warning' }
}

/** The effective path, plus a chip saying how it resolved. */
function EqFolderPath({ config }: { config: EqConfig | null }): JSX.Element {
  const chip = config ? SOURCE_CHIP[config.source] : null
  return (
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
  )
}

/**
 * Validation feedback: how many character logs are under `<root>\Logs`. Nothing is
 * claimed until the config has actually arrived, so a fresh mount shows no verdict
 * rather than a momentary "no logs found" that is only true because we haven't looked.
 */
function EqFolderCheck({ config }: { config: EqConfig | null }): JSX.Element | null {
  if (!config) return null
  const found = config.characterCount
  return found > 0 ? (
    <Alert severity="success" variant="outlined">
      Found {found} character log{found === 1 ? '' : 's'} in this folder.
    </Alert>
  ) : (
    <Alert severity="warning" variant="outlined">
      No character logs (eqlog_*.txt) found here. Make sure EverQuest logging is enabled
      (/log on) and pick the game&apos;s install folder.
    </Alert>
  )
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

  return (
    <Stack spacing={1.5}>
      <EqFolderPath config={config} />

      <EqFolderCheck config={config} />

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

/** The whole settings table, in render order. Rebuilt only when its inputs change. */
function buildSections(version: string, status: UpdateStatus): PrefSection[] {
  return [
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
  ]
}

// Lowercased search keys, recomputed only when the section set changes — the
// per-keystroke filter is then a plain substring test.
function sectionKeys(sections: PrefSection[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (const s of sections) {
    for (const i of s.items) m[`${s.id}/${i.id}`] = `${i.label} ${i.keywords ?? ''}`.toLowerCase()
  }
  return m
}

function filterSections(
  sections: PrefSection[],
  keys: Record<string, string>,
  q: string
): PrefSection[] {
  if (!q) return sections
  return sections
    .map((s) => {
      // A section-label match keeps the whole section (typing "updates" is a jump).
      if (s.label.toLowerCase().includes(q)) return s
      return { ...s, items: s.items.filter((i) => keys[`${s.id}/${i.id}`]?.includes(q)) }
    })
    .filter((s) => s.items.length > 0)
}

/** Sticky left rail: one row per (still-visible) section, click to scroll to it. */
function SectionRail({
  sections,
  active,
  onJump
}: {
  sections: PrefSection[]
  active: string
  onJump: (id: string) => void
}): JSX.Element {
  return (
    <List dense disablePadding sx={{ width: RAIL_WIDTH, flexShrink: 0, position: 'sticky', top: 0 }}>
      {sections.map((s) => (
        <ListItemButton
          key={s.id}
          dense
          selected={active === s.id}
          onClick={() => onJump(s.id)}
          sx={{ borderRadius: 1, gap: 1 }}
        >
          <Box sx={{ display: 'flex', color: 'text.secondary' }}>{s.icon}</Box>
          <ListItemText slotProps={{ primary: { variant: 'body2' } }} primary={s.label} />
        </ListItemButton>
      ))}
    </List>
  )
}

/** One section header plus its settings cards. `setRef` is the rail's scroll target. */
function PrefSectionBlock({
  section,
  setRef
}: {
  section: PrefSection
  setRef: (el: HTMLDivElement | null) => void
}): JSX.Element {
  return (
    <Box ref={setRef}>
      <Typography
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', letterSpacing: 1, mb: 0.5 }}
      >
        {section.label}
      </Typography>
      <Stack spacing={1.5}>
        {section.items.map((i) => (
          <Paper key={i.id} variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {i.label}
            </Typography>
            {i.content}
          </Paper>
        ))}
      </Stack>
    </Box>
  )
}

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

  const sections = useMemo(() => buildSections(version, status), [version, status])
  const keys = useMemo(() => sectionKeys(sections), [sections])
  const q = normalizeQuery(deferred)
  const visible = useMemo(() => filterSections(sections, keys, q), [sections, keys, q])

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
          slotProps={{
            input: {
              startAdornment: (
                <SearchIcon fontSize="small" sx={{ mr: 0.75, color: 'text.secondary' }} />
              )
            }
          }}
        />
      </Box>

      <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start' }}>
        <SectionRail sections={visible} active={active} onJump={jump} />

        <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          {visible.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No preferences match “{query.trim()}”.
            </Typography>
          )}
          {visible.map((s) => (
            <PrefSectionBlock
              key={s.id}
              section={s}
              setRef={(el) => {
                sectionRefs.current[s.id] = el
              }}
            />
          ))}
        </Box>
      </Box>
    </Box>
  )
}
