// Cursor readout for the two leveling charts. Mounted as an absolutely-positioned SIBLING
// of each chart's <svg> (levelCharts.tsx), never inside it — this component owns ALL the
// hover state, so a pointermove re-renders ~40 DOM nodes instead of the whole plot.
//
// Three rules this file exists to keep (hover plan §7.2 / §8):
//   • It binds `pointermove` and `pointerleave` ONLY. `pointerdown`/`up`/`cancel` are left
//     free for the drag-select feature that will land on these same charts, so that owner
//     never has to edit this file. Those events still bubble through this layer to the
//     wrapper, so binding them higher up keeps working.
//   • It bails the instant `ev.buttons !== 0`. A drag in progress therefore suppresses the
//     tooltip for free, even before anyone wires the explicit `suppressed` prop.
//   • Every move goes through rAF coalescing and a change gate: no setState unless the pick
//     actually changed or the cursor moved >= 2px.
//
// Content is governed by levelChartGeometry's `LevelAt` union — across an unlogged class
// swap there is no level to print, and the type makes that unrenderable rather than
// merely discouraged.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type PointerEvent } from 'react'
import { ChartTooltip, type ChartTooltipModel, type TooltipRow } from '../../lib/ChartTooltip'
import { rafThrottle } from '../../lib/rafThrottle'
import { formatDateTime } from '../../lib/formatDate'
import {
  cumulativeAt,
  fmtDelta,
  levelAt,
  pxToUser,
  stepIndexAt,
  tOf,
  type AaPoint,
  type ChartScale,
  type LevelAt
} from './levelChartGeometry'
import type { LevelSegment } from './levelSeries'
import { zoneAt, zoneColor, type ZoneBand } from './zoneBands'

/** Cursor slack, in CSS px, for "you are on that gain line". */
const GAIN_TOL_PX = 6
/** Below this the cursor has not really moved; skip the state update (plan §8.3). */
const MOVE_EPS_PX = 2

/**
 * z-order reserved across the whole chart stack, so the future range overlay slots in
 * without a fight: 1 = range band, 2 = crosshair, 3 = tooltip. This layer's root carries
 * NO z-index on purpose — it must not open a stacking context, or a sibling band at 1
 * would paint over the crosshair.
 */
const ROOT: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'auto' }
const CROSSHAIR: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }
const TIP_LAYER: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 3 }

/** Everything the tooltip needs that is not cursor geometry. */
type Content = Pick<ChartTooltipModel, 'title' | 'subtitle' | 'rows' | 'note'>

interface Hover {
  ts: number
  /** cursor in CSS px relative to this layer. */
  x: number
  y: number
  bounds: { w: number; h: number }
  /** index into `aaPoints` of the gain the cursor is ON, or -1 when out of tolerance. */
  gainIdx: number
  /** pick identity, for the change gate. */
  key: string
}

export interface LevelHoverLayerProps {
  /** The X mapping of the chart underneath — the SAME object the drawing used. */
  scale: ChartScale
  /** viewBox height (Y is 1:1 on these charts). */
  height: number
  /** Series color, reused for the crosshair so this file introduces no new hue. */
  color: string
  /** Cumulative AA series. The AA chart plots it; the level chart reads it for context. */
  aaPoints: readonly AaPoint[]
  /**
   * The SAME merged bands the strip above draws (threaded down from the view through
   * `ChartChrome`, never recomputed here). Names the zone under the cursor: the legend is
   * the hover-free identification path, but on a busy strip matching a hue to a legend row
   * by eye is work, and the tooltip is already where the cursor is.
   */
  bands: readonly ZoneBand[]
  /** Present on the LEVEL chart only — its presence selects the level readout. */
  segments?: readonly LevelSegment[]
  /** Drag-select seam (plan §7.2): true while a range drag owns the pointer. */
  suppressed?: boolean
}

/**
 * Level over time. The `swap-gap` arm cannot name a level and does not try to: the class
 * swap has no log line, so anywhere between the last pre-swap ding and the first post-swap
 * one the level is genuinely unknown (levelSeries.ts's world model — the same reason the
 * progress feed suppresses the elapsed time across a swap).
 */
function levelContent(segments: readonly LevelSegment[], aaPoints: readonly AaPoint[], ts: number): Content | null {
  const at = levelAt(segments, ts)
  if (at.kind === 'before-first') return null
  if (at.kind === 'swap-gap') {
    return {
      title: 'Between loadouts',
      subtitle: formatDateTime(ts),
      rows: [
        { label: 'last reported', value: String(at.beforeLevel) },
        { label: 'next reported', value: String(at.afterLevel) },
        { label: 'unlogged gap', value: fmtDelta(at.gapMs) }
      ],
      note: 'the class swap is not logged — the level here is unknown'
    }
  }
  const rows: TooltipRow[] = [{ label: 'since', value: formatDateTime(at.sinceTs) }]
  rows.push(at.nextTs == null ? { value: 'current level' } : { label: 'held', value: fmtDelta(at.nextTs - at.sinceTs) })
  const cum = cumulativeAt(aaPoints, ts)
  if (cum != null) rows.push({ label: 'AA gained by then', value: cum.toLocaleString() })
  return { title: `Level ${at.level}`, subtitle: formatDateTime(ts), rows }
}

/**
 * AA gained over time. The note is mandatory and repeats the panel's caption: this curve is
 * Σ of the gain LINES, so a respec's re-gained points are counted again and it runs ahead of
 * the earned headline (world-model law 5). A hover readout is read in isolation — calling
 * this "earned" here would contradict `computeAAAccounting`.
 */
function aaContent(points: readonly AaPoint[], ts: number, gainIdx: number): Content | null {
  const i = stepIndexAt(points, ts)
  if (i < 0) return null
  const rows: TooltipRow[] = []
  if (gainIdx >= 0) {
    const p = points[gainIdx]
    const gained = p.y - (gainIdx > 0 ? points[gainIdx - 1].y : 0)
    rows.push({
      label: `+${gained} AA`,
      value: p.nowHave != null ? `${p.nowHave} unspent at the time` : formatDateTime(p.ts)
    })
  }
  return {
    title: `${points[i].y.toLocaleString()} AA gained`,
    subtitle: formatDateTime(ts),
    rows,
    note: 'cumulative gain lines — includes points re-gained after a respec'
  }
}

/** Same pick AND the cursor has not really moved ⇒ there is nothing new to draw. */
function samePick(prev: Hover | null, next: Hover): boolean {
  if (!prev) return false
  return (
    prev.key === next.key &&
    Math.abs(prev.x - next.x) < MOVE_EPS_PX &&
    Math.abs(prev.y - next.y) < MOVE_EPS_PX
  )
}

/** Identity of the current pick. Deliberately coarse — it changes only when the tooltip's
 *  SUBJECT changes, which is what makes most moves free. The zone is part of that subject:
 *  a boundary can be crossed inside the 2px move gate, and a stale zone name would be a
 *  lie rather than a missed repaint. */
function pickKey(at: LevelAt | null, gainIdx: number, zone: string): string {
  if (!at) return `aa:${gainIdx}|${zone}`
  if (at.kind === 'level') return `level:${at.sinceTs}|${zone}`
  if (at.kind === 'swap-gap') return `gap:${at.beforeLevel}|${zone}`
  return `before-first|${zone}`
}

/**
 * The zone row, prepended to whatever the chart's own readout says. Tinted with the band's
 * own hue (`zoneColor`), so the name and the stripe above the cursor are visibly the same
 * thing — the legend stays as the hover-free path, unchanged.
 *
 * No band covering the cursor ⇒ no row at all. The zone column is capped, so "before the
 * strip starts" means the log no longer says where you were; naming the nearest zone would
 * be a guess (world-model law 1).
 */
function withZone(content: Content, bands: readonly ZoneBand[], ts: number): Content {
  const band = zoneAt(bands, ts)
  if (!band) return content
  return { ...content, rows: [{ label: 'zone', value: band.name, color: zoneColor(band.key) }, ...content.rows] }
}

export function LevelHoverLayer({
  scale,
  height,
  color,
  aaPoints,
  bands,
  segments,
  suppressed = false
}: LevelHoverLayerProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [hov, setHov] = useState<Hover | null>(null)
  const lastRef = useRef<Hover | null>(null)

  // Change gate: identical pick + a sub-2px move costs zero React work.
  const commit = useCallback((next: Hover | null): void => {
    if (next === null ? lastRef.current === null : samePick(lastRef.current, next)) return
    lastRef.current = next
    setHov(next)
  }, [])

  const onFrame = useMemo(
    () =>
      rafThrottle((cx: number, cy: number) => {
        const el = rootRef.current
        if (!el) return
        const r = el.getBoundingClientRect()
        if (r.width <= 0) return
        const x = cx - r.left
        const ts = tOf(scale, pxToUser(x, r.width, scale.w))
        // Tolerance is stated in px and converted to ms through the same stretched mapping,
        // so it stays 6 screen px whatever width the panel happens to be.
        const tolMs = Math.abs(tOf(scale, pxToUser(x + GAIN_TOL_PX, r.width, scale.w)) - ts)
        const gi = stepIndexAt(aaPoints, ts + tolMs)
        const gainIdx = gi >= 0 && Math.abs(aaPoints[gi].ts - ts) <= tolMs ? gi : -1
        const at = segments ? levelAt(segments, ts) : null
        const bounds = { w: r.width, h: r.height }
        commit({ ts, x, y: cy - r.top, bounds, gainIdx, key: pickKey(at, gainIdx, zoneAt(bands, ts)?.key ?? '') })
      }),
    [scale, aaPoints, bands, segments, commit]
  )

  useEffect(() => () => { onFrame.cancel() }, [onFrame])

  const handleMove = (ev: PointerEvent<HTMLDivElement>): void => {
    // A held button means someone else owns this pointer (pan today, range-select tomorrow).
    if (suppressed || ev.buttons !== 0) {
      onFrame.cancel()
      commit(null)
      return
    }
    onFrame(ev.clientX, ev.clientY)
  }
  const handleLeave = (): void => {
    onFrame.cancel()
    commit(null)
  }

  const content = useMemo(() => {
    if (!hov) return null
    const base = segments ? levelContent(segments, aaPoints, hov.ts) : aaContent(aaPoints, hov.ts, hov.gainIdx)
    return base && withZone(base, bands, hov.ts)
  }, [hov, segments, aaPoints, bands])

  return (
    <div ref={rootRef} style={ROOT} onPointerMove={handleMove} onPointerLeave={handleLeave}>
      {hov && (
        <svg
          style={CROSSHAIR}
          width="100%"
          height="100%"
          viewBox={`0 0 ${scale.w} ${height}`}
          preserveAspectRatio="none"
        >
          <line
            x1={pxToUser(hov.x, hov.bounds.w, scale.w)}
            y1={0}
            x2={pxToUser(hov.x, hov.bounds.w, scale.w)}
            y2={height}
            stroke={color}
            strokeWidth={1}
            strokeDasharray="3 4"
            opacity={0.5}
          />
        </svg>
      )}
      {hov && content && (
        <div style={TIP_LAYER}>
          <ChartTooltip {...content} x={hov.x} y={hov.y} bounds={hov.bounds} />
        </div>
      )}
    </div>
  )
}
