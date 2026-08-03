import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Box, IconButton, Paper, Stack, Tooltip as MuiTooltip, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import FitScreenIcon from '@mui/icons-material/FitScreen'
import type { TimelineView } from '@shared/combat'
import { EventTicks, HoverCard, LaneRows, PinLabels, PinSpans, TimeAxis } from './TimelineChart'
import {
  MIN_PLOT_W,
  MIN_SPAN_MS,
  PAD,
  ZOOM_STEP,
  fmtDur,
  timelineMetrics,
  type Hover,
  type WrapSize
} from './timelineGeometry'
import { useTimelineViewport, type TimelineViewport } from './useTimelineViewport'

// Dense, dark, WarcraftLogs-style timeline (Task #51 v2): X = encounter time, Y = one row
// per skill/spell (left-axis labels), ticks where events occurred. Stance/invocation spans
// are pinned above the skill lanes. SVG render (crisp at any zoom, cheap hover).
//
// The three halves live in their own modules: `timelineGeometry.ts` (sizing + tooltip text),
// `useTimelineViewport.ts` (the zoom/pan window and its wheel/drag interactions) and
// `TimelineChart.tsx` (the SVG parts). What is left here is the chart's frame.

/** Measure the scroll container so the SVG fills it, responsively (Task #54). */
function useWrapSize(ref: React.RefObject<HTMLDivElement>): WrapSize {
  const [wrap, setWrap] = useState<WrapSize>({ w: 900, h: 400 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (cr) setWrap({ w: Math.max(MIN_PLOT_W + 140, cr.width), h: Math.max(120, cr.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return wrap
}

/** Title + the counts + the three zoom controls. */
function TimelineToolbar({ tl, vp }: { tl: TimelineView; vp: TimelineViewport }): React.JSX.Element {
  const { view, span, zoomedIn } = vp
  return (
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
            <IconButton size="small" onClick={() => vp.zoomAround((view.start + view.end) / 2, ZOOM_STEP)} disabled={!zoomedIn}>
              <RemoveIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </MuiTooltip>
        <MuiTooltip title="Zoom in">
          <span>
            <IconButton size="small" onClick={() => vp.zoomAround((view.start + view.end) / 2, 1 / ZOOM_STEP)} disabled={span <= MIN_SPAN_MS}>
              <AddIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </MuiTooltip>
        <MuiTooltip title="Reset to fit">
          <span>
            <IconButton size="small" onClick={vp.fit} disabled={!zoomedIn}>
              <FitScreenIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </MuiTooltip>
      </Stack>
    </Stack>
  )
}

function CombatTimelineInner({ tl }: { tl: TimelineView }): React.JSX.Element {
  const [hover, setHover] = useState<Hover | null>(null)
  const dur = Math.max(1, tl.durationMs)
  const svgRef = useRef<SVGSVGElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const wrap = useWrapSize(wrapRef)
  const m = timelineMetrics(tl, wrap)
  const vp = useTimelineViewport({ dur, id: tl.id, svgRef, labelW: m.labelW, plotW: m.plotW })
  const { view, span, zoomedIn, xOf } = vp

  // Lane index by label (Y position). Lanes are pre-sorted (category, total desc) by the
  // engine; keep that order top→bottom.
  const laneIndex = useMemo(() => {
    const map = new Map<string, number>()
    tl.lanes.forEach((l, i) => map.set(l.lane, i))
    return map
  }, [tl.lanes])

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
      <TimelineToolbar tl={tl} vp={vp} />
      <Box ref={wrapRef} sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0, position: 'relative' }}>
        <svg
          ref={svgRef}
          width={m.labelW + m.plotW + PAD}
          height={m.totalH + PAD}
          style={{ display: 'block', fontFamily: 'inherit', cursor: zoomedIn ? 'grab' : 'default', touchAction: 'none' }}
          onPointerDown={vp.onPointerDown}
          onPointerMove={vp.onPointerMove}
          onPointerUp={vp.onPointerUp}
          onMouseLeave={() => setHover(null)}
        >
          {/* clip the plot so ticks/spans don't draw over the label gutter when panning */}
          <defs>
            <clipPath id="tl-plot-clip">
              <rect x={m.labelW} y={0} width={m.plotW + 1} height={m.totalH + PAD} />
            </clipPath>
          </defs>

          {/* pinned stance / invocation spans */}
          <g clipPath="url(#tl-plot-clip)">
            <PinSpans tl={tl} m={m} xOf={xOf} setHover={setHover} />
          </g>
          {/* pin-row labels (outside the clip, in the gutter) */}
          <PinLabels pinRows={m.pinRows} />

          {/* lane labels + gridlines */}
          <g transform={`translate(0, ${m.laneTop})`}>
            <LaneRows tl={tl} m={m} />

            {/* event ticks (windowed to the visible time range) */}
            <g clipPath="url(#tl-plot-clip)" transform={`translate(0, ${-m.laneTop})`}>
              <g transform={`translate(0, ${m.laneTop})`}>
                <EventTicks events={visibleEvents} laneIndex={laneIndex} m={m} xOf={xOf} setHover={setHover} />
              </g>
            </g>
          </g>

          {/* time axis */}
          <g transform={`translate(0, ${m.laneTop + m.plotH})`}>
            <TimeAxis ticks={ticks} m={m} xOf={xOf} zoomedIn={zoomedIn} />
          </g>
        </svg>

        {hover && <HoverCard hover={hover} m={m} />}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
        Scroll to zoom around the cursor · Shift+scroll or drag to pan · hollow red = miss/resist
      </Typography>
    </Paper>
  )
}

export const CombatTimeline = memo(CombatTimelineInner)
