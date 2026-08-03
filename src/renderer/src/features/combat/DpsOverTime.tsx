// The DPS-over-time CARD, whole: header stats, the three curves, the marker ticks, the elapsed
// axis, the legend, and the hover layer that reads the drawing backwards.
//
// It lives in its own file because TWO surfaces render it now — the Combat dashboard's 2x2 grid
// and the Overview tab's glance row. The ONE-source rule (AGENTS.md) applies to the whole chart,
// not just its colors: a second copy would drift in exactly the places that matter least visibly
// (which marker kinds get a legend entry, whether the peak is `~`-prefixed, where the hover dot
// sits) and most honestly. So the card is extracted, not forked, and `DpsChartCard`
// (CombatDashboard.tsx) is now a thin wrapper over it with the same testid and the same layout.
//
// COMPACT is the only thing the two callers differ on — see the prop's comment for exactly what
// it drops. It never changes the CURVE: same geometry, same markers, same hover, same numbers.
//
// Everything here is cheap inline SVG (no chart libs) and every derivation is a single pass in
// `dashboardData.ts`/`dpsChart.ts`; the memos are keyed on the timeline's IDENTITY, which the
// Combat tab stabilises so a frozen finalized fight doesn't re-derive on every 1s snapshot tick.

import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import { Box, Stack, Tooltip, Typography } from '@mui/material'
import type { TimelineView } from '@shared/combat'
import { formatRate } from '../../lib/formatRate'
import { ApproxChip, DashCard, QuietNote, fmtDur } from './combatShared'
import { approxNote, buildDpsSeries, type DpsSeries } from './dashboardData'
import { CHART_H, CHART_W, PAD_B, PAD_T, buildDpsChart, placeMarkers, type DpsChart, type PlacedMarker } from './dpsChart'
import { DpsCurveHoverLayer, type CurveHoverHandle } from './DpsCurveHoverLayer'
import { MARKER_COLOR, MARKER_WORD } from './markerStyle'

const OUT_COLOR = '#d9b25f'
const PET_COLOR = '#6fb3d2'
const INC_COLOR = '#cf6679'

/**
 * The card header's right slot: the inexact-ring chip (ONE chip for both event-ring losses —
 * downsample and/or drop-oldest truncation; the note carries the TRUE instant count, so an
 * overflowed ring can't advertise its own capacity) and the visible-window peak.
 */
function ChartHeaderStats({
  tl,
  series,
  chart
}: {
  tl: TimelineView | null
  series: DpsSeries | null
  chart: DpsChart | null
}): React.JSX.Element | null {
  if (!tl || !series || !chart) return null
  const note = approxNote(tl)
  return (
    <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ minWidth: 0 }}>
      {note && <ApproxChip shown={note.shown} raw={note.of} truncated={note.truncated} />}
      <Tooltip title={`Peak ${Math.round(series.smoothMs / 1000)}s rolling outgoing rate in the visible window.`}>
        <Typography variant="caption" sx={{ color: OUT_COLOR, whiteSpace: 'nowrap' }}>
          {series.estimated ? '~' : ''}
          {formatRate(chart.peakVis)} peak
        </Typography>
      </Tooltip>
    </Stack>
  )
}

/** The three curves + the marker ticks + the y-max readout, in one SVG, under a hover layer. */
function DpsCurve({
  chart,
  series,
  markers,
  startTs,
  a
}: {
  chart: DpsChart
  series: DpsSeries
  markers: PlacedMarker[]
  startTs: number
  a: string
}): React.JSX.Element {
  const hoverRef = useRef<CurveHoverHandle>(null)
  // HOVER / DRAG SEAM (§7.1): a bare pointermove only. `buttons` is non-zero throughout a drag,
  // so bailing on it keeps the readout out of the way of any future drag interaction here — and
  // of a text selection dragged across the card — with no shared "isDragging" state.
  const onHoverMove = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    if (ev.buttons !== 0) {
      hoverRef.current?.clear()
      return
    }
    const r = ev.currentTarget.getBoundingClientRect()
    hoverRef.current?.move(ev.clientX - r.left, ev.clientY - r.top, r.width)
  }, [])
  const onHoverLeave = useCallback(() => hoverRef.current?.clear(), [])

  return (
    // flexShrink 0 on every strip: in a short grid cell the card body scrolls, it never
    // squashes the curve into an unreadable sliver.
    <Box sx={{ position: 'relative', flexShrink: 0 }} onPointerMove={onHoverMove} onPointerLeave={onHoverLeave}>
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        width="100%"
        height={CHART_H}
        preserveAspectRatio="none"
        style={{ display: 'block' }}
      >
        <polygon points={chart.outArea} fill={OUT_COLOR} opacity={0.16} />
        {chart.incLine && (
          <polyline
            points={chart.incLine}
            fill="none"
            stroke={INC_COLOR}
            strokeWidth={1}
            opacity={0.5}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {chart.petLine && (
          <polyline
            points={chart.petLine}
            fill="none"
            stroke={PET_COLOR}
            strokeWidth={1.2}
            opacity={0.85}
            vectorEffect="non-scaling-stroke"
          />
        )}
        <polyline
          points={chart.outLine}
          fill="none"
          stroke={OUT_COLOR}
          strokeWidth={1.8}
          vectorEffect="non-scaling-stroke"
        />
        {/* Markers LAST so a tick is never buried under the area fill. */}
        <MarkerTicks markers={markers} />
      </svg>
      <Typography
        variant="caption"
        sx={{ position: 'absolute', top: 0, left: 2, color: 'text.disabled', pointerEvents: 'none' }}
      >
        {a}
        {formatRate(chart.yMax)}
      </Typography>
      <DpsCurveHoverLayer api={hoverRef} chart={chart} series={series} markers={markers} startTs={startTs} />
    </Box>
  )
}

/** The ticks carry NO native `<title>`: the hover layer describes them now, and two tooltips for
 *  one mark is worse than one (the native one also can't say what the rate was at that instant). */
function MarkerTicks({ markers }: { markers: PlacedMarker[] }): React.JSX.Element {
  return (
    <>
      {markers.map(({ m, x }, i) => (
        <g key={`${m.kind}|${m.t}|${i}`} opacity={0.9}>
          <line
            x1={x}
            x2={x}
            y1={PAD_T - 4}
            y2={CHART_H - PAD_B}
            stroke={MARKER_COLOR[m.kind]}
            strokeWidth={1}
            strokeDasharray={m.kind === 'slow' ? undefined : '2 2'}
            vectorEffect="non-scaling-stroke"
          />
          {/* The slow tick is the outcome the tab exists to show, so it also flies a
              flag — solid line + pennant, unmistakable against the dashed settings. */}
          {m.kind === 'slow' && (
            <polygon
              points={`${x.toFixed(1)},${PAD_T - 4} ${(x + 7).toFixed(1)},${PAD_T - 1} ${x.toFixed(1)},${PAD_T + 2}`}
              fill={MARKER_COLOR.slow}
            />
          )}
        </g>
      ))}
    </>
  )
}

/** The four evenly-spaced elapsed labels under the curve. */
function ChartAxis({ chart }: { chart: DpsChart }): React.JSX.Element {
  return (
    <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.25, flexShrink: 0 }}>
      {[0, 1, 2, 3].map((k) => (
        <Typography key={k} variant="caption" color="text.disabled">
          {fmtDur((chart.startMs + ((chart.endMs - chart.startMs) * k) / 3) / 1000)}
        </Typography>
      ))}
    </Stack>
  )
}

function ChartLegend({
  series,
  chart,
  markers
}: {
  series: DpsSeries
  chart: DpsChart
  markers: PlacedMarker[]
}): React.JSX.Element {
  return (
    <Stack
      direction="row"
      spacing={1.25}
      alignItems="center"
      sx={{ mt: 0.25, flexShrink: 0 }}
      flexWrap="wrap"
      useFlexGap
    >
      <Legend color={OUT_COLOR} label="you + pet" />
      {series.hasPet && <Legend color={PET_COLOR} label="pet" />}
      {series.hasInc && <Legend color={INC_COLOR} label="incoming" />}
      {/* One legend entry per marker KIND actually present — an always-on legend for four
          kinds would spend the strip explaining ticks the fight never had. */}
      {(['slow', 'coat', 'stance', 'invocation'] as const)
        .filter((k) => markers.some(({ m }) => m.kind === k))
        .map((k) => (
          <Legend key={k} color={MARKER_COLOR[k]} label={MARKER_WORD[k]} />
        ))}
      <Box sx={{ flexGrow: 1 }} />
      <Typography variant="caption" color="text.disabled" noWrap>
        {Math.round(series.smoothMs / 1000)}s rolling
        {chart.scrolling ? ' · last 2:00' : ''}
      </Typography>
    </Stack>
  )
}

function Legend({ color, label }: { color: string; label: string }): React.JSX.Element {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Box sx={{ width: 10, height: 3, borderRadius: 1, bgcolor: color }} />
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  )
}

export interface DpsOverTimeProps {
  tl: TimelineView | null
  /** a GENUINELY live selection — only then does the visible window follow `now`. */
  live: boolean
  /** What to say when there is no per-event ring at all. The caller owns this sentence because
   *  the two surfaces have different reasons to be empty: Combat knows WHY the ring is missing
   *  (zone session / evicted fight), Overview only knows there are no fights yet. */
  noRing: ReactNode
  /**
   * GLANCE mode. Drops the LEGEND strip and nothing else — the curve, its markers, the y-max
   * readout, the header stats and the whole hover layer are identical. The elapsed axis stays:
   * without it the chart would have no time scale at all, and an unlabelled x is the one thing a
   * DPS curve can't be honest without. The legend is affordable to lose because the hover names
   * every marker it would have explained, and the glance surface links to the full card.
   */
  compact?: boolean
  title?: string
  testId?: string
  /** Grid-cell mode (see DashCard): 100% of the cell, body scrolls internally. */
  fill?: boolean
}

/**
 * Smoothed damage rate over encounter time. For the LIVE fight the window follows `now`
 * (the last 2 minutes) and advances on the view's existing snapshot cadence — there is no
 * timer here. For a finalized fight the whole encounter is drawn statically.
 */
export function DpsOverTime({
  tl,
  live,
  noRing,
  compact,
  title = 'DPS over time',
  testId,
  fill
}: DpsOverTimeProps): React.JSX.Element {
  const series = useMemo(() => (tl ? buildDpsSeries(tl) : null), [tl])
  const chart = useMemo(() => buildDpsChart(series, live), [series, live])
  const markers = useMemo(() => placeMarkers(tl, chart), [tl, chart])
  const a = series?.estimated ? '~' : ''

  return (
    <DashCard title={title} right={<ChartHeaderStats tl={tl} series={series} chart={chart} />} fill={fill} testId={testId}>
      {!tl ? (
        <QuietNote>{noRing}</QuietNote>
      ) : !chart || !series ? (
        <QuietNote>No damage recorded yet — the curve starts with the first hit.</QuietNote>
      ) : (
        <>
          <DpsCurve chart={chart} series={series} markers={markers} startTs={tl.startTs} a={a} />
          <ChartAxis chart={chart} />
          {!compact && <ChartLegend series={series} chart={chart} markers={markers} />}
        </>
      )}
    </DashCard>
  )
}
