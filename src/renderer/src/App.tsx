import { useEffect, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  CssBaseline,
  Divider,
  Drawer,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Snackbar,
  Alert,
  Typography
} from '@mui/material'
import SettingsIcon from '@mui/icons-material/Settings'
import TravelExploreIcon from '@mui/icons-material/TravelExplore'
import ShieldMoonIcon from '@mui/icons-material/ShieldMoon'
import BarChartIcon from '@mui/icons-material/BarChart'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import EmojiEventsIcon2 from '@mui/icons-material/EmojiEvents'
import type { CharacterRef } from '@shared/types'
import TitleBar from './components/TitleBar'
import UpdateToast from './components/UpdateToast'
import PoskyView from './features/posky/PoskyView'
import LootView from './features/loot/LootView'
import LevelingView from './features/leveling/LevelingView'
import BossView from './features/bosses/BossView'
import CombatView from './features/combat/CombatView'
import AlertsView from './features/alerts/AlertsView'
import BuffsView from './features/buffs/BuffsView'
import PreferencesView from './features/preferences/PreferencesView'
import AlertPlayer, { fireAppSignal } from './features/alerts/player'
import { getBossData } from './data'
import { useBossKills } from './features/bosses/useBossKills'
import type { TargetStatus } from './features/bosses/bossStatus'
import { useProgress } from './features/posky/useProgress'

const bossData = getBossData()

const DRAWER_WIDTH = 220

type View =
  | 'combat'
  | 'bosses'
  | 'posky'
  | 'alerts'
  | 'leveling'
  | 'loot'
  | 'buffs'
  | 'preferences'

const VIEW_KEY = 'eq.view'
const DEFAULT_VIEW: View = 'combat'
const KNOWN_VIEWS: View[] = [
  'combat',
  'bosses',
  'posky',
  'alerts',
  'leveling',
  'loot',
  'buffs',
  'preferences'
]

function loadView(): View {
  const v = localStorage.getItem(VIEW_KEY)
  // The Inventory feature was folded into Loot (Task #55) — land those users on Loot
  // instead of silently bouncing them to the default view.
  if (v === 'inventory') return 'loot'
  return v && (KNOWN_VIEWS as string[]).includes(v) ? (v as View) : DEFAULT_VIEW
}

/**
 * Fresh-machine empty state: no eqlog_*.txt were found in the (auto-detected or
 * overridden) EQ folder. Quiet + actionable — points the user at Preferences > Game
 * to set the install folder, rather than showing empty/erroring feature views.
 */
function NoLogsEmptyState({ onOpenPreferences }: { onOpenPreferences: () => void }): JSX.Element {
  return (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 1.5,
        color: 'text.secondary'
      }}
    >
      <TravelExploreIcon sx={{ fontSize: 48, opacity: 0.6 }} />
      <Typography variant="h6" color="text.primary">
        No EverQuest logs found yet
      </Typography>
      <Typography variant="body2" sx={{ maxWidth: 440 }}>
        We looked for your EverQuest Legends install automatically but didn&apos;t find any
        character logs. Make sure logging is on in-game (type <code>/log on</code>), or point us
        at your install folder.
      </Typography>
      <Button
        variant="contained"
        startIcon={<SettingsIcon />}
        onClick={onOpenPreferences}
        sx={{ mt: 1 }}
      >
        Open preferences
      </Button>
    </Box>
  )
}

export default function App(): JSX.Element {
  const [view, setView] = useState<View>(loadView)
  const [character, setCharacter] = useState<CharacterRef | null>(null)
  const [characters, setCharacters] = useState<CharacterRef[]>([])
  const [live, setLive] = useState(false)
  // App-wide "raid target defeated" toast — fires on any tab.
  const [defeatToast, setDefeatToast] = useState<TargetStatus | null>(null)
  // App-wide "quest complete" toast — fires on any tab the instant a Sky turn-in
  // auto-completes a quest.
  const [questToast, setQuestToast] = useState<string | null>(null)

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

  // App-level Sky turn-in watch: always mounted so the celebration fires on ANY tab,
  // the same as the boss watch above. useProgress seeds a silent baseline on the first
  // hydrated snapshot, so historical completions on load never fire — only a live
  // turn-in transition does (Task #46). This is the SINGLE always-mounted place we fire
  // the 'questComplete' app signal (sound) + the app-wide snackbar; PoskyView's own
  // useProgress additionally bursts confetti when that tab is open. fireAppSignal applies
  // the alert cooldown, so PoskyView's detector firing in the same tick can't double-play.
  useProgress({
    onQuestComplete: (q) => {
      setQuestToast(q.name)
      fireAppSignal('questComplete', q.name)
    }
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
    // The EQ install dir changed (Settings override applied/cleared): re-list the
    // characters so the TitleBar selector reflects the new folder. Main separately
    // pushes onCharacter if the active tail moved.
    const offEqConfig = window.eq.onEqConfigChanged(() => {
      void window.eq.listCharacters().then(setCharacters)
    })
    return () => {
      offDelta()
      offChar()
      offEqConfig()
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
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <CssBaseline />

      {/* The single frameless title bar: brand + live dot + character selector +
          window min/max/close buttons. Replaces the OS chrome AND the old AppBar. */}
      <TitleBar
        live={live}
        character={character}
        characters={characters}
        onSelectCharacter={(logPath) => void onSelectCharacter(logPath)}
        onOpenPreferences={() => setView('preferences')}
      />

      {/* Everything below the bar: nav drawer + main content, side by side. */}
      <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              // Frameless: the drawer is a normal in-flow child now (no fixed OS bar
              // above it), so it fills the space under the title bar. `position:
              // relative` + `height: 100%` keeps it inside the flex row.
              position: 'relative',
              height: '100%',
              borderTop: 'none'
            }
          }}
        >
          <List>
            <ListItemButton selected={view === 'combat'} onClick={() => setView('combat')}>
              <ListItemIcon>
                <BarChartIcon />
              </ListItemIcon>
              <ListItemText primary="Combat" />
            </ListItemButton>
            <ListItemButton selected={view === 'bosses'} onClick={() => setView('bosses')}>
              <ListItemIcon>
                <EmojiEventsIcon />
              </ListItemIcon>
              <ListItemText primary="Raid Targets" />
            </ListItemButton>
            <ListItemButton selected={view === 'posky'} onClick={() => setView('posky')}>
              <ListItemIcon>
                <ShieldMoonIcon />
              </ListItemIcon>
              <ListItemText primary="Plane of Sky" />
            </ListItemButton>
            <ListItemButton selected={view === 'alerts'} onClick={() => setView('alerts')}>
              <ListItemIcon>
                <NotificationsActiveIcon />
              </ListItemIcon>
              <ListItemText primary="Alerts" />
            </ListItemButton>
            <ListItemButton selected={view === 'leveling'} onClick={() => setView('leveling')}>
              <ListItemIcon>
                <TrendingUpIcon />
              </ListItemIcon>
              <ListItemText primary="Leveling" />
            </ListItemButton>
            <ListItemButton selected={view === 'loot'} onClick={() => setView('loot')}>
              <ListItemIcon>
                <ReceiptLongIcon />
              </ListItemIcon>
              <ListItemText primary="Loot" />
            </ListItemButton>
            <ListItemButton selected={view === 'buffs'} onClick={() => setView('buffs')}>
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
              <ListItemButton
                selected={view === 'preferences'}
                onClick={() => setView('preferences')}
              >
                <ListItemIcon>
                  <SettingsIcon />
                </ListItemIcon>
                <ListItemText primary="Preferences" />
              </ListItemButton>
            </List>
          </Box>
        </Drawer>

        <Box
          component="main"
          sx={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        >
          <Box sx={{ flexGrow: 1, overflow: 'auto', p: 2 }}>
            {/* Preferences renders even with zero characters — it's how a user fixes the
                install path, so the fresh-machine empty state must never hide it. */}
            {view === 'preferences' ? (
              <PreferencesView />
            ) : characters.length === 0 ? (
              <NoLogsEmptyState onOpenPreferences={() => setView('preferences')} />
            ) : (
              <>
                {view === 'posky' && <PoskyView key={viewKey} />}
                {view === 'loot' && <LootView key={viewKey} />}
                {view === 'bosses' && <BossView key={viewKey} />}
                {view === 'leveling' && <LevelingView key={viewKey} />}
                {view === 'combat' && <CombatView key={viewKey} />}
                {view === 'buffs' && <BuffsView key={viewKey} />}
                {view === 'alerts' && <AlertsView key={viewKey} />}
              </>
            )}
          </Box>
        </Box>
      </Box>

      {/* Always-mounted: plays fired alert sounds regardless of the active tab. */}
      <AlertPlayer />
      {/* Always-mounted: "update ready — relaunch to update" toast (no-op in dev). */}
      <UpdateToast />

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

      <Snackbar
        open={!!questToast}
        autoHideDuration={6000}
        onClose={() => setQuestToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert
          severity="success"
          variant="filled"
          icon={<ShieldMoonIcon fontSize="inherit" />}
          onClose={() => setQuestToast(null)}
          sx={{ alignItems: 'center' }}
        >
          Quest complete: {questToast}
        </Alert>
      </Snackbar>
    </Box>
  )
}
