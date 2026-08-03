// The map's LABELS, as absolutely-positioned DOM over the canvas (docs/plans/map-viewer.md §6.4).
//
// THE HYBRID, AND WHY IT IS NOT ARBITRARY: geometry is 26,383 segments at worst and goes on the
// canvas (MapCanvas.tsx); points are 320 at worst — measured, across all 1,900 files — and want
// hit-testing, tooltips, non-scaling text and a search-jump target. DOM is free at 320 nodes and
// gives all four for nothing; canvas would mean hand-rolling every one of them.
//
// FOUR RULES THIS LAYER OWES THE USER:
//
//   * TEXT DOES NOT SCALE WITH ZOOM. Font size comes from `MapPoint.size` (the file's text size
//     CLASS 1..3, not a radius) and nothing else, which is what the in-game map does — a label
//     is legible at every zoom or it is not a label.
//   * COLOUR IS NEVER CHANGED. rgb encodes the POI category in Brewall's published scheme (zone
//     connection 255,0,0; banker 255,210,0; merchant 0,127,0; ground spawn 0,0,240 …), so
//     recolouring for contrast would destroy the meaning. Legibility comes from a HALO instead —
//     a four-way text-shadow in whichever extreme contrasts with the label — which leaves dark
//     labels readable on this app's dark panes and light ones readable anywhere.
//   * OVERLAPPING TEXT IS NOT SHOWN. `labelLayout.ts` runs the Mapbox/MapLibre model — screen
//     space collision boxes in a grid hash, greedy placement in a stable priority order — and a
//     label that loses becomes a DOT. The POI is still there, still hoverable, and hovering
//     RAISES its full text above everything. Nothing is deleted; text is deferred to a gesture.
//   * THE LAYER ITSELF IS INERT. `pointerEvents: 'none'` on the container so drag-to-pan works
//     everywhere, re-enabled on the labels and dots alone so their tooltips still work.
//
// HOVER IS NOT PART OF THE LAYOUT, on purpose. Feeding the hovered point into the collision pass
// as a top-priority symbol would re-run placement and shuffle every other label the instant the
// pointer moved. The layout is hover-independent; the raised label is drawn OVER the result.
//
// No search UI lives here (that is `MapSearch.tsx`); `labelPosition` is exported so the
// jump-to-a-hit path positions its marker with exactly the arithmetic the labels used.

import { useMemo, useState, type JSX } from 'react'
import type { MapPoint } from '@shared/maps'
import { expandRect, visiblePoints, type LayerMask, type ScreenPos } from './mapGeometry'
import { LABEL_FONT_PX, layoutLabels, type LabelSlot } from './labelLayout'
import { inActiveBand, type FloorBand } from './floorSlice'
import type { MapViewport } from './useMapViewport'

export { LABEL_FONT_PX }

/**
 * How far outside the visible window a label is still rendered, in CSS pixels. A label is
 * centred on its point and can be a couple of hundred pixels wide, so culling exactly at the
 * edge would pop half-visible labels out of existence as you pan.
 */
const OVERSCAN_PX = 220

/** The dot a decluttered label collapses to, and its (larger) pointer target. */
const DOT_PX = 5
const DOT_HIT_PX = 13

/** How far a hovered label is lifted off its dot, so the dot stays visible under it. */
const RAISE_PX = 11

/**
 * Where a point lands on the surface, in CSS pixels from the host's top-left.
 *
 * Exported because "jump to this search hit" must put its flash marker at the SAME place the
 * label is, and the only way to guarantee that is to call the same function.
 */
export function labelPosition(vp: MapViewport, p: Pick<MapPoint, 'x' | 'y'>): ScreenPos {
  return vp.toScreen(p.x, p.y)
}

/** Relative luminance, 0..1 — decides which extreme the halo takes. */
function luminance(p: MapPoint): number {
  return (0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b) / 255
}

function contrast(p: MapPoint): string {
  return luminance(p) < 0.5 ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.92)'
}

function haloShadow(p: MapPoint): string {
  const c = contrast(p)
  return `-1px 0 0 ${c}, 1px 0 0 ${c}, 0 -1px 0 ${c}, 0 1px 0 ${c}`
}

function rgb(p: MapPoint): string {
  return `rgb(${String(p.r)},${String(p.g)},${String(p.b)})`
}

export interface MapPointsLayerProps {
  points: readonly MapPoint[]
  vp: MapViewport
  /** Same mask the canvas draws with, so a toggled-off layer hides its labels too. */
  layers: LayerMask
  /** The zone's clustered floors. Empty ⇒ no slicing is possible and every point is in band. */
  bands?: readonly FloorBand[]
  /** The active floor, or null for "All levels". Out-of-band labels drop to dots. */
  floor?: number | null
}

interface GlyphProps {
  p: MapPoint
  at: ScreenPos
  onHover: (index: number | null) => void
  index: number
}

/** The full text. `raised` is the hover state: lifted off its dot and above every other glyph. */
function Label({ p, at, onHover, index, raised }: GlyphProps & { raised?: boolean }): JSX.Element {
  return (
    <span
      data-testid="map-point"
      // The RAW display text — `label.replace(/_/g,' ')`, computed once by the parser. The
      // tooltip repeats it verbatim so a label clipped by a neighbour is still readable.
      title={p.display}
      onMouseEnter={() => {
        onHover(index)
      }}
      onMouseLeave={() => {
        onHover(null)
      }}
      style={{
        position: 'absolute',
        left: at.px,
        top: at.py - (raised === true ? RAISE_PX : 0),
        transform: 'translate(-50%, -50%)',
        font: `${String(LABEL_FONT_PX[p.size])}px/1.1 inherit`,
        color: rgb(p),
        textShadow: haloShadow(p),
        whiteSpace: 'nowrap',
        pointerEvents: 'auto',
        userSelect: 'none',
        cursor: 'default',
        zIndex: raised === true ? 2 : 1
      }}
    >
      {p.display}
    </span>
  )
}

/**
 * The decluttered form: a dot in the point's own colour, haloed the same way the text is.
 *
 * The POI stays on the map and stays a pointer target — the outer box is `DOT_HIT_PX` so a 5px
 * dot is still comfortably hoverable at any zoom.
 */
function Dot({ p, at, onHover, index }: GlyphProps): JSX.Element {
  return (
    <span
      data-testid="map-point-dot"
      title={p.display}
      onMouseEnter={() => {
        onHover(index)
      }}
      onMouseLeave={() => {
        onHover(null)
      }}
      style={{
        position: 'absolute',
        left: at.px,
        top: at.py,
        width: DOT_HIT_PX,
        height: DOT_HIT_PX,
        marginLeft: -DOT_HIT_PX / 2,
        marginTop: -DOT_HIT_PX / 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
        cursor: 'default'
      }}
    >
      <span
        style={{
          width: DOT_PX,
          height: DOT_PX,
          borderRadius: '50%',
          background: rgb(p),
          boxShadow: `0 0 0 1px ${contrast(p)}`
        }}
      />
    </span>
  )
}

/** Project the visible points and run the declutter. Pure input → pure output, memoized. */
function useLabelSlots(props: MapPointsLayerProps): LabelSlot[] {
  const { points, vp, layers, bands, floor } = props
  const { rect, view, toScreen } = vp
  return useMemo(() => {
    const vis = visiblePoints(points, expandRect(rect, OVERSCAN_PX / view.scale), layers)
    return layoutLabels(
      vis.map(({ point, index }) => ({
        index,
        point,
        ...toScreen(point.x, point.y),
        inBand: inActiveBand(bands ?? [], floor ?? null, point.z)
      }))
    )
  }, [points, rect, view.scale, toScreen, layers, bands, floor])
}

export function MapPointsLayer(props: MapPointsLayerProps): JSX.Element {
  const slots = useLabelSlots(props)
  const [hover, setHover] = useState<number | null>(null)
  return (
    <div
      data-testid="map-points-layer"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {slots.map((s) =>
        s.shown ? (
          <Label key={s.index} p={s.point} at={s} index={s.index} onHover={setHover} />
        ) : (
          <Dot key={s.index} p={s.point} at={s} index={s.index} onHover={setHover} />
        )
      )}
      {/* The hovered dot's text, raised above every placed label. Drawn outside the layout so
          moving the pointer can never reshuffle what the declutter already decided. */}
      {slots
        .filter((s) => s.index === hover && !s.shown)
        .map((s) => (
          <Label key={`raised-${String(s.index)}`} p={s.point} at={s} index={s.index} onHover={setHover} raised />
        ))}
    </div>
  )
}
