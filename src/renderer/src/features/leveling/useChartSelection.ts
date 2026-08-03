// useChartSelection — drag a time RANGE across either leveling chart (plan §6.3).
//
// ONE selection for both charts. It lives in `LevelingView` (this hook is called once
// there), the same band is drawn on the AA chart and the level chart, and a new drag on
// either one replaces it — because since the shared-domain refactor both charts plot the
// same `ChartScale`, so the same pixel is the same instant on both.
//
// THE DISAMBIGUATION CONTRACT with the hover layer (LevelHoverLayer.tsx), which this hook
// must not need to edit:
//   • This hook binds pointerDOWN / UP / CANCEL and captures the pointer. `onPointerMove`
//     is bound too, but it READS ONLY while a capture is live — a plain hover move returns
//     on the first line, so the tooltip's own move handler stays the only thing doing work.
//   • `dragging` flips true only once the pointer has travelled DRAG_THRESHOLD_PX. It flows
//     to the hover layer as its existing `suppressed` prop: no tooltip while a range is
//     being dragged, and the hover layer never reads pointer state independently.
//   • Below the threshold, pointer-up is a CLICK, and a click CLEARS the selection. That is
//     the whole dismissal gesture; `Escape` is the keyboard twin.
//
// The handlers are bound on the chart WRAPPER (levelCharts.tsx), not on the <svg>: the hover
// layer is an absolutely-positioned sibling covering the plot with `pointerEvents:'auto'`,
// so a press lands on IT and bubbles up. Capturing on the wrapper also means a drag that
// leaves the element keeps tracking, and `ev.currentTarget` stays the chart the drag STARTED
// on — which is the rect every later coordinate is measured against.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { pxToUser, tOf, type ChartScale } from './levelChartGeometry'

/** Travel, in CSS px, before a press counts as a drag rather than a click. */
export const DRAG_THRESHOLD_PX = 5
/**
 * Shorter ranges are DISCARDED rather than committed: rates over a three-second window
 * ("142 levels/hr") are meaningless, and the panel exists to answer a farming question.
 * A discarded drag leaves any previous selection alone — only a click clears.
 */
export const MIN_SELECTION_MS = 60_000

export interface ChartSelection {
  t0: number
  t1: number
}

/** Just the pointer half — what a chart component needs to spread onto its wrapper. */
export interface SelectionPointerHandlers {
  onPointerDown: (ev: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (ev: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (ev: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (ev: ReactPointerEvent<HTMLElement>) => void
}

export interface SelectionApi extends SelectionPointerHandlers {
  /** committed selection, or null. */
  sel: ChartSelection | null
  /** live band while the pointer is down and past the threshold (the ghost rect). */
  draft: ChartSelection | null
  /** TRUE from the moment the drag threshold is crossed until pointer-up. The hover tooltip
   *  MUST NOT render while this is true — the disambiguation contract. */
  dragging: boolean
  clear: () => void
}

interface Drag {
  pointerId: number
  /** the element holding the capture — every coordinate is measured against ITS rect. */
  el: HTMLElement
  originX: number
  originTs: number
}

export function useChartSelection(scale: ChartScale | null): SelectionApi {
  const [sel, setSel] = useState<ChartSelection | null>(null)
  const [draft, setDraft] = useState<ChartSelection | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<Drag | null>(null)
  // Mirrors `dragging` for the handlers: they run outside the render that would give them a
  // fresh closure, so the state value alone would be one frame stale at the threshold.
  const draggingRef = useRef(false)

  /**
   * Cursor -> timestamp, CLAMPED to the domain. `preserveAspectRatio="none"` means CSS px
   * are not viewBox units, so this goes through the charts' own `pxToUser`/`tOf` — the same
   * mapping the pixels were drawn with, which is what keeps the band under the cursor.
   */
  const tsAt = useCallback(
    (el: HTMLElement, clientX: number): number | null => {
      if (!scale) return null
      const r = el.getBoundingClientRect()
      if (r.width <= 0) return null
      const t = tOf(scale, pxToUser(clientX - r.left, r.width, scale.w))
      return Math.min(scale.t1, Math.max(scale.t0, t))
    },
    [scale]
  )

  const stop = useCallback((): void => {
    const d = dragRef.current
    if (d?.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId)
    dragRef.current = null
    draggingRef.current = false
    setDragging(false)
    setDraft(null)
  }, [])

  const onPointerDown = useCallback(
    (ev: ReactPointerEvent<HTMLElement>): void => {
      if (ev.button !== 0) return
      const el = ev.currentTarget
      const ts = tsAt(el, ev.clientX)
      if (ts == null) return
      // Record the origin and take the pointer, but commit NOTHING yet: this may still turn
      // out to be a click.
      el.setPointerCapture(ev.pointerId)
      dragRef.current = { pointerId: ev.pointerId, el, originX: ev.clientX, originTs: ts }
    },
    [tsAt]
  )

  const onPointerMove = useCallback(
    (ev: ReactPointerEvent<HTMLElement>): void => {
      const d = dragRef.current
      if (!d) return // no capture ⇒ this is a hover move and belongs to the tooltip
      if (!draggingRef.current) {
        if (Math.abs(ev.clientX - d.originX) < DRAG_THRESHOLD_PX) return
        draggingRef.current = true
        setDragging(true)
      }
      const ts = tsAt(d.el, ev.clientX)
      if (ts == null) return
      setDraft({ t0: Math.min(d.originTs, ts), t1: Math.max(d.originTs, ts) })
    },
    [tsAt]
  )

  const onPointerUp = useCallback(
    (ev: ReactPointerEvent<HTMLElement>): void => {
      const d = dragRef.current
      if (!d) return
      const wasDragging = draggingRef.current
      const ts = tsAt(d.el, ev.clientX)
      stop()
      if (!wasDragging) {
        setSel(null) // below the threshold ⇒ a click ⇒ dismiss
        return
      }
      if (ts == null) return
      const t0 = Math.min(d.originTs, ts)
      const t1 = Math.max(d.originTs, ts)
      if (t1 - t0 < MIN_SELECTION_MS) return
      setSel({ t0, t1 })
    },
    [tsAt, stop]
  )

  const onPointerCancel = useCallback((): void => { stop() }, [stop])
  const clear = useCallback((): void => { setSel(null) }, [])

  // Escape is the keyboard twin of the click-to-clear gesture. Bound only while a selection
  // exists, so this view never holds a global key listener it has no use for.
  useEffect(() => {
    if (!sel) return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setSel(null)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [sel])

  return { sel, draft, dragging, clear, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }
}
