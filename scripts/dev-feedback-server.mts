/**
 * dev-feedback-server.mts — THE LOCAL FEEDBACK STACK. No cloud, no credentials, no deploy.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * HOW TO USE IT (two terminals)
 *
 *   1)  npm run dev:stack
 *       → listens on http://127.0.0.1:8477, prints the exact env line to copy.
 *
 *   2)  PowerShell:  $env:EQ_FEEDBACK_URL='http://127.0.0.1:8477/v1/feedback'; npm run dev
 *       bash:        EQ_FEEDBACK_URL=http://127.0.0.1:8477/v1/feedback npm run dev
 *
 *   Open the app → Send feedback → the dialog behaves exactly as it will against the real
 *   API, including the log-slice preview, the presigned upload leg, and every failure state.
 *
 * The env var is honoured ONLY by an unpackaged, non-e2e Electron process, and ONLY for
 * LOOPBACK urls (src/main/feedback/net.ts, header item 3). A packaged build ignores it
 * completely — that is pinned by tests/feedbackNet.test.mts, not merely intended.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * REHEARSING THE FAILURE STATES — one control endpoint, no restarts:
 *
 *   curl -X POST 127.0.0.1:8477/devstack/mode -d '{"closed":"Paused while we fix a thing."}'
 *   curl -X POST 127.0.0.1:8477/devstack/mode -d '{"blocked":true}'
 *   curl -X POST 127.0.0.1:8477/devstack/mode -d '{"quota":"exhausted"}'
 *   curl -X POST 127.0.0.1:8477/devstack/mode -d '{"latencyMs":20000}'   # trips the 15s timeout
 *   curl -X POST 127.0.0.1:8477/devstack/mode -d '{"closed":null,"blocked":false,"quota":"ok","latencyMs":0}'
 *   curl 127.0.0.1:8477/devstack/mode        # what's set right now
 *   curl 127.0.0.1:8477/devstack/reports     # what actually landed
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT LANDS ON DISK (`.devstack/`, gitignored):
 *
 *   .devstack/reports.jsonl          append-only: one line per report, one per upload
 *   .devstack/uploads/<reportId>.log.gz   the slice bytes, exactly as uploaded
 *
 * The daily quota counter and the idempotency map are REBUILT from reports.jsonl at startup,
 * so they survive a restart without a second source of truth to disagree with.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * FIDELITY — what this server IS, and what it can never be.
 *
 * IS: the same shared `validateSubmit` the Lambda runs (imported, not re-implemented), the
 * same step ORDER (size → shape → closed → blocked → replay → quota → write → presign), the
 * same status codes and the same `SubmitResponse` union — including `field` on 400 and
 * `retryAfterSec` on 429 — and a presign leg that enforces the pinned key, the two `eq`
 * conditions and the 1..MAX_UPLOAD_BYTES content-length-range the way S3 does.
 *
 * IS NOT, and cannot be — do not read a green run here as a green run against AWS:
 *   * NO OPTIMISTIC-CONCURRENCY CONFLICTS. Aurora DSQL aborts a racing write with SQLSTATE
 *     40001 and the handler retries; this server is one process handling one request at a
 *     time, so the retry path and the dead-heat idempotency insert are UNREHEARSABLE here.
 *   * NO SPAM SCORE and no cross-install dedupe probe. Scoring lives in the Lambda; a local
 *     row carries `spamScore: null` rather than a second opinion about someone else's rule.
 *   * NO AWS SIGNATURE. The presign carries the fields that MEAN something locally (key,
 *     Content-Type, SSE) and no Policy/X-Amz-Signature, because there is no key to sign with.
 *     A client that mangled the signature fields would still be accepted here, and rejected
 *     by S3.
 *   * NO THROTTLES, no reserved concurrency, no cold starts, no TLS, no SSE-at-rest, no
 *     90-day lifecycle. Latency is a knob, not a distribution.
 *   * The report id is a ULID of the same shape, minted by a SECOND implementation.
 *
 * The one thing it knows that S3 cannot: it re-hashes the uploaded bytes and reports whether
 * they match the `sha256` the client declared. That is a local convenience, never a rejection.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  MAX_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  validateSubmit,
  type LogSliceMeta,
  type PresignedUpload,
  type SubmitErrorCode,
  type SubmitRequest,
} from '../src/shared/feedback'

const DEFAULT_PORT = 8477
const DEFAULT_DIR = '.devstack'
const DEFAULT_MAX_PER_DAY = 10
/** Matches the Lambda's UPLOAD_TTL_SEC, so an expired presign is rehearsable. */
const UPLOAD_TTL_SEC = 300
/** Multipart framing around a 2 MB file part. Bounds memory; the FILE cap is enforced apart. */
const MULTIPART_SLACK = 64 * 1024

// ---- state -------------------------------------------------------------------------------

interface Mode {
  /** Non-null ⇒ every submit answers 503 `closed` with this message, verbatim. */
  closed: string | null
  blocked: boolean
  quota: 'ok' | 'exhausted'
  latencyMs: number
  maxPerDay: number
}

interface Presign {
  key: string
  expiresAt: number
  meta: LogSliceMeta
}

interface State {
  dir: string
  origin: string
  mode: Mode
  quiet: boolean
  /** `installId|clientReportId` → reportId. */
  idemp: Map<string, string>
  /** `installId|yyyy-mm-dd` → count. */
  quota: Map<string, number>
  presigns: Map<string, Presign>
  rows: Record<string, unknown>[]
}

export interface DevStackOptions {
  /** 0 asks the OS for a free port (what the tests use). */
  port?: number
  dir?: string
  maxPerDay?: number
  quiet?: boolean
}

export interface DevStack {
  port: number
  /** The value to put in `EQ_FEEDBACK_URL`. */
  url: string
  dir: string
  close: () => Promise<void>
}

// ---- small shared helpers ------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function ulid(now: number): string {
  let time = ''
  for (let rest = now, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time
  return time + Array.from({ length: 16 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join('')
}

const utcDate = (now: number): string => new Date(now).toISOString().slice(0, 10)

function secondsToUtcMidnight(now: number): number {
  const d = new Date(now)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return Math.max(1, Math.ceil((midnight - now) / 1000))
}

function logObjectKey(reportId: string, now: number): string {
  const d = new Date(now)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `logs/${d.getUTCFullYear()}/${mm}/${dd}/${reportId}.log.gz`
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** What a route answers with. `xml` is the S3 shape; `json` is the ingest API's. */
interface Res {
  status: number
  json?: unknown
  xml?: string
  /** Extra detail for the one console line this request prints. */
  note?: string
}

const fail = (
  status: number,
  error: SubmitErrorCode,
  message: string,
  extra: { field?: string; retryAfterSec?: number } = {},
): Res => ({ status, json: { ok: false, error, message, ...extra }, note: error })

/** S3's own words for the two `content-length-range` failures. */
const TOO_BIG = 'Your proposed upload exceeds the maximum allowed size'
const TOO_SMALL = 'Your proposed upload is smaller than the minimum allowed size'

const s3Error = (status: number, code: string, message: string): Res => ({
  status,
  xml: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
  note: code,
})

// ---- persistence ---------------------------------------------------------------------------
//
// reports.jsonl is the ONE file: append-only, one JSON object per line, `t` discriminating a
// report row from an upload row. The quota counter and the idempotency map are projections of
// it, rebuilt at startup — a second file would be a second truth.

function appendRow(state: State, row: Record<string, unknown>): void {
  state.rows.push(row)
  appendFileSync(join(state.dir, 'reports.jsonl'), `${JSON.stringify(row)}\n`)
}

function replayRow(state: State, row: Record<string, unknown>): void {
  const { installId, clientReportId, reportId, receivedAt } = row
  if (row.t !== 'report' || typeof installId !== 'string' || typeof reportId !== 'string') return
  if (typeof clientReportId !== 'string' || typeof receivedAt !== 'number') return
  state.idemp.set(`${installId}|${clientReportId}`, reportId)
  const key = `${installId}|${utcDate(receivedAt)}`
  state.quota.set(key, (state.quota.get(key) ?? 0) + 1)
}

function loadHistory(state: State): void {
  let text = ''
  try {
    text = readFileSync(join(state.dir, 'reports.jsonl'), 'utf8')
  } catch {
    return // first run: nothing has landed yet
  }
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const row = JSON.parse(line) as Record<string, unknown>
    state.rows.push(row)
    replayRow(state, row)
  }
}

// ---- POST /v1/feedback ----------------------------------------------------------------------

function consumeQuota(state: State, req: SubmitRequest, now: number): boolean {
  if (state.mode.quota === 'exhausted') return false
  const key = `${req.installId}|${utcDate(now)}`
  const n = state.quota.get(key) ?? 0
  if (n >= state.mode.maxPerDay) return false
  state.quota.set(key, n + 1)
  return true
}

/** The presign, minus the parts that only mean something with an AWS key to sign with. */
function mintUpload(state: State, reportId: string, meta: LogSliceMeta, now: number): PresignedUpload {
  const key = logObjectKey(reportId, now)
  state.presigns.set(reportId, { key, expiresAt: now + UPLOAD_TTL_SEC * 1000, meta })
  const fields = { key, 'Content-Type': 'application/gzip', 'x-amz-server-side-encryption': 'AES256' }
  return { url: `${state.origin}/devstack/upload/${reportId}`, fields, key, expiresInSec: UPLOAD_TTL_SEC }
}

function reportRow(req: SubmitRequest, reportId: string, now: number): Record<string, unknown> {
  const { installId, clientReportId, clientTs, draft, env, log } = req
  return {
    t: 'report', reportId, installId, clientReportId, receivedAt: now, clientTs, status: 'new',
    // Scored only by the Lambda — never guessed at here (see FIDELITY in the header).
    spamScore: null,
    // title/contact were retired from the wire contract; nulls mirror the Lambda's row shape.
    type: draft.type, title: null, description: draft.description,
    contact: null, env, log,
    logKey: log === null ? null : logObjectKey(reportId, now),
  }
}

/** The Lambda's `accept`, step for step (§8.3). */
function accept(state: State, req: SubmitRequest, now: number): Res {
  if (state.mode.closed !== null) return fail(503, 'closed', state.mode.closed)
  if (state.mode.blocked) return fail(403, 'blocked', 'This install is blocked from submitting feedback.')

  const idempKey = `${req.installId}|${req.clientReportId}`
  const replay = state.idemp.get(idempKey)
  if (replay !== undefined)
    return { status: 200, json: { ok: true, reportId: replay, upload: null }, note: `replay ${replay}` }

  if (!consumeQuota(state, req, now))
    return fail(429, 'quota_exceeded', 'Daily report limit reached for this install.', {
      retryAfterSec: secondsToUtcMidnight(now),
    })

  const reportId = ulid(now)
  appendRow(state, reportRow(req, reportId, now))
  state.idemp.set(idempKey, reportId)
  const upload = req.log === null ? null : mintUpload(state, reportId, req.log, now)
  return {
    status: 201,
    json: { ok: true, reportId, upload },
    note: `${reportId} ${req.draft.type}${req.log === null ? '' : ` +log ${req.log.bytes}B`}`,
  }
}

function submitRoute(state: State, body: Buffer): Res {
  if (body.byteLength > MAX_BODY_BYTES) return fail(413, 'too_large', 'Report body is too large.')
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return fail(400, 'invalid_payload', 'Body is not valid JSON.')
  }
  const v = validateSubmit(parsed)
  if (!v.ok) return fail(400, 'invalid_payload', v.message, { field: v.field })
  return accept(state, v.value, Date.now())
}

// ---- POST /devstack/upload/<reportId> — the presign leg ---------------------------------------

function boundaryOf(contentType: string | undefined): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  if (m === null) return null
  const b = (m[1] ?? m[2] ?? '').trim()
  return b.length === 0 ? null : b
}

function addPart(out: Map<string, Buffer>, raw: Buffer): void {
  const sep = raw.indexOf('\r\n\r\n')
  if (sep === -1) return
  const name = /name="([^"]*)"/i.exec(raw.subarray(0, sep).toString('latin1'))?.[1]
  if (name === undefined) return
  // The payload runs to the CRLF that precedes the next delimiter.
  out.set(name, raw.subarray(sep + 4, Math.max(sep + 4, raw.length - 2)))
}

/** Dependency-free multipart/form-data split. Enough for what `FormData` emits, no more. */
function multipartFields(body: Buffer, boundary: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const delim = Buffer.from(`--${boundary}`)
  let at = body.indexOf(delim)
  while (at !== -1) {
    const start = at + delim.length
    const next = body.indexOf(delim, start)
    if (next === -1) break
    addPart(out, body.subarray(start, next))
    at = next
  }
  return out
}

/** The three `Conditions` the real presign policy pins, checked the way S3 checks them. */
function policyViolation(parts: Map<string, Buffer>, presign: Presign): Res | null {
  const field = (name: string): string => parts.get(name)?.toString('utf8') ?? ''
  const pinned: [string, string][] = [
    ['key', presign.key],
    ['Content-Type', 'application/gzip'],
    ['x-amz-server-side-encryption', 'AES256'],
  ]
  const bad = pinned.find(([name, want]) => field(name) !== want)
  if (bad === undefined) return null
  return s3Error(403, 'AccessDenied', `Invalid according to Policy: Policy Condition failed: ["eq", "$${bad[0]}", ...]`)
}

function storeSlice(state: State, reportId: string, presign: Presign, file: Buffer): Res {
  const sha256 = createHash('sha256').update(file).digest('hex')
  mkdirSync(join(state.dir, 'uploads'), { recursive: true })
  writeFileSync(join(state.dir, 'uploads', `${reportId}.log.gz`), file)
  const shaMatches = sha256 === presign.meta.sha256
  const { key } = presign
  appendRow(state, {
    t: 'upload', reportId, key, bytes: file.byteLength,
    sha256, declaredSha256: presign.meta.sha256, shaMatches, at: Date.now(),
  })
  // S3 answers a plain presigned POST with 204 and an empty body.
  return { status: 204, note: `${file.byteLength}B sha=${shaMatches ? 'ok' : 'MISMATCH'}` }
}

function uploadRoute(state: State, reportId: string, contentType: string | undefined, body: Buffer): Res {
  const presign = state.presigns.get(reportId)
  if (presign === undefined) return s3Error(403, 'AccessDenied', 'no presign was minted for this key')
  if (Date.now() > presign.expiresAt) return s3Error(403, 'AccessDenied', 'Request has expired')
  const boundary = boundaryOf(contentType)
  if (boundary === null) return s3Error(400, 'MalformedPOSTRequest', 'not well-formed multipart/form-data')

  const parts = multipartFields(body, boundary)
  const violation = policyViolation(parts, presign)
  if (violation !== null) return violation

  const file = parts.get('file')
  if (file === undefined || file.byteLength < 1) return s3Error(400, 'EntityTooSmall', TOO_SMALL)
  if (file.byteLength > MAX_UPLOAD_BYTES) return s3Error(400, 'EntityTooLarge', TOO_BIG)
  return storeSlice(state, reportId, presign, file)
}

// ---- the /devstack control plane ---------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function patchMode(state: State, body: Buffer): Res {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8') || '{}') as unknown
  } catch {
    parsed = null
  }
  if (!isRecord(parsed))
    return { status: 400, json: { ok: false, message: 'mode expects a JSON object' }, note: 'bad json' }
  const patch = parsed
  const m = state.mode
  if ('closed' in patch) m.closed = typeof patch.closed === 'string' ? patch.closed : null
  if (typeof patch.blocked === 'boolean') m.blocked = patch.blocked
  if (patch.quota === 'exhausted' || patch.quota === 'ok') m.quota = patch.quota
  if (typeof patch.latencyMs === 'number') m.latencyMs = Math.max(0, patch.latencyMs)
  if (typeof patch.maxPerDay === 'number') m.maxPerDay = Math.max(0, Math.floor(patch.maxPerDay))
  return { status: 200, json: { ok: true, mode: m }, note: JSON.stringify(m) }
}

function listReports(state: State): Res {
  const idOf = (r: Record<string, unknown>): string =>
    typeof r.reportId === 'string' ? r.reportId : ''
  const uploaded = new Set(state.rows.filter((r) => r.t === 'upload').map(idOf))
  const reports = state.rows
    .filter((r) => r.t === 'report')
    .map((r) => ({ ...r, uploaded: uploaded.has(idOf(r)) }))
  return { status: 200, json: { ok: true, count: reports.length, reports }, note: `${reports.length} rows` }
}

// ---- the http seam ---------------------------------------------------------------------------

/** Read the body, refusing anything past `cap` without buffering it. */
async function readBody(req: IncomingMessage, cap: number): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > cap) return null
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.byteLength
    if (total > cap) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function send(res: ServerResponse, out: Res): void {
  // 204 (a successful upload) carries no body at all, exactly like S3's answer.
  if (out.xml === undefined && out.json === undefined) {
    res.writeHead(out.status)
    res.end()
    return
  }
  const type = out.xml === undefined ? 'application/json' : 'application/xml'
  res.writeHead(out.status, { 'content-type': type })
  res.end(out.xml ?? JSON.stringify(out.json))
}

/** The two read-only conveniences. Returns null when the path is not one of them. */
function getRoute(state: State, path: string): Res | null {
  if (path === '/devstack/reports') return listReports(state)
  if (path === '/devstack/mode') return { status: 200, json: { ok: true, mode: state.mode } }
  return null
}

async function postRoute(state: State, req: IncomingMessage, path: string): Promise<Res | null> {
  if (path === '/devstack/mode') {
    const body = await readBody(req, 8 * 1024)
    return body === null ? { status: 413, json: { ok: false } } : patchMode(state, body)
  }
  if (path === '/v1/feedback') {
    const body = await readBody(req, MAX_BODY_BYTES + 1)
    await sleep(state.mode.latencyMs)
    return body === null ? fail(413, 'too_large', 'Report body is too large.') : submitRoute(state, body)
  }
  const upload = /^\/devstack\/upload\/([A-Za-z0-9]+)$/.exec(path)
  if (upload === null) return null
  const body = await readBody(req, MAX_UPLOAD_BYTES + MULTIPART_SLACK)
  await sleep(state.mode.latencyMs)
  return body === null
    ? s3Error(400, 'EntityTooLarge', TOO_BIG)
    : uploadRoute(state, upload[1] ?? '', req.headers['content-type'], body)
}

async function route(state: State, req: IncomingMessage, path: string): Promise<Res> {
  const method = req.method ?? 'GET'
  if (method === 'GET') return getRoute(state, path) ?? notFound(method, path)
  if (method !== 'POST') return { status: 405, json: { ok: false, message: 'method not allowed' } }
  return (await postRoute(state, req, path)) ?? notFound(method, path)
}

const notFound = (method: string, path: string): Res => ({
  status: 404,
  json: { ok: false, message: `no route for ${method} ${path}` },
})

async function handle(state: State, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startedAt = Date.now()
  const path = new URL(req.url ?? '/', state.origin).pathname
  let out: Res
  try {
    out = await route(state, req, path)
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err)
    const json = { ok: false, error: 'internal', message: 'Something went wrong on our side.' }
    out = { status: 500, json, note }
  }
  // ONE line per request, and it says what actually happened.
  if (!state.quiet) {
    const stamp = new Date().toISOString().slice(11, 19)
    const detail = out.note === undefined ? '' : ` ${out.note}`
    console.log(`${stamp} ${req.method ?? '?'} ${path} → ${out.status}${detail} (${Date.now() - startedAt}ms)`)
  }
  send(res, out)
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((done, broke) => {
    server.once('error', broke)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      done(typeof addr === 'object' && addr !== null ? addr.port : port)
    })
  })
}

/** Start the stack. Exported so tests drive the REAL server in-process on port 0. */
export async function startDevStack(opts: DevStackOptions = {}): Promise<DevStack> {
  const dir = resolve(opts.dir ?? DEFAULT_DIR)
  mkdirSync(dir, { recursive: true })
  const mode: Mode = {
    closed: null, blocked: false, quota: 'ok', latencyMs: 0,
    maxPerDay: opts.maxPerDay ?? DEFAULT_MAX_PER_DAY,
  }
  const state: State = {
    dir, mode, origin: 'http://127.0.0.1', quiet: opts.quiet ?? false,
    idemp: new Map(), quota: new Map(), presigns: new Map(), rows: [],
  }
  loadHistory(state)

  const server = createServer((req, res) => {
    void handle(state, req, res)
  })
  const port = await listen(server, opts.port ?? DEFAULT_PORT)
  state.origin = `http://127.0.0.1:${port}`
  const close = (): Promise<void> =>
    new Promise<void>((done) => {
      server.close(() => {
        done()
      })
      server.closeAllConnections()
    })
  return { port, url: `${state.origin}/v1/feedback`, dir, close }
}

// ---- cli ---------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = { port: { type: 'string' }, dir: { type: 'string' }, 'max-per-day': { type: 'string' } } as const
  const { values } = parseArgs({ options: opts })
  const stack = await startDevStack({
    port: values.port === undefined ? DEFAULT_PORT : Number(values.port),
    ...(values.dir === undefined ? {} : { dir: values.dir }),
    ...(values['max-per-day'] === undefined ? {} : { maxPerDay: Number(values['max-per-day']) }),
  })
  console.log(
    [
      `dev feedback stack listening on ${stack.url}`,
      `reports + uploads land in ${stack.dir}`,
      '',
      'point the dev app at it (a second terminal):',
      `  PowerShell  $env:EQ_FEEDBACK_URL='${stack.url}'; npm run dev`,
      `  bash        EQ_FEEDBACK_URL=${stack.url} npm run dev`,
      '',
      `failure knobs: POST ${stack.url.replace('/v1/feedback', '/devstack/mode')}`,
      '  {"closed":"<message>"} | {"blocked":true} | {"quota":"exhausted"} | {"latencyMs":20000}',
    ].join('\n'),
  )
}

const invoked = process.argv[1]
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  await main()
}
