// The DPS curve's hover: a crosshair, a dot riding the outgoing line, and the shared
// ChartTooltip — the readout that turns "a violet dashed tick" into "Neurotoxic, applied at 1:04,
// and you were doing 12.4k dps when it went on".
//
// Structurally identical to TimelineHoverLayer, and for the same two reasons:
//   1. ALL hover state lives HERE, in a leaf. `DpsCurve` renders the chart SVG and receives no
//      hover-derived props, so a mousemove re-renders this layer and nothing else — the curve,
//      its marker ticks and its legend never re-render on hover.
//   2. Moves are rAF-coalesced AND change-gated, so a 1000Hz mouse sitting still inside one
//      marker's tolerance costs zero React work.
//
// The layer is `pointerEvents: 'none'`; the wrapper Box owns the listeners.

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import type { TimelineMarker } from '@shared/combat'
import { ChartTooltip, type TooltipRow } from '../../lib/ChartTooltip'
import { formatRate } from '../../lib/formatRate'
import { rafThrottle } from '../../lib/rafThrottle'
import { KIND_COLOR } from './combatShared'
import type { DpsSeries } from './dashboardData'
import { dpsAt, rollingNote } from './dpsAt'
import {
  CHART_H,
  CHART_W,
  PAD_B,
  PAD_T,
  PAD_X,
  curveYAtUserX,
  pxToUser,
  tAtUserX,
  userToPx,
  xAtT,
  type DpsChart,
  type PlacedMarker
} from './dpsChart'
import { MARKER_COLOR } from './markerStyle'
import { markerTooltip, timeTooltip, type TipContent } from './timelineGeometry'
import { pickMarker } from './timelineHitTest'

/** Grab radius for a marker tick, in CSS px — the same 5 the timeline's rail uses, so a coat is
 *  equally easy to hit on either surface. Converted to a TIME tolerance before hit-testing (D7),
 *  and through `pxToUser` first because CSS px are not user units on this stretched chart. */
const MARKER_TOL_PX = 5

/** How the wrapper drives this layer. Imperative on purpose: it keeps hover setState out of the
 *  component that renders the curve (rule 1 above) while the listeners stay on the wrapper Box. */
export interface CurveHoverHandle {
  /** cursor at (x, y) in CSS px relative to the wrapper, over a chart `w` CSS px wide. */
  move: (x: number, y: number, w: number) => void
  clear: () => void
}

export interface DpsCurveHoverProps {
  api: Ref<CurveHoverHandle>
  chart: DpsChart
  series: DpsSeries
  /** the markers the curve actually DREW (already windowed) — hit-testing costs what drawing
   *  costs, and a marker scrolled out of the live window can't be hovered into existence. */
  markers: readonly PlacedMarker[]
  /** epoch ms of t=0, for the tooltip's wall clock (display only — TimelineView.startTs). */
  startTs: number
}

/** What the cursor resolved to. The marker is held by REFERENCE, not by index: the change gate
 *  compares it, and an index into a re-windowed array could describe the wrong tick. */
interface Hit {
  x: number
  y: number
  /** measured CSS width of the stretched chart — the px↔user factor for this move. */
  w: number
  /** cursor time, ms into the encounter. */
  t: number
  mk: TimelineMarker | null
}

/** The change gate: same marker, same width, and the cursor barely moved ⇒ no setState at all. */
function sameHit(a: Hit, b: Hit): boolean {
  return a.mk === b.mk && a.w === b.w && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2
}

/** The rolling-DPS block — sampled from THIS chart's own series (dpsAt), never recomputed, and
 *  `~`-prefixed when that series is inexact. Rates go through formatRate: '12.4k dps', no '/s'. */
function dpsRows(series: DpsSeries, t: number): TooltipRow[] {
  const p = dpsAt(series, t)
  const a = series.estimated ? '~' : ''
  const rows: TooltipRow[] = [{ label: 'you + pet', value: `${a}${formatRate(p.out)}`, color: KIND_COLOR.you }]
  if (series.hasPet) rows.push({ label: 'pet', value: `${a}${formatRate(p.pet)}`, color: KIND_COLOR.pet })
  if (series.hasInc) rows.push({ label: 'incoming', value: `${a}${formatRate(p.inc)}`, color: KIND_COLOR.enemy })
  return rows
}

/** A marker under the cursor becomes the tooltip's SUBJECT and the rates drop to secondary rows;
 *  otherwise the cursor's own instant is the subject and the rates are the whole point. */
function buildTip(hit: Hit, series: DpsSeries, startTs: number): TipContent {
  const base = hit.mk ? markerTooltip(hit.mk) : timeTooltip(hit.t, startTs, series.durationMs)
  return { ...base, rows: [...base.rows, ...dpsRows(series, hit.t)], note: rollingNote(series) }
}

/** Drawn in a 1:1 CSS-px overlay rather than in the chart's stretched user space — a circle in
 *  that space would paint as an ellipse, and a 1px rule as a fat one. */
function Cursor({ hit, chart, series }: { hit: Hit; chart: DpsChart; series: DpsSeries }): React.JSX.Element {
  const ux = Math.min(CHART_W - PAD_X, Math.max(PAD_X, pxToUser(hit.x, hit.w)))
  return (
    <svg width={hit.w} height={CHART_H} style={{ position: 'absolute', left: 0, top: 0, display: 'block' }}>
      {/* the confirmation of WHICH tick the title names — nearest-in-time picking has no other */}
      {hit.mk && (
        <line
          x1={userToPx(xAtT(chart, hit.mk.t), hit.w)}
          x2={userToPx(xAtT(chart, hit.mk.t), hit.w)}
          y1={PAD_T - 4}
          y2={CHART_H - PAD_B}
          stroke={MARKER_COLOR[hit.mk.kind]}
          strokeWidth={3}
          opacity={0.35}
        />
      )}
      <line
        x1={hit.x}
        x2={hit.x}
        y1={PAD_T - 4}
        y2={CHART_H - PAD_B}
        stroke="rgba(255,255,255,0.18)"
        strokeWidth={1}
      />
      {/* Y is 1:1 on this chart, so the curve's user Y is already a CSS px offset. */}
      <circle
        cx={userToPx(ux, hit.w)}
        cy={curveYAtUserX(chart, series, ux)}
        r={3}
        fill={KIND_COLOR.you}
        stroke="rgba(0,0,0,0.55)"
        strokeWidth={1}
      />
    </svg>
  )
}

export function DpsCurveHoverLayer({ api, chart, series, markers, startTs }: DpsCurveHoverProps): React.JSX.Element {
  const [hit, setHit] = useState<Hit | null>(null)
  // Mirrors the state so the change gate reads the CURRENT pick without re-creating the throttled
  // callback (and its pending animation frame) on every hover.
  const last = useRef<Hit | null>(null)
  const mks = useMemo(() => markers.map((p) => p.m), [markers])

  const hitAt = useCallback(
    (x: number, y: number, w: number): Hit => {
      const t = tAtUserX(chart, pxToUser(x, w))
      // ms per user unit × the grab radius expressed in user units — one conversion each way, so
      // the tolerance is a true 5 CSS px however wide the card happens to be.
      const msPerUser = Math.max(1, chart.endMs - chart.startMs) / (CHART_W - 2 * PAD_X)
      const tol = pxToUser(MARKER_TOL_PX, w) * msPerUser
      return { x, y, w, t, mk: pickMarker(mks, t, tol)?.item ?? null }
    },
    [chart, mks]
  )

  const apply = useCallback(
    (x: number, y: number, w: number): void => {
      const next = hitAt(x, y, w)
      const prev = last.current
      if (prev && sameHit(prev, next)) return
      last.current = next
      setHit(next)
    },
    [hitAt]
  )

  const move = useMemo(() => rafThrottle(apply), [apply])
  const clear = useCallback((): void => {
    move.cancel()
    last.current = null
    setHit(null)
  }, [move])
  useEffect(() => () => move.cancel(), [move])
  useImperativeHandle(api, () => ({ move, clear }), [move, clear])

  const tip = useMemo(() => (hit ? buildTip(hit, series, startTs) : null), [hit, series, startTs])

  return (
    <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: CHART_H, pointerEvents: 'none', zIndex: 4 }}>
      {hit && tip && (
        <>
          <Cursor hit={hit} chart={chart} series={series} />
          <ChartTooltip {...tip} x={hit.x} y={hit.y} bounds={{ w: hit.w, h: CHART_H }} />
        </>
      )}
    </div>
  )
}
