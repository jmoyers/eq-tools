// scripts/devTelemetryStack.mts, driven for real through the dev server's socket.
//
// The telemetry twin of tests/devFeedbackServer.test.mts, and it exists for the same reason:
// the local stack is what makes "rehearse the ingest path without deployed things" true, and a
// local stack that drifts from the contract is a local stack that rehearses a lie.
//
// WHAT THIS IS ACTUALLY PROVING, beyond the status codes: that a batch the client would send
// becomes the counters the panel would read. The request goes through the REAL shared
// `validateTelemetryBatch` and the REAL shared `rollupBatch` — the same two functions the
// Lambda imports — and `GET /devstack/usage` hands back the three tables in the same shape
// `src/main/triage/usageRows.ts` maps. That round trip is the only place the two halves of this
// feature meet outside a deployed stack, because the client cannot send at all yet.
//
// WHAT IT CANNOT PROVE (the dev stack's own header says the same): no optimistic-concurrency
// aborts, no 3,000-row transaction cap, no EMF. Those live in the Lambda and in DSQL.
//
// No Electron, no fixtures, no cloud, loopback only: it never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startDevStack, type DevStack } from '../scripts/dev-feedback-server.mts'
import { emptyTelemetryState, telemetryRoute } from '../scripts/devTelemetryStack.mjs'
import { DIM_NONE, USAGE_METRICS } from '../src/shared/telemetryRollup'
import {
  MAX_TELEMETRY_BODY_BYTES,
  type TelemetryBatch,
  type TelemetryEvent
} from '../src/shared/telemetry'

const dir = (): string => mkdtempSync(join(tmpdir(), 'eq-devstack-tele-'))

function batch(events: TelemetryEvent[], analyticsId = randomUUID()): TelemetryBatch {
  return {
    v: 1,
    env: { analyticsId, appVersion: '0.2.0', channel: 'dev', platform: 'win32', tzOffsetBucket: -7 },
    events: events.map((ev, i) => ({ ts: 1_000 + i, ev }))
  }
}

interface Answer {
  status: number
  body: Record<string, unknown>
}

async function post(stack: DevStack, body: unknown): Promise<Answer> {
  const res = await fetch(stack.telemetryUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

interface UsageTables {
  usageDaily: { day: string; metric: string; dim: string; n: number }[]
  usageFunnelDaily: { funnel: string; step: string; app_version: string; n: number }[]
  analyticsInstall: { first_seen_day: string; last_seen_day: string; days_seen: number }[]
}

async function tables(stack: DevStack): Promise<UsageTables> {
  const res = await fetch(`http://127.0.0.1:${String(stack.port)}/devstack/usage`)
  return (await res.json()) as unknown as UsageTables
}

const counterOf = (t: UsageTables, metric: string, dim = DIM_NONE): number =>
  t.usageDaily.find((r) => r.metric === metric && r.dim === dim)?.n ?? 0

async function withStack(run: (stack: DevStack) => Promise<void>): Promise<void> {
  const stack = await startDevStack({ port: 0, dir: dir(), quiet: true })
  try {
    await run(stack)
  } finally {
    await stack.close()
  }
}

// ---- the response table ----------------------------------------------------------------

test('a good batch is 202 and reports what it accepted', async () => {
  await withStack(async (stack) => {
    const answer = await post(stack, batch([{ t: 'sessionStart', coldStartMsBucket: 1 }]))
    assert.equal(answer.status, 202)
    assert.deepEqual(answer.body, { ok: true, accepted: 1 })
  })
})

test('an EMPTY batch is legal and costs nothing — 202, and no install row is created', async () => {
  await withStack(async (stack) => {
    const answer = await post(stack, batch([]))
    assert.equal(answer.status, 202)
    assert.equal(answer.body.accepted, 0)
    // The "first batch of the day" inference assumes events > 0, so an empty batch must not
    // reach the install UPSERT at all.
    assert.deepEqual((await tables(stack)).analyticsInstall, [])
  })
})

test('a body over the cap is 413, and it is refused BEFORE the shape is looked at', async () => {
  await withStack(async (stack) => {
    // Deliberately not valid JSON either: a 413 proves the size gate ran first.
    const answer = await post(stack, 'x'.repeat(MAX_TELEMETRY_BODY_BYTES + 10))
    assert.equal(answer.status, 413)
    assert.equal(answer.body.error, 'too_large')
  })
})

test('a malformed batch is 400 and NAMES THE FIELD — the shared validator’s own answer', async () => {
  await withStack(async (stack) => {
    assert.equal((await post(stack, 'not json')).status, 400)

    const bad = await post(stack, { ...batch([]), v: 99 })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.field, 'v')

    const badId = await post(stack, { ...batch([]), env: { ...batch([]).env, analyticsId: 'nope' } })
    assert.equal(badId.body.field, 'env.analyticsId')

    // The event union is closed; an unknown `t` is refused rather than stored as "other".
    const badEvent = await post(stack, batch([{ t: 'nonsense' } as unknown as TelemetryEvent]))
    assert.equal(badEvent.status, 400)
    assert.equal(badEvent.body.field, 't')
  })
})

test('A FIELD THE SCHEMA HAS NO ROOM FOR NEVER LANDS — it is dropped, not stored', async () => {
  await withStack(async (stack) => {
    const smuggled = {
      t: 'viewDwell',
      view: 'combat',
      ms: 5_000,
      characterName: 'Primitive',
      zone: 'Plane of Sky'
    } as unknown as TelemetryEvent
    assert.equal((await post(stack, batch([smuggled]))).status, 202)
    const json = JSON.stringify(await tables(stack))
    assert.equal(json.includes('Primitive'), false)
    assert.equal(json.includes('Plane of Sky'), false)
    assert.equal(json.includes('characterName'), false)
  })
})

// ---- the aggregate, end to end -----------------------------------------------------------

test('THE ROUND TRIP: a batch becomes the counters the readout consumes', async () => {
  await withStack(async (stack) => {
    const id = randomUUID()
    await post(
      stack,
      batch(
        [
          { t: 'sessionStart', coldStartMsBucket: 2 },
          { t: 'viewDwell', view: 'combat', ms: 30_000 },
          { t: 'viewDwell', view: 'combat', ms: 10_000 },
          { t: 'featureUse', feature: 'mapOpen', count: 3 },
          { t: 'funnelStep', funnel: 'first-run', step: 'installed' }
        ],
        id
      )
    )
    const t = await tables(stack)
    assert.equal(counterOf(t, USAGE_METRICS.sessions), 1)
    assert.equal(counterOf(t, USAGE_METRICS.activeInstalls), 1)
    assert.equal(counterOf(t, USAGE_METRICS.viewDwellMs, 'combat'), 40_000)
    assert.equal(counterOf(t, USAGE_METRICS.viewVisits, 'combat'), 2)
    assert.equal(counterOf(t, USAGE_METRICS.featureUse, 'mapOpen'), 3)
    assert.equal(counterOf(t, USAGE_METRICS.version, '0.2.0'), 1)
    assert.deepEqual(
      t.usageFunnelDaily.map((r) => [r.funnel, r.step, r.app_version, r.n]),
      [['first-run', 'installed', '0.2.0', 1]]
    )
    assert.equal(t.analyticsInstall.length, 1)
    assert.equal(t.analyticsInstall[0].days_seen, 1)
  })
})

test('COUNTERS ACCUMULATE, and the per-day install facts are counted exactly once', async () => {
  await withStack(async (stack) => {
    const id = randomUUID()
    const events: TelemetryEvent[] = [{ t: 'sessionHeartbeat', uptimeMs: 300_000 }]
    await post(stack, batch(events, id))
    await post(stack, batch(events, id))
    await post(stack, batch(events, id))
    const t = await tables(stack)
    assert.equal(counterOf(t, USAGE_METRICS.heartbeats), 3, 'the events add up')
    assert.equal(counterOf(t, USAGE_METRICS.activeInstalls), 1, 'the INSTALL is counted once a day')
    assert.equal(counterOf(t, USAGE_METRICS.version, '0.2.0'), 1)
    assert.equal(t.analyticsInstall.length, 1)
  })
})

test('two ids on one day are two active installs and ONE set of counters', async () => {
  await withStack(async (stack) => {
    const events: TelemetryEvent[] = [{ t: 'alertFired', count: 2, spokenCount: 1 }]
    await post(stack, batch(events, randomUUID()))
    await post(stack, batch(events, randomUUID()))
    const t = await tables(stack)
    assert.equal(counterOf(t, USAGE_METRICS.activeInstalls), 2)
    assert.equal(counterOf(t, USAGE_METRICS.alertsFired), 4)
    assert.equal(t.analyticsInstall.length, 2)
  })
})

// ---- the two gates, driven directly ---------------------------------------------------------
//
// The kill switch and the per-id cap are state on the ingest half rather than knobs on the
// server's `/devstack/mode`, so they are driven through the exported route with an injected
// clock — which also buys the one thing HTTP cannot give here: a second DAY.

test('the kill switch answers 503 and moves NO counter', () => {
  const state = emptyTelemetryState()
  state.mode.closed = true
  const res = telemetryRoute(state, Buffer.from(JSON.stringify(batch([{ t: 'sessionStart', coldStartMsBucket: 0 }]))))
  assert.equal(res.status, 503)
  assert.equal(state.usage.size, 0)
  assert.equal(state.installs.size, 0, 'a closed endpoint does not even learn the id exists')
})

test('the per-id daily cap answers 429, and it is a FLOOR: the batch that crosses it lands', () => {
  const state = emptyTelemetryState(3)
  const body = Buffer.from(JSON.stringify(batch([
    { t: 'sessionHeartbeat', uptimeMs: 1 },
    { t: 'sessionHeartbeat', uptimeMs: 2 }
  ])))
  assert.equal(telemetryRoute(state, body).status, 202)
  // 2 events counted, cap 3: the guard reads the count BEFORE this batch, so this one lands.
  assert.equal(telemetryRoute(state, body).status, 202)
  // Now at 4 > 3: refused.
  assert.equal(telemetryRoute(state, body).status, 429)
})

test('A NEW DAY resets the cap and advances days_seen — the row is the whole per-id footprint', () => {
  const state = emptyTelemetryState(2)
  const id = randomUUID()
  const body = Buffer.from(JSON.stringify(batch([{ t: 'sessionHeartbeat', uptimeMs: 1 }], id)))
  const monday = Date.UTC(2026, 7, 3, 10)
  const tuesday = Date.UTC(2026, 7, 4, 10)
  assert.equal(telemetryRoute(state, body, monday).status, 202)
  assert.equal(telemetryRoute(state, body, monday).status, 202)
  assert.equal(telemetryRoute(state, body, monday).status, 429, 'the cap is spent for that day')
  assert.equal(telemetryRoute(state, body, tuesday).status, 202, 'a new day, a fresh cap')

  const row = state.installs.get(id)
  assert.equal(row?.firstSeenDay, '2026-08-03')
  assert.equal(row?.lastSeenDay, '2026-08-04')
  assert.equal(row?.daysSeen, 2)
  // The envelope facts were counted once PER DAY, not once per batch.
  assert.equal(state.usage.get(`2026-08-03|${USAGE_METRICS.activeInstalls}|${DIM_NONE}`), 1)
  assert.equal(state.usage.get(`2026-08-04|${USAGE_METRICS.activeInstalls}|${DIM_NONE}`), 1)
})
