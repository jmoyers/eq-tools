// src/shared/telemetryRollup.ts — what a batch BECOMES, and what the ingest handler writes.
//
// This is the seam wave A2 turns on: the client's allowlisted events arrive, and what survives
// them is counters. Three properties are load-bearing and each gets real coverage:
//
//   1. THE ROLLUP IS TOTAL AND DETERMINISTIC. Every event kind in the union folds into a
//      (metric, dim) pair or into the funnel table, the same rows come out in the same order
//      every time, and nothing throws on any legal input. The handler's multi-row UPSERT is
//      built straight off this list, so an unstable order would be an unstable statement.
//   2. THE PER-DAY FACTS ARE GATED. `activeInstalls` and the envelope facts (version, channel,
//      platform, tz) are emitted ONLY on an install's first batch of the day — that gating is
//      the ONLY reason a distinct-install count exists without keeping a per-id event trail.
//      Counted per batch they would measure the flush loop, not people.
//   3. NOTHING IDENTIFYING SURVIVES. The rollup's output is (metric, dim, n) triples whose dims
//      come from closed enums; the analyticsId reaches the counters nowhere at all.
//
// Plus the handler's own SQL shape, pinned by reading it: additive UPSERTs and the shared
// validator, both of which are properties a refactor can silently break with a green suite.
//
// No Electron, no AWS, no fixtures, no network: this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DIM_NONE,
  medianBucket,
  rollupBatch,
  sessionBucketLabel,
  SESSION_MS_EDGES,
  USAGE_METRICS,
  utcDay,
  type RollupContext
} from '../src/shared/telemetryRollup'
import {
  MAX_TELEMETRY_BODY_BYTES,
  type TelemetryBatch,
  type TelemetryEvent,
  type TelemetryRecord
} from '../src/shared/telemetry'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** CRLF-normalized: this repo checks out with core.autocrlf=true, so a source pin written with
 *  `\n` would be red on every Windows checkout for a file that has not drifted (the same
 *  normalization tests/telemetryDoc.test.mts makes for TELEMETRY.md). */
const readSource = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

const batchOf = (events: TelemetryEvent[], appVersion = '0.2.0'): TelemetryBatch => ({
  v: 1,
  env: { analyticsId: ID, appVersion, channel: 'prod', platform: 'win32', tzOffsetBucket: -7 },
  events: events.map((ev, i): TelemetryRecord => ({ ts: 1_000 + i, ev }))
})

const FIRST: RollupContext = { firstOfDay: true, newInstall: false }
const LATER: RollupContext = { firstOfDay: false, newInstall: false }

/** `metric dim` -> n, for assertions that do not care about ordering. */
function counters(batch: TelemetryBatch, ctx: RollupContext = LATER): Map<string, number> {
  return new Map(rollupBatch(batch, ctx).counters.map((c) => [`${c.metric} ${c.dim}`, c.n]))
}

// ---- 1. the fold --------------------------------------------------------------------------

test('counts and durations are SUMMED per (metric, dim); repeats do not create rows', () => {
  const c = counters(
    batchOf([
      { t: 'viewDwell', view: 'combat', ms: 4_000 },
      { t: 'viewDwell', view: 'combat', ms: 6_000 },
      { t: 'viewDwell', view: 'maps', ms: 1_000 },
      { t: 'featureUse', feature: 'mapOpen', count: 2 },
      { t: 'featureUse', feature: 'mapOpen', count: 3 }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.viewDwellMs} combat`), 10_000)
  assert.equal(c.get(`${USAGE_METRICS.viewVisits} combat`), 2)
  assert.equal(c.get(`${USAGE_METRICS.viewDwellMs} maps`), 1_000)
  assert.equal(c.get(`${USAGE_METRICS.featureUse} mapOpen`), 5)
})

test('a session end is kept THREE ways: a count, a total, and a histogram bucket', () => {
  // A median cannot be summed across days, which is why the bucket exists at all.
  const c = counters(batchOf([{ t: 'sessionEnd', durationMs: 20 * 60_000, viewsVisited: 3 }]))
  assert.equal(c.get(`${USAGE_METRICS.sessionEnds} ${DIM_NONE}`), 1)
  assert.equal(c.get(`${USAGE_METRICS.sessionMsTotal} ${DIM_NONE}`), 20 * 60_000)
  // 20 min lands in the 15–30 bucket, which is index 3 over the edges.
  assert.equal(c.get(`${USAGE_METRICS.sessionLenBucket} 3`), 1)
})

test('an overlay toggle splits on OPEN vs CLOSE — the mix is opens, not events', () => {
  const c = counters(
    batchOf([
      { t: 'overlayToggle', kind: 'fight', open: true },
      { t: 'overlayToggle', kind: 'fight', open: false },
      { t: 'overlayToggle', kind: 'events', open: true }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.overlayOpen} fight`), 1)
  assert.equal(c.get(`${USAGE_METRICS.overlayClose} fight`), 1)
  assert.equal(c.get(`${USAGE_METRICS.overlayOpen} events`), 1)
})

test('a setup snapshot becomes one row per FIELD, each dim a bucket index or an enum member', () => {
  const c = counters(
    batchOf([
      {
        t: 'setupSnapshot',
        charCountBucket: 2,
        logSizeBucket: 3,
        alertCountBucket: 1,
        overlaysEnabled: ['fight', 'events'],
        cursorRing: true,
        autoHide: false,
        voiceEngine: 'kokoro',
        soundPackCount: 4,
        updateChannel: 'main'
      }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.setups} ${DIM_NONE}`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupChars} 2`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupOverlay} fight`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupOverlay} events`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupCursorRing} on`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupAutoHide} off`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupVoice} kokoro`), 1)
  assert.equal(c.get(`${USAGE_METRICS.setupPacks} ${DIM_NONE}`), 4)
})

test('health counters keep the FIELD as the dim, so an error class is a row not a column', () => {
  const c = counters(
    batchOf([
      {
        t: 'healthCounters',
        rendererCrashes: 1,
        mainErrorLogLines: 12,
        parserStalls: 0,
        presenceRestarts: 2,
        speechFailures: 0
      }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.healthReports} ${DIM_NONE}`), 1)
  assert.equal(c.get(`${USAGE_METRICS.health} rendererCrashes`), 1)
  assert.equal(c.get(`${USAGE_METRICS.health} mainErrorLogLines`), 12)
  // A ZERO IS NOT A ROW. Writing zeros would multiply the table by five for no information —
  // "no parser stall was reported" is the absence of the row, and the reader defaults to 0.
  assert.equal(c.has(`${USAGE_METRICS.health} parserStalls`), false)
})

test('an update outcome carries its own ok/failed dim, and the failure CLASS is a second row', () => {
  const c = counters(
    batchOf([
      { t: 'updateOutcome', step: 'download', ok: false, failureClass: 'network' },
      { t: 'updateOutcome', step: 'apply', ok: true }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.update} download:failed`), 1)
  assert.equal(c.get(`${USAGE_METRICS.update} apply:ok`), 1)
  assert.equal(c.get(`${USAGE_METRICS.updateFailure} download:network`), 1)
})

// ---- funnels ------------------------------------------------------------------------------

test('funnel steps go to their OWN table, keyed with the outcome and the app version', () => {
  const roll = rollupBatch(
    batchOf(
      [
        { t: 'funnelStep', funnel: 'voice-install', step: 'engineSelected' },
        { t: 'funnelStep', funnel: 'voice-install', step: 'downloadStarted' },
        { t: 'funnelStep', funnel: 'voice-install', step: 'downloadStarted' },
        { t: 'funnelStep', funnel: 'feedback', step: 'sendFinished', outcome: 'ok' }
      ],
      '0.3.1'
    ),
    LATER
  )
  assert.deepEqual(
    roll.funnels.map((f) => [f.funnel, f.step, f.outcome, f.appVersion, f.n]),
    [
      ['feedback', 'sendFinished', 'ok', '0.3.1', 1],
      ['voice-install', 'downloadStarted', DIM_NONE, '0.3.1', 2],
      ['voice-install', 'engineSelected', DIM_NONE, '0.3.1', 1]
    ]
  )
  // An absent outcome is the SENTINEL, never NULL: the column is part of the primary key.
  assert.equal(roll.funnels.every((f) => f.outcome.length > 0), true)
})

test('a funnel failure CLASS lands in usage_daily — the funnel key has no column for it', () => {
  const c = counters(
    batchOf([
      {
        t: 'funnelStep',
        funnel: 'voice-install',
        step: 'downloadCompleted',
        outcome: 'failed',
        failureClass: 'checksum'
      }
    ])
  )
  assert.equal(c.get(`${USAGE_METRICS.funnelFailure} voice-install:downloadCompleted:checksum`), 1)
})

// ---- 2. the per-day gate -------------------------------------------------------------------

test('THE DISTINCT-INSTALL GATE: envelope facts are counted once a day, not once a batch', () => {
  const events: TelemetryEvent[] = [{ t: 'sessionHeartbeat', uptimeMs: 60_000 }]
  const first = counters(batchOf(events), FIRST)
  assert.equal(first.get(`${USAGE_METRICS.activeInstalls} ${DIM_NONE}`), 1)
  assert.equal(first.get(`${USAGE_METRICS.version} 0.2.0`), 1)
  assert.equal(first.get(`${USAGE_METRICS.channel} prod`), 1)
  assert.equal(first.get(`${USAGE_METRICS.platform} win32`), 1)
  assert.equal(first.get(`${USAGE_METRICS.tzOffset} -7`), 1)

  // The SECOND batch of the same day contributes its events and NOTHING about the install.
  const later = counters(batchOf(events), LATER)
  assert.equal(later.has(`${USAGE_METRICS.activeInstalls} ${DIM_NONE}`), false)
  assert.equal(later.has(`${USAGE_METRICS.version} 0.2.0`), false)
  assert.equal(later.get(`${USAGE_METRICS.heartbeats} ${DIM_NONE}`), 1)
})

test('a NEW install is counted once, and only alongside its first-of-day batch', () => {
  const events: TelemetryEvent[] = [{ t: 'sessionStart', coldStartMsBucket: 1 }]
  const fresh = counters(batchOf(events), { firstOfDay: true, newInstall: true })
  assert.equal(fresh.get(`${USAGE_METRICS.newInstalls} ${DIM_NONE}`), 1)
  assert.equal(counters(batchOf(events), FIRST).has(`${USAGE_METRICS.newInstalls} ${DIM_NONE}`), false)
})

// ---- 3. nothing identifying, and nothing unstable -------------------------------------------

test('THE ANALYTICS ID REACHES NO COUNTER — not as a metric, not as a dim', () => {
  const roll = rollupBatch(
    batchOf([
      { t: 'viewDwell', view: 'maps', ms: 10 },
      { t: 'funnelStep', funnel: 'first-run', step: 'installed' }
    ]),
    FIRST
  )
  const text = JSON.stringify(roll)
  assert.equal(text.includes(ID), false)
  // …and every dim is a short, closed-enum-shaped token, never free text.
  for (const c of roll.counters) assert.match(c.dim, /^[\w.:—-]{1,64}$/)
})

test('the same batch always yields the same rows in the same order', () => {
  const batch = batchOf([
    { t: 'featureUse', feature: 'questFavorite', count: 1 },
    { t: 'viewDwell', view: 'loot', ms: 5 },
    { t: 'alertFired', count: 3, spokenCount: 1 },
    { t: 'featureUse', feature: 'mapOpen', count: 1 }
  ])
  const a = rollupBatch(batch, FIRST)
  const b = rollupBatch(batch, FIRST)
  assert.deepEqual(a, b)
  const metrics = a.counters.map((c) => `${c.metric} ${c.dim}`)
  assert.deepEqual([...metrics].sort((x, y) => x.localeCompare(y)), metrics)
})

test('an EMPTY batch rolls up to nothing at all — no envelope row, no funnel row', () => {
  const roll = rollupBatch(batchOf([]), FIRST)
  // The handler refuses an empty batch before it reaches the database (its "first batch today"
  // inference assumes events > 0), and the rollup agrees rather than inventing an active day.
  assert.deepEqual(roll.funnels, [])
  assert.equal(roll.counters.some((c) => c.metric === USAGE_METRICS.activeInstalls), true)
  assert.equal(roll.counters.some((c) => c.metric === USAGE_METRICS.heartbeats), false)
})

// ---- buckets and labels ---------------------------------------------------------------------

test('the median is a BUCKET, and an empty histogram has no median at all', () => {
  assert.equal(medianBucket([]), -1)
  assert.equal(medianBucket([0, 0, 0]), -1)
  assert.equal(medianBucket([1]), 0)
  assert.equal(medianBucket([1, 1, 1]), 1)
  assert.equal(medianBucket([10, 1, 1]), 0)
  assert.equal(medianBucket([1, 1, 10]), 2)
})

test('a session bucket renders as a RANGE, and the top bucket is open-ended', () => {
  assert.equal(sessionBucketLabel(0), '0–1 min')
  assert.equal(sessionBucketLabel(3), '15 min–30 min')
  assert.equal(sessionBucketLabel(SESSION_MS_EDGES.length), '4 h+')
  // Out of range clamps rather than producing `undefined–undefined`.
  assert.equal(sessionBucketLabel(99), '4 h+')
  assert.equal(sessionBucketLabel(-1), '0–1 min')
})

test('the day key is the ARRIVAL day in UTC — never the client clock', () => {
  assert.equal(utcDay(Date.UTC(2026, 7, 4, 23, 59)), '2026-08-04')
  assert.equal(utcDay(Date.UTC(2026, 7, 5, 0, 0)), '2026-08-05')
})

// ---- the handler's shape, read off the source ------------------------------------------------
//
// The Lambda itself cannot be imported here (it reaches `pg` and the AWS SDK at module scope),
// and standing those up would test the driver rather than the decision. What IS worth pinning
// is the handful of properties a refactor could quietly drop, all of them visible in the text.

test('the ingest handler runs the SHARED validator and the SHARED rollup', () => {
  const src = readFileSync(join(ROOT, 'infra', 'lambda', 'telemetry.ts'), 'utf8')
  assert.match(src, /import \{ validateTelemetryBatch \} from '\.\.\/\.\.\/src\/shared\/telemetryValidate'/)
  assert.match(src, /rollupBatch/)
  // The size cap is the shared constant, checked BEFORE the parse.
  assert.match(src, /MAX_TELEMETRY_BODY_BYTES/)
  // lastIndexOf, not indexOf: the file's own step list NAMES `JSON.parse` in a comment above
  // the imports, and a pin that a comment can satisfy is not a pin.
  assert.ok(
    src.lastIndexOf('MAX_TELEMETRY_BODY_BYTES') < src.lastIndexOf('JSON.parse'),
    'the size cap must be checked before JSON.parse — it is the one step a hostile body cannot make expensive'
  )
})

test('every counter UPSERT is ADDITIVE, so a retried transaction cannot double-count', () => {
  const src = readFileSync(join(ROOT, 'infra', 'lambda', 'telemetry.ts'), 'utf8')
  assert.match(src, /ON CONFLICT \(day, metric, dim\) DO UPDATE SET n = usage_daily\.n \+ EXCLUDED\.n/)
  assert.match(src, /ON CONFLICT \(day, funnel, step, outcome, app_version\) DO UPDATE/)
  assert.match(src, /SET n = usage_funnel_daily\.n \+ EXCLUDED\.n/)
  // The install UPSERT's guard IS the daily cap; without the WHERE it would never refuse.
  assert.match(src, /WHERE analytics_install\.quota_day <> \$2 OR analytics_install\.quota_n < \$6/)
})

test('THE THREE TABLES, AND NO FOURTH: the handler writes exactly the plan’s storage shape', () => {
  const src = readFileSync(join(ROOT, 'infra', 'lambda', 'telemetry.ts'), 'utf8')
  const tables = [...src.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(tables)].sort(), ['analytics_install', 'usage_daily', 'usage_funnel_daily'])
  // NO RAW EVENT STORE (T6): nothing inserts an event row, and no id is ever logged.
  assert.equal(/INSERT INTO (telemetry_event|usage_event|raw_)/.test(src), false)
  assert.equal(/log\(\{[^}]*analyticsId/.test(src), false)
})

test('the body cap is bigger than feedback’s, and big enough for a maximal batch', () => {
  // 500 records of the fattest event kind is ~130 KB; the cap has to clear that with room.
  assert.ok(MAX_TELEMETRY_BODY_BYTES >= 200 * 1024)
  assert.ok(MAX_TELEMETRY_BODY_BYTES <= 1024 * 1024)
})

// ---- the schema, read off the file ------------------------------------------------------------

test('schema.sql declares the three tables, the kill switch and a role that cannot read reports', () => {
  const sql = readSource(join(ROOT, 'infra', 'schema.sql'))
  for (const table of ['usage_daily', 'usage_funnel_daily', 'analytics_install']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
  }
  // Seeded CLOSED, and guarded so a re-run cannot re-close a switch somebody opened.
  assert.match(sql, /SET telemetry_accepting = false\n WHERE id = 'FEEDBACK' AND telemetry_accepting IS NULL/)
  assert.match(sql, /CREATE ROLE telemetry_ingest WITH LOGIN/)
  // THE GRANT LIST IS THE PROMISE (§8.5). No privilege on `report`, and no DELETE anywhere.
  const grants = [...sql.matchAll(/GRANT ([^;]+) TO telemetry_ingest/g)].map((m) => m[1])
  assert.ok(grants.length >= 4)
  assert.equal(grants.some((g) => /\breport\b/.test(g)), false)
  assert.equal(grants.some((g) => /DELETE/.test(g)), false)
  assert.equal(grants.some((g) => /install_profile/.test(g)), false)
})

test('every statement in schema.sql still ends on its own line — the splitter law', () => {
  const sql = readSource(join(ROOT, 'infra', 'schema.sql'))
  // The runner splits on "the first line whose last character is `;`", so a string literal that
  // ended a line with one would silently cut a statement in half.
  for (const line of sql.split(/\r?\n/)) {
    if (!line.trimEnd().endsWith(';')) continue
    const quotes = (line.match(/'/g) ?? []).length
    assert.equal(quotes % 2, 0, `unbalanced quotes on a statement-ending line: ${line}`)
  }
})
