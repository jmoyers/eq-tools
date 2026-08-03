// The combat DASHBOARD panels: a scrolling DPS curve, a composition preview of the
// selected source, and a ranked damage-by-mob list that drives the main panel's drill.
//
// All three are cheap inline SVG / bars — these surfaces are RENDER-bound (see AGENTS.md),
// so there are no chart libs, every derivation is a single pass in `dashboardData.ts`, and
// each memo is keyed on the timeline's IDENTITY (CombatView stabilises that identity so a
// frozen finalized fight doesn't re-derive on every 1s snapshot tick).
//
// Honesty: panels fed by the per-event ring degrade to a quiet note when the selection has
// no ring (finalized zone sessions), and wear a `~ N of M events` chip with `~`-prefixed
// numbers whenever that ring is inexact — downsampled (scaled estimates) AND/OR truncated
// by the drop-oldest cap (lower bounds over the retained window). Both losses get the SAME
// treatment; only the chip's tooltip distinguishes them. The source meter's totals stay
// authoritative in every case — they are folded on ingest and never read the ring.

import { useMemo } from 'react'
import { Box, Stack, Tooltip, Typography } from '@mui/material'
import type { SegmentView, TimelineMarker, TimelineView } from '@shared/combat'
import { formatNum as fmt, formatRate } from '../../lib/formatRate'
import { ApproxChip, Bar, CopyButton, DashCard, KIND_COLOR, QuietNote, RESIST_COLOR, SkillBar, fmtDur } from './combatShared'
import { fmtElapsed, formatMobsText } from './copyText'
import {
  approxNote,
  buildDpsSeries,
  groupByTarget,
  skillsForTarget,
  type Drill,
  type DpsSeries,
  type MobBreakdown,
  type TargetDetail
} from './dashboardData'
import { CHART_H, CHART_W, PAD_B, PAD_T, PAD_X, buildDpsChart, type DpsChart } from './dpsChart'

/** Why the selection has no per-event ring — decides the wording of the quiet note. */
export type Ringless = 'zone' | 'evicted' | null

function ringlessText(r: Ringless): string {
  return r === 'zone'
    ? 'Per-event detail isn’t kept for zone sessions — pick a fight to see this.'
    : 'Per-event detail is no longer kept for this fight.'
}

// ── Panel 1: DPS over time ─────────────────────────────────────────────────────────

const OUT_COLOR = '#d9b25f'
const PET_COLOR = '#6fb3d2'
const INC_COLOR = '#cf6679'

/**
 * MARKER COLORS (Task #64) — deliberately the SAME hues as the header's modifier slots, so a
 * violet tick on the curve and the violet "3: Neurotoxic" pill are obviously the same fact:
 *   stance      gold   (slot 1)
 *   invocation  violet (slot 2)
 *   coat        magenta(slot 3)
 *   slow        green  — the one marker that is an OUTCOME rather than a choice, so it also
 *                        gets a flag head instead of a plain tick. It is what the user is
 *                        looking for on this chart; it must not read as another setting.
 */
const MARKER_COLOR: Record<TimelineMarker['kind'], string> = {
  stance: '#d9b25f',
  invocation: '#a98fe0',
  coat: '#c46fd2',
  slow: '#57e0a0'
}
const MARKER_WORD: Record<TimelineMarker['kind'], string> = {
  stance: 'stance',
  invocation: 'invocation',
  coat: 'coat',
  slow: 'slow landed'
}

/** One marker, already placed in chart X coordinates. */
interface PlacedMarker {
  m: TimelineMarker
  x: number
}

/**
 * MARKERS (Task #64) — thin vertical ticks at the instants the fight CHANGED: a stance or
 * invocation commit, a blade coat, a slow landing.
 *
 * They are placed by TIME, not by bucket index, so a marker sits exactly where it happened
 * rather than snapping to the curve's sampling grid; markers outside the visible (scrolling)
 * window are dropped rather than clamped to the edge, which would put a coat from four
 * minutes ago at t=0 and read as if it had just happened.
 *
 * The engine never downsamples markers (see TimelineMarker), so what is drawn here is the
 * complete set for the visible span — this chart can be read as exhaustive.
 */
function placeMarkers(tl: TimelineView | null, chart: DpsChart | null): PlacedMarker[] {
  if (!tl || !chart) return []
  const span = Math.max(1, chart.endMs - chart.startMs)
  return tl.markers
    .filter((m) => m.t >= chart.startMs && m.t <= chart.endMs)
    .map((m) => ({
      m,
      x: PAD_X + ((m.t - chart.startMs) / span) * (CHART_W - 2 * PAD_X)
    }))
}

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

/** The three curves + the marker ticks + the y-max readout, in one SVG. */
function DpsCurve({ chart, markers, a }: { chart: DpsChart; markers: PlacedMarker[]; a: string }): React.JSX.Element {
  return (
    // flexShrink 0 on every strip: in a short grid cell the card body scrolls, it never
    // squashes the curve into an unreadable sliver.
    <Box sx={{ position: 'relative', flexShrink: 0 }}>
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
        {/* Markers LAST so a tick is never buried under the area fill. The <title> is the
            native SVG tooltip: an MUI Tooltip per tick would mount a popper for every one
            of them on a surface that re-renders each snapshot. */}
        <MarkerTicks markers={markers} />
      </svg>
      <Typography
        variant="caption"
        sx={{ position: 'absolute', top: 0, left: 2, color: 'text.disabled', pointerEvents: 'none' }}
      >
        {a}
        {formatRate(chart.yMax)}
      </Typography>
    </Box>
  )
}

function MarkerTicks({ markers }: { markers: PlacedMarker[] }): React.JSX.Element {
  return (
    <>
      {markers.map(({ m, x }, i) => (
        <g key={`${m.kind}|${m.t}|${i}`} opacity={0.9}>
          <title>
            {`${m.label} ${MARKER_WORD[m.kind]} @ ${fmtElapsed(m.t)}${m.detail ? ` — ${m.detail}` : ''}`}
          </title>
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

/**
 * Smoothed damage rate over encounter time. For the LIVE fight the window follows `now`
 * (the last 2 minutes) and advances on the view's existing snapshot cadence — there is no
 * timer here. For a finalized fight the whole encounter is drawn statically.
 */
export function DpsChartCard({
  tl,
  live,
  ringless
}: {
  tl: TimelineView | null
  live: boolean
  ringless: Ringless
}): React.JSX.Element {
  const series = useMemo(() => (tl ? buildDpsSeries(tl) : null), [tl])
  const chart = useMemo(() => buildDpsChart(series, live), [series, live])
  const markers = useMemo(() => placeMarkers(tl, chart), [tl, chart])
  const a = series?.estimated ? '~' : ''

  return (
    <DashCard
      title="DPS over time"
      right={<ChartHeaderStats tl={tl} series={series} chart={chart} />}
      fill
      testId="dash-panel"
    >
      {!tl ? (
        <QuietNote>{ringlessText(ringless)}</QuietNote>
      ) : !chart || !series ? (
        <QuietNote>No damage recorded yet — the curve starts with the first hit.</QuietNote>
      ) : (
        <>
          <DpsCurve chart={chart} markers={markers} a={a} />
          <ChartAxis chart={chart} />
          <ChartLegend series={series} chart={chart} markers={markers} />
        </>
      )}
    </DashCard>
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

// ── Panel 3: Damage by mob ─────────────────────────────────────────────────────────

const MOB_ROWS = 10

/** The mob card's header stats + its copy affordance. Nothing to say ⇒ nothing rendered. */
function MobCardStats({ seg, mobs }: { seg: SegmentView; mobs: MobBreakdown | null }): React.JSX.Element | null {
  if (!mobs || mobs.rows.length === 0) return null
  const a = mobs.estimated ? '~' : ''
  return (
    <Stack direction="row" spacing={0.5} alignItems="baseline" sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" noWrap>
        {mobs.rows.length} mob{mobs.rows.length === 1 ? '' : 's'} · {a}
        {fmt(mobs.total)}
      </Typography>
      {/* Copies the ranked rows as they are LISTED here — the card's own cap included, so
          the paste says what it left off instead of quietly widening. */}
      <CopyButton getText={() => formatMobsText(seg, mobs, MOB_ROWS)} title="Copy this breakdown as text" />
    </Stack>
  )
}

/** The ranked rows, plus the honest "+N more" tail when the card's cap is truncating. */
function MobRows({
  mobs,
  rows,
  selected,
  setDrill
}: {
  mobs: MobBreakdown
  rows: MobBreakdown['rows']
  selected: string | null
  setDrill: (d: Drill | null) => void
}): React.JSX.Element {
  const a = mobs.estimated ? '~' : ''
  return (
    <Box sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0 }}>
      {rows.map((m, i) => (
        <Bar
          key={m.target}
          color={KIND_COLOR.enemy}
          pct={m.pct}
          rank={i + 1}
          selected={selected === m.target}
          onClick={() => setDrill(selected === m.target ? null : { kind: 'target', target: m.target })}
          name={
            <>
              {m.target}
              {m.resists > 0 && (
                <Typography component="span" variant="caption" sx={{ ml: 0.5, color: RESIST_COLOR }}>
                  {a}
                  {m.resists} resist
                </Typography>
              )}
            </>
          }
          right={`${a}${fmt(m.total)} · ${Math.round(m.share)}%`}
        />
      ))}
      {mobs.rows.length > rows.length && (
        <Typography variant="caption" color="text.disabled">
          +{mobs.rows.length - rows.length} more
        </Typography>
      )}
    </Box>
  )
}

/**
 * Outgoing damage grouped by defender. Clicking a row drives the MAIN panel down to the
 * flat skill breakdown of everything you and your pet landed on that mob.
 */
export function MobDamageCard({
  seg,
  tl,
  ringless,
  drill,
  setDrill
}: {
  /** The selected segment — this card's rows are only meaningful against that subject, and the
   *  copied text names it. */
  seg: SegmentView
  tl: TimelineView | null
  ringless: Ringless
  drill: Drill | null
  setDrill: (d: Drill | null) => void
}): React.JSX.Element {
  const mobs = useMemo(() => (tl ? groupByTarget(tl) : null), [tl])
  const rows = mobs ? mobs.rows.slice(0, MOB_ROWS) : []
  const selected = drill?.kind === 'target' ? drill.target : null

  return (
    <DashCard title="Damage by mob" right={<MobCardStats seg={seg} mobs={mobs} />} fill testId="dash-panel">
      {!tl || !mobs ? (
        <QuietNote>{ringlessText(ringless)}</QuietNote>
      ) : rows.length === 0 ? (
        <QuietNote>Nothing landed on anything yet.</QuietNote>
      ) : (
        <MobRows mobs={mobs} rows={rows} selected={selected} setDrill={setDrill} />
      )}
    </DashCard>
  )
}

// ── The mob-filtered level-2 body (rendered inside the main panel) ─────────────────

/**
 * Everything you and your pet landed on ONE mob, as the same flat category-colored rows
 * the entity drill uses. Derived from the encounter's event ring, so it wears the `~`
 * labels whenever that ring is inexact — downsampled and/or truncated by the drop-oldest
 * cap (`detail.estimated` covers both; the panel chip above says which).
 */
export function TargetSkillBars({
  target,
  detail,
  seg
}: {
  target: string
  detail: TargetDetail
  seg: SegmentView
}): React.JSX.Element {
  const a = detail.estimated ? '~' : ''
  const share = seg.outTotal > 0 ? (detail.total / seg.outTotal) * 100 : 0
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
        <Typography variant="caption" sx={{ color: KIND_COLOR.enemy, fontWeight: 700 }}>
          {a}
          {fmt(detail.total)} dealt to {target}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {Math.round(share)}% of this segment’s outgoing · {a}
          {detail.hits} hits
          {detail.crits > 0 ? ` · ${a}${detail.crits} crit` : ''}
          {detail.misses > 0 ? ` · ${a}${detail.misses} avoided` : ''}
          {detail.resists > 0 ? ` · ${a}${detail.resists} resisted` : ''}
        </Typography>
        <Tooltip title="You and your pet are combined in this per-mob list — it answers “what killed this mob”, not “who”. Use the source rows above for per-source splits.">
          <Typography variant="caption" color="text.disabled">
            you + pet combined
          </Typography>
        </Tooltip>
      </Stack>
      {detail.rows.map((s) => (
        <SkillBar key={`${s.category}|${s.name}`} s={s} approx={detail.estimated} />
      ))}
      {detail.rows.length === 0 && <QuietNote>Nothing landed on this mob in the selected segment.</QuietNote>}
    </Box>
  )
}

export { skillsForTarget }
