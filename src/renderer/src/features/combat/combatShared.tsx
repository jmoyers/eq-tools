// Presentational primitives shared by the combat meter and the dashboard panels.
// Extracted from CombatView so both surfaces render the SAME bar, the SAME category
// colors and the SAME card chrome (one look, one source of truth).

import type { ReactNode } from 'react'
import { Box, Paper, Stack, Tooltip, Typography } from '@mui/material'
import type { DamageCategory } from '@shared/combat'
import { formatNum as fmt } from '../../lib/formatRate'
import type { FlatSkill } from './dashboardData'

export const KIND_COLOR: Record<string, string> = { you: '#d9b25f', pet: '#6fb3d2', enemy: '#cf6679' }

/** Category colors — the drill-down's ONLY grouping cue now that the category nav level is gone. */
export const CAT_COLOR: Record<DamageCategory, string> = {
  melee: '#d9b25f',
  slay: '#e8d48a',
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
 * One flat skill/spell row, colored by its parent category (fill + left stripe).
 * `approx` prefixes the derived numbers with `~` — used by the mob-filtered list when the
 * encounter's event ring was downsampled (the numbers are then sample estimates).
 */
export function SkillBar({ s, approx }: { s: FlatSkill; approx?: boolean }): JSX.Element {
  const color = CAT_COLOR[s.category]
  const resists = s.resists ?? 0
  const casts = s.hits + resists
  const a = approx ? '~' : ''
  // A spell/dot lane can carry resists (Task #51 v2). Show a resist-rate badge and,
  // for a lane that only ever resisted (0 hits), a resist-only right-hand summary.
  return (
    <Bar
      color={color}
      accent={color}
      pct={s.pct}
      name={
        <>
          {s.name}
          {resists > 0 && casts > 0 && (
            <Tooltip
              title={`${resists} resisted of ${casts} cast${casts === 1 ? '' : 's'} — ${Math.round(
                (s.hits / casts) * 100
              )}% landed`}
            >
              <Typography component="span" variant="caption" sx={{ ml: 0.5, color: RESIST_COLOR }}>
                {Math.round((resists / casts) * 100)}% resist
              </Typography>
            </Tooltip>
          )}
        </>
      }
      right={
        s.hits > 0
          ? `${a}${fmt(s.total)} · ${a}${s.hits} hits${s.crits ? ` · ${a}${s.crits} crit` : ''} · max ${fmt(s.max)}`
          : `${a}${resists} resisted · 0 landed`
      }
    />
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
  minHeight
}: {
  title: string
  right?: ReactNode
  children: ReactNode
  /** let the card absorb leftover column height (its body scrolls). */
  grow?: boolean
  minHeight?: number
}): JSX.Element {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        ...(grow ? { flex: '1 1 0', minHeight: minHeight ?? 0 } : { flex: '0 0 auto', minHeight })
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
      title={`This fight's event ring was downsampled: ${shown} of ${raw} instants were kept. Numbers below are scaled sample estimates (marked ~); observed maxima are lower bounds. The source meter's totals are exact.`}
    >
      <Typography variant="caption" sx={{ color: RESIST_COLOR, whiteSpace: 'nowrap' }}>
        ~ {shown} of {raw} events
      </Typography>
    </Tooltip>
  )
}
