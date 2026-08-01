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
  Toolbar,
  Typography
} from '@mui/material'
import ShieldMoonIcon from '@mui/icons-material/ShieldMoon'
import BarChartIcon from '@mui/icons-material/BarChart'
import Inventory2Icon from '@mui/icons-material/Inventory2'
import CircleIcon from '@mui/icons-material/Circle'
import type { CharacterRef, LootEvent } from '@shared/types'
import PoskyView from './features/posky/PoskyView'
import LootView from './features/loot/LootView'

const DRAWER_WIDTH = 220

type View = 'posky' | 'loot' | 'combat'

export default function App(): JSX.Element {
  const [view, setView] = useState<View>('posky')
  const [character, setCharacter] = useState<CharacterRef | null>(null)
  const [lastLoot, setLastLoot] = useState<LootEvent | null>(null)
  const [live, setLive] = useState(false)

  useEffect(() => {
    void window.eq.getCharacter().then(setCharacter)
    const off = window.eq.onLoot((loot) => {
      setLastLoot(loot)
      setLive(true)
    })
    return off
  }, [])

  return (
    <Box sx={{ display: 'flex', height: '100vh' }}>
      <CssBaseline />
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }} color="default" elevation={0}>
        <Toolbar variant="dense" sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ color: 'primary.main' }}>
            EQ Legends Companion
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          {character ? (
            <Chip
              size="small"
              icon={<CircleIcon sx={{ fontSize: 12, color: live ? 'success.main' : 'text.disabled' }} />}
              label={`${character.name} · ${character.server}`}
              variant="outlined"
            />
          ) : (
            <Chip size="small" color="warning" label="No log detected" variant="outlined" />
          )}
          {lastLoot && (
            <Chip size="small" color="success" variant="outlined" label={`Looted: ${lastLoot.item}`} />
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
          <ListItemButton selected={view === 'loot'} onClick={() => setView('loot')}>
            <ListItemIcon>
              <Inventory2Icon />
            </ListItemIcon>
            <ListItemText primary="Loot" />
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
          {view === 'posky' && <PoskyView lastLoot={lastLoot} />}
          {view === 'loot' && <LootView lastLoot={lastLoot} />}
          {view === 'combat' && (
            <Typography color="text.secondary">
              Combat analysis coming next. The log pipeline is already streaming every line to the
              renderer — this view will render DPS, timelines, and encounter breakdowns.
            </Typography>
          )}
        </Box>
      </Box>
    </Box>
  )
}
