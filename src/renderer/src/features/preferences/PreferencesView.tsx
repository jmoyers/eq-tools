// PreferencesView — the app's single settings surface (Task #55).
//
// Replaces the old SettingsDialog (EQ install folder) and the drawer's update-channel
// selector: everything app-level lives here, reached from the drawer's bottom-aligned
// "Preferences" item, the title-bar gear, and the fresh-machine empty state.
//
// Layout: a [section rail | content] split, where the rail is a TRUE SWITCHER — one
// section is mounted at a time. (It was originally a scroll-spy page: every section
// rendered at once and the rail called scrollIntoView. Inside the app's overflow:auto
// content area the scroll barely moved and `active` never followed, so the rail read
// as dead and the tab as one endless column. That machinery is gone.)
//
// SEARCH IS AN EXPLICIT MODE, not the default rendering. The field sits at the top of
// the content column so it lines up with the cards it filters; it echoes instantly from
// local state and filters a DEFERRED copy (AGENTS.md search pattern). While the query is
// non-empty the content column shows matches from EVERY section, each still under its
// section overline so a hit always carries its context; section labels match too, so
// typing "updates" pulls that whole section in. The rail keeps listing every section,
// dims the ones with no matches, and clicking any row exits search mode back to that
// section.
//
// Sections:
//   Game     — EverQuest install-folder discovery/override (effective path + how it
//             resolved + a folder picker + character-log validation). Lives in
//             ./EqFolderSetting.tsx, like Updates does — this file only names it.
//   Profiles — export your GLOBAL settings as a paste-safe share string / file, and import
//             someone else's ADDITIVELY (see src/shared/profiles.ts for the data model).
//   Updates — app version, last-checked time, a manual check, background download
//             progress, and the "Relaunch to update" action when one is waiting.
//             Lives in ./UpdateSetting.tsx; this file only names it in the table.
//   Feedback — the second entry point into the feedback DIALOG (the first is the nav
//             drawer's footer). Feedback is not a view, so this section only opens it.

import { type JSX, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import {
  Box,
  FormControlLabel,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import SportsEsportsIcon from '@mui/icons-material/SportsEsports'
import BarChartIcon from '@mui/icons-material/BarChart'
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt'
import IosShareIcon from '@mui/icons-material/IosShare'
import FeedbackIcon from '@mui/icons-material/Feedback'
import { ExportSettingsSetting, ImportSettingsSetting } from '../profiles/ProfileSharing'
import { ClassComboSetting } from '../profiles/ClassComboPanel'
import { useCombinePetRow } from '../combat/useCombatPrefs'
import { UpdateSetting, VersionSetting, useUpdateStatus } from './UpdateSetting'
import type { UpdateStatus } from '@shared/types'
import { EqFolderSetting } from './EqFolderSetting'
import { FeedbackSetting, type OpenFeedback } from './FeedbackSetting'
import { normalizeQuery } from '../../lib/search'

// -------------------------------------------------------------- Combat section

/**
 * Pet nesting (owner direction, 2026-08-03). ON by default: the game is mostly played solo, so
 * "you and your pet" is the shape of nearly every fight, and a two-row source meter is a lid on
 * the only list worth reading. Combined, the pet is ONE line item inside your breakdown —
 * labelled with its real name, drillable into its own skills, and never summed into a skill row
 * of yours (features/combat/petRows.ts). Off, it is a separate source row, as it always was.
 *
 * Renderer-local (localStorage, like the Fight/Overall scope), so it needs no store migration —
 * and it applies LIVE: the Combat dashboard and the Overview card subscribe to the same value.
 */
function PetNestingSetting(): JSX.Element {
  const [combine, setCombine] = useCombinePetRow()
  return (
    <Stack spacing={1}>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={combine}
            data-testid="pref-combine-pet"
            onChange={(e) => setCombine(e.target.checked)}
          />
        }
        label={<Typography variant="body2">Show your pet inside your damage</Typography>}
      />
      <Typography variant="caption" color="text.secondary">
        {combine
          ? 'Your pet is one row inside your damage breakdown — click it for the pet’s own skills. Your per-skill numbers stay yours; the pet’s damage is never folded into them.'
          : 'Your pet is listed as its own source, beside you, on the meter.'}
      </Typography>
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
function buildSections(
  version: string,
  status: UpdateStatus,
  onSendFeedback: OpenFeedback
): PrefSection[] {
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
      id: 'combat',
      label: 'Combat',
      icon: <BarChartIcon fontSize="small" />,
      items: [
        {
          id: 'combine-pet',
          label: 'Combine pet into your damage',
          keywords: 'pet combine merge damage breakdown solo meter drill charm nest source',
          content: <PetNestingSetting />
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
        },
        {
          id: 'class-combo',
          label: 'Class loadout history',
          keywords: 'class combo loadout classes swap paladin rogue berserker who correction slot',
          content: <ClassComboSetting />
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
    },
    {
      id: 'feedback',
      label: 'Feedback',
      icon: <FeedbackIcon fontSize="small" />,
      items: [
        {
          id: 'send-feedback',
          label: 'Send feedback',
          keywords: 'feedback bug report problem crash issue feature request idea suggest contact support log',
          content: <FeedbackSetting onSend={onSendFeedback} />
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

/**
 * Left rail: one row per section, ALWAYS all of them — it is the switcher, so it can
 * never shrink out from under the user's pointer. `active` is null while searching
 * (there is no single active section in that mode, so nothing is highlighted), and
 * `unmatched` holds the sections the current query found nothing in — those rows dim
 * to say so. They stay clickable on purpose: a query that matches nothing would
 * otherwise disable every row and strand the user in search mode.
 */
function SectionRail({
  sections,
  active,
  unmatched,
  onPick
}: {
  sections: PrefSection[]
  active: string | null
  unmatched: ReadonlySet<string>
  onPick: (id: string) => void
}): JSX.Element {
  return (
    <List dense disablePadding sx={{ width: RAIL_WIDTH, flexShrink: 0 }}>
      {sections.map((s) => {
        const dim = unmatched.has(s.id)
        return (
          <ListItemButton
            key={s.id}
            dense
            data-testid={`prefs-rail-${s.id}`}
            selected={active === s.id}
            aria-disabled={dim}
            onClick={() => onPick(s.id)}
            sx={{ borderRadius: 1, gap: 1, opacity: dim ? 0.38 : 1 }}
          >
            <Box sx={{ display: 'flex', color: 'text.secondary' }}>{s.icon}</Box>
            <ListItemText slotProps={{ primary: { variant: 'body2' } }} primary={s.label} />
          </ListItemButton>
        )
      })}
    </List>
  )
}

/** One section header plus its settings cards. */
function PrefSectionBlock({ section }: { section: PrefSection }): JSX.Element {
  return (
    <Box>
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

/** The search field, sized to the content column so it aligns with the cards it filters. */
function PrefSearch({
  query,
  onQuery
}: {
  query: string
  onQuery: (q: string) => void
}): JSX.Element {
  return (
    <TextField
      size="small"
      fullWidth
      data-testid="prefs-search"
      placeholder="Search preferences…"
      value={query}
      onChange={(e) => onQuery(e.target.value)}
      slotProps={{
        input: {
          startAdornment: <SearchIcon fontSize="small" sx={{ mr: 0.75, color: 'text.secondary' }} />
        }
      }}
    />
  )
}

export default function PreferencesView({
  onSendFeedback
}: {
  onSendFeedback: OpenFeedback
}): JSX.Element {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const [active, setActive] = useState('game')
  const [version, setVersion] = useState('')
  const status = useUpdateStatus()

  useEffect(() => {
    let alive = true
    void window.eq.getAppVersion().then((v) => {
      if (alive) setVersion(v)
    })
    return () => {
      alive = false
    }
  }, [])

  const sections = useMemo(
    () => buildSections(version, status, onSendFeedback),
    [version, status, onSendFeedback]
  )
  const keys = useMemo(() => sectionKeys(sections), [sections])
  const q = normalizeQuery(deferred)
  const searching = q !== ''
  const matches = useMemo(() => filterSections(sections, keys, q), [sections, keys, q])

  // Rail rows to dim: only meaningful while searching, empty otherwise.
  const unmatched = useMemo(() => {
    if (!searching) return new Set<string>()
    const hit = new Set(matches.map((s) => s.id))
    return new Set(sections.filter((s) => !hit.has(s.id)).map((s) => s.id))
  }, [searching, matches, sections])

  // A rail click is always an exit from search mode into that one section.
  const pick = useCallback((id: string): void => {
    setQuery('')
    setActive(id)
  }, [])

  const shown = searching ? matches : sections.filter((s) => s.id === active)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>
        Preferences
      </Typography>

      <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start' }}>
        <SectionRail
          sections={sections}
          active={searching ? null : active}
          unmatched={unmatched}
          onPick={pick}
        />

        <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <PrefSearch query={query} onQuery={setQuery} />

          {searching && matches.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No preferences match “{query.trim()}”.
            </Typography>
          )}
          {shown.map((s) => (
            <PrefSectionBlock key={s.id} section={s} />
          ))}
        </Box>
      </Box>
    </Box>
  )
}
