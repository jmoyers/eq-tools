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
import type { CharacterRef, LootEvent } from '@shared/types'
import PoskyView from './features/posky/PoskyView'
import LootView from './features/loot/LootView'
import InventoryView from './features/inventory/InventoryView'
import LevelingView from './features/leveling/LevelingView'
import BossView from './features/bosses/BossView'
import CombatView from './features/combat/CombatView'
import { initCombat } from './features/combat/store'

const DRAWER_WIDTH = 220

type View = 'posky' | 'inventory' | 'loot' | 'leveling' | 'bosses' | 'combat'

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
  const [view, setView] = useState<View>('posky')
  const [character, setCharacter] = useState<CharacterRef | null>(null)
  const [characters, setCharacters] = useState<CharacterRef[]>([])
  const [lastLoot, setLastLoot] = useState<LootEvent | null>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    initCombat()
    void window.eq.getCharacter().then(setCharacter)
    void window.eq.listCharacters().then(setCharacters)
    const off = window.eq.onLoot((loot) => {
      setLastLoot(loot)
      setLive(true)
    })
    return off
  }, [])

  const onSelectCharacter = async (logPath: string): Promise<void> => {
    const res = await window.eq.setCharacter(logPath)
    if (res.ok && res.character) {
      setCharacter(res.character)
      setLive(false)
      setLastLoot(null)
    }
  }

  const viewKey = character?.logPath ?? 'none'

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
        </List>
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <Toolbar variant="dense" />
        <Box sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
          {view === 'posky' && <PoskyView key={viewKey} lastLoot={lastLoot} />}
          {view === 'inventory' && <InventoryView key={viewKey} lastLoot={lastLoot} />}
          {view === 'loot' && <LootView key={viewKey} lastLoot={lastLoot} />}
          {view === 'bosses' && <BossView key={viewKey} lastLoot={lastLoot} />}
          {view === 'leveling' && <LevelingView key={viewKey} />}
          {view === 'combat' && <CombatView key={viewKey} />}
        </Box>
      </Box>
    </Box>
  )
}
