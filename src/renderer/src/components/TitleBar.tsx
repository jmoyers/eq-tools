import { type JSX, useEffect, useRef, useState } from 'react'
import { Box, Checkbox, Chip, ListItemText, ListSubheader, Menu, MenuItem, Select, Typography } from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import MinimizeIcon from '@mui/icons-material/Remove'
import CropSquareIcon from '@mui/icons-material/CropSquare'
import FilterNoneIcon from '@mui/icons-material/FilterNone'
import CloseIcon from '@mui/icons-material/Close'
import PictureInPictureAltIcon from '@mui/icons-material/PictureInPictureAlt'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import SettingsIcon from '@mui/icons-material/Settings'
import Tooltip from '@mui/material/Tooltip'
import type { CharacterRef, OverlayKind } from '@shared/types'
import { OVERLAY_KINDS } from '@shared/types'
import { track } from '../lib/telemetry'
import PerfChip from './PerfChip'

/**
 * Frameless window title bar (Task #23). Replaces BOTH the OS chrome and the old
 * in-app AppBar/Toolbar. It is the app's single top bar:
 *   [brand]  ······(drag)······  [live dot] [character selector]  | min max close
 *
 * The whole bar is a drag region (`-webkit-app-region: drag`) so the user can move
 * the window; every interactive child (the selector, the window buttons) opts back
 * out with `no-drag`. Double-clicking the empty drag region toggles maximize — on
 * Windows the OS gives us that natively for `drag` regions, but we also wire an
 * explicit handler so behavior is deterministic across platforms and covers the
 * brand text.
 */

const BAR_HEIGHT = 40 // px — compact, matches the old `Toolbar variant="dense"`.

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

// A single Discord/VS-Code-style caption button: 46px-wide hover target, icon
// centered, subtle hover fill; the close button hovers red.
function CaptionButton({
  onClick,
  label,
  danger,
  children
}: {
  onClick: () => void
  label: string
  danger?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <Box
      component="button"
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      sx={{
        WebkitAppRegion: 'no-drag',
        width: 46,
        height: BAR_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 0,
        border: 'none',
        background: 'transparent',
        color: 'text.secondary',
        cursor: 'pointer',
        outline: 'none',
        transition: 'background-color 120ms, color 120ms',
        '& svg': { fontSize: 18 },
        '&:hover': {
          backgroundColor: danger ? 'error.main' : 'rgba(255,255,255,0.08)',
          color: danger ? '#fff' : 'text.primary'
        }
      }}
    >
      {children}
    </Box>
  )
}

/**
 * Floating DPS overlay menu (Task #52; two kinds in Task #54). A compact menu toggles the
 * overlay windows independently; the button is active-tinted when ANY is open so the user
 * knows an overlay is live even off-screen / behind the game. The menu anchor is local
 * state — nothing outside this button cares whether the menu is showing.
 */
function OverlayMenu({ overlayState }: { overlayState: Record<OverlayKind, boolean> }): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const anyOverlayOpen = Object.values(overlayState).some(Boolean)

  /**
   * Toggle one overlay and record WHICH and WHETHER (usage-analytics §2 `overlayToggle`) — the
   * "which meters do people actually keep open" signal. The tracked `open` is main's ANSWER,
   * never the optimistic guess: the toggle IPC resolves to the resulting state, so a toggle
   * that failed to open a window cannot be counted as one that did.
   */
  const toggle = (kind: OverlayKind): void => {
    void window.eq.toggleOverlay(kind).then((open) => {
      track({ t: 'overlayToggle', kind, open })
    })
  }

  return (
    <Box data-no-drag sx={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center' }}>
      <Tooltip title="Floating DPS overlays">
        <Box
          component="button"
          type="button"
          ref={btnRef}
          aria-label="Floating DPS overlays"
          aria-haspopup="true"
          aria-expanded={anchor != null}
          onClick={() => setAnchor(btnRef.current)}
          sx={{
            WebkitAppRegion: 'no-drag',
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            height: 26,
            px: 1,
            borderRadius: 1,
            border: '1px solid',
            borderColor: anyOverlayOpen ? 'primary.main' : 'divider',
            bgcolor: anyOverlayOpen ? 'rgba(217,178,95,0.14)' : 'transparent',
            color: anyOverlayOpen ? 'primary.main' : 'text.secondary',
            cursor: 'pointer',
            outline: 'none',
            transition: 'background-color 120ms, color 120ms, border-color 120ms',
            '& svg': { fontSize: 16 },
            '&:hover': { bgcolor: 'rgba(255,255,255,0.08)', color: 'text.primary' }
          }}
        >
          <PictureInPictureAltIcon />
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            Overlay
          </Typography>
          <ArrowDropDownIcon />
        </Box>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={anchor != null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem dense onClick={() => { toggle('fight') }}>
          <Checkbox size="small" edge="start" checked={overlayState.fight} tabIndex={-1} disableRipple />
          <ListItemText primary="Fight meter" secondary="Current fight + fight selector" />
        </MenuItem>
        <MenuItem dense onClick={() => { toggle('overall') }}>
          <Checkbox size="small" edge="start" checked={overlayState.overall} tabIndex={-1} disableRipple />
          <ListItemText primary="Zone meter" secondary="Zone total + zone selector" />
        </MenuItem>
        {/* Task #59: the HEALING pair — siblings of the damage meters above, same per-kind
            machinery (persisted config, position, lock, drill) and the same fight vs
            zone-session selection semantics. */}
        <MenuItem dense onClick={() => { toggle('heal-fight') }}>
          <Checkbox size="small" edge="start" checked={overlayState['heal-fight']} tabIndex={-1} disableRipple />
          <ListItemText primary="Fight healing" secondary="Healing + absorption, current fight" />
        </MenuItem>
        <MenuItem dense onClick={() => { toggle('heal-overall') }}>
          <Checkbox size="small" edge="start" checked={overlayState['heal-overall']} tabIndex={-1} disableRipple />
          <ListItemText primary="Zone healing" secondary="Healing + absorption, zone total" />
        </MenuItem>
        {/* Task #59: the event log — a non-meter overlay kind driven by the same
            per-kind machinery (persisted config, position, lock). */}
        <MenuItem dense onClick={() => { toggle('events') }}>
          <Checkbox size="small" edge="start" checked={overlayState.events} tabIndex={-1} disableRipple />
          <ListItemText primary="Event log" secondary="Alerts, notable loot, quest completions" />
        </MenuItem>
      </Menu>
    </Box>
  )
}

/** The character picker (or a "no log" chip when nothing was discovered). */
function CharacterPicker({
  character,
  characters,
  onSelectCharacter
}: {
  character: CharacterRef | null
  characters: CharacterRef[]
  onSelectCharacter: (logPath: string) => void
}): JSX.Element {
  return (
    <Box data-no-drag sx={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center', pr: 1 }}>
      {characters.length > 0 ? (
        <Select
          size="small"
          variant="standard"
          disableUnderline
          value={character?.logPath ?? ''}
          onChange={(e) => onSelectCharacter(e.target.value)}
          sx={{ minWidth: 200, fontSize: 14 }}
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
    </Box>
  )
}

/** Preferences gear — opens the Preferences view (EQ folder, updates). */
function PreferencesButton({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <Box data-no-drag sx={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center', pr: 0.5 }}>
      <Tooltip title="Preferences">
        <Box
          component="button"
          type="button"
          aria-label="Open preferences"
          onClick={onOpen}
          sx={{
            WebkitAppRegion: 'no-drag',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 28,
            width: 28,
            p: 0,
            borderRadius: 1,
            border: 'none',
            background: 'transparent',
            color: 'text.secondary',
            cursor: 'pointer',
            outline: 'none',
            transition: 'background-color 120ms, color 120ms',
            '& svg': { fontSize: 18 },
            '&:hover': { bgcolor: 'rgba(255,255,255,0.08)', color: 'text.primary' }
          }}
        >
          <SettingsIcon />
        </Box>
      </Tooltip>
    </Box>
  )
}

/** Minimize / maximize / close, far right. */
function WindowControls({ maximized }: { maximized: boolean }): JSX.Element {
  return (
    <Box data-no-drag sx={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'stretch' }}>
      <CaptionButton label="Minimize" onClick={() => window.eq.minimizeWindow()}>
        <MinimizeIcon />
      </CaptionButton>
      <CaptionButton label={maximized ? 'Restore' : 'Maximize'} onClick={() => window.eq.toggleMaximizeWindow()}>
        {maximized ? <FilterNoneIcon sx={{ transform: 'scaleX(-1)' }} /> : <CropSquareIcon />}
      </CaptionButton>
      <CaptionButton label="Close" danger onClick={() => window.eq.closeWindow()}>
        <CloseIcon />
      </CaptionButton>
    </Box>
  )
}

export interface TitleBarProps {
  live: boolean
  character: CharacterRef | null
  characters: CharacterRef[]
  onSelectCharacter: (logPath: string) => void
  /** Navigate to the Preferences view (EQ install folder, updates) — Task #55. */
  onOpenPreferences: () => void
}

export default function TitleBar({
  live,
  character,
  characters,
  onSelectCharacter,
  onOpenPreferences
}: TitleBarProps): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  // Per-kind overlay open-state (Task #52; kinds in Task #54/#59): reflected on the compact
  // Overlay menu, kept in sync with pushes so it updates if an overlay closes itself. Seeded
  // from OVERLAY_KINDS so adding a kind needs no edit here.
  const [overlayState, setOverlayState] = useState<Record<OverlayKind, boolean>>(
    () => Object.fromEntries(OVERLAY_KINDS.map((k) => [k, false])) as Record<OverlayKind, boolean>
  )

  useEffect(() => window.eq.onWindowMaximized(setMaximized), [])
  useEffect(() => {
    void window.eq.getOverlayState().then(setOverlayState)
    return window.eq.onOverlayState(({ kind, open }) =>
      setOverlayState((s) => ({ ...s, [kind]: open }))
    )
  }, [])

  // Double-click on the drag region toggles maximize (native-ish behavior). We
  // guard against double-clicks that originate on an interactive child by only
  // reacting when the target is inside the drag area (children are `no-drag`).
  const onDoubleClick = (e: React.MouseEvent): void => {
    // Only toggle when the click landed on a drag surface, not a control.
    const el = e.target as HTMLElement
    if (el.closest('[data-no-drag]')) return
    window.eq.toggleMaximizeWindow()
  }

  return (
    <Box
      onDoubleClick={onDoubleClick}
      sx={{
        WebkitAppRegion: 'drag',
        flexShrink: 0,
        height: BAR_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        pl: 2,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        userSelect: 'none'
      }}
    >
      <Typography variant="subtitle2" sx={{ color: 'primary.main', fontWeight: 700, whiteSpace: 'nowrap' }}>
        EQ Legends Companion
      </Typography>

      {/* Drag spacer between brand and the right-hand controls. */}
      <Box sx={{ flexGrow: 1 }} />

      {live && <CircleIcon sx={{ fontSize: 12, color: 'success.main' }} />}

      {/* The performance HUD (docs/plans/perf-profiling.md P3). Renders NOTHING at all unless
          the user turned it on in Preferences → Performance — no placeholder, no reserved slot,
          and no cost: main creates no timer and pushes no sample while it is off. */}
      <PerfChip />

      <OverlayMenu overlayState={overlayState} />

      {/* Interactive controls opt out of the drag region. */}
      <CharacterPicker
        character={character}
        characters={characters}
        onSelectCharacter={onSelectCharacter}
      />

      <PreferencesButton onOpen={onOpenPreferences} />

      <WindowControls maximized={maximized} />
    </Box>
  )
}
