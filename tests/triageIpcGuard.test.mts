// The DEV-ONLY triage surface's two pure halves — the handler guards (src/main/triage/validate.ts)
// and the row mappers (src/main/triage/rows.ts). No AWS, no network, no Electron, no fixtures,
// so this suite NEVER SKIPS.
//
// Four things are load-bearing and each gets real coverage:
//
//   1. `reportId` REACHES A FILE PATH (`.triage/slices/<id>.log`) as well as a SQL parameter,
//      so it is required to be a 26-character Crockford ULID. If that regressed, a renderer
//      string would reach `join()` — the exact failure `isSafePackId` exists to prevent.
//   2. THE LOG STATE IS TRI-STATE. `declared` (the list's honest answer), `present` and
//      `missing` (a real upload failure, resolved by one HeadObject). Collapsing them to a
//      boolean would make the UI lie about a failed upload.
//   3. THE KILL SWITCH'S POLARITY. The CLI says `closed on`; this surface says `accepting`.
//      A config row that says accepting:false must read as NOT accepting, and a MISSING config
//      row must read as not accepting too — schema.sql seeds a fresh stack closed.
//   4. `env_json` IS TEXT HOLDING JSON. The parse must be TOTAL: garbage yields {}, never a
//      throw that would blank the detail pane.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isInstallId,
  isReportId,
  validateAnalyticsDays,
  validateBlockReason,
  validateClosedMessage,
  validatePatch,
  validateQuery,
  MAX_NOTE
} from '../src/main/triage/validate'
import { parseEnv, toDetail, toOps, toRow } from '../src/main/triage/rows'
import {
  TRIAGE_ANALYTICS_DAYS,
  TRIAGE_ANALYTICS_DEFAULT_DAYS,
  TRIAGE_DEFAULT_QUERY,
  TRIAGE_LIMIT_MAX
} from '../src/shared/triage'

/** A real-shaped ULID: 26 Crockford base32 characters. */
const ID = '01K1P6Q8ZJ7X4M2N9V5B3C6D7E'

// ---- 1. reportId is path-safe by SHAPE ---------------------------------------------------

test('a reportId must be a 26-character ULID — it reaches a file path, not just SQL', () => {
  assert.equal(isReportId(ID), true)
  // Crockford excludes I, L, O and U precisely so they cannot be confused; a string carrying
  // one is not a ULID we minted.
  assert.equal(isReportId('01K1P6Q8ZJ7X4M2N9V5B3C6D7I'), false)
  assert.equal(isReportId(ID.slice(0, 25)), false)
  assert.equal(isReportId(`${ID}A`), false)
  assert.equal(isReportId('lowercase0123456789abcdefg'), false)
  assert.equal(isReportId(123), false)
  assert.equal(isReportId(undefined), false)
})

test('path traversal cannot survive the reportId guard', () => {
  for (const attempt of ['../../etc/passwd', '..', 'a/../../b', 'C:\\Windows\\win.ini', `${ID}/../x`]) {
    assert.equal(isReportId(attempt), false, attempt)
  }
})

test('an installId must be a v4 UUID', () => {
  assert.equal(isInstallId('3f2504e0-4f89-41d3-9a0c-0305e82c3301'), true)
  assert.equal(isInstallId('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), false) // v1, not v4
  assert.equal(isInstallId('not-a-uuid'), false)
})

// ---- the query guard ---------------------------------------------------------------------

test('the list query is validated field by field, and rejects rather than clamping', () => {
  assert.deepEqual(validateQuery(TRIAGE_DEFAULT_QUERY), TRIAGE_DEFAULT_QUERY)
  // `since` is an ENUM, not free text — it reaches parseSince, which accepts any Date.parse-able
  // string, and the answer set must be bounded by the toolbar's own choices.
  assert.equal(validateQuery({ ...TRIAGE_DEFAULT_QUERY, since: '1999-01-01' }), null)
  assert.equal(validateQuery({ ...TRIAGE_DEFAULT_QUERY, channel: 'staging' }), null)
  assert.equal(validateQuery({ ...TRIAGE_DEFAULT_QUERY, limit: 0 }), null)
  assert.equal(validateQuery({ ...TRIAGE_DEFAULT_QUERY, limit: TRIAGE_LIMIT_MAX + 1 }), null)
  assert.equal(validateQuery({ ...TRIAGE_DEFAULT_QUERY, limit: 12.5 }), null)
  assert.equal(validateQuery({ ...TRIAGE_DEFAULT_QUERY, status: 'closed' }), null)
  assert.equal(validateQuery(null), null)
  assert.equal(validateQuery('all'), null)
})

test('an optional query field that is present must still be legal', () => {
  const q = validateQuery({ ...TRIAGE_DEFAULT_QUERY, status: 'new', type: 'bug' })
  assert.deepEqual(q, { ...TRIAGE_DEFAULT_QUERY, status: 'new', type: 'bug' })
})

// ---- the patch guard ---------------------------------------------------------------------

test('an EMPTY patch is rejected — it would stamp triaged_at and change nothing', () => {
  assert.equal(validatePatch({}), null)
  assert.equal(validatePatch({ note: '   ' }), null)
})

test('a patch takes only the closed unions and bounded text', () => {
  assert.deepEqual(validatePatch({ status: 'shipped' }), { status: 'shipped' })
  assert.deepEqual(validatePatch({ severity: 'p0', note: ' looked at it ' }), {
    severity: 'p0',
    note: 'looked at it'
  })
  assert.equal(validatePatch({ severity: 'p9' }), null)
  assert.equal(validatePatch({ note: 'x'.repeat(MAX_NOTE + 1) }), null)
  // dupeOf names another report, so it is held to the same ULID shape.
  assert.deepEqual(validatePatch({ dupeOf: ID }), { dupeOf: ID })
  assert.equal(validatePatch({ dupeOf: 'some-other-report' }), null)
})

test('issueUrl is NOT writable from the UI — only `triage-feedback issue` stamps it', () => {
  // It is stamped by the command that ran assertNoLogSlice over what it published; a URL
  // written from a panel would claim a publication nobody performed.
  assert.equal(validatePatch({ issueUrl: 'https://example.invalid/1' }), null)
})

// ---- the analytics window (usage-analytics A3) ---------------------------------------------

test('the analytics window is an ENUM — it becomes a day floor over an unbounded table', () => {
  for (const days of TRIAGE_ANALYTICS_DAYS) assert.equal(validateAnalyticsDays(days), days)
  // Same reasoning as `since`: the answer set is the toolbar's own choices, not whatever a
  // renderer computes, because the value reaches a `day >= :floor` on `usage_daily`.
  assert.equal(validateAnalyticsDays(31), null)
  assert.equal(validateAnalyticsDays(0), null)
  assert.equal(validateAnalyticsDays(-30), null)
  assert.equal(validateAnalyticsDays(30.5), null)
  assert.equal(validateAnalyticsDays('30'), null)
  assert.equal(validateAnalyticsDays({ days: 30 }), null)
  assert.equal(validateAnalyticsDays(Number.NaN), null)
})

test('an OMITTED window is the default, not a rejection — the panel’s first render has none', () => {
  assert.equal(validateAnalyticsDays(undefined), TRIAGE_ANALYTICS_DEFAULT_DAYS)
  assert.equal(validateAnalyticsDays(null), TRIAGE_ANALYTICS_DEFAULT_DAYS)
  // …and the default is itself one of the offered choices, so the toolbar can always show it.
  assert.equal((TRIAGE_ANALYTICS_DAYS as readonly number[]).includes(TRIAGE_ANALYTICS_DEFAULT_DAYS), true)
})

// ---- the ops guards ----------------------------------------------------------------------

test('an omitted closed message means "keep what the cluster says", not "blank it"', () => {
  assert.equal(validateClosedMessage(undefined), undefined)
  assert.equal(validateClosedMessage(null), undefined)
  assert.equal(validateClosedMessage(' paused '), 'paused')
  assert.equal(validateClosedMessage(''), null)
  assert.equal(validateClosedMessage('x'.repeat(1000)), null)
})

test('blocking requires a reason; unblocking does not', () => {
  assert.equal(validateBlockReason(undefined, true), null)
  assert.equal(validateBlockReason('  ', true), null)
  assert.equal(validateBlockReason(' flooding ', true), 'flooding')
  assert.equal(validateBlockReason(undefined, false), 'unblocked')
})

// ---- 2. the tri-state log ----------------------------------------------------------------

const BASE = {
  report_id: ID,
  install_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  report_type: 'bug',
  description: 'the overlay goes blank after zoning',
  channel: 'prod',
  app_version: '0.2.0',
  platform: 'win32',
  env_json: '{"appVersion":"0.2.0","arch":"x64"}',
  client_ts: 1_000,
  received_at: 2_000,
  spam_score: 0,
  status: 'new',
  log_json: null,
  log_key: null
}

test('a list row says `declared`, never `present` — the list does not pay for a HeadObject', () => {
  assert.equal(toRow(BASE).log, 'none')
  assert.equal(toRow({ ...BASE, log_json: '{"lines":40}' }).log, 'declared')
})

test('the detail resolves `present` vs `missing`, and `missing` is a REAL outcome', () => {
  const declared = { ...BASE, log_json: '{"lines":40,"bytes":900}', log_key: 'slices/x.gz' }
  assert.equal(toDetail(declared, true).log, 'present')
  // Declared but not in the bucket: the presigned upload failed or expired. This must NOT read
  // as "no log attached" — the CLI prints the distinction and so does the panel.
  assert.equal(toDetail(declared, false).log, 'missing')
  // A report that never attached anything is `none` even though `logLanded` is false.
  assert.equal(toDetail(BASE, false).log, 'none')
})

test('the declared slice metadata rides along so the UI can say how big it was', () => {
  const d = toDetail({ ...BASE, log_json: '{"lines":40,"bytes":900}', log_key: 'k' }, true)
  assert.equal(d.logLines, 40)
  assert.equal(d.logBytes, 900)
  assert.equal(d.logKey, 'k')
})

test('NULL and empty optional columns are absent, never the empty string', () => {
  const d = toDetail({ ...BASE, severity: null, disposition: '   ' }, false)
  assert.equal(d.row.severity, undefined)
  assert.equal(d.note, undefined)
})

test('`title` and `contact` are DROPPED COLUMNS: a legacy row still carrying them leaks neither', () => {
  // A cluster migrated before the columns were removed still returns them from `SELECT *`.
  // The mappers must ignore what they are handed rather than pass it across the bridge —
  // that is what makes "the columns are gone" true for every reader, not just fresh stacks.
  const legacy = { ...BASE, title: 'blank overlay', contact: 'someone@example.com' }
  assert.equal('title' in toRow(legacy), false)
  const d = toDetail(legacy, false)
  assert.equal('title' in d.row, false)
  assert.equal('contact' in d, false)
})

// ---- 3. the kill switch's polarity -------------------------------------------------------

test('the ops state is POSITIVE: `accepting`, which is the inverse of the CLI\'s `closed`', () => {
  const open = toOps({ accepting: true, closed_message: 'paused', max_per_install_per_day: 10 }, [])
  assert.equal(open.accepting, true)
  const closed = toOps({ accepting: false, closed_message: 'paused', max_per_install_per_day: 10 }, [])
  assert.equal(closed.accepting, false)
})

test('a cluster with NO config row reads as closed — schema.sql seeds a fresh stack shut', () => {
  const ops = toOps(null, [])
  assert.equal(ops.accepting, false)
  assert.match(ops.closedMessage, /not open yet/i)
  assert.equal(ops.maxPerInstallPerDay, 0)
})

test('the block list is a HISTORY: an unblocked install keeps its row, flagged allowed', () => {
  const ops = toOps(null, [
    { install_id: 'a', blocked: true, blocked_reason: 'flooding', blocked_at: 5 },
    { install_id: 'b', blocked: false, blocked_reason: 'unblocked', blocked_at: 6 }
  ])
  assert.deepEqual(ops.blocked.map((b) => b.blocked), [true, false])
  assert.equal(ops.blocked[0].reason, 'flooding')
})

// ---- 4. env_json is TEXT holding JSON, and the parse is total -----------------------------

test('parseEnv never throws, whatever the column holds', () => {
  assert.deepEqual(parseEnv('{"a":"1"}'), { a: '1' })
  assert.deepEqual(parseEnv('{"n":3,"b":true}'), { n: '3', b: 'true' })
  assert.deepEqual(parseEnv('{truncated'), {})
  assert.deepEqual(parseEnv('[1,2]'), {})
  assert.deepEqual(parseEnv('null'), {})
  assert.deepEqual(parseEnv(''), {})
  assert.deepEqual(parseEnv(null), {})
  assert.deepEqual(parseEnv(42), {})
})
