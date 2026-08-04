import { type JSX, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * The overlay's segment/session selector — the OPEN half of it.
 *
 * WHY IT IS NOT A `<select>`: a native select paints its popup with the OS widget — an opaque
 * white list in a system font, with one flat line per option — dropped on top of a dark,
 * translucent, 11px meter. It also cannot carry the dense two-line disambiguation row (name +
 * rate on top, start clock · age · duration underneath) that tells five same-named giant pulls
 * apart. This is the same list rendered with the meter's own chrome: the panel background, the
 * bars' hairline borders, tabular-num rates and the same hover wash the bar rows use.
 *
 * WHERE THE CLOSED STATE WENT: the HEADER ROW is the trigger now (`OverlayHeader`). A 380×320
 * window cannot afford a second row that repeats the name, the live dot and the rate the header
 * is already showing — so the closed state IS the header, and this file owns only the popup.
 *
 * ANCHORING: `position: fixed`, with the top measured off the header's own rect. The overlay
 * window IS the viewport, so a fixed box whose height is clamped against `innerHeight` can never
 * paint outside the window — which an absolutely-positioned child of the header's flex row could
 * not promise (it would inherit the trigger's width and hang off the bottom of a shortened
 * window).
 *
 * MUI-FREE ON PURPOSE: the overlay is its own renderer entry (overlay.html) with no theme and no
 * component library — every pixel here is plain React + inline styles, exactly like Bar/IconButton
 * in OverlayMeter. Do not import @mui/* into this bundle.
 *
 * INTERACTIVE MODE ONLY: a locked overlay is fully click-through, so callers simply do not render
 * this. It owns no click-through state itself — there is nothing here that could leak a hit-test
 * target into locked mode.
 */

export interface OverlaySelectRow {
  /** the selection value handed back to `onChange`. */
  value: string
  /** main line, left. */
  label: string
  /** main line, right — a formatted rate. */
  rate: string
  /** dim second line: the disambiguation timing (start clock · age · duration). */
  timing: string
  /** genuinely live right now — gets the pulsing accent dot. */
  live: boolean
}

/** Shared chrome tokens so the trigger, the popup and the meter agree. */
const PANEL_BG = 'rgba(18,22,28,0.97)'
export const HAIRLINE = 'rgba(255,255,255,0.12)'
export const HOVER = 'rgba(255,255,255,0.08)'

/** Tallest the popup ever gets. */
const MAX_POPUP_H = 220
/** Side inset, matching the header's own 8px gutter closely enough to read as one piece. */
const SIDE_INSET = 6

/** One popup row: the dense two-line disambiguation the native widget could never carry. */
function OptionRow({
  row,
  selected,
  hovered,
  accent,
  onHover,
  onPick
}: {
  row: OverlaySelectRow
  selected: boolean
  hovered: boolean
  accent: string
  onHover: (hovering: boolean) => void
  onPick: () => void
}): JSX.Element {
  return (
    <div
      role="option"
      aria-selected={selected}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onClick={onPick}
      style={{
        padding: '3px 6px',
        borderRadius: 3,
        cursor: 'pointer',
        // The selected row keeps a full-height accent stripe — the same device the
        // drill-down bars use for a category — so it reads without a checkmark glyph.
        borderLeft: `2px solid ${selected ? accent : 'transparent'}`,
        background: hovered ? HOVER : selected ? 'rgba(255,255,255,0.045)' : 'transparent'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11, lineHeight: 1.25 }}>
        {row.live && (
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent, flexShrink: 0 }} />
        )}
        <span
          style={{
            flexGrow: 1,
            minWidth: 0,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {row.label}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.62)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {row.rate}
        </span>
      </div>
      <div
        style={{
          fontSize: 9.5,
          lineHeight: 1.3,
          color: 'rgba(255,255,255,0.42)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {row.timing}
      </div>
    </div>
  )
}

/** A ref shape both `RefObject<T>` and a plain holder satisfy — the popup only ever reads it. */
export interface ElementRef {
  current: HTMLElement | null
}

/** Where the popup sits: under the header, never past the bottom of the window. */
interface PopupBox {
  top: number
  maxHeight: number
}

/**
 * Measure the popup against the anchor (the header row) and the window. Re-measured on resize
 * because an overlay is user-resizable down to 90px tall (windows.ts) — far shorter than the
 * 320px default and shorter than the popup's own maximum. The height is therefore clamped to the
 * room that actually exists BELOW the header and the list scrolls inside it: there is no minimum
 * height, deliberately, because a floor is exactly how a popup ends up painting past the bottom
 * edge of a window this small.
 */
function usePopupBox(anchorRef: ElementRef): PopupBox | null {
  const [box, setBox] = useState<PopupBox | null>(null)
  useLayoutEffect(() => {
    const measure = (): void => {
      const top = Math.round((anchorRef.current?.getBoundingClientRect().bottom ?? 0) + 2)
      const room = window.innerHeight - top - SIDE_INSET
      setBox({ top, maxHeight: Math.max(0, Math.min(MAX_POPUP_H, room)) })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [anchorRef])
  return box
}

/**
 * The open list. Closes on Esc or on a mousedown outside BOTH itself and the trigger — the
 * trigger is exempt because it owns the toggle, and a close-then-reopen would eat the click.
 * Both listeners exist only while this is mounted, so a closed selector costs nothing and a
 * locked (click-through) overlay never installs one at all.
 */
export function OverlaySelectPopup({
  rows,
  value,
  accent,
  anchorRef,
  triggerRef,
  noDragStyle,
  onPick,
  onClose
}: {
  rows: OverlaySelectRow[]
  value: string
  /** the owning overlay's accent color (damage gold / heal green). */
  accent: string
  /** the header row — the popup hangs off its bottom edge. */
  anchorRef: ElementRef
  /** the clickable part of the header, exempt from the outside-click close. */
  triggerRef: ElementRef
  /** the caller's `WebkitAppRegion: 'no-drag'` style — the popup must not become a drag handle. */
  noDragStyle?: React.CSSProperties
  onPick: (v: string) => void
  onClose: () => void
}): JSX.Element | null {
  const [hover, setHover] = useState<string | null>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const box = usePopupBox(anchorRef)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, triggerRef])

  // The box lands in a layout effect, i.e. before the browser paints — so this null render is
  // never visible, and the popup never flashes at the top-left corner while it measures.
  if (!box) return null

  return (
    <div
      ref={popRef}
      role="listbox"
      style={{
        ...noDragStyle,
        position: 'fixed',
        top: box.top,
        left: SIDE_INSET,
        right: SIDE_INSET,
        zIndex: 20,
        maxHeight: box.maxHeight,
        overflowY: 'auto',
        background: PANEL_BG,
        border: `1px solid ${HAIRLINE}`,
        borderRadius: 5,
        boxShadow: '0 6px 18px rgba(0,0,0,0.55)',
        padding: 2
      }}
    >
      {rows.map((r) => (
        <OptionRow
          key={r.value}
          row={r}
          selected={r.value === value}
          hovered={hover === r.value}
          accent={accent}
          onHover={(hovering) => setHover((h) => (hovering ? r.value : h === r.value ? null : h))}
          onPick={() => onPick(r.value)}
        />
      ))}
    </div>
  )
}
