// The READ half of usage analytics: three tables of rows -> the six sections the Analytics tab
// and `triage-feedback analytics digest` render (docs/plans/usage-analytics.md A3).
//
// Everything under test is pure — `src/main/triage/usageRows.ts`, `src/main/triage/analytics.ts`,
// the panel's `analyticsRows.ts` and `scripts/analyticsDigest.mts` — so a whole population can
// be authored by hand here and the arithmetic asserted exactly. No AWS, no Electron, no
// fixtures, no clock: this suite never skips and never flakes.
//
// FOUR CLAIMS IT DEFENDS, and each one is a place the panel could quietly lie:
//
//   1. WHAT THE TABLES CANNOT ANSWER IS NOT ANSWERED. WAU/MAU and retention come from
//      `analytics_install` (never from summing daily counters — an install active on two days
//      would be counted twice), the median is a BUCKET RANGE, and a cohort younger than its
//      horizon reports null rather than a zero that reads as total churn.
//   2. EMPTY IS ZEROS, NOT A CRASH AND NOT A GAP. Every section survives empty input, and a day
//      inside the window with no rows is a zero in the series so the sparkline's x-axis is time.
//   3. A FUNNEL'S ORDER IS THE SCHEMA'S. Steps come from TELEMETRY_FUNNEL_STEPS in declared
//      order and a step with no rows is a ZERO IN THE CURVE — that is the shape of the exact
//      bug the plan was written around ("download started: never").
//   4. THE DASH IS LOAD-BEARING. An unknown rate renders as `—`; only a measured zero is `0%`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAnalytics } from '../src/main/triage/analytics'
import {
  addDays,
  bucketCounts,
  daysBetween,
  dimsOf,
  seriesOf,
  sumOf,
  toFunnelRows,
  toInstallRows,
  toUsageRows,
  windowDays,
  type FunnelRow,
  type InstallRow,
  type UsageRow
} from '../src/main/triage/usageRows'
import { USAGE_METRICS } from '../src/shared/telemetryRollup'
import {
  cohortCell,
  durationLabel,
  funnelBars,
  pctLabel,
  pulseTiles,
  rateLabel,
  seriesValues,
  windowIsEmpty
} from '../src/renderer/src/features/triage/analyticsRows'
import { renderAnalyticsDigest } from '../scripts/analyticsDigest.mjs'

/** A fixed "now" so every day key in this suite is stable. */
const NOW = Date.UTC(2026, 7, 10, 12, 0, 0)
const TODAY = '2026-08-10'
const day = (back: number): string => addDays(TODAY, -back)

const u = (d: string, metric: string, dim: string, n: number): UsageRow => ({ day: d, metric, dim, n })
/** A funnel row. Named fields rather than five positionals — the repo's max-params is 4. */
function funnelRow(r: Partial<FunnelRow> & { funnel: string; step: string; n: number }): FunnelRow {
  return {
    day: r.day ?? TODAY,
    funnel: r.funnel,
    step: r.step,
    outcome: r.outcome ?? '-',
    appVersion: r.appVersion ?? '0.2.0',
    n: r.n
  }
}

const f = (d: string, funnel: string, step: string, n: number): FunnelRow =>
  funnelRow({ day: d, funnel, step, n })
const install = (first: string, last: string, appVersion = '0.2.0'): InstallRow => ({
  firstSeenDay: first,
  lastSeenDay: last,
  daysSeen: 1,
  appVersion,
  channel: 'prod'
})

const build = (
  usage: UsageRow[] = [],
  funnels: FunnelRow[] = [],
  installs: InstallRow[] = [],
  days = 30
) => buildAnalytics({ usage, funnels, installs, windowDays: days, nowMs: NOW })

// ---- row mapping ---------------------------------------------------------------------------

test('column mapping is TOTAL: a missing or wrong-typed column becomes a default, never a throw', () => {
  assert.deepEqual(toUsageRows([{ day: '2026-08-01', metric: 'sessions', dim: null, n: '12' }]), [
    // `n` arrives as a number (store.ts sets the int8 parser); a string is not trusted into one.
    { day: '2026-08-01', metric: 'sessions', dim: '-', n: 0 }
  ])
  assert.deepEqual(toFunnelRows([{}]), [
    { day: '', funnel: '', step: '', outcome: '-', appVersion: '?', n: 0 }
  ])
  assert.deepEqual(toInstallRows([{ days_seen: 3 }]), [
    { firstSeenDay: '', lastSeenDay: '', daysSeen: 3, appVersion: '?', channel: '?' }
  ])
})

test('THE ID IS NEVER MAPPED: an install row carries population facts and nothing else', () => {
  const rows = toInstallRows([
    { analytics_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', first_seen_day: '2026-08-01', last_seen_day: '2026-08-02' }
  ])
  assert.equal(JSON.stringify(rows).includes('3f2504e0'), false)
})

test('day arithmetic is lexical and total', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addDays('not-a-day', 3), 'not-a-day')
  assert.equal(daysBetween('2026-08-01', '2026-08-08'), 7)
  assert.equal(daysBetween('nope', '2026-08-08'), null)
  const w = windowDays(NOW, 3)
  assert.deepEqual(w, ['2026-08-08', '2026-08-09', TODAY])
})

test('a series is DENSE over the window — a quiet day is a zero, not a missing point', () => {
  const days = windowDays(NOW, 3)
  assert.deepEqual(seriesOf([u(TODAY, 'sessions', '-', 4)], 'sessions', days), [
    { day: '2026-08-08', n: 0 },
    { day: '2026-08-09', n: 0 },
    { day: TODAY, n: 4 }
  ])
  assert.equal(sumOf([u(TODAY, 'sessions', '-', 4), u(TODAY, 'other', '-', 9)], 'sessions'), 4)
  assert.deepEqual([...dimsOf([u(TODAY, 'm', 'a', 1), u(day(1), 'm', 'a', 2)], 'm')], [['a', 3]])
  assert.deepEqual(bucketCounts(new Map([['2', 5], ['0', 1]])), [1, 0, 5])
  assert.deepEqual(bucketCounts(new Map([['nope', 5]])), [])
})

// ---- pulse ------------------------------------------------------------------------------------

test('DAU is the last day WITH DATA; WAU/MAU come from the install table, never from sums', () => {
  const usage = [
    u(day(9), USAGE_METRICS.activeInstalls, '-', 3),
    u(day(2), USAGE_METRICS.activeInstalls, '-', 5)
  ]
  const installs = [
    install(day(40), day(2)), // active 2 days before the reference day
    install(day(40), day(3)),
    install(day(40), day(9)), // inside 30 days, outside 7
    install(day(60), day(45)) // outside both
  ]
  const d = build(usage, [], installs)
  assert.equal(d.pulse.dau, 5, 'the last day with a reading, not the last day of the window')
  assert.equal(d.pulse.wau, 2)
  assert.equal(d.pulse.mau, 3)
  assert.equal(d.pulse.installsTotal, 4)
  // Summing the daily counters would say 8 — which is the double-count WAU exists to avoid.
  assert.notEqual(d.pulse.wau, 8)
})

test('session length is a mean AND a bucket median, and neither is invented from nothing', () => {
  const empty = build().pulse
  assert.equal(empty.meanSessionMs, null, 'no session has ended: unknown, not zero')
  assert.equal(empty.medianSessionLabel, null)

  const d = build([
    u(TODAY, USAGE_METRICS.sessionEnds, '-', 4),
    u(TODAY, USAGE_METRICS.sessionMsTotal, '-', 40 * 60_000),
    u(TODAY, USAGE_METRICS.sessionLenBucket, '3', 3),
    u(TODAY, USAGE_METRICS.sessionLenBucket, '5', 1)
  ]).pulse
  assert.equal(d.meanSessionMs, 10 * 60_000)
  assert.equal(d.medianSessionLabel, '15 min–30 min')
})

test('sessions per day divides by days WITH DATA, not by the window the caller asked for', () => {
  const usage = [
    u(day(1), USAGE_METRICS.sessions, '-', 4),
    u(TODAY, USAGE_METRICS.sessions, '-', 6)
  ]
  // 10 sessions over 2 days that reported — asking for 365 days must not make it 0.03.
  assert.equal(build(usage, [], [], 365).pulse.sessionsPerDay, 5)
})

// ---- adoption ----------------------------------------------------------------------------------

test('view dwell share is of TOTAL dwell, and features report uses + uses-per-session', () => {
  const d = build([
    u(TODAY, USAGE_METRICS.sessions, '-', 10),
    u(TODAY, USAGE_METRICS.viewDwellMs, 'combat', 75_000),
    u(TODAY, USAGE_METRICS.viewVisits, 'combat', 5),
    u(TODAY, USAGE_METRICS.viewDwellMs, 'maps', 25_000),
    u(TODAY, USAGE_METRICS.featureUse, 'mapOpen', 20)
  ]).adoption
  assert.deepEqual(d.views.map((v) => [v.id, v.share, v.visits]), [
    ['combat', 0.75, 5],
    ['maps', 0.25, 0]
  ])
  assert.deepEqual(d.features, [{ id: 'mapOpen', uses: 20, perSession: 2 }])
})

test('the mixes are sorted by count and deterministic on ties', () => {
  const d = build([
    u(TODAY, USAGE_METRICS.overlayOpen, 'events', 2),
    u(TODAY, USAGE_METRICS.overlayOpen, 'fight', 2),
    u(TODAY, USAGE_METRICS.overlayOpen, 'overall', 9)
  ]).adoption
  assert.deepEqual(d.overlays.map((o) => o.id), ['overall', 'events', 'fight'])
})

// ---- funnels -------------------------------------------------------------------------------------

test('THE MOTIVATING BUG: a step nobody reached is a ZERO IN THE CURVE, not a missing row', () => {
  const d = build(
    [],
    [
      f(TODAY, 'voice-install', 'engineSelected', 40),
      f(TODAY, 'voice-install', 'downloadStarted', 40)
      // downloadCompleted / firstUtterance: nothing, ever.
    ]
  )
  const voice = d.funnels.find((x) => x.funnel === 'voice-install')
  assert.ok(voice)
  assert.deepEqual(voice.steps.map((s) => [s.step, s.n, s.conversion]), [
    ['engineSelected', 40, 1],
    ['downloadStarted', 40, 1],
    ['downloadCompleted', 0, 0],
    ['firstUtterance', 0, 0]
  ])
  // …and the drop-off names the step where it happened.
  assert.equal(voice.steps[2].dropOff, 1)
  assert.equal(voice.steps[1].dropOff, 0)
})

test('EVERY declared funnel gets a view, even one with no rows at all', () => {
  const d = build()
  assert.deepEqual(d.funnels.map((x) => x.funnel), ['first-run', 'voice-install', 'feedback'])
  // A funnel missing from the panel would read as "we do not measure that"; zeros read as
  // "we measure it and nobody got there", which is the true and more alarming statement.
  assert.equal(d.funnels[0].steps.length, 5)
  assert.equal(d.funnels[0].steps.every((s) => s.n === 0), true)
})

test('the per-version curves are the same computation, restricted — that is how a regression shows', () => {
  const d = build(
    [],
    [
      funnelRow({ funnel: 'feedback', step: 'dialogOpened', n: 10, appVersion: '0.2.0' }),
      funnelRow({ funnel: 'feedback', step: 'sendPressed', n: 8, appVersion: '0.2.0' }),
      funnelRow({ funnel: 'feedback', step: 'dialogOpened', n: 10, appVersion: '0.3.0' }),
      funnelRow({ funnel: 'feedback', step: 'sendPressed', n: 1, appVersion: '0.3.0' })
    ]
  )
  const feedback = d.funnels.find((x) => x.funnel === 'feedback')
  assert.ok(feedback)
  assert.deepEqual(feedback.byVersion.map((v) => v.version), ['0.3.0', '0.2.0'])
  assert.equal(feedback.byVersion[0].steps[1].conversion, 0.1)
  assert.equal(feedback.byVersion[1].steps[1].conversion, 0.8)
})

test('a funnel failure class is attached to its own funnel and stripped of the prefix', () => {
  const d = build(
    [u(TODAY, USAGE_METRICS.funnelFailure, 'voice-install:downloadCompleted:checksum', 3),
     u(TODAY, USAGE_METRICS.funnelFailure, 'feedback:sendFinished:network', 1)],
    [f(TODAY, 'voice-install', 'engineSelected', 1)]
  )
  const voice = d.funnels.find((x) => x.funnel === 'voice-install')
  assert.deepEqual(voice?.failures, [{ id: 'downloadCompleted:checksum', n: 3 }])
})

// ---- health --------------------------------------------------------------------------------------

test('an update step with no reports has an UNKNOWN rate, not a zero one', () => {
  const d = build([
    u(TODAY, USAGE_METRICS.update, 'check:ok', 9),
    u(TODAY, USAGE_METRICS.update, 'download:ok', 3),
    u(TODAY, USAGE_METRICS.update, 'download:failed', 1),
    u(TODAY, USAGE_METRICS.health, 'rendererCrashes', 2),
    u(TODAY, USAGE_METRICS.healthReports, '-', 40)
  ]).health
  assert.deepEqual(d.update, [
    { step: 'check', ok: 9, failed: 0, rate: 1 },
    { step: 'download', ok: 3, failed: 1, rate: 0.75 },
    { step: 'apply', ok: 0, failed: 0, rate: null }
  ])
  assert.deepEqual(d.errors, [{ id: 'rendererCrashes', n: 2 }])
  assert.equal(d.reports, 40)
})

// ---- versions -------------------------------------------------------------------------------------

test('days-to-adopt is first-seen -> first MAJORITY day, and is null until there is one', () => {
  const usage = [
    u(day(9), USAGE_METRICS.activeInstalls, '-', 10),
    u(day(9), USAGE_METRICS.version, '0.3.0', 2),
    u(day(5), USAGE_METRICS.activeInstalls, '-', 10),
    u(day(5), USAGE_METRICS.version, '0.3.0', 7),
    // 0.2.0 peaks at 4 of that day's 10 active installs — a plurality, never a majority.
    u(day(9), USAGE_METRICS.version, '0.2.0', 4)
  ]
  const versions = build(usage, [], [install(day(40), day(2), '0.3.0')]).versions
  const three = versions.find((v) => v.version === '0.3.0')
  assert.ok(three)
  assert.equal(three.firstSeenDay, day(9))
  assert.equal(three.majorityDay, day(5))
  assert.equal(three.daysToAdopt, 4)
  assert.equal(three.peakShare, 0.7)
  assert.equal(three.installs, 1)

  const two = versions.find((v) => v.version === '0.2.0')
  assert.equal(two?.majorityDay, null, '0.2.0 never crossed half of a day’s active installs')
  assert.equal(two?.daysToAdopt, null)
  assert.equal(two?.installs, 0, 'nobody is on it any more, but it still appeared in the window')
})

// ---- retention --------------------------------------------------------------------------------------

test('retention is SURVIVAL, and a cohort younger than the horizon reports null not zero', () => {
  const installs = [
    install(day(10), day(10)), // first and last seen the same day: never came back
    install(day(10), day(9)), // still seen at +1
    install(day(10), day(2)), // still seen at +7 as well
    install(day(1), TODAY) // a cohort one day old, seen again today
  ]
  const rows = build([], [], installs).retention
  const older = rows.find((r) => r.cohortDay === day(10))
  assert.ok(older)
  assert.equal(older.installs, 3)
  assert.equal(older.d1, 2)
  assert.equal(older.d7, 1)
  assert.equal(older.d30, null, 'the +30 horizon has not happened yet — unknown, not "everyone left"')

  const young = rows.find((r) => r.cohortDay === day(1))
  assert.equal(young?.d1, 1, 'seen on the cohort day and again on +1 counts as surviving')
  assert.equal(young?.d7, null)
})

// ---- empty ---------------------------------------------------------------------------------------------

test('EMPTY TABLES render as honest zeros — every section exists and nothing throws', () => {
  const d = build()
  assert.equal(d.empty, true)
  assert.equal(d.pulse.dau, 0)
  assert.equal(d.pulse.sessionsPerDay, 0)
  assert.equal(d.pulse.activeSeries.length, 30)
  assert.equal(d.pulse.activeSeries.every((p) => p.n === 0), true)
  assert.deepEqual(d.adoption.features, [])
  assert.deepEqual(d.versions, [])
  assert.deepEqual(d.retention, [])
  assert.equal(d.health.update.length, 3)
  assert.equal(windowIsEmpty(d), true)
})

test('`empty` is about the TABLES; the panel’s own note is about the WINDOW', () => {
  // Rows exist (an install seen long ago) but nothing landed in the window: not `empty`, and
  // not "no data at all" either — the two sentences are different and the panel says the right
  // one because `windowIsEmpty` asks about the built numbers.
  const d = build([], [], [install('2020-01-01', '2020-01-02')])
  assert.equal(d.empty, false)
  assert.equal(windowIsEmpty(d), false, 'installsTotal is non-zero: there IS something to show')
})

// ---- the panel's pure helpers --------------------------------------------------------------------------

test('THE DASH IS LOAD-BEARING: unknown renders as —, measured zero renders as 0%', () => {
  assert.equal(rateLabel(null), '—')
  assert.equal(rateLabel(0), '0%')
  assert.equal(rateLabel(1), '100%')
  assert.equal(pctLabel(0.055), '5.5%', 'small shares keep a decimal so they are not all "6%"')
  assert.equal(pctLabel(0.5), '50%')
  assert.equal(pctLabel(2), '100%', 'a share is clamped, never rendered above 100%')
  assert.equal(pctLabel(Number.NaN), '0%')
})

test('durations read as minutes, then hours, and an unknown one is a dash', () => {
  assert.equal(durationLabel(null), '—')
  assert.equal(durationLabel(0), '—')
  assert.equal(durationLabel(90_000), '2 min')
  assert.equal(durationLabel(30_000), '1 min', 'never "0 min" for a session that happened')
  assert.equal(durationLabel(5_400_000), '1.5 h')
})

test('a cohort cell shows the count AND its share, or a dash when the horizon is unreached', () => {
  assert.equal(cohortCell(null, 10), '—')
  assert.equal(cohortCell(4, 10), '4 (40%)')
  assert.equal(cohortCell(0, 10), '0 (0%)')
  assert.equal(cohortCell(3, 0), '3 (0%)')
})

test('the pulse tiles say what they are counting, and never claim "right now"', () => {
  const tiles = pulseTiles(build())
  assert.deepEqual(tiles.map((t) => t.label), [
    'DAU',
    'WAU',
    'MAU',
    'Installs',
    'Sessions',
    'Session length'
  ])
  for (const t of tiles) assert.ok(t.note.length > 0, `${t.label} has no note`)
  assert.match(tiles[1].note, /last day with data/)
  assert.equal(tiles[5].value, '—', 'no session ended: the tile does not invent a length')
})

test('funnel bars are relative to STEP ONE, so the curve reads as a shape', () => {
  const bars = funnelBars([
    { step: 'a', n: 10, conversion: 1, dropOff: 0 },
    { step: 'b', n: 5, conversion: 0.5, dropOff: 0.5 },
    { step: 'c', n: 0, conversion: 0, dropOff: 1 }
  ])
  assert.deepEqual(bars.map((b) => b.widthPct), [100, 50, 0])
  assert.deepEqual(bars.map((b) => b.dropOff), [null, '−50%', '−100%'])
  assert.deepEqual(seriesValues([{ day: 'a', n: 1 }, { day: 'b', n: 2 }]), [1, 2])
})

// ---- the CLI digest -----------------------------------------------------------------------------------

test('the digest prints the SAME numbers, and says so when the tables are empty', () => {
  const text = renderAnalyticsDigest(build())
  assert.match(text, /usage analytics — last 30 days/)
  assert.match(text, /NO DATA YET/)
  assert.match(text, /PULSE[\s\S]*ADOPTION[\s\S]*FUNNELS[\s\S]*HEALTH[\s\S]*VERSIONS[\s\S]*RETENTION/)
  // Every funnel is named even with nothing in it.
  for (const funnel of ['first-run', 'voice-install', 'feedback']) assert.ok(text.includes(funnel))
})

test('the digest renders real numbers without an empty banner', () => {
  const text = renderAnalyticsDigest(
    build(
      [
        u(TODAY, USAGE_METRICS.activeInstalls, '-', 12),
        u(TODAY, USAGE_METRICS.sessions, '-', 30),
        u(TODAY, USAGE_METRICS.featureUse, 'mapOpen', 60)
      ],
      [f(TODAY, 'first-run', 'installed', 12)],
      [install(day(3), TODAY)]
    )
  )
  assert.equal(text.includes('NO DATA YET'), false)
  assert.match(text, /DAU 12/)
  assert.match(text, /mapOpen\s+60 uses · 2\.00\/session/)
  assert.match(text, /installed\s+12\s+100\.0% of step 1/)
})
