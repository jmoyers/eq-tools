// TELEMETRY.md ↔ the schema — plan decision T4's "so it cannot drift".
//
// TELEMETRY.md is a PROMISE to users about what this app is allowed to measure. A hand-written
// promise about a machine-readable schema is a promise that goes stale on the first PR that
// forgets it, and a stale privacy doc is worse than none: it is a claim the code no longer
// makes. So the doc is GENERATED (`npm run gen:telemetry-doc`) and this suite is the lock —
// change the schema without regenerating and the suite is red, with the fix in its message.
//
// It checks three different things, and they fail for three different reasons:
//   * COMPLETENESS — every event kind in the union has a doc row, in the union's own order.
//     Fails when someone adds an event and no doc entry.
//   * PARITY — the committed bytes equal a fresh render. Fails when someone edits either side.
//   * SUBSTANCE — the rendered page actually names every enum member and bucket edge the
//     schema has. Fails if the renderer ever stops reaching into the schema and starts
//     describing it from memory, which is the failure mode generation exists to prevent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALERT_COUNT_EDGES,
  CHAR_COUNT_EDGES,
  COLD_START_MS_EDGES,
  LOG_SIZE_BYTES_EDGES,
  TELEMETRY_BUFFER_CAP,
  TELEMETRY_EVENT_KINDS,
  TELEMETRY_FEATURES,
  TELEMETRY_FUNNELS,
  TELEMETRY_FUNNEL_STEPS,
  TELEMETRY_OVERLAY_KINDS,
  TELEMETRY_VIEWS,
  bucketRange
} from '../src/shared/telemetry'
import {
  DOC_EVENT_KINDS,
  TELEMETRY_DOC_BUCKETS,
  TELEMETRY_DOC_EVENTS,
  docCoversSchema,
  renderTelemetryDoc
} from '../src/shared/telemetryDoc'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// CRLF-normalized: parity is about CONTENT, and this repo checks out with core.autocrlf=true,
// so the committed file's on-disk bytes carry \r\n while the renderer emits \n. Comparing
// bytes would make the suite red on every Windows checkout for a doc that has not drifted.
const committed = (): string =>
  readFileSync(join(ROOT, 'TELEMETRY.md'), 'utf8').replace(/\r\n/g, '\n')

test('COMPLETENESS: every event in the schema has a doc row, in the schema’s order', () => {
  assert.deepEqual(DOC_EVENT_KINDS, [...TELEMETRY_EVENT_KINDS])
  assert.equal(docCoversSchema(), true)
  // …and every row lists at least one field, so an event cannot be documented as a name only.
  for (const e of TELEMETRY_DOC_EVENTS) {
    assert.ok(e.fields.length > 0, `${e.t} documents no fields`)
    assert.ok(e.when.length > 10, `${e.t} does not say when it fires`)
  }
})

test('PARITY: the committed TELEMETRY.md is exactly what the schema renders today', () => {
  assert.equal(
    committed(),
    renderTelemetryDoc(),
    'TELEMETRY.md is out of date — run `npm run gen:telemetry-doc` and commit the result'
  )
})

test('SUBSTANCE: the page names every enum member the schema can emit', () => {
  const md = committed()
  const closed = [
    ...TELEMETRY_EVENT_KINDS,
    ...TELEMETRY_VIEWS,
    ...TELEMETRY_OVERLAY_KINDS,
    ...TELEMETRY_FEATURES,
    ...TELEMETRY_FUNNELS,
    ...TELEMETRY_FUNNELS.flatMap((f) => TELEMETRY_FUNNEL_STEPS[f])
  ]
  for (const value of closed) {
    assert.ok(md.includes(`\`${value}\``), `TELEMETRY.md never mentions \`${value}\``)
  }
  // Every field of every event, too: a doc that lists the events but not their fields would
  // pass "completeness" while telling the user nothing they could check.
  for (const e of TELEMETRY_DOC_EVENTS) {
    for (const f of e.fields) {
      assert.ok(md.includes(`\`${f.name}\``), `TELEMETRY.md never mentions \`${e.t}.${f.name}\``)
    }
  }
})

test('SUBSTANCE: the page prints every bucket RANGE, from the schema’s own edges', () => {
  const md = committed()
  const edgeSets = [COLD_START_MS_EDGES, CHAR_COUNT_EDGES, LOG_SIZE_BYTES_EDGES, ALERT_COUNT_EDGES]
  assert.equal(TELEMETRY_DOC_BUCKETS.length, edgeSets.length, 'every bucket field is documented')
  for (const b of TELEMETRY_DOC_BUCKETS) {
    assert.ok(md.includes(`\`${b.field}\``))
    // One table row per bucket index, so a user can read off which bucket a value of theirs
    // would land in — that is the whole reason a bucket beats a raw number in public.
    for (let i = 0; i <= b.edges.length; i++) {
      assert.ok(md.includes(`| ${String(i)} |`), `${b.field} is missing bucket ${String(i)}`)
      bucketRange(b.edges, i) // in range for every index the schema can produce
    }
  }
  assert.ok(md.includes(String(TELEMETRY_BUFFER_CAP)), 'the page states how much is held locally')
})

test('THE DARK-BUILD SENTENCE is on the page, because it is true of every build today', () => {
  // When wave A2 lights the endpoint this assertion is EXPECTED to change — in the same commit
  // that amends SECURITY.md and README, which is the point of pinning it here.
  const md = committed()
  assert.match(md, /no build sends anything at all/i)
  assert.match(md, /Preferences/)
})
