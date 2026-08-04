// feedback/submit.ts — assemble the report, POST it, then upload the slice.
//
// ============================ THE ONE RULE ============================
// THE GAME LOG IS OPENED READ-ONLY AND IS NEVER WRITTEN TO. This module reads it only
// through `slice.ts`, whose single fs call is `open(path, 'r')`.
// ======================================================================
//
// CONTRACT: `submitFeedback` NEVER REJECTS. Every outcome — a validation failure, a 429, a
// dead network, a bucket that failed validation — is a typed `SubmitResult`. A dialog that
// has to `try/catch` an IPC call to know what happened is a dialog that will show the wrong
// thing on the day it matters.
//
// WHAT QUEUES AND WHAT DOES NOT (§6.3): a transport failure (status 0 — offline, DNS, TLS,
// timeout) or a 5xx queues for a later attempt. A 4xx does not: retrying a 400 forever is a
// bug, not resilience. The one refinement on the plan's "5xx queues" is `closed` (503 + the
// kill switch): that is a DELIBERATE stop, and re-POSTing at a paused endpoint is precisely
// what the kill switch exists to prevent — so a `closed` response is reported to the user and
// not queued.

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { release } from 'node:os'
import {
  MAX_BODY_BYTES,
  validateDraft,
  type FeedbackDraft,
  type FeedbackEnv,
  type LogSliceMeta,
  type PresignedUpload,
  type SubmitErrorCode,
  type SubmitRequest
} from '../../shared/feedback'
import { CHANNEL } from '../channel'
import { E2E } from '../e2e'
import { logError, logInfo } from '../errorLog'
import { resolveActiveCharacter } from '../log/config'
import { getUpdateChannel } from '../store'
import { FEEDBACK_API_URL, allowedUploadUrl, postForm, postJson } from './net'
import { buildSlice, sliceMeta, type FeedbackSlice } from './slice'
import { enqueue, installId, type QueuedReport } from './state'

/** The public result of a submit attempt. Never a thrown error, never a bare boolean. */
export type SubmitResult =
  | { ok: true; reportId: string; logUploaded: boolean }
  | {
      ok: false
      error: SubmitErrorCode
      message: string
      queued: boolean
      /** Set for `invalid_payload` so the dialog can focus the offending input. */
      field?: string
      /** Set for `quota_exceeded` — seconds until the daily counter rolls over. */
      retryAfterSec?: number
    }

const failure = (
  error: SubmitErrorCode,
  message: string,
  extra: { queued?: boolean; field?: string; retryAfterSec?: number } = {}
): SubmitResult => ({ ok: false, error, message, queued: false, ...extra })

// ---- environment ---------------------------------------------------------------------------

/**
 * Everything the client knows about ITSELF. Assembled here, never typed by the user, and
 * deliberately NOT containing: character name, server, EQ install path, machine name, user
 * name, or any progress state (§3.1). The character name does survive inside an ATTACHED
 * slice — which is disclosed in the dialog and previewable before it leaves the machine.
 */
export function feedbackEnv(): FeedbackEnv {
  return {
    appVersion: app.getVersion(),
    // 'e2e' is not a legal tag and can never be sent: the guard in `submitFeedback` fires first.
    channel: CHANNEL === 'prod' ? 'prod' : 'dev',
    updateChannel: getUpdateChannel(),
    platform: process.platform,
    osRelease: release(),
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
}

// ---- the session slice cache ------------------------------------------------------------------

/**
 * ONE built slice is cached per (log file, window) for the lifetime of the process, so the
 * bytes the user PREVIEWED, the bytes "Save a copy…" writes and the bytes that are uploaded
 * are the same bytes. Rebuilding at Send time would make the preview a claim about something
 * else — and the promise this feature makes is "you see exactly what is sent".
 */
let cacheKey = ''
let cacheValue: FeedbackSlice | null = null

/** The active character's log + name, or null on a machine with no EQ logs at all. */
export function activeLog(): { logPath: string; selfName: string } | null {
  const c = resolveActiveCharacter()
  return c === null ? null : { logPath: c.logPath, selfName: c.name }
}

/** Build (and cache for this session) a scrubbed slice. Null when no character log resolves. */
export async function cachedSlice(windowMinutes: number): Promise<FeedbackSlice | null> {
  const src = activeLog()
  if (src === null) return null
  const key = `${src.logPath}|${windowMinutes}`
  if (key === cacheKey) return cacheValue
  const slice = await buildSlice({ ...src, windowMinutes })
  cacheKey = key
  cacheValue = slice
  return slice
}

// ---- the wire ------------------------------------------------------------------------------------

/** Narrow the ingest API's JSON body. Anything unexpected is treated as no body at all. */
function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/** The presign, if the server sent a well-formed one. Its URL is validated at USE, in `upload`. */
function asUpload(raw: unknown): PresignedUpload | null {
  const o = asRecord(raw)
  if (o === null) return null
  const fields = asRecord(o.fields)
  if (typeof o.url !== 'string' || fields === null || typeof o.key !== 'string') return null
  const flat: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) if (typeof v === 'string') flat[k] = v
  return { url: o.url, fields: flat, key: o.key, expiresInSec: typeof o.expiresInSec === 'number' ? o.expiresInSec : 0 }
}

/**
 * POST the gz to the presigned endpoint. Returns whether the object landed.
 *
 * THE SECURITY STEP IS THE FIRST LINE: `upload.url` is REMOTE-SUPPLIED TEXT and this is the
 * moment a user's log would leave the machine. `allowedUploadUrl` pins it to our own bucket in
 * our own region, exactly (see net.ts). On null we upload NOTHING — the report still stands.
 */
async function uploadSlice(upload: PresignedUpload, gz: Buffer): Promise<boolean> {
  const url = allowedUploadUrl(upload.url)
  if (url === null) {
    logError('main:feedback', { message: `refused an upload URL outside our bucket: ${upload.url}` })
    return false
  }
  const form = new FormData()
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v)
  if (!('Content-Type' in upload.fields)) form.append('Content-Type', 'application/gzip')
  // S3 requires the file part LAST — everything after it in the form is ignored.
  // `new Uint8Array(gz)` rather than the Buffer itself: a Node Buffer's backing store is typed
  // `ArrayBufferLike` (it may be shared), which is not a `BlobPart`. One 2 MB copy, once.
  form.append('file', new Blob([new Uint8Array(gz)], { type: 'application/gzip' }), 'slice.log.gz')
  const res = await postForm(url, form)
  if (res.status < 200 || res.status >= 300) {
    logError('main:feedback', { message: `slice upload failed (${res.status})`, err: res.networkError })
    return false
  }
  return true
}

/** The §8.3 response table, as data. A status we do not recognize is `internal`. */
const STATUS_ERROR: Readonly<Record<number, SubmitErrorCode>> = {
  400: 'invalid_payload',
  403: 'blocked',
  413: 'too_large',
  429: 'quota_exceeded',
  503: 'closed'
}

/** Map a non-2xx response onto a typed error, preferring the server's own words. */
function errorFor(status: number, body: Record<string, unknown> | null): {
  error: SubmitErrorCode
  message: string
  field?: string
  retryAfterSec?: number
} {
  const code = typeof body?.error === 'string' ? (body.error as SubmitErrorCode) : null
  const message = typeof body?.message === 'string' ? body.message : `The server returned ${status}.`
  const field = typeof body?.field === 'string' ? body.field : undefined
  const retryAfterSec = typeof body?.retryAfterSec === 'number' ? body.retryAfterSec : undefined
  return { error: code ?? STATUS_ERROR[status] ?? 'internal', message, field, retryAfterSec }
}

/** Did this outcome earn another attempt later? Transport death and 5xx, but never `closed`. */
function retryable(status: number, error: SubmitErrorCode): boolean {
  if (error === 'closed') return false
  return status === 0 || status >= 500
}

/**
 * Send ONE assembled request. Shared by the interactive path and the queue drain, so an
 * offline retry goes over exactly the same wire as the first attempt.
 */
export async function sendReport(
  req: SubmitRequest,
  gz: Buffer | null
): Promise<SubmitResult & { retry?: boolean }> {
  const json = JSON.stringify(req)
  if (Buffer.byteLength(json, 'utf8') > MAX_BODY_BYTES) {
    return failure('too_large', 'That report is too large to send. Please shorten the description.')
  }
  const res = await postJson(FEEDBACK_API_URL, req)
  const body = asRecord(res.body)
  if (res.status >= 200 && res.status < 300 && body?.ok === true && typeof body.reportId === 'string') {
    const upload = asUpload(body.upload)
    const logUploaded = upload !== null && gz !== null ? await uploadSlice(upload, gz) : false
    return { ok: true, reportId: body.reportId, logUploaded }
  }
  const mapped = errorFor(res.status, body)
  return { ...failure(mapped.error, mapped.message, mapped), retry: retryable(res.status, mapped.error) }
}

// ---- the public submit --------------------------------------------------------------------------

/** Assemble a `SubmitRequest` for a draft + optional slice metadata. */
function requestFor(draft: FeedbackDraft, log: LogSliceMeta | null, clientReportId: string): SubmitRequest {
  return { v: 1, draft, env: feedbackEnv(), installId: installId(), clientReportId, clientTs: Date.now(), log }
}

function queueEntry(req: SubmitRequest): QueuedReport {
  return {
    clientReportId: req.clientReportId,
    draft: req.draft,
    env: req.env,
    clientTs: req.clientTs,
    log: req.log,
    attempts: 1,
    // The first retry waits out the normal backoff; the periodic drain picks it up.
    nextAttemptAt: Date.now() + 5 * 60 * 1000,
    queuedAt: Date.now()
  }
}

/** `sendReport` with a belt-and-braces catch: `postJson`/`postForm` already swallow transport
 *  errors, so reaching the catch means a BUG — which must still not reject an IPC call. */
async function attemptSend(
  req: SubmitRequest,
  gz: Buffer | null
): Promise<SubmitResult & { retry?: boolean }> {
  try {
    return await sendReport(req, gz)
  } catch (err) {
    logError('main:feedback', { message: 'submit threw; queueing', err })
    return { ...failure('internal', 'Something went wrong sending that report.'), retry: true }
  }
}

/** The failure half of the union — what `queueFailure` decorates. */
type SubmitFailure = Extract<SubmitResult, { ok: false }>

/** Spool a failed-but-retryable report, and say so in words the dialog can render as-is. */
function queueFailure(res: SubmitFailure, req: SubmitRequest, gz: Buffer | null): SubmitResult {
  const queued = enqueue(queueEntry(req), gz)
  return {
    ...res,
    queued,
    message: queued
      ? "Saved — we'll send it next time you're online."
      : 'There are already 10 reports waiting to send. Please try again later.'
  }
}

/**
 * Send a report. Never throws; a network failure QUEUES (§4.2).
 *
 * Order of the gates, cheapest and most-certain first:
 *   1. e2e — the headless harness must NEVER touch the network or create rows (§6.6).
 *   2. no endpoint compiled in — this build ships dark; there is nothing to talk to, and
 *      queueing for an endpoint that does not exist would just age out in a week.
 *   3. the shared validator — the same code the dialog gates Send on and the Lambda runs.
 */
export async function submitFeedback(
  draft: FeedbackDraft,
  opts: { attachLog: boolean; windowMinutes: number }
): Promise<SubmitResult> {
  if (E2E) return failure('internal', 'disabled in e2e')
  if (FEEDBACK_API_URL === '') {
    return failure('internal', 'This build has no feedback endpoint. Please update to a newer version.')
  }
  const valid = validateDraft(draft)
  if (!valid.ok) return failure('invalid_payload', valid.message, { field: valid.field })

  const slice = opts.attachLog ? await cachedSlice(opts.windowMinutes) : null
  const gz = slice === null ? null : slice.gz
  const req = requestFor(valid.value, slice === null ? null : sliceMeta(slice), randomUUID())

  const res = await attemptSend(req, gz)
  if (res.ok) {
    logInfo(`[everquest-companion] feedback sent: ${res.reportId} (log ${res.logUploaded ? 'uploaded' : 'not uploaded'})`)
    return { ok: true, reportId: res.reportId, logUploaded: res.logUploaded }
  }
  return res.retry === true ? queueFailure(res, req, gz) : { ...res, queued: false }
}
