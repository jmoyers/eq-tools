// The combat DASHBOARD panels: a scrolling DPS curve, a composition preview of the
// selected source, and a ranked damage-by-mob list that drives the main panel's drill.
//
// The curve itself now lives in `DpsOverTime.tsx` — the Overview tab renders it too, and the
// ONE source rule covers the whole chart, not just its colors. `DpsChartCard` below is the
// Combat tab's binding of it (same testid, same `fill` grid-cell layout, same wording for the
// no-ring case, which is the one thing only this tab knows the reason for).
//
// All three panels are cheap inline SVG / bars — these surfaces are RENDER-bound (see AGENTS.md),
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
import type { SegmentView, TimelineView } from '@shared/combat'
import { formatNum as fmt } from '../../lib/formatRate'
import { Bar, CopyButton, DashCard, KIND_COLOR, QuietNote, RESIST_COLOR, SkillBar } from './combatShared'
import { formatMobsText } from './copyText'
import { groupByTarget, skillsForTarget, type Drill, type MobBreakdown, type TargetDetail } from './dashboardData'
import { DpsOverTime } from './DpsOverTime'

/** Why the selection has no per-event ring — decides the wording of the quiet note. */
export type Ringless = 'zone' | 'evicted' | null

/** Exported because Overview's curve card shares the "this fight's ring is gone" wording — the
 *  only case the two surfaces have in common (Overview never selects a zone session). */
export function ringlessText(r: Ringless): string {
  return r === 'zone'
    ? 'Per-event detail isn’t kept for zone sessions — pick a fight to see this.'
    : 'Per-event detail is no longer kept for this fight.'
}

// ── Panel 1: DPS over time ─────────────────────────────────────────────────────────

/**
 * The Combat tab's DPS curve: the full card (legend and all) in a 2x2 grid cell, and the only
 * surface that can explain WHY a selection has no per-event ring.
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
  return <DpsOverTime tl={tl} live={live} noRing={ringlessText(ringless)} fill testId="dash-panel" />
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
