// useWindowedRows — a dependency-free fixed-row-height windowing hook.
//
// The app's dense lists (loot rows, spell rows, pack rows) are fixed-height dense
// rows — the ideal case for simple windowing: we only render the slice of rows that
// intersects the scroll viewport, plus a small overscan, and reserve the total
// height with two spacer elements (top + bottom). This keeps the rendered DOM node
// count bounded (≈ viewport / rowHeight) no matter how long the list is, so a filter
// keystroke never has to mount hundreds of MUI rows synchronously.
//
// Why hand-rolled (not react-window): the lists are uniform-height and this is ~1
// screen of code with zero deps — see AGENTS.md "search pattern" note. For
// variable-height surfaces (Accordions) we cap+paginate instead of windowing.
//
// Usage:
//   const scrollRef = useRef<HTMLDivElement>(null)
//   const win = useWindowedRows({ count: rows.length, rowHeight: 33, scrollRef })
//   return (
//     <div ref={scrollRef} style={{ overflow: 'auto', height: '100%' }}>
//       <div style={{ height: win.topPad }} />
//       {rows.slice(win.start, win.end).map(...)}
//       <div style={{ height: win.bottomPad }} />
//     </div>
//   )
// For a <table>, render the spacers as rows with a single full-colspan <td> whose
// height is set (see LootView) so the browser's table layout keeps the geometry.

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'

export interface WindowedRows {
  /** First row index to render (inclusive). */
  start: number
  /** One past the last row index to render (exclusive). */
  end: number
  /** Height (px) of the spacer BEFORE the rendered slice. */
  topPad: number
  /** Height (px) of the spacer AFTER the rendered slice. */
  bottomPad: number
  /** Total content height (px) — count * rowHeight. */
  totalHeight: number
}

export interface UseWindowedRowsOptions {
  /** Number of rows in the (already-filtered) list. */
  count: number
  /** Fixed pixel height of one row. */
  rowHeight: number
  /** Ref to the scrolling container element. */
  scrollRef: RefObject<HTMLElement>
  /** Extra rows rendered above/below the viewport to hide scroll seams. Default 8. */
  overscan?: number
}

export function useWindowedRows({
  count,
  rowHeight,
  scrollRef,
  overscan = 8
}: UseWindowedRowsOptions): WindowedRows {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    setViewport(el.clientHeight)
  }, [scrollRef])

  // Measure once mounted and whenever the container resizes.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, scrollRef])

  // Track scroll position on the container.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => setScrollTop(el.scrollTop)
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scrollRef])

  const totalHeight = count * rowHeight
  // A zero-height viewport (not yet measured) still renders `overscan` rows so the
  // first paint isn't blank; the ResizeObserver corrects it on the next frame.
  const visibleCount = viewport > 0 ? Math.ceil(viewport / rowHeight) : overscan
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, start + visibleCount + overscan * 2)

  return {
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (count - end) * rowHeight),
    totalHeight
  }
}
