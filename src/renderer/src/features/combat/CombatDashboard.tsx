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
// numbers when the ring was downsampled. The source meter's totals stay authoritative.

import { useMemo } from 'react'
import { Box, Stack, Tooltip, Typography } from '@mui/material'
import type { SegmentView, SourceView, TimelineView } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'
import { formatNum as fmt, formatRate } from '../../lib/formatRate'
import { ApproxChip, Bar, CAT_COLOR, DashCard, KIND_COLOR, QuietNote, RESIST_COLOR, SkillBar, fmtDur } from './combatShared'
import {
  buildDpsSeries,
  composition,
  flattenSkills,
  groupByTarget,
  skillsForTarget,
  type Drill,
  type TargetDetail
} from './dashboardData'

/** Why the selection has no per-event ring — decides the wording of the quiet note. */
export type Ringless = 'zone' | 'evicted' | null

function ringlessText(r: Ringless): string {
  return r === 'zone'
    ? 'Per-event detail isn’t kept for zone sessions — pick a fight to see this.'
    : 'Per-event detail is no longer kept for this fight.'
}

// ── Panel 1: DPS over time ─────────────────────────────────────────────────────────

const CHART_W = 720
const CHART_H = 118
const PAD_X = 4
const PAD_T = 6
const PAD_B = 4
/** How much of a LIVE fight the curve shows before it starts scrolling with `now`. */
const LIVE_WINDOW_MS = 120_000

const OUT_COLOR = '#d9b25f'
const PET_COLOR = '#6fb3d2'
const INC_COLOR = '#cf6679'

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
}): JSX.Element {
  const series = useMemo(() => (tl ? buildDpsSeries(tl) : null), [tl])
  const chart = useMemo(() => {
    if (!series || !series.hasAny) return null
    const { n, bucketMs } = series
    const scrolling = live && n * bucketMs > LIVE_WINDOW_MS
    const i0 = scrolling ? Math.max(0, n - Math.ceil(LIVE_WINDOW_MS / bucketMs)) : 0
    const idx: number[] = []
    for (let i = i0; i < n; i++) idx.push(i)
    // A one-bucket fight would draw nothing; repeat it so the opening rate reads as a line.
    if (idx.length === 1) idx.push(i0)
    let yMax = 1
    let peakVis = 0
    for (const i of idx) {
      const out = series.you[i] + series.pet[i]
      peakVis = Math.max(peakVis, out)
      yMax = Math.max(yMax, out, series.inc[i])
    }
    const x = (k: number): number => PAD_X + (idx.length > 1 ? k / (idx.length - 1) : 0.5) * (CHART_W - 2 * PAD_X)
    const y = (v: number): number => CHART_H - PAD_B - (v / yMax) * (CHART_H - PAD_T - PAD_B)
    const pts = (pick: (i: number) => number): string =>
      idx.map((i, k) => `${x(k).toFixed(1)},${y(pick(i)).toFixed(1)}`).join(' ')
    const outLine = pts((i) => series.you[i] + series.pet[i])
    return {
      outLine,
      outArea: `${x(0).toFixed(1)},${CHART_H - PAD_B} ${outLine} ${x(idx.length - 1).toFixed(1)},${CHART_H - PAD_B}`,
      petLine: series.hasPet ? pts((i) => series.pet[i]) : null,
      incLine: series.hasInc ? pts((i) => series.inc[i]) : null,
      startMs: i0 * bucketMs,
      endMs: Math.min(series.durationMs, n * bucketMs),
      scrolling,
      peakVis,
      yMax
    }
  }, [series, live])

  const a = series?.estimated ? '~' : ''
  const right = tl && series && chart ? (
    <Stack direction="row" spacing={0.75} alignItems="baseline" sx={{ minWidth: 0 }}>
      {tl.downsampled && <ApproxChip shown={tl.events.length} raw={tl.rawCount} />}
      <Tooltip title={`Peak ${Math.round(series.smoothMs / 1000)}s rolling outgoing rate in the visible window.`}>
        <Typography variant="caption" sx={{ color: OUT_COLOR, whiteSpace: 'nowrap' }}>
          {a}
          {formatRate(chart.peakVis)} peak
        </Typography>
      </Tooltip>
    </Stack>
  ) : undefined

  return (
    <DashCard title="DPS over time" right={right} minHeight={172}>
      {!tl ? (
        <QuietNote>{ringlessText(ringless)}</QuietNote>
      ) : !chart || !series ? (
        <QuietNote>No damage recorded yet — the curve starts with the first hit.</QuietNote>
      ) : (
        <>
          <Box sx={{ position: 'relative' }}>
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
            </svg>
            <Typography
              variant="caption"
              sx={{ position: 'absolute', top: 0, left: 2, color: 'text.disabled', pointerEvents: 'none' }}
            >
              {a}
              {formatRate(chart.yMax)}
            </Typography>
          </Box>
          <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.25 }}>
            {[0, 1, 2, 3].map((k) => (
              <Typography key={k} variant="caption" color="text.disabled">
                {fmtDur((chart.startMs + ((chart.endMs - chart.startMs) * k) / 3) / 1000)}
              </Typography>
            ))}
          </Stack>
          <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mt: 0.25 }} flexWrap="wrap" useFlexGap>
            <Legend color={OUT_COLOR} label="you + pet" />
            {series.hasPet && <Legend color={PET_COLOR} label="pet" />}
            {series.hasInc && <Legend color={INC_COLOR} label="incoming" />}
            <Box sx={{ flexGrow: 1 }} />
            <Typography variant="caption" color="text.disabled" noWrap>
              {Math.round(series.smoothMs / 1000)}s rolling
              {chart.scrolling ? ' · last 2:00' : ''}
            </Typography>
          </Stack>
        </>
      )}
    </DashCard>
  )
}

function Legend({ color, label }: { color: string; label: string }): JSX.Element {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <Box sx={{ width: 10, height: 3, borderRadius: 1, bgcolor: color }} />
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  )
}

// ── Panel 2: Breakdown preview ─────────────────────────────────────────────────────

const PREVIEW_SKILLS = 6

/**
 * Always-visible composition strip for one source: a 100%-stacked category bar plus its
 * top skills. Built from the engine's AUTHORITATIVE category rollups (not events), so it
 * stays exact for ring-less zone sessions. Clicking anywhere opens the full level-2 flat
 * drill for that source — this is a preview, so it carries no legend of its own.
 */
export function BreakdownPreviewCard({
  source,
  onOpen
}: {
  source: SourceView | null
  onOpen: () => void
}): JSX.Element {
  const slices = useMemo(() => (source ? composition(source) : []), [source])
  const top = useMemo(() => (source ? flattenSkills(source).slice(0, PREVIEW_SKILLS) : []), [source])
  const more = source ? Math.max(0, source.categories.reduce((n, c) => n + c.skills.length, 0) - top.length) : 0

  return (
    <DashCard
      title={source ? `Breakdown · ${source.name}` : 'Breakdown'}
      right={
        source ? (
          <Typography variant="caption" color="text.secondary" noWrap>
            {fmt(source.total)} · {formatRate(source.dps)}
          </Typography>
        ) : undefined
      }
      minHeight={150}
    >
      {!source || slices.length === 0 ? (
        <QuietNote>No damage from this source yet.</QuietNote>
      ) : (
        <Box onClick={onOpen} sx={{ cursor: 'pointer', minWidth: 0 }}>
          <Stack direction="row" sx={{ height: 14, borderRadius: 0.5, overflow: 'hidden', mb: 0.75 }}>
            {slices.map((s) => (
              <Tooltip key={s.category} title={`${CATEGORY_LABEL[s.category]} · ${fmt(s.total)} · ${Math.round(s.pct)}%`}>
                <Box sx={{ width: `${s.pct}%`, bgcolor: CAT_COLOR[s.category], opacity: 0.75, minWidth: 2 }} />
              </Tooltip>
            ))}
          </Stack>
          {top.map((s) => (
            <Box key={`${s.category}|${s.name}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: '1px' }}>
              <Box sx={{ width: 6, height: 6, borderRadius: '2px', bgcolor: CAT_COLOR[s.category], flexShrink: 0 }} />
              <Typography variant="caption" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
                {s.name}
              </Typography>
              <Box
                sx={{
                  width: 54,
                  height: 5,
                  borderRadius: 1,
                  bgcolor: 'rgba(255,255,255,0.06)',
                  flexShrink: 0,
                  overflow: 'hidden'
                }}
              >
                <Box sx={{ width: `${Math.max(3, s.pct)}%`, height: '100%', bgcolor: CAT_COLOR[s.category], opacity: 0.7 }} />
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ width: 52, textAlign: 'right' }}>
                {fmt(s.total)}
              </Typography>
            </Box>
          ))}
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 0.25 }}>
            {more > 0 ? `+${more} more — click for the full breakdown` : 'click for the full breakdown'}
          </Typography>
        </Box>
      )}
    </DashCard>
  )
}

// ── Panel 3: Damage by mob ─────────────────────────────────────────────────────────

const MOB_ROWS = 10

/**
 * Outgoing damage grouped by defender. Clicking a row drives the MAIN panel down to the
 * flat skill breakdown of everything you and your pet landed on that mob.
 */
export function MobDamageCard({
  tl,
  ringless,
  drill,
  setDrill
}: {
  tl: TimelineView | null
  ringless: Ringless
  drill: Drill | null
  setDrill: (d: Drill | null) => void
}): JSX.Element {
  const mobs = useMemo(() => (tl ? groupByTarget(tl) : null), [tl])
  const rows = mobs ? mobs.rows.slice(0, MOB_ROWS) : []
  const a = mobs?.estimated ? '~' : ''
  const selected = drill?.kind === 'target' ? drill.target : null

  return (
    <DashCard
      title="Damage by mob"
      right={
        mobs && mobs.rows.length > 0 ? (
          <Typography variant="caption" color="text.secondary" noWrap>
            {mobs.rows.length} mob{mobs.rows.length === 1 ? '' : 's'} · {a}
            {fmt(mobs.total)}
          </Typography>
        ) : undefined
      }
      grow
      minHeight={140}
    >
      {!tl ? (
        <QuietNote>{ringlessText(ringless)}</QuietNote>
      ) : rows.length === 0 ? (
        <QuietNote>Nothing landed on anything yet.</QuietNote>
      ) : (
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
          {mobs && mobs.rows.length > rows.length && (
            <Typography variant="caption" color="text.disabled">
              +{mobs.rows.length - rows.length} more
            </Typography>
          )}
        </Box>
      )}
    </DashCard>
  )
}

// ── The mob-filtered level-2 body (rendered inside the main panel) ─────────────────

/**
 * Everything you and your pet landed on ONE mob, as the same flat category-colored rows
 * the entity drill uses. Derived from the encounter's event ring, so it wears the `~`
 * labels whenever that ring was downsampled.
 */
export function TargetSkillBars({
  target,
  detail,
  seg
}: {
  target: string
  detail: TargetDetail
  seg: SegmentView
}): JSX.Element {
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
