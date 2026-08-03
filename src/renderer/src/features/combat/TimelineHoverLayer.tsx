// The timeline's hover: a crosshair, a highlight ring on the mark being described, and the
// shared ChartTooltip — over a nearest-in-time hit test instead of a handler per element.
//
// TWO structural rules make this cheap, and both are load-bearing:
//   1. ALL hover state lives HERE, in a leaf. The chart's SVG subtree is a sibling that receives
//      no hover-derived props, so a mousemove re-renders this layer and nothing else. (It used
//      to live in CombatTimelineInner, which meant every move re-rendered up to ~2k ticks.)
//      The wrapper owns the listeners and drives this layer through the `api` handle.
//   2. Moves are rAF-coalesced AND change-gated: no setState unless the picked mark changed or
//      the cursor moved >=2px, so a 1000Hz mouse inside one tick's tolerance costs zero React
//      work.
//
// The layer itself is `pointerEvents: 'none'` — the wheel-zoom (a native non-passive listener)
// and the drag-pan stay on the <svg> beneath it, untouched.

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import type { StanceSpan, TimelineEvent, TimelineMarker, TimelineView } from '@shared/combat'
import { ChartTooltip, type TooltipRow } from '../../lib/ChartTooltip'
import { rafThrottle } from '../../lib/rafThrottle'
import { formatRate } from '../../lib/formatRate'
import { CAT_COLOR, KIND_COLOR, RESIST_COLOR } from './combatShared'
import type { DpsSeries } from './dashboardData'
import { dpsAt, rollingNote } from './dpsAt'
import { MARKER_COLOR, MARKER_WORD } from './markerStyle'
import { laneAt, pickEventInLane, pickMarker, pickSpanAt } from './timelineHitTest'
import {
  PIN_H,
  markerTooltip,
  spanTooltip,
  tickTooltip,
  timeTooltip,
  type TimelineMetrics,
  type TipContent,
  type ViewWin
} from './timelineGeometry'

/** Grab radii, in CSS px, converted to a time tolerance by the caller (D7). A tick is 2–3px
 *  wide, so 6 is what turns it from a sub-pixel target into something a hand can hit; the rail
 *  is wider because nothing else is up there to compete for the cursor. */
const TICK_TOL_PX = 6
const MARKER_TOL_PX = 5
const RAIL_TOL_PX = 10

/** How the wrapper drives this layer. Imperative on purpose: it keeps hover setState OUT of the
 *  chart's root component (rule 1 above) while the listeners stay on the wrapper Box, where they
 *  cannot swallow the viewport's own wheel/drag handlers. */
export interface HoverHandle {
  /** cursor at (x,y), CSS px relative to the wrapper's content box. */
  move: (x: number, y: number) => void
  clear: () => void
}

/** What the cursor resolved to. Item REFERENCES (not indices) — the change gate compares them,
 *  and a stale index into a re-windowed array could otherwise describe the wrong tick. */
interface Hit {
  x: number
  y: number
  /** cursor time, ms into the encounter. */
  t: number
  ev: TimelineEvent | null
  mk: TimelineMarker | null
  span: StanceSpan | null
}

export interface HoverLayerProps {
  api: Ref<HoverHandle>
  tl: TimelineView
  /** the visible-window slice the chart actually drew — hit-testing costs what drawing costs. */
  events: TimelineEvent[]
  laneIndex: Map<string, number>
  m: TimelineMetrics
  view: ViewWin
  span: number
  series: DpsSeries
}

/** Everything a hit test reads that does not change with the cursor. Memoized by the layer, so
 *  the hit-test callback (and its animation frame) survive a parent re-render. */
interface HitCtx {
  tl: TimelineView
  events: TimelineEvent[]
  m: TimelineMetrics
}

/** Which pinned span row the cursor is over, and the span covering the cursor's time in it. */
function pinSpanAt(c: HitCtx, y: number, t: number): StanceSpan | null {
  if (y < 0 || y >= c.m.pinBlockH) return null
  const group = c.m.pinRows[Math.floor(y / (PIN_H + 2))]
  return group ? pickSpanAt(c.tl.stanceSpans, group, t) : null
}

/** The tick under the cursor, or null when the cursor is not in the lane block at all. */
function laneHit(c: HitCtx, y: number, t: number, msPerPx: number): TimelineEvent | null {
  const lane = laneAt(y - c.m.laneTop, c.m.laneH, c.tl.lanes.length)
  if (lane === null) return null
  return pickEventInLane(c.events, c.tl.lanes[lane].lane, t, TICK_TOL_PX * msPerPx)?.item ?? null
}

/** The change gate (§8.3): same pick, and the cursor barely moved ⇒ no setState at all. */
function sameHit(a: Hit, b: Hit): boolean {
  return a.ev === b.ev && a.mk === b.mk && a.span === b.span && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2
}

/** The rolling-DPS block every timeline tooltip carries — sampled from the chart's own series
 *  (dpsAt), never recomputed, and `~`-prefixed when that series is inexact. */
function dpsRows(series: DpsSeries, t: number): TooltipRow[] {
  const p = dpsAt(series, t)
  const a = series.estimated ? '~' : ''
  const rows: TooltipRow[] = [{ label: 'you + pet', value: `${a}${formatRate(p.out)}`, color: KIND_COLOR.you }]
  if (series.hasPet) rows.push({ label: 'pet', value: `${a}${formatRate(p.pet)}`, color: KIND_COLOR.pet })
  if (series.hasInc) rows.push({ label: 'incoming', value: `${a}${formatRate(p.inc)}`, color: KIND_COLOR.enemy })
  return rows
}

/**
 * The honesty footer. On a TRUNCATED ring the left edge is not the fight's opening — the oldest
 * instants were dropped — so the note says which edge the user is actually looking at rather
 * than letting the chart imply a start it never held.
 */
function noteFor(tl: TimelineView, series: DpsSeries, t: number): string {
  const base = rollingNote(series)
  const firstT = tl.events[0]?.t ?? 0
  return tl.truncated && t <= firstT ? `${base} · earliest retained instant` : base
}

/** The tick/marker/span the cursor is on, plus the rolling-DPS block and the footer. */
function buildTip(hit: Hit, tl: TimelineView, series: DpsSeries): TipContent {
  const base: TipContent = hit.span
    ? spanTooltip(hit.span)
    : hit.ev
      ? tickTooltip(hit.ev, { cat: CAT_COLOR[hit.ev.category], resist: RESIST_COLOR })
      : hit.mk
        ? markerTooltip(hit.mk)
        : timeTooltip(hit.t, tl.startTs, tl.durationMs)
  const rows = [...base.rows]
  // A tick sitting on a marker guide answers both questions at once: what landed, and what was
  // in force when it did.
  if (hit.ev && hit.mk) rows.push({ value: `${hit.mk.label} ${MARKER_WORD[hit.mk.kind]}`, color: MARKER_COLOR[hit.mk.kind] })
  return { ...base, rows: [...rows, ...dpsRows(series, hit.t)], note: noteFor(tl, series, hit.t) }
}

/** The crosshair, plus the ring that says WHICH mark the tooltip is describing (nearest-in-time
 *  hit-testing has no other way to confirm the pick). */
function Crosshair({ hit, p }: { hit: Hit; p: HoverLayerProps }): React.JSX.Element {
  const { m, view, span, laneIndex } = p
  const lane = hit.ev ? laneIndex.get(hit.ev.lane) : undefined
  const ring =
    hit.ev && lane !== undefined
      ? {
          cx: m.labelW + ((hit.ev.t - view.start) / span) * m.plotW,
          cy: m.laneTop + lane * m.laneH + m.laneH / 2,
          stroke: hit.ev.outcome === 'miss' || hit.ev.outcome === 'resist' ? RESIST_COLOR : CAT_COLOR[hit.ev.category]
        }
      : null
  return (
    <svg
      width={m.labelW + m.plotW + 1}
      height={m.laneTop + m.plotH}
      style={{ position: 'absolute', left: 0, top: 0, display: 'block' }}
    >
      <line x1={hit.x} x2={hit.x} y1={m.markerTop} y2={m.laneTop + m.plotH} stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
      {ring && (
        <circle
          cx={ring.cx}
          cy={ring.cy}
          r={Math.min(8, m.laneH / 2)}
          fill="none"
          stroke={ring.stroke}
          strokeWidth={2}
          opacity={0.9}
        />
      )}
    </svg>
  )
}

export function TimelineHoverLayer(p: HoverLayerProps): React.JSX.Element {
  const { api, tl, events, m, view, span, series } = p
  const [hit, setHit] = useState<Hit | null>(null)
  // Mirrors the state so the change gate reads the CURRENT pick without re-creating the
  // throttled callback (and its animation frame) on every hover.
  const last = useRef<Hit | null>(null)

  const ctx = useMemo((): HitCtx => ({ tl, events, m }), [tl, events, m])
  const hitAt = useCallback(
    (x: number, y: number): Hit | null => {
      const px = x - m.labelW
      if (px < 0 || px > m.plotW) return null
      const t = view.start + (px / m.plotW) * span
      const msPerPx = span / m.plotW
      // In the rail the marker IS the subject; in the lanes it is only a secondary row.
      const inRail = m.railH > 0 && y >= m.markerTop && y < m.laneTop
      const mk = pickMarker(tl.markers, t, (inRail ? RAIL_TOL_PX : MARKER_TOL_PX) * msPerPx)
      return {
        x,
        y,
        t,
        ev: inRail ? null : laneHit(ctx, y, t, msPerPx),
        mk: mk?.item ?? null,
        span: inRail ? null : pinSpanAt(ctx, y, t)
      }
    },
    [ctx, tl.markers, m, view.start, span]
  )

  const apply = useCallback(
    (x: number, y: number): void => {
      const next = hitAt(x, y)
      const prev = last.current
      if (!next) {
        if (prev) {
          last.current = null
          setHit(null)
        }
        return
      }
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

  const tip = useMemo(() => (hit ? buildTip(hit, tl, series) : null), [hit, tl, series])

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: m.labelW + m.plotW + 1,
        height: m.totalH,
        pointerEvents: 'none',
        zIndex: 4
      }}
    >
      {hit && tip && (
        <>
          <Crosshair hit={hit} p={p} />
          <ChartTooltip {...tip} x={hit.x} y={hit.y} bounds={{ w: m.labelW + m.plotW, h: m.totalH }} />
        </>
      )}
    </div>
  )
}
