/**
 * analyticsDigest.mts — `triage-feedback analytics digest`, as a pure renderer.
 *
 * Surface 3 of the four in docs/plans/usage-analytics.md §1: "the same pulse/adoption/funnel/
 * health numbers as text, for the terminal". SAME NUMBERS, literally: this file renders the
 * `TriageAnalyticsData` that `src/main/triage/analytics.ts` builds, which is the same value the
 * Analytics panel renders. Two views, one computation — the CLI cannot disagree with the tab.
 *
 * PURE, like `triageCluster.mts` beside it: it takes a value and returns a string, touches no
 * database and no clock, so `tests/usageAnalytics.test.mts` asserts the output directly.
 *
 * THE FORMAT IS FIXED-WIDTH TEXT, not markdown. `digest` (the feedback one) renders markdown
 * because its output is meant to be pasted to a model; this output is meant to be READ in a
 * terminal, and a table of numbers reads better aligned than fenced.
 */

import type {
  TriageAnalyticsData,
  TriageFunnelStepRow,
  TriageMixRow
} from '../src/shared/triage'

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

/** Durations read in minutes here: a session is minutes, and `formatMs` lives in the renderer. */
function minutes(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 60_000).toFixed(1)} min`
}

function bar(label: string, n: number, max: number, width = 24): string {
  const filled = max > 0 ? Math.round((n / max) * width) : 0
  return `  ${label.padEnd(22)} ${String(n).padStart(8)}  ${'█'.repeat(filled)}`
}

/** A `dim -> n` list as a bar chart, capped. Empty renders as one honest line. */
function mixBlock(rows: readonly TriageMixRow[], limit = 10): string[] {
  if (rows.length === 0) return ['  (nothing recorded)']
  const max = Math.max(...rows.map((r) => r.n))
  return rows.slice(0, limit).map((r) => bar(r.id, r.n, max))
}

function funnelBlock(steps: readonly TriageFunnelStepRow[]): string[] {
  if (steps.length === 0) return ['  (no steps declared)']
  return steps.map(
    (s) =>
      `  ${s.step.padEnd(22)} ${String(s.n).padStart(8)}  ${pct(s.conversion).padStart(7)} of step 1` +
      (s.dropOff > 0 ? `  (−${pct(s.dropOff)} here)` : '')
  )
}

function pulseLines(d: TriageAnalyticsData): string[] {
  const p = d.pulse
  return [
    'PULSE',
    `  DAU ${String(p.dau)} · WAU ${String(p.wau)} · MAU ${String(p.mau)} · installs all-time ${String(p.installsTotal)}`,
    `  sessions ${String(p.sessions)} (${p.sessionsPerDay.toFixed(1)}/day on days with data)`,
    `  session length: mean ${minutes(p.meanSessionMs)} · median ${p.medianSessionLabel ?? '—'}`,
  ]
}

function adoptionLines(d: TriageAnalyticsData): string[] {
  const a = d.adoption
  const views = a.views
    .slice(0, 8)
    .map((v) => `  ${v.id.padEnd(22)} ${pct(v.share).padStart(7)} of dwell · ${String(v.visits)} visits`)
  const features =
    a.features.length === 0
      ? ['  (nothing recorded)']
      : a.features
          .slice(0, 12)
          .map(
            (f) =>
              `  ${f.id.padEnd(22)} ${String(f.uses).padStart(8)} uses · ${f.perSession.toFixed(2)}/session`
          )
  return [
    '',
    'ADOPTION',
    '  views by dwell share',
    ...(views.length > 0 ? views : ['  (nothing recorded)']),
    '  features (uses, not reach — see src/main/triage/analytics.ts)',
    ...features,
    '  overlays opened',
    ...mixBlock(a.overlays),
    '  voice engine',
    ...mixBlock(a.voice),
    `  alerts fired ${String(a.alertsFired)} · spoken ${String(a.alertsSpoken)}`,
  ]
}

function funnelLines(d: TriageAnalyticsData): string[] {
  const out: string[] = ['', 'FUNNELS']
  for (const f of d.funnels) {
    out.push(`  ${f.funnel}`)
    out.push(...funnelBlock(f.steps))
    if (f.failures.length > 0) {
      out.push('    failures')
      out.push(...f.failures.slice(0, 6).map((x) => `      ${x.id.padEnd(28)} ${String(x.n)}`))
    }
  }
  return out
}

function healthLines(d: TriageAnalyticsData): string[] {
  const h = d.health
  return [
    '',
    'HEALTH',
    `  health rollups received: ${String(h.reports)}`,
    ...mixBlock(h.errors),
    '  update outcomes',
    ...h.update.map(
      (u) =>
        `  ${u.step.padEnd(22)} ok ${String(u.ok).padStart(6)} · failed ${String(u.failed).padStart(6)}` +
        ` · ${u.rate === null ? '—' : pct(u.rate)}`
    ),
    ...(h.updateFailures.length > 0
      ? ['  update failure classes', ...mixBlock(h.updateFailures, 6)]
      : []),
  ]
}

function versionLines(d: TriageAnalyticsData): string[] {
  if (d.versions.length === 0) return ['', 'VERSIONS', '  (nothing recorded)']
  return [
    '',
    'VERSIONS',
    ...d.versions
      .slice(0, 10)
      .map(
        (v) =>
          `  ${v.version.padEnd(14)} ${String(v.installs).padStart(6)} installs · peak ${pct(v.peakShare).padStart(7)}` +
          ` · first ${v.firstSeenDay ?? '—'} · majority ${v.majorityDay ?? '—'}` +
          ` · ${v.daysToAdopt === null ? 'not adopted' : `${String(v.daysToAdopt)}d to adopt`}`
      ),
  ]
}

function retentionLines(d: TriageAnalyticsData): string[] {
  if (d.retention.length === 0) return ['', 'RETENTION', '  (no cohorts yet)']
  const cell = (v: number | null, of: number): string =>
    v === null ? '   —  ' : `${String(v).padStart(3)} ${pct(of > 0 ? v / of : 0).padStart(6)}`
  return [
    '',
    'RETENTION (survival: first seen on the day, still seen on or after +N)',
    '  cohort       installs        D1            D7           D30',
    ...d.retention.map(
      (c) =>
        `  ${c.cohortDay}  ${String(c.installs).padStart(6)}  ${cell(c.d1, c.installs)}  ` +
        `${cell(c.d7, c.installs)}  ${cell(c.d30, c.installs)}`
    ),
  ]
}

/**
 * The whole digest. The header states the window and, when the tables are empty, SAYS SO in
 * one line before printing the zeros — the numbers below it are then read as "nothing has
 * arrived", which is what they mean, rather than as "everybody left".
 */
export function renderAnalyticsDigest(d: TriageAnalyticsData): string {
  const head = [
    `usage analytics — last ${String(d.windowDays)} days (${d.days[0] ?? '?'} → ${d.days.at(-1) ?? '?'})`,
    d.empty
      ? 'NO DATA YET: the tables exist and are empty. Every number below is a true zero.'
      : '',
    '',
  ].filter((line, i) => i !== 1 || line.length > 0)
  return [
    ...head,
    ...pulseLines(d),
    ...adoptionLines(d),
    ...funnelLines(d),
    ...healthLines(d),
    ...versionLines(d),
    ...retentionLines(d),
    '',
  ].join('\n')
}

