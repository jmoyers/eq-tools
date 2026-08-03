// hoverCardLayer — places a feed hover card near its anchor and clamps it inside the overlay
// window. Plain React + inline styles; the overlay bundle stays MUI-free.

import { type JSX, useLayoutEffect, useRef, useState } from 'react'

/** Gap the hover card keeps from its anchor AND from every window edge. */
const CARD_MARGIN = 4

/**
 * Places a hover card near its anchor and CLAMPS it inside the window.
 *
 * `position: fixed`, not absolute-in-the-row: the feed is an `overflow:auto` scroll box inside an
 * `overflow:hidden` shell, so a card positioned within a row would be clipped by the scroller
 * (and, worse, could grow its scroll extent). Fixed coordinates are measured against the
 * VIEWPORT — the overlay window itself — which is also the only frame that matters here: this
 * window is small and routinely parked against a screen edge.
 *
 * Placement: above the anchor by preference (the feed reads newest-first, so a card below would
 * cover the rows you're scanning), flipped below when there's no room, then clamped on both
 * axes so it can never hang off any edge. Re-runs whenever the card's own size changes — the
 * MUI ItemWindow arrives lazily and its icon later still, so the first measurement is never the
 * last one. Hidden until placed, so it never flashes at 0,0.
 *
 * `pointerEvents: none` is load-bearing: the card has nothing to click (no links, no nested
 * hover), and a card that took the pointer while overlapping its own anchor would fire the
 * anchor's mouseleave, unmount itself, and flicker.
 */
export function HoverCardLayer({ anchor, children }: { anchor: HTMLElement; children: React.ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const place = (): void => {
      const a = anchor.getBoundingClientRect()
      const c = el.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const m = CARD_MARGIN
      let top = a.top - c.height - m
      if (top < m) top = a.bottom + m
      if (top + c.height > vh - m) top = Math.max(m, vh - m - c.height)
      let left = a.left
      if (left + c.width > vw - m) left = vw - m - c.width
      if (left < m) left = m
      setPos((p) => (p && Math.abs(p.left - left) < 0.5 && Math.abs(p.top - top) < 0.5 ? p : { left, top }))
    }
    place()
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(place)
    })
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [anchor])

  return (
    <div
      ref={ref}
      data-testid="feed-hover-card"
      style={{
        position: 'fixed',
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
        zIndex: 20,
        pointerEvents: 'none',
        maxWidth: `calc(100vw - ${CARD_MARGIN * 2}px)`,
        maxHeight: `calc(100vh - ${CARD_MARGIN * 2}px)`,
        overflow: 'hidden'
      }}
    >
      {children}
    </div>
  )
}
