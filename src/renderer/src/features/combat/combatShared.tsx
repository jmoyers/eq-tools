// Presentational primitives shared by the combat meter and the dashboard panels.
// Extracted from CombatView so both surfaces render the SAME bar, the SAME category
// colors and the SAME card chrome (one look, one source of truth).

import { useState, type ReactNode } from 'react'
import { Box, Collapse, Paper, Stack, Tooltip, Typography } from '@mui/material'
import type { DamageCategory } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'
import { formatNum as fmt } from '../../lib/formatRate'
import type { FlatSkill } from './dashboardData'

export const KIND_COLOR: Record<string, string> = { you: '#d9b25f', pet: '#6fb3d2', enemy: '#cf6679' }

/**
 * Category colors. Keep this map in sync with the overlay's copy (OverlayMeter.tsx) and the
 * timeline (CombatTimeline.tsx imports THIS map — one source).
 *
 * `slay` used to be #e8d48a: a pale gold that is indistinguishable from melee #d9b25f at the
 * 3px stripe width, which made Slay Undead procs look like duplicate weapon rows in the flat
 * drill-down. It is now a radiant ivory — a holy proc reads as near-white, and it separates
 * from gold at any stripe width while staying high-contrast on the dark bg.
 */
export const CAT_COLOR: Record<DamageCategory, string> = {
  melee: '#d9b25f',
  slay: '#f6f0da',
  spell: '#a98fe0',
  dot: '#6fb3d2',
  ds: '#cf6679'
}

/** Red-tint for resist/miss rate badges (matches the timeline's hollow marks). */
export const RESIST_COLOR = '#e05663'

export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function Bar({
  color,
  pct,
  rank,
  name,
  right,
  onClick,
  accent,
  selected
}: {
  color: string
  pct: number
  rank?: number
  name: ReactNode
  right: string
  onClick?: () => void
  /** Full-height left stripe — keeps a row's category readable even when its fill is 2% wide. */
  accent?: string
  /** Outline the row as the current drill subject. */
  selected?: boolean
}): JSX.Element {
  return (
    <Box
      onClick={onClick}
      sx={{
        position: 'relative',
        height: 22,
        borderRadius: 0.5,
        mb: '3px',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        bgcolor: 'rgba(255,255,255,0.04)',
        outline: selected ? `1px solid ${color}` : 'none'
      }}
    >
      <Box sx={{ position: 'absolute', inset: 0, width: `${Math.max(2, pct)}%`, bgcolor: color, opacity: 0.5 }} />
      {accent && <Box sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, bgcolor: accent }} />}
      <Stack
        direction="row"
        alignItems="center"
        sx={{ position: 'absolute', inset: 0, pl: accent ? '9px' : 0.75, pr: 0.75 }}
        spacing={0.75}
      >
        {rank != null && (
          <Typography variant="caption" sx={{ color: 'text.secondary', width: 16, textAlign: 'right' }}>
            {rank}
          </Typography>
        )}
        <Typography variant="caption" noWrap sx={{ fontWeight: 600, flexGrow: 1 }}>
          {name}
        </Typography>
        <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
          {right}
        </Typography>
      </Stack>
    </Box>
  )
}

/**
 * A flat-row skill name that makes the row's CATEGORY readable from the ROW, not just from
 * its stripe. Only 'slay' needs it: the flatten renders a Slay Undead proc under its weapon
 * skill ("Melee"/"Backstab"), so it arrived as a DUPLICATE of the plain melee row separable
 * only by a 3px stripe. Every other category's lane names are already unambiguous.
 */
export function SkillName({ name, category }: { name: string; category: DamageCategory }): JSX.Element {
  if (category !== 'slay') return <>{name}</>
  return (
    <>
      {name}
      <Typography component="span" variant="caption" sx={{ ml: 0.5, color: CAT_COLOR.slay, fontWeight: 600 }}>
        · Slay Undead
      </Typography>
    </>
  )
}

/**
 * The per-skill stat summary that rides INSIDE the bar, after the skill name:
 *   `12% miss · 3 - 145dmg`
 * Deliberately just the two stats that can't be read off the bar itself: the miss rate and the
 * damage RANGE. Counts (hits/crits/resists) live one click down in the expanded readout — a bar
 * carrying five numbers stops being scannable. Both values are labeled (`% miss`, `dmg`); no
 * positional codes, because there is no column header in the middle of a colored row.
 * Omissions: no avoided swings → no miss rate; a lane whose smallest hit equals its largest
 * (a single hit, or a fixed-damage proc) collapses to just `145dmg`.
 * Miss rate is misses ÷ (hits + misses) for THIS lane. The row's TOTAL is deliberately not
 * here — it owns the right end of every bar so the list stays scannable as a ranked column.
 * `a` is the `~` estimate prefix the event-derived list wears on a downsampled ring; observed
 * max/min are NOT prefixed (they are not scaled estimates — they're an observed lower/upper
 * bound, which the panel's `~ N of M events` chip spells out).
 */
export function skillStatText(s: FlatSkill, a = ''): string {
  const misses = s.misses ?? 0
  const swings = s.hits + misses
  const parts: string[] = []
  if (misses > 0 && swings > 0) parts.push(`${a}${Math.round((misses / swings) * 100)}% miss`)
  const min = s.min ?? 0
  parts.push(min > 0 && min !== s.max ? `${fmt(min)} - ${fmt(s.max)}dmg` : `${fmt(s.max)}dmg`)
  return parts.join(' · ')
}

/** One labeled figure in the expanded readout: a small uppercase caption over the value. */
function StatItem({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        variant="caption"
        noWrap
        sx={{
          display: 'block',
          fontSize: 9,
          lineHeight: 1.4,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'text.disabled'
        }}
      >
        {label}
      </Typography>
      <Typography variant="caption" noWrap sx={{ display: 'block', fontWeight: 600, color: color ?? 'text.primary' }}>
        {value}
      </Typography>
    </Box>
  )
}

/**
 * The expanded per-ability readout (one level below the flat row, inline — no new nav level,
 * no breadcrumb). Everything the bar compresses, spelled out and labeled: the category, the
 * total, hit/crit counts with the crit rate, the miss rate over swings, resists over casts,
 * the damage range and the average per hit (total ÷ hits — derived, so it's labeled as an
 * average and never presented as an observed hit).
 * `a` carries the `~` sample-estimate marker through; the observed range is never prefixed
 * (a sampled max is a lower bound, a sampled min an upper bound — the panel's chip says so).
 */
function SkillReadout({ s, approx }: { s: FlatSkill; approx?: boolean }): JSX.Element {
  const a = approx ? '~' : ''
  const misses = s.misses ?? 0
  const resists = s.resists ?? 0
  const swings = s.hits + misses
  const casts = s.hits + resists
  const min = s.min ?? 0
  const color = CAT_COLOR[s.category]
  return (
    <Box
      sx={{
        mt: '-1px',
        mb: '3px',
        px: 1,
        py: 0.75,
        borderLeft: `3px solid ${color}`,
        borderRadius: '0 4px 4px 0',
        bgcolor: 'rgba(255,255,255,0.03)'
      }}
    >
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <StatItem label="Category" value={CATEGORY_LABEL[s.category]} color={color} />
        <StatItem label="Total" value={`${a}${fmt(s.total)}`} />
        <StatItem label="Hits" value={`${a}${s.hits}`} />
        {s.hits > 0 && <StatItem label="Avg per hit" value={`${a}${fmt(Math.round(s.total / s.hits))}`} />}
        {s.hits > 0 && (
          <StatItem
            label="Crits"
            value={`${a}${s.crits} (${Math.round((s.crits / s.hits) * 100)}% crit)`}
          />
        )}
        {misses > 0 && (
          <StatItem
            label="Miss rate"
            value={`${Math.round((misses / swings) * 100)}% (${a}${misses} of ${a}${swings} swings)`}
            color={RESIST_COLOR}
          />
        )}
        {resists > 0 && (
          <StatItem
            label="Resists"
            value={`${a}${resists} of ${a}${casts} casts (${Math.round((resists / casts) * 100)}%)`}
            color={RESIST_COLOR}
          />
        )}
        {s.hits > 0 && (
          <StatItem label="Damage range" value={min > 0 && min !== s.max ? `${fmt(min)} - ${fmt(s.max)}` : `${fmt(s.max)}`} />
        )}
      </Stack>
    </Box>
  )
}

/** The dimmed stat run inside a bar. Lower contrast than the name so the row still reads
 *  name-first, but sits on the translucent (0.5-opacity) fill, not beyond it. */
function InlineStats({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Typography component="span" variant="caption" sx={{ ml: 0.75, color: 'text.secondary', fontWeight: 400 }}>
      {children}
    </Typography>
  )
}

/**
 * One flat skill/spell row, colored by its parent category (fill + left stripe). Layout:
 * `<name> <embedded labeled stats> ………… <total>` — the stats live INSIDE the bar next to the
 * name (dimmed), and the right end is the total and nothing else, so a column of these reads
 * as a ranked list at a glance.
 * `approx` prefixes the derived numbers with `~` — used by the mob-filtered list when the
 * encounter's event ring was downsampled (the numbers are then sample estimates).
 */
export function SkillBar({ s, approx }: { s: FlatSkill; approx?: boolean }): JSX.Element {
  // Click expands the full per-ability readout in place (the same inline-Collapse pattern the
  // incoming meter rows use) — no extra nav level, so the flat ranked list never moves.
  const [open, setOpen] = useState(false)
  const color = CAT_COLOR[s.category]
  const resists = s.resists ?? 0
  const casts = s.hits + resists
  const a = approx ? '~' : ''
  // A spell/dot lane can carry resists (Task #51 v2). Show a resist-rate badge and,
  // for a lane that only ever resisted (0 hits), a resist-only embedded summary.
  return (
    <Box>
      <Bar
        color={color}
        accent={color}
        pct={s.pct}
        selected={open}
        onClick={() => setOpen((o) => !o)}
        name={
          <>
            <SkillName name={s.name} category={s.category} />
            {resists > 0 && casts > 0 && (
              <Tooltip
                title={`${resists} resisted of ${casts} cast${casts === 1 ? '' : 's'} — ${Math.round(
                  (s.hits / casts) * 100
                )}% landed`}
              >
                <Typography component="span" variant="caption" sx={{ ml: 0.75, color: RESIST_COLOR }}>
                  {Math.round((resists / casts) * 100)}% resist
                </Typography>
              </Tooltip>
            )}
            <InlineStats>
              {s.hits > 0 ? skillStatText(s, a) : `0 landed · ${a}${resists} resisted`}
            </InlineStats>
          </>
        }
        right={`${a}${fmt(s.total)}`}
      />
      <Collapse in={open} unmountOnExit>
        <SkillReadout s={s} approx={approx} />
      </Collapse>
    </Box>
  )
}

/**
 * Dashboard card chrome: dense uppercase caption on the left, a free-form status slot on
 * the right, body fills the rest. Matches the app's outlined-Paper card style.
 */
export function DashCard({
  title,
  right,
  children,
  grow,
  minHeight,
  height
}: {
  title: string
  right?: ReactNode
  children: ReactNode
  /** let the card absorb leftover column height (its body scrolls). */
  grow?: boolean
  minHeight?: number
  /**
   * FIXED card height (`flex: 0 0 <height>px`) — for a card whose body is an ever-growing
   * append-only ring. Without it such a card sizes to its CONTENT (`flex: 0 0 auto` can
   * neither grow nor shrink), so it silently steals the whole column from its shrinkable
   * siblings — which is exactly how the combat log ate the dashboard. Wins over minHeight.
   */
  height?: number
}): JSX.Element {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        ...(grow
          ? { flex: '1 1 0', minHeight: minHeight ?? 0 }
          : height != null
            ? { flex: `0 0 ${height}px`, minHeight: 0, maxHeight: height }
            : { flex: '0 0 auto', minHeight })
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={1} sx={{ mb: 0.75 }}>
        <Typography
          variant="caption"
          noWrap
          sx={{ fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'text.secondary' }}
        >
          {title}
        </Typography>
        {right}
      </Stack>
      <Box sx={{ minWidth: 0, minHeight: 0, flexGrow: 1, display: 'flex', flexDirection: 'column' }}>{children}</Box>
    </Paper>
  )
}

/** A one-line quiet state for a panel that has nothing (honest) to show. Never an error. */
export function QuietNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Typography variant="caption" color="text.disabled" sx={{ py: 0.5 }}>
      {children}
    </Typography>
  )
}

/** The `~ estimated` chip a panel wears when its numbers came from a downsampled ring. */
export function ApproxChip({ shown, raw }: { shown: number; raw: number }): JSX.Element {
  return (
    <Tooltip
      title={`This fight's event ring was downsampled: ${shown} of ${raw} instants were kept. Numbers below are scaled sample estimates (marked ~); observed maxima are lower bounds and observed minima upper bounds (the true biggest/smallest hit may not be in the sample). The source meter's totals are exact.`}
    >
      <Typography variant="caption" sx={{ color: RESIST_COLOR, whiteSpace: 'nowrap' }}>
        ~ {shown} of {raw} events
      </Typography>
    </Tooltip>
  )
}
