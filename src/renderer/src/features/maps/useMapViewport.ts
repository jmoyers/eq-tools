// The map viewer's ZOOM/PAN interaction (docs/plans/map-viewer.md §6.2) — the 2-D sibling of
// `features/combat/useTimelineViewport.ts`, and deliberately the same shape:
//
//   - Mouse WHEEL over the surface zooms around the CURSOR (anchored zoom, both axes).
//   - Drag pans, against the window captured at drag START (no accumulation, no drift).
//   - `fit()` resets to the whole zone; the view STARTS fit and re-fits when the zone changes.
//   - A ResizeObserver measures the host, and the pure `mapGeometry` module does all the maths.
//
// TWO DETAILS THAT COST AN HOUR EACH IF MISSED:
//
//   1. The wheel listener is attached NATIVELY and NON-PASSIVELY. React's `onWheel` is passive,
//      so `preventDefault()` there is a no-op (and warns) and the pane scrolls instead of
//      zooming. Same trap, same fix, as useTimelineViewport.ts:116-124.
//   2. `view` is null while the map is FITTED, and the fit is recomputed from the live pane
//      size. A concrete "fitted" view would go stale the moment the window is resized, and the
//      map would sit off-centre until the user touched it.
//
// State is the view; every projection is derived. No rAF loop: a wheel or a pointermove sets
// state, React re-renders, and MapCanvas redraws in its effect. An idle map costs nothing.
//
// HOW THE THREE PIECES COMPOSE (the containing view owns the host box and the layer toggles):
//
//   const hostRef = useRef<HTMLDivElement>(null)
//   const vp = useMapViewport({ bounds: data.bounds, id: data.zone, hostRef })
//   <Box ref={hostRef} onPointerDown={vp.onPointerDown} onPointerMove={vp.onPointerMove}
//        onPointerUp={vp.onPointerUp}
//        sx={{ position:'relative', flexGrow:1, minHeight:0, overflow:'hidden',
//              touchAction:'none', cursor: vp.dragging ? 'grabbing' : 'grab' }}>
//     <MapCanvas lines={data.lines} vp={vp} layers={layers} />
//     <MapPointsLayer points={data.points} vp={vp} layers={layers} />
//   </Box>
//
// `layers` starts as mapGeometry.DEFAULT_LAYERS (the legend off). `vp.centerOn(x, y)` is the
// search's jump-to-a-hit; `MapPointsLayer.labelPosition(vp, point)` is where that hit's marker
// goes, so the marker and the label can never disagree.

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { MapBounds } from '@shared/maps'
import {
  ZOOM_STEP,
  clampView,
  fit,
  isZoomedIn,
  panBy,
  project,
  unproject,
  viewRect,
  zoomAround,
  type MapPos,
  type MapView,
  type ScreenPos,
  type ViewRect,
  type ViewportSize
} from './mapGeometry'

export interface MapViewportArgs {
  /** The zone's extent, EXCLUDING the legend layer (parseMap.ts computes it that way). */
  bounds: MapBounds
  /** Identity of the loaded map — a change re-fits the view. The zone short name will do. */
  id: string
  /** The positioned box the canvas and the label layer fill. Measured, and the pointer target. */
  hostRef: RefObject<HTMLElement>
}

/** Everything the canvas, the label layer and the toolbar need. Passed down as one object. */
export interface MapViewport {
  view: MapView
  /** The measured host, in CSS pixels. `{w:0,h:0}` until the first ResizeObserver callback. */
  size: ViewportSize
  /** The visible window in map coordinates — the cull query. */
  rect: ViewRect
  /** The view is tighter than the whole zone: the zoom-out and Fit controls do something. */
  zoomedIn: boolean
  /** Map coordinate → CSS pixel within the host. */
  toScreen: (x: number, y: number) => ScreenPos
  /** CSS pixel within the host → map coordinate. */
  toMap: (px: number, py: number) => MapPos
  /** Zoom around the pane's centre — the +/− buttons. */
  zoomBy: (factor: number) => void
  /** Put a map coordinate under the pane centre, optionally at a new scale (search jump-to). */
  centerOn: (x: number, y: number, scale?: number) => void
  /** Back to the whole zone. */
  fit: () => void
  /** A drag is in progress — the surface shows `grabbing`. */
  dragging: boolean
  onPointerDown: (ev: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (ev: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (ev: React.PointerEvent<HTMLElement>) => void
}

/** Measure the host box. Fed straight into the pure geometry — no sizing logic lives here. */
function useHostSize(hostRef: RefObject<HTMLElement>): ViewportSize {
  const [size, setSize] = useState<ViewportSize>({ w: 0, h: 0 })
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) setSize({ w: Math.max(1, cr.width), h: Math.max(1, cr.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hostRef])
  return size
}

/** The pointer state a drag carries: where it started, and the view it started from. */
interface DragState {
  px: number
  py: number
  from: MapView
}

export function useMapViewport({ bounds, id, hostRef }: MapViewportArgs): MapViewport {
  const size = useHostSize(hostRef)
  // null === "fitted". Derived from the CURRENT size, so a resize keeps a fitted map fitted.
  const [zoomed, setZoomed] = useState<MapView | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<DragState | null>(null)

  const fitted = useMemo(() => fit(bounds, size), [bounds, size])
  const view = zoomed ?? fitted

  // A new zone starts fit, exactly as the timeline re-fits on a new encounter.
  useEffect(() => setZoomed(null), [id])

  const toScreen = useCallback(
    (x: number, y: number): ScreenPos => project(view, size, { x, y }),
    [view, size]
  )
  const toMap = useCallback(
    (px: number, py: number): MapPos => unproject(view, size, { px, py }),
    [view, size]
  )
  const rect = useMemo(() => viewRect(view, size), [view, size])

  const zoomAt = useCallback(
    (anchor: ScreenPos, factor: number) => {
      setZoomed((v) => zoomAround({ view: v ?? fitted, bounds, vp: size, anchor, factor }))
    },
    [fitted, bounds, size]
  )

  const onWheel = useCallback(
    (ev: WheelEvent) => {
      const el = hostRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      // deltaY < 0 (scroll up) = zoom IN = MORE pixels per map unit.
      zoomAt({ px: ev.clientX - r.left, py: ev.clientY - r.top }, ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)
      ev.preventDefault()
    },
    [hostRef, zoomAt]
  )

  // NON-PASSIVE, NATIVE. See the header — React's onWheel cannot preventDefault.
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel, hostRef])

  const onPointerDown = useCallback(
    (ev: React.PointerEvent<HTMLElement>) => {
      if (ev.button !== 0) return
      dragRef.current = { px: ev.clientX, py: ev.clientY, from: view }
      ev.currentTarget.setPointerCapture(ev.pointerId)
      setDragging(true)
    },
    [view]
  )
  const onPointerMove = useCallback(
    (ev: React.PointerEvent<HTMLElement>) => {
      const d = dragRef.current
      if (!d) return
      // Against the drag's START view, never the previous move's result.
      setZoomed(panBy(d.from, bounds, size, { px: ev.clientX - d.px, py: ev.clientY - d.py }))
    },
    [bounds, size]
  )
  const onPointerUp = useCallback((ev: React.PointerEvent<HTMLElement>) => {
    dragRef.current = null
    ev.currentTarget.releasePointerCapture(ev.pointerId)
    setDragging(false)
  }, [])

  const zoomBy = useCallback(
    (factor: number) => zoomAt({ px: size.w / 2, py: size.h / 2 }, factor),
    [zoomAt, size.w, size.h]
  )
  const centerOn = useCallback(
    (x: number, y: number, scale?: number) => {
      setZoomed((v) => clampView({ cx: x, cy: y, scale: scale ?? (v ?? fitted).scale }, bounds, size))
    },
    [fitted, bounds, size]
  )
  const resetFit = useCallback(() => setZoomed(null), [])

  return {
    view,
    size,
    rect,
    zoomedIn: isZoomedIn(view, bounds, size),
    toScreen,
    toMap,
    zoomBy,
    centerOn,
    fit: resetFit,
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp
  }
}
