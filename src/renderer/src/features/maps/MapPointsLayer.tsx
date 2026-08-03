// The map's LABELS, as absolutely-positioned DOM over the canvas (docs/plans/map-viewer.md §6.4).
//
// THE HYBRID, AND WHY IT IS NOT ARBITRARY: geometry is 26,383 segments at worst and goes on the
// canvas (MapCanvas.tsx); points are 316 at worst — measured, across all 1,900 files — and want
// hit-testing, tooltips, non-scaling text and a search-jump target. DOM is free at 316 nodes and
// gives all four for nothing; canvas would mean hand-rolling every one of them.
//
// THREE RULES THIS LAYER OWES THE USER:
//
//   * TEXT DOES NOT SCALE WITH ZOOM. Font size comes from `MapPoint.size` (the file's text size
//     CLASS 1..3, not a radius) and nothing else, which is what the in-game map does — a label
//     is legible at every zoom or it is not a label.
//   * COLOUR IS NEVER CHANGED. rgb encodes the POI category in Brewall's published scheme (zone
//     connection 255,0,0; banker 255,210,0; merchant 0,127,0; ground spawn 0,0,240 …), so
//     recolouring for contrast would destroy the meaning. Legibility comes from a HALO instead —
//     a four-way text-shadow in whichever extreme contrasts with the label — which leaves dark
//     labels readable on this app's dark panes and light ones readable anywhere.
//   * THE LAYER ITSELF IS INERT. `pointerEvents: 'none'` on the container so drag-to-pan works
//     everywhere, re-enabled on the labels alone so their tooltips still work.
//
// No search UI lives here (that is wave 3's `MapSearch.tsx`); `labelPosition` is exported so the
// jump-to-a-hit path positions its marker with exactly the arithmetic the labels used.

import type { MapPoint } from '@shared/maps'
import { expandRect, visiblePoints, type LayerMask, type ScreenPos } from './mapGeometry'
import type { MapViewport } from './useMapViewport'

/**
 * Font size per text-size class. 3 = large (zone connections), 2 = medium (the default),
 * 1 = small (ground spawns) — the file's own three-way distinction, kept three-way.
 */
export const LABEL_FONT_PX: Record<1 | 2 | 3, number> = { 1: 10, 2: 12, 3: 14 }

/**
 * How far outside the visible window a label is still rendered, in CSS pixels. A label is
 * centred on its point and can be a couple of hundred pixels wide, so culling exactly at the
 * edge would pop half-visible labels out of existence as you pan.
 */
const OVERSCAN_PX = 220

/**
 * Where a point lands on the surface, in CSS pixels from the host's top-left.
 *
 * Exported because wave 3's "jump to this search hit" must put its flash marker at the SAME
 * place the label is, and the only way to guarantee that is to call the same function.
 */
export function labelPosition(vp: MapViewport, p: Pick<MapPoint, 'x' | 'y'>): ScreenPos {
  return vp.toScreen(p.x, p.y)
}

/** Relative luminance, 0..1 — decides which extreme the halo takes. */
function luminance(p: MapPoint): number {
  return (0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b) / 255
}

function haloShadow(p: MapPoint): string {
  const c = luminance(p) < 0.5 ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.92)'
  return `-1px 0 0 ${c}, 1px 0 0 ${c}, 0 -1px 0 ${c}, 0 1px 0 ${c}`
}

export interface MapPointsLayerProps {
  points: readonly MapPoint[]
  vp: MapViewport
  /** Same mask the canvas draws with, so a toggled-off layer hides its labels too. */
  layers: LayerMask
}

function Label({ p, at }: { p: MapPoint; at: ScreenPos }): React.JSX.Element {
  return (
    <span
      data-testid="map-point"
      // The RAW display text — `label.replace(/_/g,' ')`, computed once by the parser. The
      // tooltip repeats it verbatim so a label clipped by a neighbour is still readable.
      title={p.display}
      style={{
        position: 'absolute',
        left: at.px,
        top: at.py,
        transform: 'translate(-50%, -50%)',
        font: `${String(LABEL_FONT_PX[p.size])}px/1.1 inherit`,
        color: `rgb(${String(p.r)},${String(p.g)},${String(p.b)})`,
        textShadow: haloShadow(p),
        whiteSpace: 'nowrap',
        pointerEvents: 'auto',
        userSelect: 'none',
        cursor: 'default'
      }}
    >
      {p.display}
    </span>
  )
}

export function MapPointsLayer({ points, vp, layers }: MapPointsLayerProps): React.JSX.Element {
  const vis = visiblePoints(points, expandRect(vp.rect, OVERSCAN_PX / vp.view.scale), layers)
  return (
    <div
      data-testid="map-points-layer"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {vis.map(({ point, index }) => (
        <Label key={index} p={point} at={labelPosition(vp, point)} />
      ))}
    </div>
  )
}
