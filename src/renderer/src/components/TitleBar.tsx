import { useEffect, useState } from 'react'
import { Box, Chip, ListSubheader, MenuItem, Select, Typography } from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import MinimizeIcon from '@mui/icons-material/Remove'
import CropSquareIcon from '@mui/icons-material/CropSquare'
import FilterNoneIcon from '@mui/icons-material/FilterNone'
import CloseIcon from '@mui/icons-material/Close'
import PictureInPictureAltIcon from '@mui/icons-material/PictureInPictureAlt'
import Tooltip from '@mui/material/Tooltip'
import type { CharacterRef } from '@shared/types'

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

export interface TitleBarProps {
  live: boolean
  character: CharacterRef | null
  characters: CharacterRef[]
  onSelectCharacter: (logPath: string) => void
}

export default function TitleBar({
  live,
  character,
  characters,
  onSelectCharacter
}: TitleBarProps): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  // Overlay open-state (Task #52): reflected on the toggle button, kept in sync with
  // pushes so it updates if the overlay closes itself (its own close button).
  const [overlayOpen, setOverlayOpen] = useState(false)

  useEffect(() => window.eq.onWindowMaximized(setMaximized), [])
  useEffect(() => {
    void window.eq.getOverlayState().then(setOverlayOpen)
    return window.eq.onOverlayState(setOverlayOpen)
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

      {/* Floating DPS overlay toggle (Task #52). Active-state tinted so the user can
          see the overlay is open even when it's off-screen / behind the game. */}
      <Box data-no-drag sx={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center' }}>
        <Tooltip title={overlayOpen ? 'Hide floating DPS overlay' : 'Show floating DPS overlay'}>
          <Box
            component="button"
            type="button"
            aria-label="Toggle DPS overlay"
            aria-pressed={overlayOpen}
            onClick={() => void window.eq.toggleOverlay()}
            sx={{
              WebkitAppRegion: 'no-drag',
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              height: 26,
              px: 1,
              borderRadius: 1,
              border: '1px solid',
              borderColor: overlayOpen ? 'primary.main' : 'divider',
              bgcolor: overlayOpen ? 'rgba(217,178,95,0.14)' : 'transparent',
              color: overlayOpen ? 'primary.main' : 'text.secondary',
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
          </Box>
        </Tooltip>
      </Box>

      {/* Interactive controls opt out of the drag region. */}
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

      {/* Window controls (far right). */}
      <Box data-no-drag sx={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'stretch' }}>
        <CaptionButton label="Minimize" onClick={() => window.eq.minimizeWindow()}>
          <MinimizeIcon />
        </CaptionButton>
        <CaptionButton
          label={maximized ? 'Restore' : 'Maximize'}
          onClick={() => window.eq.toggleMaximizeWindow()}
        >
          {maximized ? <FilterNoneIcon sx={{ transform: 'scaleX(-1)' }} /> : <CropSquareIcon />}
        </CaptionButton>
        <CaptionButton label="Close" danger onClick={() => window.eq.closeWindow()}>
          <CloseIcon />
        </CaptionButton>
      </Box>
    </Box>
  )
}
