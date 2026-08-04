import type { JSX } from 'react'
import { Box, Chip, Divider, Drawer, List, ListItemButton, ListItemIcon, ListItemText } from '@mui/material'
import SettingsIcon from '@mui/icons-material/Settings'
import ShieldMoonIcon from '@mui/icons-material/ShieldMoon'
import BarChartIcon from '@mui/icons-material/BarChart'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import PetsIcon from '@mui/icons-material/Pets'
import MapIcon from '@mui/icons-material/Map'
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard'
import FeedbackIcon from '@mui/icons-material/Feedback'
// Dev-only, and its import goes with it: MUI's icon packages declare `sideEffects: false`, so
// an icon whose only use sits inside a `false &&` branch is tree-shaken out with the branch.
import RuleFolderIcon from '@mui/icons-material/RuleFolder'
import UpdateChip from './UpdateChip'
import { DEV_TOOLS } from '../devFlags'
import type { View } from '../appViews'

export const DRAWER_WIDTH = 220

interface NavRow {
  view: View
  label: string
  icon: JSX.Element
  /** trailing state chip, when a row has one to state */
  badge?: JSX.Element
}

/* State, not process: this tab is unfinished, and the chip says so. */
const IN_DEV = (
  <Chip
    size="small"
    label="in dev"
    variant="outlined"
    sx={{ height: 18, fontSize: 10, color: 'text.secondary', '& .MuiChip-label': { px: 0.75 } }}
  />
)

// Row ORDER is the nav's order. Overview leads: it is the at-a-glance landing surface.
const ROWS: NavRow[] = [
  { view: 'overview', label: 'Overview', icon: <SpaceDashboardIcon /> },
  { view: 'combat', label: 'Combat', icon: <BarChartIcon /> },
  { view: 'mobs', label: 'Mobs', icon: <PetsIcon /> },
  { view: 'maps', label: 'Maps', icon: <MapIcon /> },
  { view: 'bosses', label: 'Raid Targets', icon: <EmojiEventsIcon /> },
  { view: 'posky', label: 'Plane of Sky', icon: <ShieldMoonIcon /> },
  { view: 'alerts', label: 'Alerts', icon: <NotificationsActiveIcon /> },
  { view: 'leveling', label: 'Leveling', icon: <TrendingUpIcon /> },
  { view: 'loot', label: 'Loot', icon: <ReceiptLongIcon /> },
  { view: 'buffs', label: 'Buffs', icon: <AutoFixHighIcon />, badge: IN_DEV }
]

/** Bottom-aligned, outside ROWS — it is not a feature view and never moves. */
const PREFERENCES: NavRow = { view: 'preferences', label: 'Preferences', icon: <SettingsIcon /> }

/** One nav row. `data-testid="nav-<view>"` is the stable handle the e2e clicks. */
function NavRowButton({
  row,
  view,
  onSelect
}: {
  row: NavRow
  view: View
  onSelect: (v: View) => void
}): JSX.Element {
  return (
    <ListItemButton
      data-testid={`nav-${row.view}`}
      selected={view === row.view}
      onClick={() => onSelect(row.view)}
    >
      <ListItemIcon>{row.icon}</ListItemIcon>
      <ListItemText primary={row.label} />
      {row.badge}
    </ListItemButton>
  )
}

/**
 * The permanent left nav: one row per view, Preferences bottom-aligned with the ambient
 * update chip beneath it.
 *
 * Frameless: the drawer is a normal in-flow child (no fixed OS bar above it), so it fills
 * the space under the title bar — `position: relative` + `height: 100%` keeps it inside
 * the flex row.
 */
export default function NavDrawer({
  view,
  onSelect,
  onSendFeedback
}: {
  view: View
  onSelect: (v: View) => void
  /** Opens the feedback DIALOG (Task #65). Feedback is not a view — appViews.ts is untouched —
   *  so this row carries a callback instead of a `View`, and never shows a selected state. */
  onSendFeedback: () => void
}): JSX.Element {
  return (
    <Drawer
      variant="permanent"
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: DRAWER_WIDTH,
          boxSizing: 'border-box',
          position: 'relative',
          height: '100%',
          borderTop: 'none'
        }
      }}
    >
      <List>
        {ROWS.map((row) => (
          <NavRowButton key={row.view} row={row} view={view} onSelect={onSelect} />
        ))}
        {/* DEV-ONLY: the feedback-triage tab. `DEV_TOOLS` folds to a compile-time literal, so
            in `electron-vite build` this reads `false && …` and rollup deletes the branch —
            the row, its label, its chip and its icon are not in the shipped bundle at all.
            Built INSIDE the branch rather than hoisted to a module const on purpose: a
            top-level `jsx()` call is not something rollup can prove is side-effect free, and
            it would keep the strings alive. The e2e suite asserts `nav-triage` is ABSENT in a
            production-shaped build. */}
        {DEV_TOOLS && (
          <NavRowButton
            row={{
              view: 'triage',
              label: 'Triage',
              icon: <RuleFolderIcon />,
              badge: (
                <Chip
                  size="small"
                  label="dev only"
                  variant="outlined"
                  color="warning"
                  sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
                />
              )
            }}
            view={view}
            onSelect={onSelect}
          />
        )}
      </List>

      {/* Bottom-aligned Preferences (Task #55) — replaces the old update-channel block. */}
      <Box sx={{ mt: 'auto' }}>
        <Divider />
        <List disablePadding>
          {/* Send feedback (Task #65): a dialog, so it is a plain action row — no `selected`
              state to own, because nothing in the nav stays "on" while it is open. */}
          <ListItemButton data-testid="nav-feedback" onClick={onSendFeedback}>
            <ListItemIcon>
              <FeedbackIcon />
            </ListItemIcon>
            <ListItemText primary="Send feedback" />
          </ListItemButton>
          <NavRowButton row={PREFERENCES} view={view} onSelect={onSelect} />
        </List>
        {/* …and directly beneath it, the AMBIENT update affordance (Task #60):
            a gold "Restart to update" chip when a build is downloaded and
            staged, otherwise a muted "checked 2h ago" line. Never a nag —
            ignoring it just means apply-on-quit does the work silently. */}
        <UpdateChip />
      </Box>
    </Drawer>
  )
}
