// The overlay windows' one button primitive: a 20px square, plain (no MUI — the overlay bundle
// stays lean). All five overlay kinds use it for the lock/pin and close controls.
//
// `accentBg` is the only thing that ever differed between the copies this replaces: the damage
// and event windows tint the pressed state gold, the healing pair tints it green, matching each
// window's own accent so a pinned meter reads as one piece.

import type { JSX } from 'react'

/** The damage/event overlays' pressed tint. */
export const ICON_ACCENT_GOLD = 'rgba(217,178,95,0.2)'
/** The healing overlays' pressed tint. */
export const ICON_ACCENT_GREEN = 'rgba(127,209,160,0.2)'

export function IconButton({
  onClick,
  title,
  children,
  danger,
  accent,
  accentBg = ICON_ACCENT_GOLD
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  danger?: boolean
  accent?: boolean
  accentBg?: string
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 20,
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: 1,
        background: accent ? accentBg : 'transparent',
        color: danger ? '#cf6679' : 'inherit',
        padding: 0
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.14)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = accent ? accentBg : 'transparent')}
    >
      {children}
    </button>
  )
}
