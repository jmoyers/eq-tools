// ============================================================================
// usageRows.ts — DSQL counter rows -> typed values, plus the arithmetic over them.
// ============================================================================
//
// The same split, for the same reason, as `rows.ts` beside it: everything here is PURE (no
// `pg`, no `@aws-sdk/*`, no Electron), so `tests/usageAnalytics.test.mts` drives the whole
// read-time model with authored rows and no credentials.
//
// The interesting decisions live in `./analytics.ts`; this file is the boring half — parse a
// column, key a Map, walk a date. It is separate because the two together are past the repo's
// 400-code-line ceiling and a split is the answer to that, not a widened threshold.

import { DIM_NONE } from '../../shared/telemetryRollup'
import type { UsageDayPoint } from '../../shared/triage'

/** A DSQL row as node-postgres hands it over: every column is `unknown` until proven. */
export type Row = Record<string, unknown>

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
/** `bigint` comes back as a number (store.ts sets the int8 parser); anything else is 0. */
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export interface UsageRow {
  day: string
  metric: string
  dim: string
  n: number
}

export interface FunnelRow {
  day: string
  funnel: string
  step: string
  outcome: string
  appVersion: string
  n: number
}

/**
 * One `analytics_install` row — WITHOUT the id, which the reader never selects (store.ts says
 * why). What is left is population shape: when this install first appeared, when it was last
 * seen, how many distinct days it has been seen on, and what it is running now.
 */
export interface InstallRow {
  firstSeenDay: string
  lastSeenDay: string
  daysSeen: number
  appVersion: string
  channel: string
}

export function toUsageRows(rows: readonly Row[]): UsageRow[] {
  return rows.map((r) => ({
    day: str(r.day),
    metric: str(r.metric),
    dim: str(r.dim, DIM_NONE),
    n: num(r.n)
  }))
}

export function toFunnelRows(rows: readonly Row[]): FunnelRow[] {
  return rows.map((r) => ({
    day: str(r.day),
    funnel: str(r.funnel),
    step: str(r.step),
    outcome: str(r.outcome, DIM_NONE),
    appVersion: str(r.app_version, '?'),
    n: num(r.n)
  }))
}

export function toInstallRows(rows: readonly Row[]): InstallRow[] {
  return rows.map((r) => ({
    firstSeenDay: str(r.first_seen_day),
    lastSeenDay: str(r.last_seen_day),
    daysSeen: num(r.days_seen),
    appVersion: str(r.app_version, '?'),
    channel: str(r.channel, '?')
  }))
}

// ---- days ---------------------------------------------------------------------------
//
// Day keys are UTC `yyyy-mm-dd` strings, which is what the counters are stored on. They sort
// and compare LEXICALLY, which is why every comparison below is `<=` on a string rather than
// arithmetic on a Date — the format makes the cheap thing also the correct thing.

const MS_PER_DAY = 86_400_000

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** `2026-08-04` + 3 → `2026-08-07`. Total: an unparseable key comes back unchanged. */
export function addDays(day: string, delta: number): string {
  const at = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(at) ? dayOf(at + delta * MS_PER_DAY) : day
}

/** Whole days between two keys, or null when either is unparseable. */
export function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / MS_PER_DAY)
}

/** The window's day keys, ascending and DENSE — a day with no rows is a zero, not a gap. */
export function windowDays(nowMs: number, days: number): string[] {
  const today = dayOf(nowMs)
  const span = Math.max(1, Math.floor(days))
  return Array.from({ length: span }, (_, i) => addDays(today, i - (span - 1)))
}

// ---- aggregation --------------------------------------------------------------------

/** Every row for one metric, summed. */
export function sumOf(rows: readonly UsageRow[], metric: string): number {
  return rows.reduce((total, r) => (r.metric === metric ? total + r.n : total), 0)
}

/** One metric's dimensions, summed over the window: `dim -> n`. Insertion order is irrelevant;
 *  every caller sorts. */
export function dimsOf(rows: readonly UsageRow[], metric: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    if (r.metric !== metric) continue
    out.set(r.dim, (out.get(r.dim) ?? 0) + r.n)
  }
  return out
}

/** One metric's daily totals, aligned to `days` so a sparkline's x-axis is the window. */
export function seriesOf(
  rows: readonly UsageRow[],
  metric: string,
  days: readonly string[]
): UsageDayPoint[] {
  const byDay = new Map<string, number>()
  for (const r of rows) {
    if (r.metric !== metric) continue
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.n)
  }
  return days.map((day) => ({ day, n: byDay.get(day) ?? 0 }))
}

/** `dim -> n` as a sorted, typed list. Ties break on the dim so the order is deterministic. */
export function mixRows(counts: Map<string, number>): { id: string; n: number }[] {
  return [...counts.entries()]
    .map(([id, n]) => ({ id, n }))
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id))
}

/** A histogram Map keyed by bucket INDEX (as text) → a dense array, index 0..max. */
export function bucketCounts(counts: Map<string, number>): number[] {
  const indices = [...counts.keys()]
    .map((k) => Number(k))
    .filter((i) => Number.isInteger(i) && i >= 0)
  if (indices.length === 0) return []
  const out = new Array<number>(Math.max(...indices) + 1).fill(0)
  for (const [key, n] of counts) {
    const i = Number(key)
    if (Number.isInteger(i) && i >= 0) out[i] += n
  }
  return out
}

/** x / y, or null when y is zero — a rate with no denominator is not zero, it is unknown. */
export function ratio(x: number, y: number): number | null {
  return y > 0 ? x / y : null
}
