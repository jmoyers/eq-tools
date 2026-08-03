// The timeline's ZOOM/PAN state — a renderer-side view window [start,end] in ms over the
// encounter (world-model law 8's timeline note). Split out of CombatTimeline.tsx so the chart
// component is the SVG and this is the interaction:
//
//   - Mouse WHEEL over the plot zooms around the cursor's time point (anchored zoom).
//   - SHIFT + wheel pans left/right; drag-to-pan too.
//   - +/− buttons zoom around the current center; "Fit" resets to the full encounter.
//   - Starts fit to the whole encounter, and re-fits whenever the selected encounter changes.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { MIN_SPAN_MS, ZOOM_STEP, type ViewWin } from './timelineGeometry'

export interface TimelineViewport {
  view: ViewWin
  /** the visible span in ms, floored at MIN_SPAN_MS. */
  span: number
  /** the window is narrower than the encounter — enables the zoom-out / Fit controls. */
  zoomedIn: boolean
  /** encounter ms → pixel X within the plot. */
  xOf: (t: number) => number
  /** zoom by `factor`, keeping `anchorMs` at the same fractional position in the window. */
  zoomAround: (anchorMs: number, factor: number) => void
  /** reset to the whole encounter. */
  fit: () => void
  onPointerDown: (ev: React.PointerEvent<SVGSVGElement>) => void
  onPointerMove: (ev: React.PointerEvent<SVGSVGElement>) => void
  onPointerUp: (ev: React.PointerEvent<SVGSVGElement>) => void
}

export interface ViewportArgs {
  /** encounter duration in ms (already floored at 1 by the caller). */
  dur: number
  /** identity of the selected encounter — a change re-fits the window. */
  id: string
  svgRef: RefObject<SVGSVGElement>
  labelW: number
  plotW: number
}

export function useTimelineViewport({ dur, id, svgRef, labelW, plotW }: ViewportArgs): TimelineViewport {
  const [view, setView] = useState<ViewWin>({ start: 0, end: dur })
  const dragRef = useRef<{ x: number; start: number; end: number } | null>(null)

  // Reset to fit whenever the selected encounter changes (id or duration).
  useEffect(() => setView({ start: 0, end: dur }), [id, dur])

  const span = Math.max(MIN_SPAN_MS, view.end - view.start)

  const xOf = useCallback(
    (t: number): number => labelW + ((t - view.start) / span) * plotW,
    [view.start, span, labelW, plotW]
  )
  // Inverse: pixel X (relative to the plot's left edge = labelW) → encounter ms.
  const tOfPx = useCallback((px: number): number => view.start + (px / plotW) * span, [view.start, span, plotW])

  // Clamp a candidate window to the encounter bounds, preserving its span where possible.
  const clampView = useCallback(
    (start: number, end: number): ViewWin => {
      let s = start
      let e = end
      const w = Math.min(dur, Math.max(MIN_SPAN_MS, e - s))
      if (s < 0) {
        s = 0
        e = w
      }
      if (e > dur) {
        e = dur
        s = dur - w
      }
      if (s < 0) s = 0
      return { start: s, end: e }
    },
    [dur]
  )

  const zoomAround = useCallback(
    (anchorMs: number, factor: number) => {
      setView((v) => {
        const curSpan = v.end - v.start
        const newSpan = Math.min(dur, Math.max(MIN_SPAN_MS, curSpan * factor))
        // Keep the anchor time at the same fractional position in the window.
        const frac = curSpan > 0 ? (anchorMs - v.start) / curSpan : 0.5
        const s = anchorMs - frac * newSpan
        return clampView(s, s + newSpan)
      })
    },
    [dur, clampView]
  )

  const onWheel = useCallback(
    (ev: WheelEvent) => {
      // Only react to wheel over the plot region (not the label gutter).
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect) return
      const px = ev.clientX - rect.left - labelW
      if (ev.shiftKey) {
        // Pan: horizontal by the wheel delta (either axis, so a plain vertical wheel with
        // shift still pans). One notch ≈ 12% of the visible span.
        const delta = (ev.deltaX || ev.deltaY) > 0 ? 1 : -1
        setView((v) => {
          const shift = delta * (v.end - v.start) * 0.12
          return clampView(v.start + shift, v.end + shift)
        })
        ev.preventDefault()
        return
      }
      // Zoom around the cursor's time. deltaY<0 (scroll up) = zoom IN (smaller span).
      const anchor = tOfPx(Math.max(0, Math.min(plotW, px)))
      const factor = ev.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP
      zoomAround(anchor, factor)
      ev.preventDefault()
    },
    [tOfPx, zoomAround, clampView, labelW, plotW, svgRef]
  )

  // Attach the wheel handler NATIVELY as a NON-PASSIVE listener — React's onWheel is passive
  // by default, so ev.preventDefault() there is a no-op (and warns), letting the container
  // scroll instead of zoom. A native { passive: false } listener lets us claim the wheel.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel, svgRef])

  // Drag-to-pan (pointer). Trivial + handy once zoomed.
  const onPointerDown = useCallback(
    (ev: React.PointerEvent<SVGSVGElement>) => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect) return
      const px = ev.clientX - rect.left
      if (px < labelW) return // don't start a drag in the label gutter
      dragRef.current = { x: ev.clientX, start: view.start, end: view.end }
      svgRef.current?.setPointerCapture(ev.pointerId)
    },
    [view.start, view.end, labelW, svgRef]
  )
  const onPointerMove = useCallback(
    (ev: React.PointerEvent<SVGSVGElement>) => {
      const d = dragRef.current
      if (!d) return
      const dxPx = ev.clientX - d.x
      const dtMs = -(dxPx / plotW) * (d.end - d.start)
      setView(clampView(d.start + dtMs, d.end + dtMs))
    },
    [clampView, plotW]
  )
  const onPointerUp = useCallback(
    (ev: React.PointerEvent<SVGSVGElement>) => {
      dragRef.current = null
      svgRef.current?.releasePointerCapture(ev.pointerId)
    },
    [svgRef]
  )

  const fit = useCallback(() => setView({ start: 0, end: dur }), [dur])

  return { view, span, zoomedIn: span < dur - 1, xOf, zoomAround, fit, onPointerDown, onPointerMove, onPointerUp }
}
