// src/shared/telemetry.ts — the usage-analytics allowlist.
//
// THE PROPERTY THIS SUITE EXISTS TO PIN is not "the validators work". It is that the schema
// CANNOT EXPRESS A NAME. Plan decision T2: "the schema structurally cannot express character
// names, zone/mob/spell/item names, log text, or anything typed". A privacy promise enforced by
// remembering to strip things is a promise that will be broken by the fifth person to add an
// event; a privacy promise enforced by the type having no slot cannot be.
//
// So the load-bearing tests here are the negative ones: an event carrying an extra property
// comes back WITHOUT it, every string-typed field is a member of a closed set declared in the
// file, and the buckets refuse a raw value dressed up as an index.
//
// No Electron, no fixtures, no network: this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OVERLAY_KINDS } from '../src/shared/types'
import {
  ALERT_COUNT_EDGES,
  CHAR_COUNT_EDGES,
  COLD_START_MS_EDGES,
  DEFAULT_TELEMETRY_PREFS,
  LOG_SIZE_BYTES_EDGES,
  MAX_BATCH_EVENTS,
  MAX_TZ_OFFSET_HOURS,
  MIN_TZ_OFFSET_HOURS,
  TELEMETRY_API_VERSION,
  TELEMETRY_BUFFER_CAP,
  TELEMETRY_EVENT_KINDS,
  TELEMETRY_FEATURES,
  TELEMETRY_FUNNELS,
  TELEMETRY_FUNNEL_STEPS,
  TELEMETRY_OVERLAY_KINDS,
  TELEMETRY_VIEWS,
  bucketOf,
  bucketRange,
  normalizeTelemetryPrefs,
  tzOffsetBucket,
  type TelemetryEvent
} from '../src/shared/telemetry'
import {
  validateEnvelope,
  validateTelemetryBatch,
  validateTelemetryEvent
} from '../src/shared/telemetryValidate'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

const valid = (input: unknown): TelemetryEvent => {
  const res = validateTelemetryEvent(input)
  assert.ok(res.ok, `expected valid, got: ${res.ok ? '' : res.message}`)
  return res.value
}
const invalid = (input: unknown, field: string): void => {
  const res = validateTelemetryEvent(input)
  assert.equal(res.ok, false, `expected ${JSON.stringify(input)} to be refused`)
  if (!res.ok) assert.equal(res.field, field)
}

// ---- THE PRIVACY PROPERTY ----------------------------------------------------------------

test('an event carrying extra properties comes back WITHOUT them — the value is CONSTRUCTED', () => {
  // This is the whole design. The validators do not "sanitize" an object; they build a new one
  // field by field from the schema. So a caller who bolts a character name onto an event does
  // not get it stripped — it never enters the value that is buffered in the first place.
  const smuggled = {
    t: 'viewDwell',
    view: 'combat',
    ms: 5_000,
    characterName: 'Primitive',
    zone: 'The Plane of Sky',
    raw: "[Sun Aug 03] Primitive tells the group, 'inc'"
  }
  const out = valid(smuggled)
  assert.deepEqual(out, { t: 'viewDwell', view: 'combat', ms: 5_000 })
  assert.deepEqual(Object.keys(out).sort(), ['ms', 't', 'view'])
})

test('EVERY string-valued field in every event is a member of a closed set', () => {
  // The tripwire for the property above stated positively: take one valid instance of every
  // event kind, and assert that no string anywhere in it is free text. `t` is the union tag;
  // every other string must appear in one of the file's own exported enums.
  const closed = new Set<string>([
    ...TELEMETRY_EVENT_KINDS,
    ...TELEMETRY_VIEWS,
    ...TELEMETRY_OVERLAY_KINDS,
    ...TELEMETRY_FEATURES,
    ...TELEMETRY_FUNNELS,
    ...TELEMETRY_FUNNELS.flatMap((f) => TELEMETRY_FUNNEL_STEPS[f]),
    'system',
    'kokoro',
    'off',
    'main',
    'stable',
    'check',
    'download',
    'apply',
    'ok',
    'failed',
    'queued',
    'network',
    'checksum',
    'disk',
    'timeout',
    'other'
  ])
  // Flattened to one loop: every string anywhere in every sample, with the path that found it.
  const strings = SAMPLES.flatMap((ev) =>
    Object.entries(ev).flatMap(([key, v]) =>
      (Array.isArray(v) ? (v as unknown[]) : [v])
        .filter((x): x is string => typeof x === 'string')
        .map((value) => ({ where: `${ev.t}.${key}`, value }))
    )
  )
  assert.ok(strings.length > SAMPLES.length, 'the samples must actually contain strings')
  for (const { where, value } of strings) {
    assert.ok(closed.has(value), `${where} = "${value}" is free text`)
  }
})

/** One valid instance of every event kind — also the completeness check below. */
const SAMPLES: TelemetryEvent[] = [
  { t: 'sessionStart', coldStartMsBucket: 2 },
  { t: 'sessionHeartbeat', uptimeMs: 300_000 },
  { t: 'sessionEnd', durationMs: 3_600_000, viewsVisited: 4 },
  { t: 'viewDwell', view: 'combat', ms: 90_000 },
  { t: 'overlayToggle', kind: 'heal-fight', open: true },
  { t: 'featureUse', feature: 'mapOpen', count: 3 },
  { t: 'alertFired', count: 12, spokenCount: 4 },
  {
    t: 'setupSnapshot',
    charCountBucket: 1,
    logSizeBucket: 3,
    alertCountBucket: 2,
    overlaysEnabled: ['fight', 'events'],
    cursorRing: false,
    autoHide: true,
    voiceEngine: 'kokoro',
    soundPackCount: 2,
    updateChannel: 'main'
  },
  { t: 'funnelStep', funnel: 'voice-install', step: 'downloadStarted' },
  {
    t: 'healthCounters',
    rendererCrashes: 0,
    mainErrorLogLines: 7,
    parserStalls: 0,
    presenceRestarts: 1,
    speechFailures: 0
  },
  { t: 'updateOutcome', step: 'download', ok: false, failureClass: 'network' }
]

test('every kind in the union has a sample, and every sample round-trips unchanged', () => {
  assert.deepEqual(
    SAMPLES.map((s) => s.t).sort(),
    [...TELEMETRY_EVENT_KINDS].sort(),
    'a new event kind needs a sample here — that is how it gets its privacy assertion'
  )
  for (const ev of SAMPLES) assert.deepEqual(valid(ev), ev, `${ev.t} must round-trip`)
})

// ---- the closed enums --------------------------------------------------------------------

test('an unlisted enum member is refused, on every enum-typed field', () => {
  invalid({ t: 'viewDwell', view: 'Primitive', ms: 1 }, 'view')
  invalid({ t: 'viewDwell', view: 'inventory', ms: 1 }, 'view') // a RETIRED view is not a view
  invalid({ t: 'overlayToggle', kind: 'dps', open: true }, 'kind')
  invalid({ t: 'featureUse', feature: 'somethingNew', count: 1 }, 'feature')
  invalid({ t: 'updateOutcome', step: 'reboot', ok: true }, 'step')
  invalid({ t: 'updateOutcome', step: 'apply', ok: false, failureClass: 'ENOENT' }, 'failureClass')
  invalid({ t: 'notAThing' }, 't')
  invalid({ t: 'viewDwell' }, 'view')
  for (const junk of [null, undefined, 0, 'viewDwell', [], true]) invalid(junk, 'event')
})

test('a funnel step is checked against ITS OWN funnel, never the union of all steps', () => {
  // `downloadStarted` is a real step — of a different funnel. A flat step list would accept it
  // and quietly produce a feedback funnel with a voice-install step in the middle of it.
  valid({ t: 'funnelStep', funnel: 'feedback', step: 'sendPressed' })
  invalid({ t: 'funnelStep', funnel: 'feedback', step: 'downloadStarted' }, 'step')
  invalid({ t: 'funnelStep', funnel: 'first-run', step: 'sendPressed' }, 'step')
  invalid({ t: 'funnelStep', funnel: 'onboarding', step: 'installed' }, 'funnel')

  // The optionals are optional, and refused when present and wrong.
  assert.deepEqual(valid({ t: 'funnelStep', funnel: 'feedback', step: 'sendFinished' }), {
    t: 'funnelStep',
    funnel: 'feedback',
    step: 'sendFinished'
  })
  invalid({ t: 'funnelStep', funnel: 'feedback', step: 'sendFinished', outcome: 'sent' }, 'outcome')
})

test('overlaysEnabled is a SET of closed kinds — deduped, canonically ordered', () => {
  // Membership and nothing else: not click order, not a repeat count. Two users with the same
  // overlays open produce a byte-identical field.
  const out = valid({
    ...SAMPLES[7],
    overlaysEnabled: ['events', 'fight', 'fight']
  }) as Extract<TelemetryEvent, { t: 'setupSnapshot' }>
  assert.deepEqual(out.overlaysEnabled, ['fight', 'events'])
  invalid({ ...SAMPLES[7], overlaysEnabled: ['fight', 'raid'] }, 'overlaysEnabled[]')
  invalid({ ...SAMPLES[7], overlaysEnabled: 'fight' }, 'overlaysEnabled')
})

test('the overlay-kind list is the SAME set the app uses (the duplication cannot rot)', () => {
  // telemetry.ts may import nothing at all, so it re-declares the kinds. This is the tripwire
  // that keeps the copy honest: adding a sixth overlay to the app fails here until the schema
  // (and therefore TELEMETRY.md) learns about it.
  assert.deepEqual([...TELEMETRY_OVERLAY_KINDS].sort(), [...OVERLAY_KINDS].sort())
})

test('the view list is the SAME set the app can render', () => {
  // Same duplication, same tripwire — read out of appViews.ts's source, because that module is
  // renderer-only (it reads a vite define) and cannot be imported under plain node.
  const src = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'appViews.ts'), 'utf8')
  const union = /export type View =([\s\S]*?)export const VIEW_KEY/.exec(src)?.[1] ?? ''
  // Deduped: the union's own doc comment quotes 'triage' while explaining why it stays in.
  const declared = [...new Set([...union.matchAll(/'([a-z]+)'/g)].map((m) => m[1] as string))]
  assert.ok(declared.length > 5, 'failed to read the View union out of appViews.ts')
  assert.deepEqual(declared.sort(), [...TELEMETRY_VIEWS].sort())
})

// ---- counts, durations and buckets -------------------------------------------------------

test('numbers must be whole, non-negative and bounded — no floats, no NaN, no negatives', () => {
  invalid({ t: 'viewDwell', view: 'combat', ms: -1 }, 'ms')
  invalid({ t: 'viewDwell', view: 'combat', ms: 1.5 }, 'ms')
  invalid({ t: 'viewDwell', view: 'combat', ms: Number.NaN }, 'ms')
  invalid({ t: 'viewDwell', view: 'combat', ms: Number.POSITIVE_INFINITY }, 'ms')
  invalid({ t: 'viewDwell', view: 'combat', ms: '5000' }, 'ms')
  // 30 days is the duration ceiling; a longer "session" is a broken clock, not a data point.
  invalid({ t: 'sessionHeartbeat', uptimeMs: 31 * 24 * 60 * 60 * 1000 }, 'uptimeMs')
  invalid({ t: 'alertFired', count: 2_000_000, spokenCount: 0 }, 'count')
})

test('a bucket FIELD holds an index, not a value — the raw number can never arrive', () => {
  // The point of a bucket is that the revealing number stays on the machine. A field that
  // accepted 104857600 "because it is a valid integer" would defeat the whole mechanism.
  valid({ t: 'sessionStart', coldStartMsBucket: COLD_START_MS_EDGES.length })
  invalid({ t: 'sessionStart', coldStartMsBucket: COLD_START_MS_EDGES.length + 1 }, 'coldStartMsBucket')
  invalid({ t: 'sessionStart', coldStartMsBucket: 4_200 }, 'coldStartMsBucket')
  invalid({ ...SAMPLES[7], logSizeBucket: 104_857_600 }, 'logSizeBucket')
  invalid({ ...SAMPLES[7], charCountBucket: -1 }, 'charCountBucket')
})

test('bucketOf lands every value in the range the doc prints for it', () => {
  // edges [1, 5, 10, 25, 50] ⇒ 0 | 1–4 | 5–9 | 10–24 | 25–49 | 50+
  const cases: [number, number][] = [
    [0, 0],
    [1, 1],
    [4, 1],
    [5, 2],
    [9, 2],
    [10, 3],
    [24, 3],
    [25, 4],
    [49, 4],
    [50, 5],
    [10_000, 5]
  ]
  for (const [value, want] of cases) {
    assert.equal(bucketOf(value, ALERT_COUNT_EDGES), want, `${String(value)} alerts`)
  }
  // Every bucket index is in range, and the ranges tile the number line with no gap or overlap.
  for (const edges of [COLD_START_MS_EDGES, CHAR_COUNT_EDGES, LOG_SIZE_BYTES_EDGES, ALERT_COUNT_EDGES]) {
    assert.ok([...edges].every((e, i) => i === 0 || e > (edges[i - 1] as number)), 'edges ascend')
    for (let i = 0; i <= edges.length; i++) {
      const { lo, hi } = bucketRange(edges, i)
      assert.equal(bucketOf(lo, edges), i, `the low end of bucket ${String(i)} is in it`)
      if (hi !== null) assert.equal(bucketOf(hi, edges), i + 1, 'the top edge belongs to the NEXT bucket')
    }
  }
  assert.equal(bucketOf(Number.NaN, ALERT_COUNT_EDGES), 0, 'a broken number is not a big number')
})

test('tzOffsetBucket rounds to whole hours and clamps to the real range of offsets', () => {
  assert.equal(tzOffsetBucket(-300), -5) // US Eastern
  assert.equal(tzOffsetBucket(330), 6) // India (+5:30) rounds — half-hour zones are not carried
  assert.equal(tzOffsetBucket(-99_999), MIN_TZ_OFFSET_HOURS)
  assert.equal(tzOffsetBucket(99_999), MAX_TZ_OFFSET_HOURS)
  assert.equal(tzOffsetBucket(Number.NaN), 0)
})

// ---- the envelope and the batch ------------------------------------------------------------

test('the envelope accepts only a UUID id, a semver version, and closed channel/platform', () => {
  const base = { analyticsId: ID, appVersion: '0.2.0', channel: 'prod', platform: 'win32', tzOffsetBucket: -5 }
  assert.deepEqual(validateEnvelope(base), { ok: true, value: base })
  assert.deepEqual(validateEnvelope({ ...base, appVersion: '0.2.0-main.41' }).ok, true)

  // The two string fields that are NOT enums are the two the schema regex-pins, precisely so
  // they cannot become somewhere to put text.
  const bad = (over: Record<string, unknown>, field: string): void => {
    const res = validateEnvelope({ ...base, ...over })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.field, field)
  }
  bad({ analyticsId: 'Primitive@freeport' }, 'env.analyticsId')
  bad({ analyticsId: '' }, 'env.analyticsId')
  bad({ appVersion: 'the build from tuesday' }, 'env.appVersion')
  bad({ channel: 'e2e' }, 'env.channel') // T7: the harness is not a telemetry channel
  bad({ platform: 'Windows 11 Pro 22631' }, 'env.platform')
  bad({ tzOffsetBucket: 99 }, 'env.tzOffsetBucket')
})

test('a batch is version-pinned, size-capped, and rejects on its first bad record', () => {
  const env = { analyticsId: ID, appVersion: '1.0.0', channel: 'dev', platform: 'linux', tzOffsetBucket: 0 }
  const rec = (ev: TelemetryEvent): unknown => ({ ts: 1_754_000_000_000, ev })

  const good = validateTelemetryBatch({ v: TELEMETRY_API_VERSION, env, events: SAMPLES.map(rec) })
  assert.equal(good.ok, true)
  if (good.ok) assert.equal(good.value.events.length, SAMPLES.length)

  // An empty batch is legal (the flush loop never sends one, but a server rejecting it would
  // be asserting something it does not need to).
  assert.equal(validateTelemetryBatch({ v: TELEMETRY_API_VERSION, env, events: [] }).ok, true)

  const bad = (input: unknown, field: string): void => {
    const res = validateTelemetryBatch(input)
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.field, field)
  }
  bad({ v: 2, env, events: [] }, 'v')
  bad({ v: TELEMETRY_API_VERSION, env, events: {} }, 'events')
  bad({ v: TELEMETRY_API_VERSION, env, events: [{ ts: 1, ev: { t: 'nope' } }] }, 't')
  bad({ v: TELEMETRY_API_VERSION, env, events: [{ ev: SAMPLES[0] }] }, 'ts')
  bad(
    { v: TELEMETRY_API_VERSION, env, events: Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => rec(SAMPLES[0] as TelemetryEvent)) },
    'events'
  )
  assert.equal(MAX_BATCH_EVENTS, TELEMETRY_BUFFER_CAP, 'a full ring must fit in one batch')
})

// ---- the persisted prefs -------------------------------------------------------------------

test('the prefs default to OPT-OUT with the notice unshown and no id yet', () => {
  // Each of these three is a decision, and together they are the whole policy: on by default
  // (owner's call), nothing transmitted until the notice has rendered, and no identifier minted
  // for a user who has not run the app.
  assert.deepEqual(DEFAULT_TELEMETRY_PREFS, { enabled: true, noticeShown: false, analyticsId: null })
  assert.deepEqual(normalizeTelemetryPrefs(undefined), DEFAULT_TELEMETRY_PREFS)
  for (const junk of [null, 42, 'yes', [], { nested: true }]) {
    assert.deepEqual(normalizeTelemetryPrefs(junk), DEFAULT_TELEMETRY_PREFS, JSON.stringify(junk))
  }
})

test('a stored analyticsId that is not a UUID is DROPPED, never repaired into one', () => {
  assert.equal(normalizeTelemetryPrefs({ analyticsId: ID }).analyticsId, ID)
  for (const junk of ['Primitive', '', 0, {}, `${ID} `]) {
    assert.equal(normalizeTelemetryPrefs({ analyticsId: junk }).analyticsId, null, JSON.stringify(junk))
  }
  // A user's own choices survive field by field; a broken neighbour does not take them with it.
  assert.deepEqual(normalizeTelemetryPrefs({ enabled: false, noticeShown: true, analyticsId: 'x' }), {
    enabled: false,
    noticeShown: true,
    analyticsId: null
  })
})
