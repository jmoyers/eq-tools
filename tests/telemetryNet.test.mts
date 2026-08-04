// src/main/telemetry/ — THE DARK-BUILD LAW, and the ring that fills behind it.
//
// This suite exists to make one sentence provable rather than promised: **no build that exists
// today can send a telemetry event anywhere.** SECURITY.md still says the app has no telemetry
// of any kind, and that statement is TRUE for every build up to and including this one — which
// is only defensible if the absence is structural. So it is asserted three ways:
//
//   1. THE ENDPOINT IS EMPTY, and the predicate that reads it is false for every input that
//      could otherwise open the gate (the truth table below).
//   2. THERE IS NO TRANSPORT AT ALL. Every file under `src/main/telemetry/` is read and grepped
//      for `fetch`, `XMLHttpRequest`, `net.request`, `http`/`https` requires. A boolean can be
//      inverted by a careless edit; a directory with no networking code in it cannot send
//      anything however the booleans land.
//   3. THERE IS NO OVERRIDE. No setter, no env var, no store key can supply an endpoint —
//      unlike feedback, telemetry does not even have a loopback dev gate, because it has no
//      local-stack rehearsal need and a gate that does not exist cannot be widened.
//
// When wave A2 lights the endpoint, assertions 1 and 2 are EXPECTED to change — in the same
// commit that amends SECURITY.md and README. That is the point of pinning them: the doc change
// cannot be forgotten, because the test that forces it is the test that fails.
//
// No Electron, no fixtures, no network: this suite never skips. (`ring.ts`'s pure half is tested
// here too; its file half needs `app.getPath` and is exercised by the e2e spec.)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as net from '../src/main/telemetry/net'
import { TELEMETRY_API_URL, telemetryCollectEnabled, telemetryEndpointConfigured, telemetryFlushEnabled } from '../src/main/telemetry/net'
import { emptyRing, parseRingFile, pushCapped, TELEMETRY_RING_VERSION } from '../src/main/telemetry/ring'
import { TELEMETRY_BUFFER_CAP, type TelemetryPrefs, type TelemetryRecord } from '../src/shared/telemetry'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TELEMETRY_DIR = join(ROOT, 'src', 'main', 'telemetry')

const prefs = (over: Partial<TelemetryPrefs> = {}): TelemetryPrefs => ({
  enabled: true,
  noticeShown: true,
  analyticsId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  ...over
})

// ---- 1. THE ENDPOINT --------------------------------------------------------------------

test('THE DARK-BUILD PIN: no endpoint is compiled in, so nothing can be sent', () => {
  assert.equal(TELEMETRY_API_URL, '', 'wave A2 fills this in — and amends SECURITY.md + README with it')
  assert.equal(telemetryEndpointConfigured(), false)
})

test('THE TRUTH TABLE: the flush gate needs all four facts, and today one is impossible', () => {
  const LIT = 'https://example.execute-api.us-east-1.amazonaws.com/v1/telemetry'

  // The one row that can ever be true — and it needs an endpoint that does not exist yet.
  assert.equal(telemetryFlushEnabled(false, LIT, prefs()), true)

  // Every single-fact negation, each fatal on its own.
  assert.equal(telemetryFlushEnabled(true, LIT, prefs()), false, 'e2e never sends (plan T7)')
  assert.equal(telemetryFlushEnabled(false, '', prefs()), false, 'a dark build has nowhere to send')
  assert.equal(
    telemetryFlushEnabled(false, LIT, prefs({ enabled: false })),
    false,
    "the user's switch is off"
  )
  assert.equal(
    telemetryFlushEnabled(false, LIT, prefs({ noticeShown: false })),
    false,
    'THE T1 GATE: nothing transmits before the first-run notice has rendered'
  )

  // And the state every build shipped to date is actually in, whatever the prefs say.
  for (const p of [prefs(), prefs({ enabled: false }), prefs({ noticeShown: false })]) {
    for (const e2e of [true, false]) {
      assert.equal(telemetryFlushEnabled(e2e, TELEMETRY_API_URL, p), false)
    }
  }
})

test('COLLECTION is gated on the user’s switch ALONE — that is what makes the notice honest', () => {
  // T1: "Collection may buffer pre-notice; the network starts only after the notice renders."
  // A buffer that stayed empty until the notice was answered would leave the notice's own
  // "here is what would be sent" panel showing nothing, which is the wrong kind of honest.
  assert.equal(telemetryCollectEnabled(prefs({ noticeShown: false })), true)
  assert.equal(telemetryCollectEnabled(prefs()), true)
  assert.equal(telemetryCollectEnabled(prefs({ enabled: false })), false)
  assert.equal(telemetryCollectEnabled(prefs({ enabled: false, noticeShown: false })), false)
})

// ---- 2. THERE IS NO TRANSPORT ------------------------------------------------------------

/** Every source file the telemetry feature owns in main. */
function telemetrySources(): { name: string; body: string }[] {
  return readdirSync(TELEMETRY_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => ({ name, body: readFileSync(join(TELEMETRY_DIR, name), 'utf8') }))
}

test('THE STRUCTURAL PIN: there is no networking code anywhere under src/main/telemetry/', () => {
  const files = telemetrySources()
  assert.ok(files.length >= 4, `expected the feature's modules, found ${String(files.length)}`)
  // Comments are stripped first: this whole directory TALKS about the transport it does not
  // have, and a grep that counted prose would be a grep nobody could keep green.
  const code = (body: string): string =>
    body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const banned = [
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /\bnet\.request\b/,
    /require\(['"]https?['"]\)/,
    /from ['"]node:https?['"]/,
    /new WebSocket/
  ]
  for (const { name, body } of files) {
    const src = code(body)
    for (const re of banned) {
      assert.equal(re.test(src), false, `${name} contains ${String(re)} — the build is meant to be DARK`)
    }
  }
})

test('THERE IS NO OVERRIDE: no setter, no env var, nothing can supply an endpoint', () => {
  // The feedback precedent (§6.2): an overridable ingest URL is an exfiltration primitive, not
  // a convenience. Telemetry does not even have feedback's loopback dev gate.
  assert.deepEqual(Object.keys(net).filter((k) => /^(set|override|configure)/i.test(k)), [])
  for (const { name, body } of telemetrySources()) {
    assert.equal(/process\.env/.test(body), false, `${name} must not read an env var for an endpoint`)
  }
})

// ---- 3. THE RING ---------------------------------------------------------------------------

const rec = (ts: number): TelemetryRecord => ({ ts, ev: { t: 'sessionHeartbeat', uptimeMs: ts } })

test('the ring keeps the NEWEST records and drops the oldest — never the other way round', () => {
  // A counter feed that stopped recording at 500 would stop measuring exactly the long sessions
  // most worth measuring.
  let events: TelemetryRecord[] = []
  for (let i = 0; i < TELEMETRY_BUFFER_CAP + 25; i++) events = pushCapped(events, rec(i))
  assert.equal(events.length, TELEMETRY_BUFFER_CAP)
  assert.equal(events[0]?.ts, 25, 'the oldest 25 were dropped')
  assert.equal(events.at(-1)?.ts, TELEMETRY_BUFFER_CAP + 24, 'the newest is always kept')

  // Pure: the input array is never mutated.
  const before: TelemetryRecord[] = [rec(1)]
  const after = pushCapped(before, rec(2), 5)
  assert.equal(before.length, 1)
  assert.equal(after.length, 2)
  assert.deepEqual(pushCapped(before, rec(2), 0), [], 'a zero cap holds nothing')
})

test('a foreign, corrupt or hand-edited ring file is refused rather than trusted', () => {
  assert.deepEqual(parseRingFile({ version: TELEMETRY_RING_VERSION, events: [] }), emptyRing())
  for (const junk of [null, 42, 'nope', [], {}, { version: 99, events: [] }, { version: 1 }]) {
    assert.equal(parseRingFile(junk), null, JSON.stringify(junk))
  }

  // AND the records inside it go through the SHARED validator, so a hand edit cannot smuggle a
  // field the schema has no room for into a future batch. The ring is an input like any other.
  const parsed = parseRingFile({
    version: TELEMETRY_RING_VERSION,
    events: [
      { ts: 1, ev: { t: 'viewDwell', view: 'combat', ms: 10, characterName: 'Primitive' } },
      { ts: 2, ev: { t: 'notAnEvent', payload: 'anything at all' } },
      'not a record'
    ]
  })
  assert.deepEqual(parsed?.events, [{ ts: 1, ev: { t: 'viewDwell', view: 'combat', ms: 10 } }])
  assert.equal(parsed?.lastBatch, null, 'a display-only field is never restored from disk')
})

test('an over-long ring file is trimmed to the cap on read, not honored', () => {
  const events = Array.from({ length: TELEMETRY_BUFFER_CAP + 40 }, (_, i) => rec(i))
  const parsed = parseRingFile({ version: TELEMETRY_RING_VERSION, events })
  assert.equal(parsed?.events.length, TELEMETRY_BUFFER_CAP)
  assert.equal(parsed?.events.at(-1)?.ts, TELEMETRY_BUFFER_CAP + 39)
})
