import { useEffect, useState } from 'react'
import {
  AppBar,
  Box,
  Chip,
  CssBaseline,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  MenuItem,
  Select,
  Snackbar,
  Alert,
  Toolbar,
  Typography
} from '@mui/material'
import ShieldMoonIcon from '@mui/icons-material/ShieldMoon'
import BarChartIcon from '@mui/icons-material/BarChart'
import Inventory2Icon from '@mui/icons-material/Inventory2'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents'
import CircleIcon from '@mui/icons-material/Circle'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import EmojiEventsIcon2 from '@mui/icons-material/EmojiEvents'
import type { CharacterRef } from '@shared/types'
import PoskyView from './features/posky/PoskyView'
import LootView from './features/loot/LootView'
import InventoryView from './features/inventory/InventoryView'
import LevelingView from './features/leveling/LevelingView'
import BossView from './features/bosses/BossView'
import CombatView from './features/combat/CombatView'
import AlertsView from './features/alerts/AlertsView'
import BuffsView from './features/buffs/BuffsView'
import AlertPlayer, { fireAppSignal } from './features/alerts/player'
import { getBossData } from './data'
import { useBossKills } from './features/bosses/useBossKills'
import type { TargetStatus } from './features/bosses/bossStatus'

const bossData = getBossData()

const DRAWER_WIDTH = 220

type View = 'posky' | 'inventory' | 'loot' | 'leveling' | 'bosses' | 'combat' | 'alerts' | 'buffs'

const VIEW_KEY = 'eq.view'
const DEFAULT_VIEW: View = 'posky'
const KNOWN_VIEWS: View[] = ['posky', 'inventory', 'loot', 'leveling', 'bosses', 'combat', 'alerts', 'buffs']

function loadView(): View {
  const v = localStorage.getItem(VIEW_KEY)
  return v && (KNOWN_VIEWS as string[]).includes(v) ? (v as View) : DEFAULT_VIEW
}

function lastPlayed(ms?: number): string {
  if (!ms) return ''
  const secs = Math.max(0, (Date.now() - ms) / 1000)
  if (secs < 90) return 'just now'
  const mins = secs / 60
  if (mins < 90) return `${Math.round(mins)}m ago`
  const hrs = mins / 60
  if (hrs < 36) return `${Math.round(hrs)}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

export default function App(): JSX.Element {
  const [view, setView] = useState<View>(loadView)
  const [character, setCharacter] = useState<CharacterRef | null>(null)
  const [characters, setCharacters] = useState<CharacterRef[]>([])
  const [live, setLive] = useState(false)
  // App-wide "raid target defeated" toast — fires on any tab.
  const [defeatToast, setDefeatToast] = useState<TargetStatus | null>(null)

  const [rebuild, setRebuild] = useState(0)

  // App-level boss-kill watch: independent of the Boss tab being open, so the
  // snackbar shows anywhere. useBossKills gates out the historical baseline. This
  // is the SINGLE always-mounted detector, so it's the one place we fire the
  // 'bossDefeat' app signal for the alerts extension. Task #24 splits the two:
  //   - onKill      → snackbar on ANY roster kill, incl. repeats (matches confetti).
  //   - onNewDefeat → the bossDefeat sound ONLY on a first defeat at a new tier.
  // fireAppSignal also applies the alert's cooldown, so even if the Boss tab's own
  // detector fires in the same instant it can't double-play.
  useBossKills(bossData.targets, {
    onKill: (s) => setDefeatToast(s),
    onNewDefeat: (s) => fireAppSignal('bossDefeat', s.target.name)
  })

  // Remember the selected tab across launches (renderer-only).
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view)
  }, [view])

  useEffect(() => {
    void window.eq.getCharacter().then(setCharacter)
    void window.eq.listCharacters().then(setCharacters)
    // Any live module delta means the tail is producing events — light the dot.
    const offDelta = window.eq.onModuleDelta(() => setLive(true))
    // FIX 3: main pushes onCharacter once state is fully rebuilt (startup + switch).
    // Sync the character and bump a rebuild counter so views reliably remount and
    // re-fetch their snapshots against the freshly-rebuilt state.
    const offChar = window.eq.onCharacter((c) => {
      setCharacter(c)
      setLive(false)
      setRebuild((n) => n + 1)
    })
    return () => {
      offDelta()
      offChar()
    }
  }, [])

  const onSelectCharacter = async (logPath: string): Promise<void> => {
    const res = await window.eq.setCharacter(logPath)
    if (res.ok && res.character) {
      setCharacter(res.character)
      setLive(false)
    }
  }

  const viewKey = `${character?.logPath ?? 'none'}#${rebuild}`

  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
      <CssBaseline />
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }} color="default" elevation={0}>
        <Toolbar variant="dense" sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ color: 'primary.main' }}>
            EQ Legends Companion
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          {live && <CircleIcon sx={{ fontSize: 12, color: 'success.main' }} />}
          {characters.length > 0 ? (
            <Select
              size="small"
              value={character?.logPath ?? ''}
              onChange={(e) => void onSelectCharacter(e.target.value)}
              sx={{ minWidth: 220 }}
              renderValue={(v) => {
                const c = characters.find((x) => x.logPath === v)
                return c ? `${c.name} · ${c.server}` : 'Select character'
              }}
            >
              <ListSubheader>Characters — most recently played</ListSubheader>
              {characters.map((c) => (
                <MenuItem key={c.logPath} value={c.logPath}>
                  <Box>
                    <Typography variant="body2">
                      {c.name} · {c.server}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      last played {lastPlayed(c.lastPlayed)}
                    </Typography>
                  </Box>
                </MenuItem>
              ))}
            </Select>
          ) : (
            <Chip size="small" color="warning" label="No log detected" variant="outlined" />
          )}
        </Toolbar>
      </AppBar>

      <Drawer
        variant="permanent"
        sx={{
          width: DRAWER_WIDTH,
          flexShrink: 0,
          '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box' }
        }}
      >
        <Toolbar variant="dense" />
        <List>
          <ListItemButton selected={view === 'posky'} onClick={() => setView('posky')}>
            <ListItemIcon>
              <ShieldMoonIcon />
            </ListItemIcon>
            <ListItemText primary="Plane of Sky" />
          </ListItemButton>
          <ListItemButton selected={view === 'inventory'} onClick={() => setView('inventory')}>
            <ListItemIcon>
              <Inventory2Icon />
            </ListItemIcon>
            <ListItemText primary="Inventory" />
          </ListItemButton>
          <ListItemButton selected={view === 'loot'} onClick={() => setView('loot')}>
            <ListItemIcon>
              <ReceiptLongIcon />
            </ListItemIcon>
            <ListItemText primary="Loot" />
          </ListItemButton>
          <ListItemButton selected={view === 'bosses'} onClick={() => setView('bosses')}>
            <ListItemIcon>
              <EmojiEventsIcon />
            </ListItemIcon>
            <ListItemText primary="Raid Targets" />
          </ListItemButton>
          <ListItemButton selected={view === 'leveling'} onClick={() => setView('leveling')}>
            <ListItemIcon>
              <TrendingUpIcon />
            </ListItemIcon>
            <ListItemText primary="Leveling" />
          </ListItemButton>
          <ListItemButton selected={view === 'combat'} onClick={() => setView('combat')}>
            <ListItemIcon>
              <BarChartIcon />
            </ListItemIcon>
            <ListItemText primary="Combat" />
          </ListItemButton>
          <ListItemButton selected={view === 'buffs'} onClick={() => setView('buffs')}>
            <ListItemIcon>
              <AutoFixHighIcon />
            </ListItemIcon>
            <ListItemText primary="Buffs" />
          </ListItemButton>
          <ListItemButton selected={view === 'alerts'} onClick={() => setView('alerts')}>
            <ListItemIcon>
              <NotificationsActiveIcon />
            </ListItemIcon>
            <ListItemText primary="Alerts" />
          </ListItemButton>
        </List>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <Toolbar variant="dense" />
        <Box sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
          {view === 'posky' && <PoskyView key={viewKey} />}
          {view === 'inventory' && <InventoryView key={viewKey} />}
          {view === 'loot' && <LootView key={viewKey} />}
          {view === 'bosses' && <BossView key={viewKey} />}
          {view === 'leveling' && <LevelingView key={viewKey} />}
          {view === 'combat' && <CombatView key={viewKey} />}
          {view === 'buffs' && <BuffsView key={viewKey} />}
          {view === 'alerts' && <AlertsView key={viewKey} />}
        </Box>
      </Box>

      {/* Always-mounted: plays fired alert sounds regardless of the active tab. */}
      <AlertPlayer />

      <Snackbar
        open={!!defeatToast}
        autoHideDuration={6000}
        onClose={() => setDefeatToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity="success"
          variant="filled"
          icon={<EmojiEventsIcon2 fontSize="inherit" />}
          onClose={() => setDefeatToast(null)}
          sx={{ alignItems: 'center' }}
        >
          Raid target defeated: {defeatToast?.target.name}!
        </Alert>
      </Snackbar>
    </Box>
  )
}
