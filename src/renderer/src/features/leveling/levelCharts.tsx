// The leveling view's two inline SVG chart primitives. They take already-derived
// series (see ./levelSeries.ts for the world model behind the level one) and draw
// them — no data shaping, no MUI, no chart library. Split out of LevelingView.tsx
// for file mass; the drawing rules themselves are unchanged.
//
// Both charts now take ONE `ChartScale` from the view (see ./zoneBands.ts `chartDomain`).
// They used to compute their own, so a zone band or a range selection at the same pixel
// meant two different instants on the two charts. The shared domain is the seam the band
// strip and the drag selection hang off; nothing else about the drawing changed.

import type { CSSProperties, JSX } from 'react'
import type { LevelSegment } from './levelSeries'
import { CHART_H, CHART_W, xOf, type AaPoint, type ChartScale } from './levelChartGeometry'
import { LevelHoverLayer } from './LevelHoverLayer'
import { formatTime } from '../../lib/formatDate'
import { BAND_H, BAND_PAD, PAD_X, bandRects, type ZoneBand, type ZoneLegend } from './zoneBands'
import type { ChartSelection, SelectionPointerHandlers } from './useChartSelection'

const W = CHART_W
const H = CHART_H

/**
 * Everything both charts need in order to agree with each other: the one time domain, the
 * zone bands over it, the current range band, and the drag handlers. Bundled into a single
 * prop so adding a chart-wide concern later is one plumbing change, not two.
 */
export interface ChartChrome {
  scale: ChartScale
  bands: readonly ZoneBand[]
  /** live draft or committed selection — the SAME band is drawn on both charts. */
  range: ChartSelection | null
  /** a range drag owns the pointer: the hover tooltip must not render. */
  suppressed: boolean
  pointer: SelectionPointerHandlers
}

/**
 * Positioned ancestor for the hover + selection layers, and the element the drag handlers
 * bind to (see useChartSelection for why it is the wrapper and not the <svg>). A plain
 * `div`, not an MUI `Box`: this file is deliberately MUI-free (see the header), and emotion
 * would serialize a style object on every render of a component that sits directly under a
 * pointermove path. `touchAction`/`userSelect` are what make a horizontal drag a range drag
 * instead of a scroll gesture or a text selection.
 */
const WRAP_STYLE: CSSProperties = { position: 'relative', touchAction: 'none', userSelect: 'none' }

/** z-order reserved across the chart stack: 1 = range band, 2 = crosshair, 3 = tooltip. */
const SEL_LAYER: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }
const TICK: CSSProperties = { position: 'absolute', bottom: 0, fontSize: 9, lineHeight: '11px', whiteSpace: 'nowrap' }

/**
 * The zone strip: which zone you were in, along the top of the plot.
 *
 * NO `<title>` children on the bands. The hover layer owns tooltips on these charts and a
 * native browser tooltip would race its card — one owner, per the plan's §6.2 arbitration.
 * Identification without hover is the legend's job (ZoneLegendStrip below).
 */
function ZoneBandStrip({ bands, scale }: { bands: readonly ZoneBand[]; scale: ChartScale }): JSX.Element | null {
  const rects = bandRects(bands, scale)
  if (rects.length === 0) return null
  return (
    <g>
      {rects.map((r, i) => (
        <rect key={`${r.key}-${i}`} x={r.x} y={0} width={r.w} height={BAND_H} fill={r.color} opacity={0.85} />
      ))}
    </g>
  )
}

/**
 * The range band, as HTML rather than SVG. The plots are `preserveAspectRatio="none"`, so
 * anything drawn inside them is horizontally STRETCHED — fine for a rect, ruinous for the
 * edge tick labels. Percent offsets against the stretched viewBox width land in exactly the
 * same place as the SVG geometry would, and the text stays upright.
 *
 * `pointerEvents:'none'` throughout: the band must never steal a hover target, so the
 * tooltip stays fully live over a committed selection.
 */
function SelectionBand({
  scale,
  range,
  color
}: {
  scale: ChartScale
  range: ChartSelection | null
  color: string
}): JSX.Element | null {
  if (!range) return null
  const l = (xOf(scale, range.t0) / scale.w) * 100
  const r = (xOf(scale, range.t1) / scale.w) * 100
  const edge: CSSProperties = { position: 'absolute', top: 0, bottom: 0, width: 1, background: color, opacity: 0.75 }
  return (
    <div style={SEL_LAYER}>
      <div
        style={{ position: 'absolute', left: `${l}%`, width: `${Math.max(0, r - l)}%`, top: 0, bottom: 0, background: color, opacity: 0.14 }}
      />
      <div style={{ ...edge, left: `${l}%` }} />
      <div style={{ ...edge, left: `${r}%` }} />
      <div style={{ ...TICK, left: `${l}%`, color, transform: 'translateX(2px)' }}>{formatTime(range.t0)}</div>
      <div style={{ ...TICK, left: `${r}%`, color, transform: 'translateX(calc(-100% - 2px))' }}>
        {formatTime(range.t1)}
      </div>
    </div>
  )
}

const LEGEND_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '2px 10px',
  fontSize: 11,
  // Fixed-height law: a wrapped legend must not push the chart column around as the visible
  // zone mix changes. Two rows are visible; anything beyond scrolls.
  maxHeight: 40,
  overflowY: 'auto',
  opacity: 0.85
}
const SWATCH: CSSProperties = { width: 9, height: 9, borderRadius: 2, flexShrink: 0 }
const LEGEND_ITEM: CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }

/**
 * The zones on screen, by dwell. This is the identification path that does NOT depend on
 * hover, so it survives whatever the tooltip does. Plain HTML with inherited type: this
 * file stays MUI-free, and the strip reads as a caption under the plot it belongs to.
 */
export function ZoneLegendStrip({
  legend,
  fmtDuration
}: {
  legend: ZoneLegend
  /** the view's duration formatter, injected so there is no second one in this feature. */
  fmtDuration: (ms: number) => string
}): JSX.Element | null {
  if (legend.rows.length === 0) return null
  return (
    <div style={LEGEND_STYLE}>
      {legend.rows.map((row) => (
        <span key={row.key} style={LEGEND_ITEM}>
          <span style={{ ...SWATCH, background: row.color }} />
          <span>{row.name}</span>
          <span style={{ opacity: 0.6 }}>{fmtDuration(row.ms)}</span>
        </span>
      ))}
      {legend.more > 0 && <span style={{ opacity: 0.6 }}>+{legend.more} more</span>}
    </div>
  )
}

/** Simple filled area chart of a cumulative series over time. */
export function AreaChart({
  points,
  color,
  chrome
}: {
  points: AaPoint[]
  color: string
  chrome: ChartChrome
}): JSX.Element | null {
  if (points.length < 2) return null
  const pad = PAD_X
  // The X mapping is the SHARED scale, so the hover layer below reads the cursor back
  // through the same domain the level chart plots and neither can drift from the other.
  const scale = chrome.scale
  const padTop = pad + BAND_PAD
  const yMax = points[points.length - 1].y || 1
  const x = (t: number): number => xOf(scale, t)
  const y = (v: number): number => H - pad - (v / yMax) * (H - pad - padTop)
  const line = points.map((p) => `${x(p.ts).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')
  // Hold the curve flat to the end of the shared domain. Cumulative AA is a STEP function
  // between gain lines (that is what `cumulativeAt` reads), so the plateau is what the
  // series actually says — and it is the same trailing-plateau rule the level chart uses.
  const tail = `${x(scale.t1).toFixed(1)},${y(points[points.length - 1].y).toFixed(1)}`
  const area = `${x(points[0].ts).toFixed(1)},${H - pad} ${line} ${tail} ${x(scale.t1).toFixed(1)},${H - pad}`
  return (
    <div style={WRAP_STYLE} {...chrome.pointer}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        <ZoneBandStrip bands={chrome.bands} scale={scale} />
        <polygon points={area} fill={color} opacity={0.18} />
        <polyline points={`${line} ${tail}`} fill="none" stroke={color} strokeWidth={2} />
      </svg>
      <SelectionBand scale={scale} range={chrome.range} color={color} />
      <LevelHoverLayer
        scale={scale}
        height={H}
        color={color}
        aaPoints={points}
        bands={chrome.bands}
        suppressed={chrome.suppressed}
      />
    </div>
  )
}

export const SWAP_COLOR = '#8fa3b8'

/** One loadout's drawn run. */
interface DrawnSegment {
  line: string
  area: string
  startX: number
  startY: number
  endX: number
  endY: number
  /** under 2 user units wide — a single-ding run, which a polyline cannot show at all. */
  narrow: boolean
  afterSwap: boolean
}

/**
 * Build the polyline/area for each loadout run.
 *
 * HONESTY FIX (was: `end = segments[i+1].points[0].ts`). A pre-swap run used to be extended
 * flat to the FIRST DING OF THE NEXT LOADOUT, which drew a solid "level 50" line straight
 * across the unlogged swap gap — a window where `levelAt()` correctly reports `swap-gap` and
 * the tooltip says the level is unknown. The picture contradicted the readout. Each run now
 * ends at its OWN last ding and the gap renders as a gap; only the FINAL run gets the
 * trailing plateau, because you are in fact still that level.
 */
function drawSegments(segments: readonly LevelSegment[], scale: ChartScale, y: (v: number) => number, floor: number): DrawnSegment[] {
  return segments.map((seg, i) => {
    const x = (t: number): number => xOf(scale, t)
    const last = seg.points[seg.points.length - 1]
    const end = i + 1 < segments.length ? last.ts : scale.t1
    const pts: string[] = []
    let py = y(seg.points[0].level)
    for (const p of seg.points) {
      const px = x(p.ts)
      if (pts.length) pts.push(`${px.toFixed(1)},${py.toFixed(1)}`) // hold the old level…
      py = y(p.level)
      pts.push(`${px.toFixed(1)},${py.toFixed(1)}`) // …then step up at the ding
    }
    pts.push(`${x(end).toFixed(1)},${py.toFixed(1)}`)
    const x0 = x(seg.points[0].ts)
    return {
      line: pts.join(' '),
      area: `${x0.toFixed(1)},${floor} ${pts.join(' ')} ${x(end).toFixed(1)},${floor}`,
      startX: x0,
      startY: y(seg.points[0].level),
      endX: x(end),
      endY: py,
      narrow: x(end) - x0 < 2,
      afterSwap: seg.afterSwap
    }
  })
}

/**
 * Level over time, drawn HONESTLY (see ./levelSeries.ts for the world model).
 *
 * A level is a step function: it holds until the next ding, so the line is step-AFTER —
 * never a diagonal that implies you were level 43.6 on Thursday afternoon. A loadout swap
 * drops the reported level with NO log line, so the segments are drawn DISJOINT: each run
 * stops at its own last ding, the gap between runs is left EMPTY (nothing observed, nothing
 * drawn), a dashed rule marks the boundary, and the new run starts at its first ding.
 * Nothing is drawn descending, because nothing descending was ever observed — you did not
 * lose levels, you changed classes.
 * Cheap inline SVG (these surfaces are render-bound; no chart libs).
 */
export function LevelStepChart({
  segments,
  color,
  aaPoints,
  chrome
}: {
  segments: LevelSegment[]
  color: string
  /** Cumulative AA series — context only ("AA gained by then"), never drawn here. */
  aaPoints: AaPoint[]
  chrome: ChartChrome
}): JSX.Element | null {
  const all = segments.flatMap((s) => s.points)
  if (all.length < 2) return null
  const padTop = 14 + BAND_PAD
  const padBottom = 8
  const scale = chrome.scale
  const hi = all.reduce((m, p) => Math.max(m, p.level), all[0].level)
  const lo = all.reduce((m, p) => Math.min(m, p.level), all[0].level)
  // Baseline one level under the lowest observed ding: the fill follows the steps rather
  // than reaching an arbitrary zero, so a low post-swap segment doesn't look like a crater.
  const base = lo - 1
  const y = (v: number): number => H - padBottom - ((v - base) / Math.max(1, hi - base)) * (H - padTop - padBottom)
  const floor = H - padBottom
  const drawn = drawSegments(segments, scale, y, floor)

  return (
    <div style={WRAP_STYLE} {...chrome.pointer}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        <ZoneBandStrip bands={chrome.bands} scale={scale} />
        {drawn.map((d, i) => (
          <g key={i}>
            <polygon points={d.area} fill={color} opacity={0.12} />
            <polyline points={d.line} fill="none" stroke={color} strokeWidth={2} />
            {/* A run with a single ding has zero width now that it no longer stretches to the
                next loadout. The dot marks the one instant that WAS observed. */}
            {d.narrow && <circle cx={d.endX} cy={d.endY} r={2.5} fill={color} />}
          </g>
        ))}
        {drawn.map((d, i) =>
          d.afterSwap ? (
            <g key={`s${i}`}>
              <line
                x1={d.startX}
                y1={padTop - 6}
                x2={d.startX}
                y2={floor}
                stroke={SWAP_COLOR}
                strokeWidth={1}
                strokeDasharray="3 4"
                opacity={0.9}
              />
              <circle cx={d.startX} cy={d.startY} r={3.5} fill="none" stroke={SWAP_COLOR} strokeWidth={1.5} />
            </g>
          ) : null
        )}
        <text x={PAD_X} y={padTop} fill={color} fontSize={10} opacity={0.7}>
          {hi}
        </text>
        <text x={PAD_X} y={floor - 2} fill={color} fontSize={10} opacity={0.7}>
          {lo}
        </text>
      </svg>
      <SelectionBand scale={scale} range={chrome.range} color={color} />
      <LevelHoverLayer
        scale={scale}
        height={H}
        color={color}
        aaPoints={aaPoints}
        bands={chrome.bands}
        segments={segments}
        suppressed={chrome.suppressed}
      />
    </div>
  )
}
