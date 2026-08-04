// The dashboard's ANCHOR PANEL — the source meter (level 1) and, when drilled, ONE level-2
// subject. Split out of CombatView.tsx; the tab is now header + body + log, and this is the body's
// first cell.
//
// The two drill kinds are a union, so there is always exactly one breadcrumb: an entity's flat
// skill list, or a MOB's (everything you + pet landed on it).

import { useMemo, useState } from 'react'
import { Box, Breadcrumbs, Button, Link, Paper, Stack, Tooltip, Typography } from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CircleIcon from '@mui/icons-material/Circle'
import { TargetSkillBars } from './CombatDashboard'
import { EntityRow } from './EntityRow'
import { PetBar } from './PetBar'
import { CAT_COLOR, CopyButton, KIND_COLOR, QuietNote, RESIST_COLOR, SkillBar, fmtDur } from './combatShared'
import { skillsForTarget, type Drill, type TargetDetail } from './dashboardData'
import { nestedRows, petSources, selfSource } from './petRows'
import { useCombinePetRow } from './useCombatPrefs'
import { fmtElapsed, formatEntityText, formatSegmentText, formatTargetText } from './copyText'
import { formatNum as fmt, formatRate } from '../../lib/formatRate'
import type { DamageCategory, SegmentView, SourceView, TimelineView } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'

function IncomingHeals({ seg }: { seg: SegmentView }): React.JSX.Element | null {
  if (seg.incomingHealTotal <= 0) return null
  const top = seg.incomingHealers.slice(0, 4)
  return (
    <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
      <Typography variant="caption" sx={{ color: '#5fbf7f', fontWeight: 600 }}>
        Heals received: {fmt(seg.incomingHealTotal)}
      </Typography>
      {top.map((h) => (
        <Typography key={h.name} variant="caption" sx={{ display: 'block', color: 'text.secondary', pl: 1 }}>
          {h.name} · {fmt(h.total)} ({h.count})
        </Typography>
      ))}
    </Box>
  )
}

/**
 * The compact category legend above the flat list: swatch + label + total, carrying the
 * category-level badges (crit%, resist%) that used to live on the removed category bars.
 * Chips double as filters — click to isolate one category, click again to clear.
 */
function CategoryLegend({
  e,
  active,
  onToggle
}: {
  e: SourceView
  active: DamageCategory | null
  onToggle: (c: DamageCategory) => void
}): React.JSX.Element | null {
  if (e.categories.length === 0) return null
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
      {e.categories.map((c) => {
        const on = active === c.category
        return (
          <Tooltip
            key={c.category}
            title={`${CATEGORY_LABEL[c.category]}: ${fmt(c.total)} over ${c.hits} hits · max ${fmt(c.max)} — click to ${
              on ? 'show all categories' : 'show only this category'
            }`}
          >
            <Box
              onClick={() => onToggle(c.category)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                px: 0.75,
                py: '2px',
                borderRadius: 999,
                cursor: 'pointer',
                userSelect: 'none',
                border: '1px solid',
                borderColor: on ? CAT_COLOR[c.category] : 'divider',
                bgcolor: on ? `${CAT_COLOR[c.category]}22` : 'transparent',
                opacity: active && !on ? 0.45 : 1,
                '&:hover': { borderColor: CAT_COLOR[c.category] }
              }}
            >
              <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: CAT_COLOR[c.category], flexShrink: 0 }} />
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                {CATEGORY_LABEL[c.category]}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {fmt(c.total)}
              </Typography>
              {c.critPct >= 1 && (
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
                  {Math.round(c.critPct)}% crit
                </Typography>
              )}
              {c.resists > 0 && (
                <Typography component="span" variant="caption" sx={{ color: RESIST_COLOR }}>
                  {Math.round(c.resistPct)}% resist
                </Typography>
              )}
            </Box>
          </Tooltip>
        )
      })}
    </Stack>
  )
}

/** The melee-rounds heuristic footer — a cluster proxy, and labeled as one (world-model law 6). */
function MeleeRoundsNote({ rounds }: { rounds: SourceView['rounds'] }): React.JSX.Element | null {
  if (!rounds || (rounds.multiHitRounds <= 0 && rounds.maxHitsInRound <= 1)) return null
  return (
    <Tooltip
      title={`Heuristic: EQ never logs double/triple attack, so a "round" here is same-second, same-skill melee/slay hits — a cluster proxy, not a certainty. Main-hand vs off-hand is not distinguishable. Distribution (hits→rounds): ${rounds.histogram
        .map((n, i) => `${i + 1}:${n}`)
        .join('  ')}`}
    >
      <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary">
          Melee rounds: {rounds.totalRounds} · avg {rounds.avgHitsPerRound.toFixed(2)} hits/round · {rounds.multiHitRounds} multi-hit · up to{' '}
          {rounds.maxHitsInRound}/round
        </Typography>
      </Box>
    </Tooltip>
  )
}

/**
 * Level-2 (one of two level-2 subjects): the category legend + ONE flat ranked list of every
 * skill/spell this entity landed. The melee-rounds heuristic footer rides along.
 *
 * `pets` are the pet sources NESTED into this list (see petRows.ts) — non-empty only for YOUR
 * row, and only while the 'Combine pet into your damage' preference is on. Each nests as one
 * line item that drills into that pet's own breakdown; nothing about your per-skill rows
 * changes, because a pet's damage is never folded into a lane of yours.
 *
 * A category filter hides them: the legend filters YOUR categories, and a pet is not one of
 * them — showing it under "Melee only" would claim it was melee damage of yours.
 */
function EntitySkillBars({
  e,
  pets,
  onDrillPet
}: {
  e: SourceView
  pets: SourceView[]
  onDrillPet: (id: string) => void
}): React.JSX.Element {
  const [filter, setFilter] = useState<DamageCategory | null>(null)
  const all = nestedRows(e, pets)
  const rows = filter ? all.filter((r) => r.kind === 'skill' && r.skill.category === filter) : all
  return (
    <Box>
      <CategoryLegend e={e} active={filter} onToggle={(c) => setFilter((f) => (f === c ? null : c))} />
      {rows.map((r) =>
        r.kind === 'pet' ? (
          <PetBar key={r.pet.id} pet={r.pet} pct={r.pct} onDrill={() => onDrillPet(r.pet.id)} />
        ) : (
          <SkillBar key={`${r.skill.category}|${r.skill.name}`} s={r.skill} />
        )
      )}
      {rows.length === 0 && <QuietNote>No skill breakdown for this source.</QuietNote>}
      <MeleeRoundsNote rounds={e.rounds} />
    </Box>
  )
}

// ── the panel header's stat run ────────────────────────────────────────────────────────

/** Active-time DPS: only worth printing when the fight actually had idle gaps. */
function ActiveDpsNote({ seg, mode }: { seg: SegmentView; mode: 'out' | 'in' }): React.JSX.Element | null {
  if (mode !== 'out' || seg.activeSec <= 0 || seg.activeSec >= seg.durationSec) return null
  return (
    <Tooltip
      title={`Active-time DPS: damage ÷ ${fmtDur(
        seg.activeSec
      )} of actual combat time (gaps between hits capped at 3s each). Wall-clock DPS (${formatRate(
        seg.outDps
      )}) divides by the full ${fmtDur(seg.durationSec)} fight length.`}
    >
      <Typography component="span" variant="caption" sx={{ color: 'text.secondary', mr: 0.25 }}>
        (act {formatRate(seg.activeDps)})
      </Typography>
    </Tooltip>
  )
}

/** How much of your damage the enemies healed back — effective DPS is lower by exactly this. */
function EnemyHealNote({ seg, mode }: { seg: SegmentView; mode: 'out' | 'in' }): React.JSX.Element | null {
  if (mode !== 'out' || seg.enemyHealTotal <= 0) return null
  return (
    <Tooltip
      title={`Enemies healed for ${fmt(
        seg.enemyHealTotal
      )} during this fight — that much of your damage was undone (effective DPS is lower).`}
    >
      <Typography component="span" variant="caption" sx={{ color: '#5fbf7f', ml: 0.5 }}>
        · +{fmt(seg.enemyHealTotal)} enemy heal
      </Typography>
    </Tooltip>
  )
}

/**
 * SLOW CHIP (Task #64). Shown ONLY when a slow-capable coat was actually on at engage — that is
 * what makes "not landed" a fact about the poison rather than about the loadout, and it keeps the
 * chip off the header of every fight the user wasn't running slow poison for.
 */
function SlowChip({ seg, mode }: { seg: SegmentView; mode: 'out' | 'in' }): React.JSX.Element | null {
  if (mode !== 'out' || !seg.procs.slowExpected) return null
  const landed = seg.procs.slowLandMs !== undefined
  return (
    <Tooltip
      title={
        seg.procs.slowLandMs !== undefined
          ? `${seg.procs.coatAtEngage?.poison} was coated at engage; its Weakening Strike proc landed ${fmtElapsed(
              seg.procs.slowLandMs
            )} in (${seg.procs.slowLands} landing${seg.procs.slowLands === 1 ? '' : 's'} this fight).`
          : `${seg.procs.coatAtEngage?.poison} was coated at engage, but its slow proc has not landed in this fight.`
      }
    >
      <Typography component="span" variant="caption" sx={{ color: landed ? '#57e0a0' : 'text.disabled', ml: 0.5 }}>
        · {seg.procs.slowLandMs !== undefined ? `slow @ ${fmtElapsed(seg.procs.slowLandMs)}` : 'slow: not landed'}
      </Typography>
    </Tooltip>
  )
}

/**
 * The panel's title + stat run, and hard right of it the copy affordance — it belongs to THIS
 * panel (not to the tab's top bar), because what it copies is whatever level this panel is
 * currently showing.
 */
function SegmentHeader({
  seg,
  mode,
  total,
  dps,
  copyView
}: {
  seg: SegmentView
  mode: 'out' | 'in'
  total: number
  dps: number
  copyView: () => string
}): React.JSX.Element {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1, flexShrink: 0 }}>
      <Typography variant="subtitle1" noWrap>
        {seg.name}
        {seg.active && <CircleIcon sx={{ fontSize: 10, color: 'success.main', ml: 1, verticalAlign: 'middle' }} />}
      </Typography>
      <Stack direction="row" spacing={0.5} alignItems="baseline" sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ color: mode === 'out' ? 'primary.main' : KIND_COLOR.enemy }}>
          {formatRate(dps)} <ActiveDpsNote seg={seg} mode={mode} />
          <Typography component="span" variant="caption" color="text.secondary">
            · {fmt(total)} · {fmtDur(seg.durationSec)}
            <EnemyHealNote seg={seg} mode={mode} />
            <SlowChip seg={seg} mode={mode} />
          </Typography>
        </Typography>
        <CopyButton getText={copyView} />
      </Stack>
    </Stack>
  )
}

/**
 * Drill-down breadcrumb + Back. Two levels, plus ONE nested case: a pet that was opened from
 * inside your breakdown (petRows.ts) is a level below it, and the crumb says so —
 * `All › You › Vebarn`. `parent` is what makes the trail honest: Back goes to the row the pet
 * was clicked from, "All" still goes all the way out, and neither pretends the pet is a
 * top-level source while it is being shown as a line item of yours.
 */
function DrillCrumb({
  crumb,
  isTarget,
  parent,
  setDrill
}: {
  crumb: string
  isTarget: boolean
  /** the source this drill was nested inside, when it was (your row, for a nested pet). */
  parent: SourceView | null
  setDrill: (d: Drill | null) => void
}): React.JSX.Element {
  const up = (): void => setDrill(parent ? { kind: 'entity', entityId: parent.id } : null)
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75, flexShrink: 0 }}>
      <Button
        size="small"
        data-testid="drill-back"
        startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />}
        onClick={up}
        sx={{ minWidth: 0, py: 0 }}
      >
        Back
      </Button>
      <Breadcrumbs separator="›" sx={{ fontSize: 12 }}>
        <Link component="button" underline="hover" color="inherit" onClick={() => setDrill(null)} sx={{ fontSize: 12 }}>
          All
        </Link>
        {parent ? (
          <Link component="button" underline="hover" color="inherit" onClick={up} sx={{ fontSize: 12 }}>
            {parent.name}
          </Link>
        ) : null}
        <Typography variant="caption" color="text.primary">
          {isTarget ? `damage to ${crumb}` : crumb}
        </Typography>
      </Breadcrumbs>
    </Stack>
  )
}

// ── drill resolution ───────────────────────────────────────────────────────────────────

/** Which level-2 subject (if any) the current drill resolves to, against THIS segment. */
interface DrillState {
  entity: SourceView | undefined
  targetName: string | null
  targetDetail: TargetDetail | null
  /** the breadcrumb label; null means we are at level 1. */
  crumb: string | null
}

/**
 * If a stale drill points at an entity no longer present (fight changed), fall back to
 * level 1. The mob drill goes stale the same way when the ring disappears.
 */
function useDrillState(rows: SourceView[], tl: TimelineView | null, drill: Drill | null): DrillState {
  const entity = drill?.kind === 'entity' ? rows.find((r) => r.id === drill.entityId) : undefined
  const targetName = drill?.kind === 'target' ? drill.target : null
  const targetDetail = useMemo(
    () => (tl && targetName ? skillsForTarget(tl, targetName) : null),
    [tl, targetName]
  )
  return { entity, targetName, targetDetail, crumb: entity?.name ?? (targetDetail ? targetName : null) }
}

/** The scrolling body: the ranked source list at level 1, one level-2 subject when drilled. */
function SegmentContent({
  seg,
  mode,
  rows,
  pets,
  d,
  setDrill
}: {
  seg: SegmentView
  mode: 'out' | 'in'
  rows: SourceView[]
  /** pet sources to NEST inside your breakdown (empty when the preference is off). */
  pets: SourceView[]
  d: DrillState
  setDrill: (drill: Drill | null) => void
}): React.JSX.Element {
  return (
    <Box data-testid="meter-body" sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0 }}>
      {!d.crumb &&
        (rows.length ? (
          rows.map((e, i) => (
            <EntityRow
              key={e.id}
              e={e}
              rank={i + 1}
              onDrill={mode === 'out' ? () => setDrill({ kind: 'entity', entityId: e.id }) : undefined}
            />
          ))
        ) : (
          <QuietNote>
            {mode === 'out' ? 'No outgoing damage in this segment.' : 'No incoming damage in this segment.'}
          </QuietNote>
        ))}

      {/* Keyed by entity so switching sources resets the legend's category filter. Pets nest
          into YOUR row only — drilling the pet itself shows the pet's own list, never a pet
          nested inside a pet. */}
      {d.entity && (
        <EntitySkillBars
          key={d.entity.id}
          e={d.entity}
          pets={d.entity.kind === 'you' ? pets : []}
          onDrillPet={(id) => setDrill({ kind: 'entity', entityId: id })}
        />
      )}
      {!d.entity && d.targetDetail && d.targetName && (
        <TargetSkillBars target={d.targetName} detail={d.targetDetail} seg={seg} />
      )}

      {mode === 'in' && !d.crumb && <IncomingHeals seg={seg} />}
    </Box>
  )
}

export function SegmentBody({
  seg,
  tl,
  mode,
  drill,
  setDrill
}: {
  seg: SegmentView
  tl: TimelineView | null
  mode: 'out' | 'in'
  drill: Drill | null
  setDrill: (d: Drill | null) => void
}): React.JSX.Element {
  const rows = mode === 'out' ? seg.entities : seg.incoming
  // The header total/DPS stay the SEGMENT's (you + every pet) at every drill level — the same
  // aggregate the Overview card headlines, so the two surfaces can never disagree on a number.
  const total = mode === 'out' ? seg.outTotal : seg.inTotal
  const dps = mode === 'out' ? seg.outDps : seg.inDps
  const d = useDrillState(rows, tl, drill)
  const [combinePetRow] = useCombinePetRow()
  const pets = mode === 'out' && combinePetRow ? petSources(rows) : []
  // A drilled pet is NESTED (and so has a parent in the trail) only while it is actually being
  // shown as a line item inside your row — i.e. while the preference is on and you have a row.
  const nestedIn = d.entity?.kind === 'pet' && pets.some((p) => p.id === d.entity?.id) ? selfSource(rows) : null

  // "Copy this view" means THIS view: the same three-way choice the body below makes, so the
  // clipboard can never hold a level the user isn't looking at. Built on click, never on render.
  const copyView = (): string =>
    d.entity
      ? // The SAME pets the body nests into this list (`SegmentContent` uses this exact test),
        // so the clipboard can no longer drop a row the reader can see on screen.
        formatEntityText(seg, d.entity, d.entity.kind === 'you' ? pets : [])
      : d.targetDetail && d.targetName
        ? formatTargetText(seg, d.targetName, d.targetDetail)
        : formatSegmentText(seg, mode)

  return (
    // Grid-cell sizing, exactly like DashCard's `fill`: 100% of the cell, zero intrinsic
    // height (so a `minmax(0, 1fr)` row can shrink it), everything below the header scrolls
    // internally. The meter must never be what makes the dashboard taller than its box.
    <Paper
      variant="outlined"
      data-testid="dash-panel"
      sx={{
        p: 1.5,
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <SegmentHeader seg={seg} mode={mode} total={total} dps={dps} copyView={copyView} />
      {d.crumb && <DrillCrumb crumb={d.crumb} isTarget={!!d.targetDetail} parent={nestedIn} setDrill={setDrill} />}
      <SegmentContent seg={seg} mode={mode} rows={rows} pets={pets} d={d} setDrill={setDrill} />
    </Paper>
  )
}
