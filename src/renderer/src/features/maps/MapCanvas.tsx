// The map's LINE GEOMETRY, on a canvas (docs/plans/map-viewer.md §6.1).
//
// WHY CANVAS AND NOT SVG — settled by measurement, not preference: one zone is up to 26,383
// line segments (everfrost.txt; p95 = 12,738 across 701 base files). As SVG that is 26k DOM
// nodes reconciled by React on every pan frame. The combat timeline gets away with SVG only
// because it windows to a visible TIME range; a map's default view is fit-to-zone, which shows
// every segment by definition. There is no windowing escape here.
//
// HOW ONE FRAME IS DRAWN:
//
//   1. Cull to the visible rect — indices into a caller-owned Uint32Array, zero allocation
//      (mapGeometry.cullSegments).
//   2. One Path2D PER PALETTE COLOUR, filled from the culled set. Measured max is 19 distinct
//      colours in a real file, so a full-zone frame is ~19 `stroke()` calls instead of 26,383.
//   3. Stroke each path once. The projection is inlined into the loop rather than calling
//      `project()` per endpoint — that would be 52k short-lived objects per frame at pointer
//      rate, which is exactly the allocation the columnar model exists to avoid.
//
// REDRAW POLICY: an effect keyed on the view, the size, the data and the toggles. NO
// requestAnimationFrame loop — an idle map costs zero frames, and React already coalesces the
// pointer-driven state changes that do cause a redraw.
//
// devicePixelRatio is handled (backing store scaled, CSS size in px, ctx pre-scaled). Skipping
// it is the difference between a crisp map and a blurry one on every modern display.

import { useEffect, useRef } from 'react'
import type { MapLines } from '@shared/maps'
import { cullSegments, type LayerMask, type MapView, type ViewRect, type ViewportSize } from './mapGeometry'
import type { MapViewport } from './useMapViewport'

/**
 * Substitute stroke for NEAR-BLACK geometry.
 *
 * Black (`0,0,0`) is the map format's "main elevation band" and the default EQL set's only line
 * colour — and this app's panes are dark, so drawn literally it is an invisible map. Lifting
 * only the near-black bucket keeps every colour that carries meaning (water 0,0,255; lava
 * 255,0,0; zone lines 199,21,133; the warm/cool elevation bands) exactly as authored. It is a
 * legibility substitution on ONE indistinguishable-from-background colour, not a recolouring of
 * the palette.
 */
export const DEFAULT_INK = '#c8d0de'

/** Max channel below this counts as "black" for the substitution above. */
const NEAR_BLACK = 32

export interface MapCanvasProps {
  lines: MapLines
  vp: MapViewport
  /** Which layers to draw. Layer 2 (the legend) is off in `DEFAULT_LAYERS`. */
  layers: LayerMask
  /** Stroke used in place of near-black geometry. */
  ink?: string
}

/** One CSS colour per palette slot, resolved once per data/theme change. */
function strokeStyles(palette: Uint8Array, ink: string): string[] {
  const out: string[] = []
  for (let i = 0; i + 2 < palette.length; i += 3) {
    const r = palette[i]
    const g = palette[i + 1]
    const b = palette[i + 2]
    out.push(Math.max(r, g, b) < NEAR_BLACK ? ink : `rgb(${r},${g},${b})`)
  }
  return out
}

/** Size the backing store for the display, and hand back a context already in CSS-pixel space. */
function prepare(cv: HTMLCanvasElement, size: ViewportSize): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(size.w * dpr))
  const h = Math.max(1, Math.round(size.h * dpr))
  // Assigning width/height clears the canvas, so only touch them when they actually changed.
  if (cv.width !== w) cv.width = w
  if (cv.height !== h) cv.height = h
  cv.style.width = `${String(size.w)}px`
  cv.style.height = `${String(size.h)}px`
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size.w, size.h)
  return ctx
}

/** Everything one frame needs. An object because the draw is well past max-params 4. */
interface Frame {
  lines: MapLines
  view: MapView
  size: ViewportSize
  rect: ViewRect
  layers: LayerMask
  ink: string
  /** Caller-owned scratch buffer for culled segment indices — reused across frames. */
  idx: Uint32Array
}

function paint(ctx: CanvasRenderingContext2D, f: Frame): void {
  const n = cullSegments(f.lines, f.rect, f.layers, f.idx)
  const styles = strokeStyles(f.lines.palette, f.ink)
  const paths = styles.map(() => new Path2D())
  if (paths.length === 0 || n === 0) return

  const { coords, colorIndex } = f.lines
  const { cx, cy, scale } = f.view
  const hw = f.size.w / 2
  const hh = f.size.h / 2
  for (let k = 0; k < n; k += 1) {
    const seg = f.idx[k]
    const o = seg * 6
    const path = paths[colorIndex[seg]]
    // Projection inlined: px = hw + (x-cx)*scale, py = hh - (y-cy)*scale. The `-` is the screen
    // flip (map y grows up) and it is the only negation at render time.
    path.moveTo(hw + (coords[o] - cx) * scale, hh - (coords[o + 1] - cy) * scale)
    path.lineTo(hw + (coords[o + 3] - cx) * scale, hh - (coords[o + 4] - cy) * scale)
  }

  ctx.lineWidth = 1
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (let i = 0; i < paths.length; i += 1) {
    ctx.strokeStyle = styles[i]
    ctx.stroke(paths[i])
  }
}

export function MapCanvas({ lines, vp, layers, ink = DEFAULT_INK }: MapCanvasProps): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  // ONE index buffer per loaded map, not per frame — grown only when a bigger zone arrives.
  // At everfrost's 26,383 segments a per-frame allocation would run at pointer rate.
  const idxRef = useRef<Uint32Array>(new Uint32Array(0))

  const { view, size, rect } = vp
  useEffect(() => {
    const cv = ref.current
    if (!cv || size.w <= 0 || size.h <= 0) return
    if (idxRef.current.length < lines.count) idxRef.current = new Uint32Array(lines.count)
    const ctx = prepare(cv, size)
    if (!ctx) return
    paint(ctx, { lines, view, size, rect, layers, ink, idx: idxRef.current })
  }, [lines, view, size, rect, layers, ink])

  return (
    <canvas
      ref={ref}
      data-testid="map-canvas"
      style={{ position: 'absolute', inset: 0, display: 'block' }}
    />
  )
}
