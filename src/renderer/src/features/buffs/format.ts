// Small formatting helpers for BuffsView (kept out of the component for reuse/testing).

/**
 * Format a millisecond duration compactly: seconds under a minute, m:ss under an
 * hour, h:mm above. Null/≤0 renders as an em-dash.
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (totalMin < 60) return `${totalMin}m ${sec.toString().padStart(2, '0')}s`
  const hr = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return `${hr}h ${min.toString().padStart(2, '0')}m`
}

/**
 * Fraction of the estimated window still remaining (1 = just landed, 0 = expired),
 * clamped to [0,1]. Used to drive the progress bar. `estimatedMs` must be > 0.
 */
export function remainingFraction(elapsedMs: number, estimatedMs: number): number {
  if (estimatedMs <= 0) return 0
  const frac = 1 - elapsedMs / estimatedMs
  return frac < 0 ? 0 : frac > 1 ? 1 : frac
}

/**
 * True when a buff has run past its expected window (Task #30): elapsed exceeds the
 * p75 of observed durations, with at least 2 samples backing the estimate. Used to
 * flip the remaining-time from a (would-be-negative) countdown to a subtle "overdue"
 * hint. `p75`/`n` come straight off the ActiveBuff; null p75 or n<2 → not overdue.
 */
export function isOverdue(elapsedMs: number, p75: number | null, n: number): boolean {
  return p75 != null && n >= 2 && elapsedMs > p75
}

import type { ActiveBuff, BuffClass } from '@shared/types'

/**
 * The left-border accent color (an MUI theme path) for a buff-class (Task #35). A DEBUFF
 * (detrimental, cast on a hostile) is visually distinct with a red-ish accent so the user
 * never confuses a slow on an enemy with their own buff; beneficial buffs read gold.
 * NOTE (Task #35): the accent is a SPELL property (buff vs debuff), NOT who it's on — a
 * buff on the pet is not a different color from a buff on the player.
 */
export function classAccent(cls: BuffClass): string {
  return cls === 'debuff' ? 'error.main' : 'warning.main'
}

/**
 * The group key for the UI's PRIORITY layout (Task #35): self buffs first ('self'), then
 * one group per bound entity (the current pet naturally tops the per-entity list). Debuffs
 * on hostile mobs sit in their target's group but are styled distinct by `classAccent`.
 */
export function groupKey(b: ActiveBuff): string {
  return b.self ? 'self' : b.target ?? 'other'
}

/** Human label for an entity group header. */
export function groupLabel(key: string): string {
  return key === 'self' ? 'Your buffs' : key === 'other' ? 'Other targets' : key
}
