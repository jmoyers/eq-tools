// scripts/dev-feedback-server.mts — the LOCAL feedback stack, driven for real.
//
// This suite starts the actual server in-process on port 0 and talks to it over a real socket
// with `fetch`, exactly as `src/main/feedback/submit.ts` does. Nothing is stubbed: the request
// goes through the REAL shared `validateSubmit`, the real quota counter, the real idempotency
// map and the real multipart upload leg, and the bytes land on a real temp dir.
//
// WHY IT MATTERS: this server is what makes "test the app without deployed things" true. If it
// drifts from the contract — a wrong status, a missing `field`, an upload that accepts 3 MB —
// then every local rehearsal of the dialog is rehearsing a lie. So the pins here are the
// §8.3 response table and the §8.4 presign conditions, not the server's own conveniences.
//
// No Electron, no network beyond loopback, no fixtures: it never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDevStack, type DevStack } from '../scripts/dev-feedback-server.mts'
import {
  MAX_UPLOAD_BYTES,
  type FeedbackEnv,
  type LogSliceMeta,
  type PresignedUpload,
  type SubmitRequest,
} from '../src/shared/feedback'

// ---- helpers -------------------------------------------------------------------------------

const ENV: FeedbackEnv = {
  appVersion: '0.2.0',
  channel: 'dev',
  updateChannel: 'main',
  platform: 'win32',
  osRelease: '10.0.22631',
  arch: 'x64',
  electron: '33.2.0',
  chrome: '130.0.0.0',
  node: '20.18.0',
}

const GZ = gzipSync(Buffer.from('[Sat Aug 01 13:00:28 2026] You slash a froglok tad for 42 points of damage.\n'))

function metaFor(gz: Buffer): LogSliceMeta {
  return {
    bytes: gz.byteLength,
    lines: 1,
    dropped: 0,
    fromMs: Date.UTC(2026, 7, 1, 13, 0, 28),
    toMs: Date.UTC(2026, 7, 1, 13, 0, 28),
    sha256: createHash('sha256').update(gz).digest('hex'),
  }
}

function request(over: Partial<SubmitRequest> = {}): SubmitRequest {
  return {
    v: 1,
    draft: { type: 'bug', description: 'The overlay meter goes blank after zoning into Sky.' },
    env: ENV,
    installId: randomUUID(),
    clientReportId: randomUUID(),
    clientTs: Date.now(),
    log: null,
    ...over,
  }
}

interface Answer {
  status: number
  body: Record<string, unknown>
}

async function submit(stack: DevStack, body: unknown): Promise<Answer> {
  const res = await fetch(stack.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) }
}

async function setMode(stack: DevStack, patch: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${stack.port}/devstack/mode`, {
    method: 'POST',
    body: JSON.stringify(patch),
  })
  assert.equal(res.status, 200)
}

/** Exactly what submit.ts's `uploadSlice` builds: every field, then the file part LAST. */
async function upload(url: string, fields: Record<string, string>, gz: Buffer): Promise<number> {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  form.append('file', new Blob([new Uint8Array(gz)], { type: 'application/gzip' }), 'slice.log.gz')
  const res = await fetch(url, { method: 'POST', body: form })
  return res.status
}

const upstairs = (a: Answer): PresignedUpload => a.body.upload as PresignedUpload

async function withStack(fn: (stack: DevStack) => Promise<void>, maxPerDay = 10): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'devstack-'))
  const stack = await startDevStack({ port: 0, dir, maxPerDay, quiet: true })
  try {
    await fn(stack)
  } finally {
    await stack.close()
  }
}

// ---- the happy path, end to end --------------------------------------------------------------

test('a submit with a log round-trips: 201, presign, upload, bytes on disk', async () => {
  await withStack(async (stack) => {
    // `title` rides along as a retired legacy field — the server must drop it, not reject it.
    const req = request({ log: metaFor(GZ), draft: { type: 'bug', title: 'blank overlay', description: 'It goes blank after zoning, every time.' } as never })
    const a = await submit(stack, req)

    assert.equal(a.status, 201)
    assert.equal(a.body.ok, true)
    const reportId = a.body.reportId
    assert.equal(typeof reportId, 'string')
    // A ULID: 26 Crockford base32 characters, so it sorts by creation time.
    assert.match(String(reportId), /^[0-9A-HJKMNP-TV-Z]{26}$/)

    // The presign points at THIS server and carries the fields the real policy pins.
    const up = upstairs(a)
    assert.equal(up.url, `http://127.0.0.1:${stack.port}/devstack/upload/${String(reportId)}`)
    assert.match(up.key, /^logs\/\d{4}\/\d{2}\/\d{2}\/[0-9A-Z]{26}\.log\.gz$/)
    assert.equal(up.fields['Content-Type'], 'application/gzip')
    assert.equal(up.fields['x-amz-server-side-encryption'], 'AES256')
    assert.equal(up.expiresInSec, 300)

    // S3 answers a plain presigned POST with 204 and no body.
    assert.equal(await upload(up.url, up.fields, GZ), 204)

    const landed = join(stack.dir, 'uploads', `${String(reportId)}.log.gz`)
    assert.ok(existsSync(landed), 'the slice bytes landed')
    assert.deepEqual(readFileSync(landed), GZ)

    // …and the report is in the ledger, with the upload joined onto it.
    const listed = await fetch(`http://127.0.0.1:${stack.port}/devstack/reports`)
    const seen = (await listed.json()) as { count: number; reports: Record<string, unknown>[] }
    assert.equal(seen.count, 1)
    assert.equal(seen.reports[0]?.reportId, reportId)
    assert.equal(seen.reports[0]?.uploaded, true)
    // Retired wire field, retired COLUMN: the legacy title an old client sent is dropped before
    // the row is built, and the row carries no `title` key at all — not a null one. The real
    // Lambda's INSERT no longer names the column, because the column no longer exists.
    assert.equal('title' in (seen.reports[0] ?? {}), false)
    assert.equal('contact' in (seen.reports[0] ?? {}), false)
  })
})

test('no log attached ⇒ no presign is minted at all', async () => {
  await withStack(async (stack) => {
    const a = await submit(stack, request())
    assert.equal(a.status, 201)
    assert.equal(a.body.upload, null)
  })
})

// ---- the §8.3 response table -------------------------------------------------------------------

test('invalid payloads are 400 invalid_payload and NAME the field', async () => {
  await withStack(async (stack) => {
    const short = await submit(stack, request({ draft: { type: 'bug', description: 'too short' } }))
    assert.equal(short.status, 400)
    assert.equal(short.body.error, 'invalid_payload')
    assert.equal(short.body.field, 'description')

    const badType = await submit(stack, request({ draft: { type: 'praise', description: 'a'.repeat(30) } as never }))
    assert.equal(badType.status, 400)
    assert.equal(badType.body.field, 'type')

    const badId = await submit(stack, request({ installId: 'not-a-uuid' }))
    assert.equal(badId.status, 400)
    assert.equal(badId.body.field, 'installId')

    const badVersion = await submit(stack, { ...request(), v: 2 })
    assert.equal(badVersion.status, 400)
    assert.equal(badVersion.body.field, 'v')

    // Not JSON at all.
    const res = await fetch(stack.url, { method: 'POST', body: 'not json' })
    assert.equal(res.status, 400)
  })
})

test('an oversize body is 413 too_large, refused before it is parsed', async () => {
  await withStack(async (stack) => {
    const a = await submit(stack, request({ draft: { type: 'bug', description: 'x'.repeat(40_000) } }))
    assert.equal(a.status, 413)
    assert.equal(a.body.error, 'too_large')
  })
})

test('KNOB closed: 503 with the operator message, verbatim', async () => {
  await withStack(async (stack) => {
    await setMode(stack, { closed: 'Feedback is paused while we fix an abuse problem — sorry.' })
    const a = await submit(stack, request())
    assert.equal(a.status, 503)
    assert.equal(a.body.error, 'closed')
    assert.equal(a.body.message, 'Feedback is paused while we fix an abuse problem — sorry.')
    // …and it lifts.
    await setMode(stack, { closed: null })
    assert.equal((await submit(stack, request())).status, 201)
  })
})

test('KNOB blocked: 403 blocked', async () => {
  await withStack(async (stack) => {
    await setMode(stack, { blocked: true })
    const a = await submit(stack, request())
    assert.equal(a.status, 403)
    assert.equal(a.body.error, 'blocked')
  })
})

test('KNOB quota exhausted: 429 with retryAfterSec', async () => {
  await withStack(async (stack) => {
    await setMode(stack, { quota: 'exhausted' })
    const a = await submit(stack, request())
    assert.equal(a.status, 429)
    assert.equal(a.body.error, 'quota_exceeded')
    assert.ok(typeof a.body.retryAfterSec === 'number' && a.body.retryAfterSec > 0)
    assert.ok(a.body.retryAfterSec <= 86_400)
  })
})

test('KNOB latencyMs: the response is genuinely delayed (this is how a timeout is rehearsed)', async () => {
  await withStack(async (stack) => {
    await setMode(stack, { latencyMs: 250 })
    const started = Date.now()
    assert.equal((await submit(stack, request())).status, 201)
    assert.ok(Date.now() - started >= 240, 'the server actually waited')
  })
})

// ---- the counters ------------------------------------------------------------------------------

test('the daily quota is REAL: it counts per install, and other installs are unaffected', async () => {
  await withStack(async (stack) => {
    const installId = randomUUID()
    assert.equal((await submit(stack, request({ installId }))).status, 201)
    assert.equal((await submit(stack, request({ installId }))).status, 201)

    const third = await submit(stack, request({ installId }))
    assert.equal(third.status, 429)
    assert.equal(third.body.error, 'quota_exceeded')

    // A different install has its own counter.
    assert.equal((await submit(stack, request({ installId: randomUUID() }))).status, 201)
  }, 2)
})

test('idempotent replay: the same clientReportId returns the ORIGINAL id and no new presign', async () => {
  await withStack(async (stack) => {
    const req = request({ log: metaFor(GZ) })
    const first = await submit(stack, req)
    assert.equal(first.status, 201)
    assert.notEqual(first.body.upload, null)

    const replay = await submit(stack, req)
    assert.equal(replay.status, 200) // 200, not 201 — nothing was created
    assert.equal(replay.body.reportId, first.body.reportId)
    assert.equal(replay.body.upload, null)

    // …and a replay does not consume quota twice, so a retrying offline client is not punished.
    const listed = await fetch(`http://127.0.0.1:${stack.port}/devstack/reports`)
    assert.equal(((await listed.json()) as { count: number }).count, 1)
  }, 1)
})

test('the ledger survives a restart: idempotency and quota are rebuilt from reports.jsonl', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devstack-'))
  const req = request()
  const first = await startDevStack({ port: 0, dir, maxPerDay: 1, quiet: true })
  const created = await submit(first, req)
  assert.equal(created.status, 201)
  await first.close()

  const second = await startDevStack({ port: 0, dir, maxPerDay: 1, quiet: true })
  try {
    const replay = await submit(second, req)
    assert.equal(replay.status, 200)
    assert.equal(replay.body.reportId, created.body.reportId)
    // The quota was rebuilt too: a NEW report from that install is over the (1/day) cap.
    const another = await submit(second, request({ installId: req.installId }))
    assert.equal(another.status, 429)
  } finally {
    await second.close()
  }
})

// ---- the presign leg's own rules ------------------------------------------------------------------

test('the upload leg enforces the pinned key and the two eq conditions, like the policy does', async () => {
  await withStack(async (stack) => {
    const a = await submit(stack, request({ log: metaFor(GZ) }))
    const up = upstairs(a)

    assert.equal(await upload(up.url, { ...up.fields, key: 'logs/2026/08/03/somewhere-else.log.gz' }, GZ), 403)
    assert.equal(await upload(up.url, { ...up.fields, 'Content-Type': 'text/plain' }, GZ), 403)
    assert.equal(await upload(up.url, { ...up.fields, 'x-amz-server-side-encryption': 'none' }, GZ), 403)
    // An unminted report id has no presign behind it.
    assert.equal(await upload(`http://127.0.0.1:${stack.port}/devstack/upload/01BOGUS`, up.fields, GZ), 403)
    // The honest one still works afterwards.
    assert.equal(await upload(up.url, up.fields, GZ), 204)
  })
})

test('the upload leg enforces content-length-range 1..MAX_UPLOAD_BYTES', async () => {
  await withStack(async (stack) => {
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x41)
    const a = await submit(stack, request({ log: metaFor(GZ) }))
    const up = upstairs(a)
    assert.equal(await upload(up.url, up.fields, big), 400) // EntityTooLarge
    assert.equal(await upload(up.url, up.fields, Buffer.alloc(0)), 400) // EntityTooSmall
    assert.ok(!existsSync(join(stack.dir, 'uploads', `${String(a.body.reportId)}.log.gz`)))
  })
})

test('a sha256 mismatch is REPORTED, never rejected — S3 could not see it at all', async () => {
  await withStack(async (stack) => {
    // The client declares one digest and uploads different bytes.
    const a = await submit(stack, request({ log: metaFor(GZ) }))
    const up = upstairs(a)
    const other = gzipSync(Buffer.from('[Sat Aug 01 13:05:00 2026] You have entered The Plane of Sky.\n'))
    assert.equal(await upload(up.url, up.fields, other), 204)

    const lines = readFileSync(join(stack.dir, 'reports.jsonl'), 'utf8').trim().split('\n')
    const row = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>
    assert.equal(row.t, 'upload')
    assert.equal(row.shaMatches, false)
    assert.equal(statSync(join(stack.dir, 'uploads', `${String(a.body.reportId)}.log.gz`)).size, other.byteLength)
  })
})
