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
import UpdateChip from './UpdateChip'
import type { View } from '../appViews'

export const DRAWER_WIDTH = 220

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
  onSelect
}: {
  view: View
  onSelect: (v: View) => void
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
        <ListItemButton selected={view === 'combat'} onClick={() => onSelect('combat')}>
          <ListItemIcon>
            <BarChartIcon />
          </ListItemIcon>
          <ListItemText primary="Combat" />
        </ListItemButton>
        <ListItemButton selected={view === 'mobs'} onClick={() => onSelect('mobs')}>
          <ListItemIcon>
            <PetsIcon />
          </ListItemIcon>
          <ListItemText primary="Mobs" />
        </ListItemButton>
        <ListItemButton selected={view === 'bosses'} onClick={() => onSelect('bosses')}>
          <ListItemIcon>
            <EmojiEventsIcon />
          </ListItemIcon>
          <ListItemText primary="Raid Targets" />
        </ListItemButton>
        <ListItemButton selected={view === 'posky'} onClick={() => onSelect('posky')}>
          <ListItemIcon>
            <ShieldMoonIcon />
          </ListItemIcon>
          <ListItemText primary="Plane of Sky" />
        </ListItemButton>
        <ListItemButton selected={view === 'alerts'} onClick={() => onSelect('alerts')}>
          <ListItemIcon>
            <NotificationsActiveIcon />
          </ListItemIcon>
          <ListItemText primary="Alerts" />
        </ListItemButton>
        <ListItemButton selected={view === 'leveling'} onClick={() => onSelect('leveling')}>
          <ListItemIcon>
            <TrendingUpIcon />
          </ListItemIcon>
          <ListItemText primary="Leveling" />
        </ListItemButton>
        <ListItemButton selected={view === 'loot'} onClick={() => onSelect('loot')}>
          <ListItemIcon>
            <ReceiptLongIcon />
          </ListItemIcon>
          <ListItemText primary="Loot" />
        </ListItemButton>
        <ListItemButton selected={view === 'buffs'} onClick={() => onSelect('buffs')}>
          <ListItemIcon>
            <AutoFixHighIcon />
          </ListItemIcon>
          <ListItemText primary="Buffs" />
          {/* State, not process: this tab is unfinished, and the chip says so. */}
          <Chip
            size="small"
            label="in dev"
            variant="outlined"
            sx={{ height: 18, fontSize: 10, color: 'text.secondary', '& .MuiChip-label': { px: 0.75 } }}
          />
        </ListItemButton>
      </List>

      {/* Bottom-aligned Preferences (Task #55) — replaces the old update-channel block. */}
      <Box sx={{ mt: 'auto' }}>
        <Divider />
        <List disablePadding>
          <ListItemButton selected={view === 'preferences'} onClick={() => onSelect('preferences')}>
            <ListItemIcon>
              <SettingsIcon />
            </ListItemIcon>
            <ListItemText primary="Preferences" />
          </ListItemButton>
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
