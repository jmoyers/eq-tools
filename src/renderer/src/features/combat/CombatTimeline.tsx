import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, IconButton, Paper, Stack, Tooltip as MuiTooltip, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import FitScreenIcon from '@mui/icons-material/FitScreen'
import type { TimelineEvent, TimelineView } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'
import { formatNum as fmt } from '../../lib/formatRate'
import { CAT_COLOR, RESIST_COLOR } from './combatShared'

// Dense, dark, WarcraftLogs-style timeline (Task #51 v2): X = encounter time, Y = one row
// per skill/spell (left-axis labels), ticks where events occurred. Stance/invocation spans
// are pinned above the skill lanes. SVG render (crisp at any zoom, cheap hover).
//
// INTERACTIONS (Task #51 v2):
//   - Mouse WHEEL over the plot zooms around the cursor's time point (anchored zoom).
//   - SHIFT + wheel pans left/right; drag-to-pan too.
//   - +/− buttons zoom around the current center; "Fit" resets to the full encounter.
//   - Starts fit to the whole encounter.
//   - Hover tooltip on every tick: ability · amount · modifiers · target · time (and for
//     miss/resist ticks: the outcome type + who resisted/avoided).
// Zoom/pan is a renderer-side view window [start,end] in ms; only ticks inside the window
// render (windowed by visible time range) so the SVG stays cheap at the 5k ring cap.

// Category colors + the miss/resist tint come from combatShared — ONE source, so the timeline
// lane stripe, the drill-down bar and the overlay can never disagree about what 'slay' looks
// like (it used to keep a private copy, which is how slay stayed melee-gold here).
const KIND_OPACITY: Record<string, number> = { you: 1, pet: 0.75, enemy: 0.5 }

// Timeline sizing (Task #54): the chart FILLS its container. Width comes from a ResizeObserver on
// the scroll box; lane height grows to use the available vertical space (min MIN_LANE_H for
// readability, up to MAX_LANE_H) and only scrolls when lanes×min exceeds the container. Fonts/ticks
// scale with lane height so the chart reads as the hero of the view at large sizes.
const MIN_LANE_H = 22
const MAX_LANE_H = 40
const PIN_H = 16
const PAD = 8
const MIN_PLOT_W = 320
const MIN_SPAN_MS = 500 // deepest zoom: half a second across the plot
const ZOOM_STEP = 1.35 // per wheel notch / button click

/** Left-axis label gutter width + font size, scaled up a touch at larger lane heights. */
function labelGutter(laneH: number): number {
  return laneH >= 32 ? 168 : laneH >= 26 ? 148 : 132
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function fmtClock(ms: number): string {
  // finer-grained axis label at deep zoom (m:ss.d)
  const s = Math.max(0, ms / 1000)
  const m = Math.floor(s / 60)
  const rem = s - m * 60
  return `${m}:${rem.toFixed(rem < 10 ? 1 : 0).padStart(rem < 10 ? 4 : 2, '0')}`
}
interface Hover {
  x: number
  y: number
  lines: string[]
}

/** The visible time window into the encounter, in ms. */
interface ViewWin {
  start: number
  end: number
}

function tickTooltip(e: TimelineEvent): string[] {
  const who = e.kind === 'you' ? 'You' : e.kind === 'pet' ? 'Pet' : 'Enemy'
  if (e.outcome === 'resist') {
    return [
      `${e.lane} — RESISTED`,
      `${e.target ?? '?'} resisted ${who === 'You' ? 'your' : who === 'Pet' ? "pet's" : 'the'} spell`,
      fmtDur(e.t)
    ]
  }
  if (e.outcome === 'miss') {
    return [`${e.lane} — ${(e.detail ?? 'miss').toUpperCase()}`, `${who} vs ${e.target ?? '?'}`, fmtDur(e.t)]
  }
  const mods = e.modifiers && e.modifiers.length ? ` · ${e.modifiers.join(' ')}` : ''
  return [
    `${e.lane}${e.crit ? ' · CRIT' : ''}`,
    `${fmt(e.amount)}${mods}${e.target ? ` → ${e.target}` : ''}`,
    `${who} · ${fmtDur(e.t)}`
  ]
}

function CombatTimelineInner({ tl }: { tl: TimelineView }): JSX.Element {
  const [hover, setHover] = useState<Hover | null>(null)
  const dur = Math.max(1, tl.durationMs)
  const fullView = useMemo<ViewWin>(() => ({ start: 0, end: dur }), [dur])
  const [view, setView] = useState<ViewWin>(fullView)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<{ x: number; start: number; end: number } | null>(null)
  // Measure the scroll container (Task #54): the SVG width fills it, and lane height grows to use
  // the available vertical space. A ResizeObserver keeps it responsive to window/pane resizes.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [wrap, setWrap] = useState({ w: 900, h: 400 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) setWrap({ w: Math.max(MIN_PLOT_W + 140, cr.width), h: Math.max(120, cr.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Reset to fit whenever the selected encounter changes (id or duration).
  useEffect(() => setView({ start: 0, end: dur }), [tl.id, dur])

  const span = Math.max(MIN_SPAN_MS, view.end - view.start)

  // Lane index by label (Y position). Lanes are pre-sorted (category, total desc) by the
  // engine; keep that order top→bottom.
  const laneIndex = useMemo(() => {
    const m = new Map<string, number>()
    tl.lanes.forEach((l, i) => m.set(l.lane, i))
    return m
  }, [tl.lanes])

  const pinRows = useMemo(() => {
    const groups: Array<'stance' | 'invocation'> = []
    if (tl.stanceSpans.some((s) => s.group === 'stance')) groups.push('stance')
    if (tl.stanceSpans.some((s) => s.group === 'invocation')) groups.push('invocation')
    return groups
  }, [tl.stanceSpans])

  const pinBlockH = pinRows.length * (PIN_H + 2)
  const pinGap = pinBlockH ? 6 : 0
  const AXIS_H = 22
  const laneCount = Math.max(1, tl.lanes.length)
  // Grow lane height to fill the vertical space left after pins + axis; clamp to [MIN,MAX].
  // Below MIN (many lanes) the chart exceeds the container and the wrapper scrolls.
  const availLaneH = wrap.h - pinBlockH - pinGap - AXIS_H
  const LANE_H = Math.max(MIN_LANE_H, Math.min(MAX_LANE_H, Math.floor(availLaneH / laneCount)))
  const LABEL_W = labelGutter(LANE_H)
  const PLOT_W = Math.max(MIN_PLOT_W, wrap.w - LABEL_W - PAD * 2)
  // Font sizes scale with lane height so ticks + labels read well when the chart is the hero.
  const labelFont = LANE_H >= 32 ? 13 : LANE_H >= 26 ? 12 : 10
  const axisFont = LANE_H >= 32 ? 12 : 10
  // Max lane-label chars before ellipsis, scaled to the (wider) gutter at larger sizes.
  const labelMax = LABEL_W >= 168 ? 26 : LABEL_W >= 148 ? 23 : 20
  // Damage-tick base width scales slightly with lane height so ticks stay visible when big.
  const tickW = LANE_H >= 32 ? 3 : 2
  const plotH = laneCount * LANE_H
  const totalH = pinBlockH + pinGap + plotH + AXIS_H

  // Map an encounter-relative ms `t` to a pixel X within the plot, given the view window.
  const xOf = useCallback(
    (t: number): number => LABEL_W + ((t - view.start) / span) * PLOT_W,
    [view.start, span, LABEL_W, PLOT_W]
  )
  // Inverse: pixel X (relative to the plot's left edge = LABEL_W) → encounter ms.
  const tOfPx = useCallback((px: number): number => view.start + (px / PLOT_W) * span, [view.start, span, PLOT_W])

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
      const px = ev.clientX - rect.left - LABEL_W
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
      const anchor = tOfPx(Math.max(0, Math.min(PLOT_W, px)))
      const factor = ev.deltaY < 0 ? 1 / ZOOM_STEP : ZOOM_STEP
      zoomAround(anchor, factor)
      ev.preventDefault()
    },
    [tOfPx, zoomAround, clampView, LABEL_W, PLOT_W]
  )

  // Attach the wheel handler NATIVELY as a NON-PASSIVE listener — React's onWheel is passive
  // by default, so ev.preventDefault() there is a no-op (and warns), letting the container
  // scroll instead of zoom. A native { passive: false } listener lets us claim the wheel.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onWheel])

  // Drag-to-pan (pointer). Trivial + handy once zoomed.
  const onPointerDown = useCallback(
    (ev: React.PointerEvent<SVGSVGElement>) => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect) return
      const px = ev.clientX - rect.left
      if (px < LABEL_W) return // don't start a drag in the label gutter
      dragRef.current = { x: ev.clientX, start: view.start, end: view.end }
      svgRef.current?.setPointerCapture(ev.pointerId)
    },
    [view.start, view.end, LABEL_W]
  )
  const onPointerMove = useCallback(
    (ev: React.PointerEvent<SVGSVGElement>) => {
      const d = dragRef.current
      if (!d) return
      const dxPx = ev.clientX - d.x
      const dtMs = -(dxPx / PLOT_W) * (d.end - d.start)
      setView(clampView(d.start + dtMs, d.end + dtMs))
    },
    [clampView, PLOT_W]
  )
  const onPointerUp = useCallback((ev: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null
    svgRef.current?.releasePointerCapture(ev.pointerId)
  }, [])

  const zoomedIn = span < dur - 1

  // Axis ticks: ~6 evenly spaced across the VISIBLE window.
  const ticks = useMemo(() => {
    const n = 6
    return Array.from({ length: n + 1 }, (_, i) => view.start + (span * i) / n)
  }, [view.start, span])

  // Windowed rendering: only ticks whose time falls within the visible window (a small
  // margin so ticks at the edge still draw). At the 5k ring cap + downsample budget this
  // keeps the DOM node count low even at full zoom-out.
  const visibleEvents = useMemo(
    () => tl.events.filter((e) => e.t >= view.start - 1 && e.t <= view.end + 1),
    [tl.events, view.start, view.end]
  )

  return (
    <Paper variant="outlined" sx={{ p: 1.5, flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle1" noWrap>
          {tl.name} · timeline
        </Typography>
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
            {zoomedIn ? `${fmtDur(view.start)}–${fmtDur(view.end)} of ` : ''}
            {fmtDur(tl.durationMs)} · {tl.lanes.length} lanes ·{' '}
            {/* The count after "of" is the fight's TRUE instant count (totalCount), so a ring
                that overflowed its drop-oldest cap reports what it LOST, not its own size. */}
            {tl.downsampled || tl.truncated
              ? `${tl.events.length} of ${tl.totalCount} events`
              : `${tl.totalCount} events`}
          </Typography>
          <MuiTooltip title="Zoom out">
            <span>
              <IconButton size="small" onClick={() => zoomAround((view.start + view.end) / 2, ZOOM_STEP)} disabled={!zoomedIn}>
                <RemoveIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </MuiTooltip>
          <MuiTooltip title="Zoom in">
            <span>
              <IconButton size="small" onClick={() => zoomAround((view.start + view.end) / 2, 1 / ZOOM_STEP)} disabled={span <= MIN_SPAN_MS}>
                <AddIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </MuiTooltip>
          <MuiTooltip title="Reset to fit">
            <span>
              <IconButton size="small" onClick={() => setView({ start: 0, end: dur })} disabled={!zoomedIn}>
                <FitScreenIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </span>
          </MuiTooltip>
        </Stack>
      </Stack>
      <Box ref={wrapRef} sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <svg
          ref={svgRef}
          width={LABEL_W + PLOT_W + PAD}
          height={totalH + PAD}
          style={{ display: 'block', fontFamily: 'inherit', cursor: zoomedIn ? 'grab' : 'default', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onMouseLeave={() => setHover(null)}
        >
          {/* clip the plot so ticks/spans don't draw over the label gutter when panning */}
          <defs>
            <clipPath id="tl-plot-clip">
              <rect x={LABEL_W} y={0} width={PLOT_W + 1} height={totalH + PAD} />
            </clipPath>
          </defs>

          {/* pinned stance / invocation spans */}
          <g clipPath="url(#tl-plot-clip)">
            {pinRows.map((group, gi) => {
              const y = gi * (PIN_H + 2)
              return (
                <g key={group}>
                  {tl.stanceSpans
                    .filter((s) => s.group === group)
                    .map((s, i) => {
                      const x1 = xOf(s.start)
                      const x2 = Math.max(x1 + 2, xOf(s.end))
                      return (
                        <g key={i}>
                          <rect
                            x={x1}
                            y={y + 1}
                            width={x2 - x1}
                            height={PIN_H - 2}
                            rx={2}
                            fill={group === 'stance' ? 'rgba(217,178,95,0.35)' : 'rgba(169,143,224,0.35)'}
                            stroke={group === 'stance' ? '#d9b25f' : '#a98fe0'}
                            strokeWidth={0.5}
                            onMouseEnter={() =>
                              setHover({
                                x: Math.max(LABEL_W, (x1 + x2) / 2),
                                y: y + PIN_H,
                                lines: [`${group}: ${s.name}`, `${fmtDur(s.start)}–${fmtDur(s.end)}`]
                              })
                            }
                          />
                          {x2 - x1 > 30 && (
                            <text x={Math.max(LABEL_W + 3, x1 + 3)} y={y + PIN_H - 4} fontSize={9} fill="#e6e6e6" style={{ pointerEvents: 'none' }}>
                              {s.name}
                            </text>
                          )}
                        </g>
                      )
                    })}
                </g>
              )
            })}
          </g>
          {/* pin-row labels (outside the clip, in the gutter) */}
          {pinRows.map((group, gi) => (
            <text key={group} x={4} y={gi * (PIN_H + 2) + PIN_H - 4} fontSize={10} fill="#9aa0aa">
              {group === 'stance' ? 'Stance' : 'Invocation'}
            </text>
          ))}

          {/* lane labels + gridlines */}
          <g transform={`translate(0, ${pinBlockH + (pinBlockH ? 6 : 0)})`}>
            {tl.lanes.map((l, i) => {
              const y = i * LANE_H
              return (
                <g key={l.lane}>
                  <rect x={LABEL_W} y={y} width={PLOT_W} height={LANE_H} fill={i % 2 ? 'rgba(255,255,255,0.02)' : 'transparent'} />
                  <text x={LABEL_W - 6} y={y + LANE_H / 2 + labelFont / 2 - 2} fontSize={labelFont} textAnchor="end" fill="#c8c8c8">
                    <title>{`${CATEGORY_LABEL[l.category]} · ${fmt(l.total)} total`}</title>
                    {l.lane.length > labelMax ? l.lane.slice(0, labelMax - 1) + '…' : l.lane}
                  </text>
                  <rect x={LABEL_W - 3} y={y + 3} width={2} height={LANE_H - 6} fill={CAT_COLOR[l.category]} opacity={0.8} />
                </g>
              )
            })}

            {/* event ticks (windowed to the visible time range) */}
            <g clipPath="url(#tl-plot-clip)" transform={`translate(0, ${-(pinBlockH + (pinBlockH ? 6 : 0))})`}>
              <g transform={`translate(0, ${pinBlockH + (pinBlockH ? 6 : 0)})`}>
                {visibleEvents.map((e, i) => {
                  const lane = laneIndex.get(e.lane)
                  if (lane === undefined) return null
                  const x = xOf(e.t)
                  const y = lane * LANE_H
                  const isAvoid = e.outcome === 'miss' || e.outcome === 'resist'
                  const h = e.crit ? LANE_H - 2 : LANE_H - 8
                  const onEnter = (): void => setHover({ x: Math.max(LABEL_W, x), y: y + LANE_H, lines: tickTooltip(e) })
                  if (isAvoid) {
                    // Hollow, red-tinted mark: an open circle for a resist, a thin hollow
                    // bar for a miss — visually distinct from the solid damage ticks.
                    if (e.outcome === 'resist') {
                      return (
                        <circle
                          key={i}
                          cx={x}
                          cy={y + LANE_H / 2}
                          r={3}
                          fill="none"
                          stroke={RESIST_COLOR}
                          strokeWidth={1.2}
                          onMouseEnter={onEnter}
                        />
                      )
                    }
                    return (
                      <rect
                        key={i}
                        x={x - 1}
                        y={y + 3}
                        width={2}
                        height={LANE_H - 6}
                        fill="none"
                        stroke={RESIST_COLOR}
                        strokeWidth={0.9}
                        opacity={0.85}
                        onMouseEnter={onEnter}
                      />
                    )
                  }
                  return (
                    <rect
                      key={i}
                      x={x}
                      y={y + (LANE_H - h) / 2}
                      width={e.crit ? tickW + 1 : tickW}
                      height={h}
                      fill={CAT_COLOR[e.category]}
                      opacity={KIND_OPACITY[e.kind] ?? 0.7}
                      onMouseEnter={onEnter}
                    />
                  )
                })}
              </g>
            </g>
          </g>

          {/* time axis */}
          <g transform={`translate(0, ${pinBlockH + (pinBlockH ? 6 : 0) + plotH})`}>
            <line x1={LABEL_W} y1={2} x2={LABEL_W + PLOT_W} y2={2} stroke="rgba(255,255,255,0.15)" />
            {ticks.map((t, i) => (
              <text key={i} x={xOf(t)} y={16} fontSize={axisFont} textAnchor="middle" fill="#9aa0aa">
                {zoomedIn ? fmtClock(t) : fmtDur(t)}
              </text>
            ))}
          </g>
        </svg>

        {hover && (
          <Box
            sx={{
              position: 'absolute',
              left: Math.min(hover.x + 8, LABEL_W + PLOT_W - 170),
              top: hover.y + 4,
              bgcolor: 'rgba(20,20,24,0.96)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 0.5,
              px: 0.75,
              py: 0.25,
              pointerEvents: 'none',
              zIndex: 5,
              maxWidth: 260
            }}
          >
            {hover.lines.map((ln, i) => (
              <Typography
                key={i}
                variant="caption"
                sx={{ whiteSpace: 'nowrap', display: 'block', color: i === 0 ? 'text.primary' : 'text.secondary', fontWeight: i === 0 ? 600 : 400 }}
              >
                {ln}
              </Typography>
            ))}
          </Box>
        )}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
        Scroll to zoom around the cursor · Shift+scroll or drag to pan · hollow red = miss/resist
      </Typography>
    </Paper>
  )
}

export const CombatTimeline = memo(CombatTimelineInner)
