// ============================================================================
// analyticsRows.ts — the Analytics panel's arithmetic, lifted out of the JSX.
// ============================================================================
//
// Same discipline as `dashboardData.ts` and `rows.ts`: anything that DECIDES something —
// what a tile says, how wide a bar is, whether a cell is a number or a dash — is a pure
// function here, so `tests/usageAnalytics.test.mts` can assert it without React, without a
// DOM and without a cluster. The .tsx beside it is then only layout.
//
// THE HONESTY RULES LIVE HERE, because they are formatting decisions:
//   * A null RATE renders as `—`, never as `0%`. "No update has ever been reported" and
//     "every update failed" are opposite facts and must not share a glyph.
//   * A cohort younger than the horizon renders as `—`, not `0`: nobody can have survived to
//     a day that has not happened yet.
//   * Percentages are of a stated base, and the label says which base.

import { formatNum } from '../../lib/formatRate'
import type {
  TriageAnalyticsData,
  TriageFunnelStepRow,
  UsageDayPoint
} from '@shared/triage'

/** `62.5%`. A share is always 0..1 on the way in; anything else is clamped, never rendered raw. */
export function pctLabel(v: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
  // A decimal only where rounding would erase the difference between "a few" and "none":
  // 5.5% and 0.4% are different readings, 62% and 62.4% are the same one.
  if (clamped === 0) return '0%'
  return `${(clamped * 100).toFixed(clamped >= 0.1 ? 0 : 1)}%`
}

/** A rate that may be unknown. THE DASH IS LOAD-BEARING — see the header. */
export function rateLabel(v: number | null): string {
  return v === null ? '—' : pctLabel(v)
}

/** Durations in this panel are session-scale: minutes, or hours once past one. */
export function durationLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—'
  return ms >= 3_600_000
    ? `${(ms / 3_600_000).toFixed(1)} h`
    : `${Math.max(1, Math.round(ms / 60_000)).toString()} min`
}

export interface StatTile {
  label: string
  value: string
  /** One short line under the number saying what it is COUNTING. Never a methodology note. */
  note: string
}

/**
 * The Pulse tiles. WAU/MAU are windows ending at the last day with data, not at today, which
 * is what makes them readable while ingest is dark (analytics.ts explains the choice) — the
 * note says "to the last day with data" so the number cannot be misread as "right now".
 */
export function pulseTiles(d: TriageAnalyticsData): StatTile[] {
  const p = d.pulse
  return [
    { label: 'DAU', value: formatNum(p.dau), note: 'installs on the last day with data' },
    { label: 'WAU', value: formatNum(p.wau), note: '7 days to the last day with data' },
    { label: 'MAU', value: formatNum(p.mau), note: '30 days to the last day with data' },
    { label: 'Installs', value: formatNum(p.installsTotal), note: 'all-time, one row per id' },
    { label: 'Sessions', value: formatNum(p.sessions), note: `${p.sessionsPerDay.toFixed(1)} per active day` },
    {
      label: 'Session length',
      value: p.medianSessionLabel ?? '—',
      note: p.meanSessionMs === null ? 'no session has ended yet' : `median · mean ${durationLabel(p.meanSessionMs)}`
    }
  ]
}

/** A daily series as bare numbers, oldest first — what `sparklinePoints` consumes. */
export function seriesValues(points: readonly UsageDayPoint[]): number[] {
  return points.map((p) => p.n)
}

export interface FunnelBar {
  step: string
  n: number
  /** Bar width as a percentage of the funnel's FIRST step, 0..100. */
  widthPct: number
  conversion: string
  /** Null when nothing was lost at this step — the UI then shows nothing rather than "0%". */
  dropOff: string | null
}

/**
 * The funnel's bars. Width is relative to step 1, so a funnel reads as a shape: the plan's
 * motivating bug ("100% of installs stalling at download started: never") is a full bar
 * followed by an empty one, which is visible at a glance and impossible to misread.
 */
export function funnelBars(steps: readonly TriageFunnelStepRow[]): FunnelBar[] {
  return steps.map((s) => ({
    step: s.step,
    n: s.n,
    widthPct: Math.max(0, Math.min(1, s.conversion)) * 100,
    conversion: pctLabel(s.conversion),
    dropOff: s.dropOff > 0 ? `−${pctLabel(s.dropOff)}` : null
  }))
}

/** `12 (48%)`, or `—` for a cohort that has not reached the horizon yet. */
export function cohortCell(survivors: number | null, cohortSize: number): string {
  if (survivors === null) return '—'
  return `${formatNum(survivors)} (${pctLabel(cohortSize > 0 ? survivors / cohortSize : 0)})`
}

/**
 * "Is there anything at all to look at?" — asked of the BUILT data rather than of the row
 * arrays, so the panel and the CLI agree on when to show the "no data yet" note.
 *
 * It is deliberately NOT `data.empty`: a window can be empty while the tables hold older rows
 * (`installsTotal > 0`), and that is a different sentence — "nothing in this window" rather
 * than "nothing ever".
 */
export function windowIsEmpty(d: TriageAnalyticsData): boolean {
  return d.pulse.sessions === 0 && d.pulse.dau === 0 && d.pulse.installsTotal === 0
}
