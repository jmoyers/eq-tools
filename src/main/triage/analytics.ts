// ============================================================================
// analytics.ts — the counters, read back as the six sections the panel renders.
// ============================================================================
//
// PURE, and that is the whole point of the file. Every number the Analytics tab shows is
// computed here from three arrays of plain rows, so `tests/usageAnalytics.test.mts` can author
// a population by hand and assert the arithmetic — no cluster, no credentials, no fixtures.
//
// THE RULE THIS FILE OBEYS, and it is world-model law 1 wearing a different hat: CLAIM ONLY
// WHAT THE TABLES CAN ANSWER. `src/shared/telemetryRollup.ts`'s header enumerates what daily
// anonymous counters structurally cannot say; the shapes in `src/shared/triage.ts` were cut to
// fit that, and the places where the plan asked for something un-derivable are labelled rather
// than approximated:
//
//   * per-feature REACH becomes uses + uses-per-session;
//   * MEDIAN session length is a bucket RANGE;
//   * RETENTION is survival ("first seen on D, still seen on or after D+N"), because no
//     per-day-per-id row exists to answer "came back exactly on D+N".
//
// EMPTY IS A REAL ANSWER. Every section below returns zeros and empty lists for an empty
// window rather than throwing or short-circuiting, so the panel can render honest zeros and
// say "no data yet" — a state that is genuinely different from "the tables do not exist".

import {
  medianBucket,
  sessionBucketLabel,
  USAGE_METRICS
} from '../../shared/telemetryRollup'
import { TELEMETRY_FUNNEL_STEPS } from '../../shared/telemetry'
import type {
  TriageAnalyticsAdoption,
  TriageAnalyticsData,
  TriageAnalyticsHealth,
  TriageAnalyticsPulse,
  TriageCohortRow,
  TriageFunnelStepRow,
  TriageFunnelView,
  TriageUpdateRow,
  TriageVersionRow
} from '../../shared/triage'
import {
  addDays,
  bucketCounts,
  dayOf,
  daysBetween,
  dimsOf,
  mixRows,
  ratio,
  seriesOf,
  sumOf,
  windowDays,
  type FunnelRow,
  type InstallRow,
  type UsageRow
} from './usageRows'

export interface AnalyticsInput {
  usage: readonly UsageRow[]
  funnels: readonly FunnelRow[]
  installs: readonly InstallRow[]
  windowDays: number
  nowMs: number
}

/**
 * The funnel step lists, indexed by a STRING rather than by the schema's own union: this file
 * reads a funnel name out of a database row, and a row can hold a funnel the current schema no
 * longer declares. `Partial` is what makes "no such funnel" a value (an empty curve) instead
 * of a type error that could only be silenced by lying about the lookup.
 */
const FUNNEL_STEPS: Partial<Record<string, readonly string[]>> = TELEMETRY_FUNNEL_STEPS

/** The three update steps, in the order they happen. */
const UPDATE_STEPS = ['check', 'download', 'apply'] as const

// ---- pulse ---------------------------------------------------------------------------

/**
 * The reference day for WAU/MAU is the LAST DAY WITH DATA, not today.
 *
 * Anchoring on today would make every window look like it ends in a cliff whenever ingest is
 * quiet — including right now, when the endpoint is dark and the last day with data may be
 * weeks old. "Active in the 7 days up to the last day anything happened" is the question a
 * human is actually asking of a backlog they are looking at after the fact.
 */
function referenceDay(usage: readonly UsageRow[], installs: readonly InstallRow[], nowMs: number): string {
  const lastUsage = usage.reduce((max, r) => (r.n > 0 && r.day > max ? r.day : max), '')
  const lastInstall = installs.reduce((max, r) => (r.lastSeenDay > max ? r.lastSeenDay : max), '')
  const best = lastUsage > lastInstall ? lastUsage : lastInstall
  return best.length > 0 ? best : dayOf(nowMs)
}

function activeWithin(installs: readonly InstallRow[], ref: string, days: number): number {
  const floor = addDays(ref, -(days - 1))
  return installs.filter((i) => i.lastSeenDay >= floor && i.lastSeenDay <= ref).length
}

function buildPulse(input: AnalyticsInput, days: string[], ref: string): TriageAnalyticsPulse {
  const { usage, installs } = input
  const activeSeries = seriesOf(usage, USAGE_METRICS.activeInstalls, days)
  const sessionSeries = seriesOf(usage, USAGE_METRICS.sessions, days)
  const sessions = sessionSeries.reduce((sum, p) => sum + p.n, 0)
  // The denominator is DAYS WITH DATA, not the window: dividing a week of use by 365 to satisfy
  // a `--days 365` flag would understate every install that has not existed for a year.
  const liveDays = new Set(usage.filter((r) => r.n > 0).map((r) => r.day)).size
  const ends = sumOf(usage, USAGE_METRICS.sessionEnds)
  const totalMs = sumOf(usage, USAGE_METRICS.sessionMsTotal)
  const median = medianBucket(bucketCounts(dimsOf(usage, USAGE_METRICS.sessionLenBucket)))
  return {
    dau: activeSeries.reduce((last, p) => (p.n > 0 ? p.n : last), 0),
    wau: activeWithin(installs, ref, 7),
    mau: activeWithin(installs, ref, 30),
    installsTotal: installs.length,
    sessions,
    sessionsPerDay: ratio(sessions, liveDays) ?? 0,
    meanSessionMs: ratio(totalMs, ends),
    medianSessionLabel: median < 0 ? null : sessionBucketLabel(median),
    activeSeries,
    sessionSeries
  }
}

// ---- adoption ------------------------------------------------------------------------

function buildAdoption(usage: readonly UsageRow[], sessions: number): TriageAnalyticsAdoption {
  const dwell = dimsOf(usage, USAGE_METRICS.viewDwellMs)
  const visits = dimsOf(usage, USAGE_METRICS.viewVisits)
  const totalDwell = [...dwell.values()].reduce((sum, n) => sum + n, 0)
  return {
    features: mixRows(dimsOf(usage, USAGE_METRICS.featureUse)).map((f) => ({
      id: f.id,
      uses: f.n,
      perSession: ratio(f.n, sessions) ?? 0
    })),
    views: mixRows(dwell).map((v) => ({
      id: v.id,
      dwellMs: v.n,
      visits: visits.get(v.id) ?? 0,
      share: ratio(v.n, totalDwell) ?? 0
    })),
    overlays: mixRows(dimsOf(usage, USAGE_METRICS.overlayOpen)),
    voice: mixRows(dimsOf(usage, USAGE_METRICS.setupVoice)),
    cursorRing: mixRows(dimsOf(usage, USAGE_METRICS.setupCursorRing)),
    autoHide: mixRows(dimsOf(usage, USAGE_METRICS.setupAutoHide)),
    alertsFired: sumOf(usage, USAGE_METRICS.alertsFired),
    alertsSpoken: sumOf(usage, USAGE_METRICS.alertsSpoken)
  }
}

// ---- funnels -------------------------------------------------------------------------

/**
 * One funnel's curve. THE STEP ORDER IS THE SCHEMA'S, not the data's: `TELEMETRY_FUNNEL_STEPS`
 * declares each funnel's steps in order, and that order IS the funnel (plan §3). Ordering by
 * observed count instead would produce a monotonically decreasing curve by construction and
 * could never show the thing worth seeing — a step where more events arrive than the one
 * before it, which means the instrument is wrong.
 *
 * A step with no rows is a ZERO in the curve, not a missing entry: "100% of installs stalled at
 * download-started: never" (the plan's motivating bug) is exactly a step whose count is 0.
 */
function stepRows(funnel: string, counts: Map<string, number>): TriageFunnelStepRow[] {
  const steps = FUNNEL_STEPS[funnel] ?? []
  const first = counts.get(steps[0] ?? '') ?? 0
  let previous = first
  return steps.map((step) => {
    const n = counts.get(step) ?? 0
    const row: TriageFunnelStepRow = {
      step,
      n,
      conversion: ratio(n, first) ?? 0,
      dropOff: previous > 0 ? Math.max(0, 1 - n / previous) : 0
    }
    previous = n
    return row
  })
}

function countSteps(rows: readonly FunnelRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) out.set(r.step, (out.get(r.step) ?? 0) + r.n)
  return out
}

/** Versions are capped: a funnel with twenty historical versions is a table nobody reads. */
const MAX_FUNNEL_VERSIONS = 5

function buildFunnel(funnel: string, rows: readonly FunnelRow[], usage: readonly UsageRow[]): TriageFunnelView {
  const versions = [...new Set(rows.map((r) => r.appVersion))]
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .slice(0, MAX_FUNNEL_VERSIONS)
  const failures = mixRows(dimsOf(usage, USAGE_METRICS.funnelFailure))
    .filter((f) => f.id.startsWith(`${funnel}:`))
    .map((f) => ({ id: f.id.slice(funnel.length + 1), n: f.n }))
  return {
    funnel,
    steps: stepRows(funnel, countSteps(rows)),
    byVersion: versions.map((version) => ({
      version,
      steps: stepRows(funnel, countSteps(rows.filter((r) => r.appVersion === version)))
    })),
    failures
  }
}

/**
 * EVERY funnel in the schema gets a view, even one with no rows at all. A funnel that is
 * missing from the panel reads as "we do not measure that"; a funnel of zeros reads as "we
 * measure it and nobody got there", which is the true statement and the more alarming one.
 */
function buildFunnels(funnels: readonly FunnelRow[], usage: readonly UsageRow[]): TriageFunnelView[] {
  return Object.keys(TELEMETRY_FUNNEL_STEPS).map((funnel) =>
    buildFunnel(funnel, funnels.filter((r) => r.funnel === funnel), usage)
  )
}

// ---- health --------------------------------------------------------------------------

function updateRows(counts: Map<string, number>): TriageUpdateRow[] {
  return UPDATE_STEPS.map((step) => {
    const ok = counts.get(`${step}:ok`) ?? 0
    const failed = counts.get(`${step}:failed`) ?? 0
    return { step, ok, failed, rate: ratio(ok, ok + failed) }
  })
}

function buildHealth(usage: readonly UsageRow[]): TriageAnalyticsHealth {
  return {
    errors: mixRows(dimsOf(usage, USAGE_METRICS.health)),
    reports: sumOf(usage, USAGE_METRICS.healthReports),
    update: updateRows(dimsOf(usage, USAGE_METRICS.update)),
    updateFailures: mixRows(dimsOf(usage, USAGE_METRICS.updateFailure))
  }
}

// ---- versions ------------------------------------------------------------------------

/**
 * DAYS-TO-ADOPT WITHOUT A RELEASE DATE. Nothing in this schema knows when a version was
 * published, so "how long did it take to land" is measured from the day the fleet FIRST
 * REPORTED it to the day it first carried more than half of that day's active installs. That is
 * a slightly different question than the plan's wording and a strictly answerable one; a
 * version that has never reached a majority reports null rather than a guess.
 */
function adoptionDays(
  version: string,
  usage: readonly UsageRow[],
  activeByDay: Map<string, number>
): Pick<TriageVersionRow, 'peakShare' | 'firstSeenDay' | 'majorityDay' | 'daysToAdopt'> {
  const rows = usage
    .filter((r) => r.metric === USAGE_METRICS.version && r.dim === version && r.n > 0)
    .sort((a, b) => a.day.localeCompare(b.day))
  let peakShare = 0
  let majorityDay: string | null = null
  for (const r of rows) {
    const share = ratio(r.n, activeByDay.get(r.day) ?? 0) ?? 0
    if (share > peakShare) peakShare = share
    if (majorityDay === null && share > 0.5) majorityDay = r.day
  }
  const firstSeenDay = rows[0]?.day ?? null
  return {
    peakShare,
    firstSeenDay,
    majorityDay,
    daysToAdopt:
      firstSeenDay !== null && majorityDay !== null ? daysBetween(firstSeenDay, majorityDay) : null
  }
}

function buildVersions(usage: readonly UsageRow[], installs: readonly InstallRow[]): TriageVersionRow[] {
  const activeByDay = new Map<string, number>()
  for (const r of usage) {
    if (r.metric !== USAGE_METRICS.activeInstalls) continue
    activeByDay.set(r.day, (activeByDay.get(r.day) ?? 0) + r.n)
  }
  const current = new Map<string, number>()
  for (const i of installs) current.set(i.appVersion, (current.get(i.appVersion) ?? 0) + 1)
  // The union: a version can appear in the counters (somebody ran it in the window) without
  // appearing in `analytics_install` (nobody is on it any more), and vice versa.
  const names = new Set([...current.keys(), ...dimsOf(usage, USAGE_METRICS.version).keys()])
  return [...names]
    .map((version) => ({
      version,
      installs: current.get(version) ?? 0,
      ...adoptionDays(version, usage, activeByDay)
    }))
    .sort((a, b) => b.installs - a.installs || b.version.localeCompare(a.version, undefined, { numeric: true }))
}

// ---- retention -----------------------------------------------------------------------

/** Cohorts shown, newest last. More than this is a table, not a signal. */
const MAX_COHORTS = 14

/**
 * SURVIVAL, NOT RETURN. `analytics_install` carries first-seen and LAST-seen, so what is
 * answerable is "of the installs that first appeared on day D, how many were still being seen
 * on or after D+N". Classic D1/D7/D30 retention ("came back ON that day") would need a per-day
 * per-id row, which is precisely the trail T6 refuses to keep. The panel's label says survival;
 * the field names stay d1/d7/d30 because that is what the plan asked for and what a reader
 * recognises.
 *
 * A cohort YOUNGER than N days reports null, never 0: nobody could have survived to a day that
 * has not happened, and a zero there would read as a catastrophic drop-off.
 */
function buildRetention(installs: readonly InstallRow[], ref: string): TriageCohortRow[] {
  const byCohort = new Map<string, InstallRow[]>()
  for (const i of installs) {
    if (i.firstSeenDay.length === 0) continue
    const held = byCohort.get(i.firstSeenDay)
    if (held) held.push(i)
    else byCohort.set(i.firstSeenDay, [i])
  }
  const survivors = (rows: InstallRow[], cohortDay: string, n: number): number | null => {
    const mark = addDays(cohortDay, n)
    if (mark > ref) return null
    return rows.filter((r) => r.lastSeenDay >= mark).length
  }
  return [...byCohort.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-MAX_COHORTS)
    .map(([cohortDay, rows]) => ({
      cohortDay,
      installs: rows.length,
      d1: survivors(rows, cohortDay, 1),
      d7: survivors(rows, cohortDay, 7),
      d30: survivors(rows, cohortDay, 30)
    }))
}

// ---- assembly ------------------------------------------------------------------------

/**
 * The whole readout, from three arrays of rows. Deterministic and side-effect free: the same
 * rows and the same `nowMs` always produce the same answer, which is what lets the panel's
 * numbers be asserted rather than eyeballed.
 */
export function buildAnalytics(input: AnalyticsInput): TriageAnalyticsData {
  const days = windowDays(input.nowMs, input.windowDays)
  const ref = referenceDay(input.usage, input.installs, input.nowMs)
  const pulse = buildPulse(input, days, ref)
  return {
    windowDays: days.length,
    days,
    empty: input.usage.length === 0 && input.funnels.length === 0 && input.installs.length === 0,
    pulse,
    adoption: buildAdoption(input.usage, pulse.sessions),
    funnels: buildFunnels(input.funnels, input.usage),
    health: buildHealth(input.usage),
    versions: buildVersions(input.usage, input.installs),
    retention: buildRetention(input.installs, ref)
  }
}
