// The feedback CONTRACT (src/shared/feedback.ts) — one definition, three consumers.
//
// It is run by the renderer dialog (to gate Send), by the main process (at the IPC boundary)
// and by the ingest Lambda (as its whole shape check). If those three ever disagree about what
// "valid" means, the user meets a 400 they cannot act on — so this suite pins the BOUNDARIES
// themselves: at each limit, one past it, one under it. Not a happy path.
//
// The second law it pins is REJECT, NEVER TRUNCATE: an over-long description is an error the
// user is told about, never a silently shortened report. Trimming surrounding whitespace is
// normalization and is allowed; shortening content is not.
//
// The scrub half of this wave has its own suite: tests/logScrub.test.mts.
//
// No Electron, no network, no fixtures — this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LOG_WINDOW,
  FEEDBACK_API_VERSION,
  LOG_WINDOW_CHOICES,
  MAX_DESCRIPTION,
  MAX_ENV_FIELD,
  MAX_SLICE_LINES,
  MAX_UPLOAD_BYTES,
  MIN_DESCRIPTION,
  validateDraft,
  validateLogMeta,
  validateSubmit,
  type FeedbackDraft,
  type FeedbackEnv,
  type LogSliceMeta,
  type SubmitRequest
} from '../src/shared/feedback'

// ---------------------------------------------------------------------------------------
// validateDraft — the user's own words
// ---------------------------------------------------------------------------------------

const draft = (over: Partial<FeedbackDraft> = {}): unknown => ({
  type: 'bug',
  description: 'the meter shows zero dps after zoning',
  ...over
})

/** `n` characters of prose-shaped text (never whitespace — trim would eat it). */
const chars = (n: number): string => 'x'.repeat(n)

test('validateDraft accepts the shape the dialog produces', () => {
  const res = validateDraft(draft())
  assert.equal(res.ok, true)
  assert.deepEqual(res.ok && res.value, {
    type: 'bug',
    description: 'the meter shows zero dps after zoning'
  })
})

test('description length is bounded at both ends, measured AFTER trim', () => {
  assert.equal(validateDraft(draft({ description: chars(MIN_DESCRIPTION) })).ok, true)
  assert.equal(validateDraft(draft({ description: chars(MAX_DESCRIPTION) })).ok, true)

  const short = validateDraft(draft({ description: chars(MIN_DESCRIPTION - 1) }))
  assert.equal(short.ok, false)
  assert.equal(!short.ok && short.field, 'description')
  assert.equal(!short.ok && short.error, 'invalid_payload')

  const long = validateDraft(draft({ description: chars(MAX_DESCRIPTION + 1) }))
  assert.equal(long.ok, false)
  assert.equal(!long.ok && long.field, 'description')

  // Padding is not content: a min-length description drowned in whitespace still fails, and
  // surrounding whitespace on a valid one is normalized away.
  assert.equal(validateDraft(draft({ description: `   ${chars(MIN_DESCRIPTION - 1)}   ` })).ok, false)
  const padded = validateDraft(draft({ description: `\n  ${chars(MIN_DESCRIPTION)}  \n` }))
  assert.equal(padded.ok && padded.value.description, chars(MIN_DESCRIPTION))
})

test('REJECT, NEVER TRUNCATE — an over-long description is an error, not a haircut', () => {
  const over = chars(MAX_DESCRIPTION + 500)
  const res = validateDraft(draft({ description: over }))
  assert.equal(res.ok, false)
  // and the accepted one comes back the exact length it went in
  const at = validateDraft(draft({ description: chars(MAX_DESCRIPTION) }))
  assert.equal(at.ok && at.value.description.length, MAX_DESCRIPTION)
})

test('retired fields: a title/contact from an older client is dropped, never rejected', () => {
  // The wire once carried optional `title` and `contact`; both were retired. An older client
  // still sending them must not meet a 400 — the validator constructs the value from the
  // fields the contract still has, so the retired ones simply vanish.
  for (const legacy of ['DPS resets', 'me@example.com', chars(10_000), '', null]) {
    const res = validateDraft(draft({ title: legacy, contact: legacy } as object))
    assert.equal(res.ok, true)
    assert.equal(res.ok && 'title' in res.value, false)
    assert.equal(res.ok && 'contact' in res.value, false)
  }
})

test('validateDraft rejects everything that is not one of the two types', () => {
  for (const type of ['feature', 'bug']) {
    assert.equal(validateDraft(draft({ type: type as FeedbackDraft['type'] })).ok, true)
  }
  for (const bad of ['Bug', 'question', '', 0, null, undefined]) {
    const res = validateDraft(draft({ type: bad as FeedbackDraft['type'] }))
    assert.equal(res.ok, false, `type ${String(bad)} must be rejected`)
    assert.equal(!res.ok && res.field, 'type')
  }
  // and a non-object body at all
  for (const bad of [null, undefined, 'a report', 42, ['bug']]) {
    assert.equal(validateDraft(bad).ok, false)
  }
})

// ---------------------------------------------------------------------------------------
// validateLogMeta — the attachment's metadata (the presign's cost model rests on it)
// ---------------------------------------------------------------------------------------

const meta = (over: Partial<LogSliceMeta> = {}): unknown => ({
  bytes: 131_072,
  lines: 4_812,
  dropped: 91,
  fromMs: 1_754_000_000_000,
  toMs: 1_754_001_800_000,
  sha256: 'a'.repeat(64),
  ...over
})

test('log metadata is bounded exactly where the presign policy is', () => {
  assert.equal(validateLogMeta(meta({ bytes: 1 })).ok, true)
  assert.equal(validateLogMeta(meta({ bytes: MAX_UPLOAD_BYTES })).ok, true)
  assert.equal(validateLogMeta(meta({ bytes: MAX_UPLOAD_BYTES + 1 })).ok, false)
  // 0 bytes is not an upload: `content-length-range` starts at 1, and an empty window is
  // sent as `log: null`, never as a zero-line slice.
  assert.equal(validateLogMeta(meta({ bytes: 0 })).ok, false)
  assert.equal(validateLogMeta(meta({ lines: 1 })).ok, true)
  assert.equal(validateLogMeta(meta({ lines: MAX_SLICE_LINES })).ok, true)
  assert.equal(validateLogMeta(meta({ lines: MAX_SLICE_LINES + 1 })).ok, false)
  assert.equal(validateLogMeta(meta({ lines: 0 })).ok, false)
  // a scrub that removed nothing is honest information, not an error
  assert.equal(validateLogMeta(meta({ dropped: 0 })).ok, true)
  assert.equal(validateLogMeta(meta({ dropped: -1 })).ok, false)
  // fractional byte counts are a bug in the caller, not a rounding opportunity
  assert.equal(validateLogMeta(meta({ bytes: 1024.5 })).ok, false)
})

test('a slice cannot end before it starts, and its digest is 64 hex', () => {
  assert.equal(validateLogMeta(meta({ fromMs: 5, toMs: 5 })).ok, true)
  const backwards = validateLogMeta(meta({ fromMs: 6, toMs: 5 }))
  assert.equal(backwards.ok, false)
  assert.equal(!backwards.ok && backwards.field, 'log.toMs')

  for (const bad of ['a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}z`, '', 12]) {
    const res = validateLogMeta(meta({ sha256: bad as string }))
    assert.equal(res.ok, false, `sha256 ${String(bad)} must be rejected`)
    assert.equal(!res.ok && res.field, 'log.sha256')
  }
})

// ---------------------------------------------------------------------------------------
// validateSubmit — the whole request, as the Lambda sees it
// ---------------------------------------------------------------------------------------

const env = (over: Partial<FeedbackEnv> = {}): unknown => ({
  appVersion: '0.2.0',
  channel: 'prod',
  updateChannel: 'main',
  platform: 'win32',
  osRelease: '10.0.22631',
  arch: 'x64',
  electron: '33.2.0',
  chrome: '130.0.6723.44',
  node: '20.18.0',
  ...over
})

const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const UUID_B = '9c858901-8a57-4791-81fe-4c455b099bc9'

const submit = (over: Record<string, unknown> = {}): unknown => ({
  v: FEEDBACK_API_VERSION,
  draft: draft(),
  env: env(),
  installId: UUID_A,
  clientReportId: UUID_B,
  clientTs: 1_754_000_000_000,
  log: meta(),
  ...over
})

test('validateSubmit accepts a real request, with and without an attachment', () => {
  const withLog = validateSubmit(submit())
  assert.equal(withLog.ok, true)
  assert.equal(withLog.ok && withLog.value.log?.lines, 4_812)

  const noLog = validateSubmit(submit({ log: null }))
  assert.equal(noLog.ok, true)
  assert.equal(noLog.ok && noLog.value.log, null)
  // an absent key is the same statement as an explicit null
  const absent = validateSubmit(submit({ log: undefined }))
  assert.equal(absent.ok && absent.value.log, null)
})

test('the version is a hard gate — an unknown wire version never reaches the model', () => {
  for (const v of [0, 2, '1', null, undefined]) {
    const res = validateSubmit(submit({ v }))
    assert.equal(res.ok, false, `v=${String(v)} must be rejected`)
    assert.equal(!res.ok && res.field, 'v')
  }
})

test('ids must be v4 uuids — they key the quota and the idempotency item', () => {
  for (const field of ['installId', 'clientReportId']) {
    for (const bad of [
      '',
      'not-a-uuid',
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301', // v1, not v4
      '3f2504e04f8941d39a0c0305e82c3301', // unhyphenated
      `${UUID_A} `,
      42
    ]) {
      const res = validateSubmit(submit({ [field]: bad }))
      assert.equal(res.ok, false, `${field}=${String(bad)} must be rejected`)
      assert.equal(!res.ok && res.field, field)
    }
  }
})

test('env is pinned to what the client can actually report', () => {
  // appVersion: semver, with CI's prerelease channel tag allowed
  for (const good of ['0.1.0', '0.2.0', '1.10.3', '0.2.0-main.41']) {
    assert.equal(validateSubmit(submit({ env: env({ appVersion: good }) })).ok, true)
  }
  for (const bad of ['0.2', 'v0.2.0', '', 'latest']) {
    const res = validateSubmit(submit({ env: env({ appVersion: bad }) }))
    assert.equal(res.ok, false, `appVersion=${bad} must be rejected`)
    assert.equal(!res.ok && res.field, 'env.appVersion')
  }
  // channel: 'e2e' is NOT a submitting channel — the headless harness never files a report
  assert.equal(validateSubmit(submit({ env: env({ channel: 'dev' }) })).ok, true)
  const e2e = validateSubmit(submit({ env: env({ channel: 'e2e' as FeedbackEnv['channel'] }) }))
  assert.equal(e2e.ok, false)
  assert.equal(!e2e.ok && e2e.field, 'env.channel')
  // updateChannel: exactly the store's two values
  assert.equal(validateSubmit(submit({ env: env({ updateChannel: 'stable' }) })).ok, true)
  assert.equal(
    validateSubmit(submit({ env: env({ updateChannel: 'beta' as 'main' }) })).ok,
    false
  )
  // free-form runtime strings: present and bounded
  const empty = validateSubmit(submit({ env: env({ arch: '' }) }))
  assert.equal(empty.ok, false)
  assert.equal(!empty.ok && empty.field, 'env.arch')
  assert.equal(validateSubmit(submit({ env: env({ osRelease: chars(MAX_ENV_FIELD) }) })).ok, true)
  assert.equal(
    validateSubmit(submit({ env: env({ osRelease: chars(MAX_ENV_FIELD + 1) }) })).ok,
    false
  )
  assert.equal(validateSubmit(submit({ env: null })).ok, false)
})

test("clientTs is kept, never trusted — any finite clock passes, a non-number doesn't", () => {
  for (const ts of [0, -1, 1_754_000_000_000, 4_102_444_800_000]) {
    assert.equal(validateSubmit(submit({ clientTs: ts })).ok, true, `clientTs=${ts}`)
  }
  for (const bad of ['now', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const res = validateSubmit(submit({ clientTs: bad }))
    assert.equal(res.ok, false, `clientTs=${String(bad)} must be rejected`)
    assert.equal(!res.ok && res.field, 'clientTs')
  }
})

test('a nested failure names the nested field, so the dialog can focus it', () => {
  const res = validateSubmit(submit({ draft: draft({ description: 'short' }) }))
  assert.equal(res.ok, false)
  assert.equal(!res.ok && res.field, 'description')
  const logRes = validateSubmit(submit({ log: meta({ bytes: MAX_UPLOAD_BYTES + 1 }) }))
  assert.equal(!logRes.ok && logRes.field, 'log.bytes')
})

test('validateSubmit returns a value that round-trips through JSON unchanged', () => {
  const res = validateSubmit(submit())
  assert.equal(res.ok, true)
  const value: SubmitRequest = res.ok ? res.value : ({} as SubmitRequest)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('the window choices the dialog offers include its default', () => {
  assert.ok(LOG_WINDOW_CHOICES.includes(DEFAULT_LOG_WINDOW as 15 | 30 | 60))
})

