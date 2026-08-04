// feedback/state.ts — `<userData>/feedback.json` and the pending-upload spool.
//
// WHY NOT electron-store (this is a decision, not an oversight — §6.4):
// the store-migration law exists so the SETTINGS file written by any past build loads in
// today's build, indefinitely. Feedback state is disposable and regenerable: an unreadable
// queue costs at most a few unsent reports. Paying the migration tax (bump
// CURRENT_SCHEMA_VERSION, append a MIGRATIONS step, author a fixture) for disposable state is
// the wrong trade, and putting a 2 MB blob anywhere near the settings file is worse.
//
// So: its own file, its own tiny `version` integer, corrupt ⇒ regenerate from empty. An
// executor must not "helpfully" move this into electron-store — that would trigger the
// migration law for no benefit whatsoever.
//
// The gz bytes are NOT in the JSON. They spool to `<userData>/feedback-pending/<id>.gz` and
// the queue entry holds the file name plus the metadata; a queue entry is small enough to
// rewrite on every attempt.
//
// Everything here resolves through `app.getPath('userData')`, so the channel decision in
// channel.ts redirects it automatically: the dev app, the installed app and an e2e run can
// never share a queue.

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UUID_V4_RE, type FeedbackDraft, type FeedbackEnv, type LogSliceMeta } from '../../shared/feedback'
import { logError, logInfo } from '../errorLog'

/** Bumped only if this file's shape changes. Unreadable/older ⇒ regenerate, never migrate. */
export const FEEDBACK_STATE_VERSION = 1
/** At most this many unsent reports are held. The 11th displaces nothing — it is refused. */
export const MAX_QUEUE = 10
/** Attempts per entry before it is dropped (with its spooled gz). */
export const MAX_ATTEMPTS = 5
/** An entry older than this is dropped unsent — a week-old bug report has aged out. */
export const QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Exponential backoff base: 5 min, 10, 20, 40, 80. */
export const BACKOFF_BASE_MS = 5 * 60 * 1000

/** One unsent report. `gzFile` is a NAME under the pending dir, never a path from elsewhere. */
export interface QueuedReport {
  clientReportId: string
  draft: FeedbackDraft
  env: FeedbackEnv
  clientTs: number
  log: LogSliceMeta | null
  gzFile?: string
  attempts: number
  nextAttemptAt: number
  queuedAt: number
}

export interface FeedbackState {
  version: number
  installId: string
  queue: QueuedReport[]
}

const STATE_FILE = 'feedback.json'
const PENDING_DIR = 'feedback-pending'

function statePath(): string {
  return join(app.getPath('userData'), STATE_FILE)
}

/** The spool dir, created on demand (never at startup — a user who never files a report
 *  should never grow a directory for it). */
function pendingDir(): string {
  const dir = join(app.getPath('userData'), PENDING_DIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

function emptyState(): FeedbackState {
  return { version: FEEDBACK_STATE_VERSION, installId: randomUUID(), queue: [] }
}

/** Shape check, not a migration: anything unexpected means "start fresh". */
function parseState(raw: unknown): FeedbackState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== FEEDBACK_STATE_VERSION) return null
  if (typeof o.installId !== 'string' || !UUID_V4_RE.test(o.installId)) return null
  if (!Array.isArray(o.queue)) return null
  const queue = o.queue.filter((e): e is QueuedReport => {
    if (typeof e !== 'object' || e === null) return false
    const q = e as Record<string, unknown>
    return typeof q.clientReportId === 'string' && UUID_V4_RE.test(q.clientReportId)
  })
  return { version: FEEDBACK_STATE_VERSION, installId: o.installId, queue }
}

let cached: FeedbackState | null = null

/** Read (and memoize) the state file. Missing or corrupt ⇒ a fresh state with a new id. */
export function readState(): FeedbackState {
  if (cached) return cached
  const path = statePath()
  if (existsSync(path)) {
    try {
      const parsed = parseState(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (parsed) {
        cached = parsed
        return cached
      }
      logInfo(`[everquest-companion] feedback.json unreadable/foreign — starting fresh`)
    } catch (err) {
      logError('main:feedbackState', { message: 'feedback.json parse failed; starting fresh', err })
    }
  }
  cached = emptyState()
  writeState(cached)
  return cached
}

/**
 * Persist atomically (temp file + rename). A torn write here would cost the install id and
 * every queued report, and the whole point of the "corrupt ⇒ regenerate" policy is that it
 * never has to fire.
 */
export function writeState(next: FeedbackState): void {
  cached = next
  const path = statePath()
  const tmp = `${path}.tmp`
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    logError('main:feedbackState', { message: 'feedback.json write failed', err })
  }
}

/**
 * The stable anonymous per-install id, minted LAZILY on first feedback use — there is no
 * reason to create an identifier for a user who never files a report.
 *
 * IT IS A QUOTA KEY AND A BLOCK HANDLE, NOT AN AUTHENTICATOR. It is a client-generated UUID
 * in a plain JSON file the user owns; a spammer mints a fresh one for free. Its real jobs are
 * to make the honest path cheap, to link a user's follow-up report to their earlier one, and
 * to give us one thing to block. NEVER build policy on it as though it were an identity —
 * the HMAC upgrade path (§9.3) exists for that, deliberately unbuilt until blocks stop working.
 */
export function installId(): string {
  return readState().installId
}

export function queuedCount(): number {
  return readState().queue.length
}

/** Absolute path of a queue entry's spooled gz, or null when it carries no attachment. */
export function pendingGzPath(entry: QueuedReport): string | null {
  if (entry.gzFile === undefined) return null
  return join(app.getPath('userData'), PENDING_DIR, entry.gzFile)
}

/** Read a spooled gz back. Missing ⇒ null, and the report is sent without its log. */
export function readPendingGz(entry: QueuedReport): Buffer | null {
  const path = pendingGzPath(entry)
  if (path === null || !existsSync(path)) return null
  try {
    return readFileSync(path)
  } catch (err) {
    logError('main:feedbackState', { message: 'pending gz unreadable', err })
    return null
  }
}

/**
 * Queue a report for a later attempt. Returns false when the queue is full — the caller tells
 * the user, rather than silently dropping either this report or an older one.
 *
 * The gz spools to its own file keyed by `clientReportId`, which is also the server's
 * idempotency key: a retry that races a successful first attempt gets the original reportId
 * back, never a duplicate row.
 */
export function enqueue(entry: QueuedReport, gz: Buffer | null): boolean {
  const state = readState()
  if (state.queue.length >= MAX_QUEUE) return false
  const next = { ...entry }
  if (gz !== null) {
    try {
      const file = `${entry.clientReportId}.gz`
      writeFileSync(join(pendingDir(), file), gz)
      next.gzFile = file
    } catch (err) {
      // A report without its log beats a lost report.
      logError('main:feedbackState', { message: 'pending gz write failed; queuing without it', err })
      next.log = null
    }
  }
  writeState({ ...state, queue: [...state.queue, next] })
  return true
}

/** Remove an entry (sent, dropped, or aged out) and unlink its spooled gz. */
export function removeQueued(clientReportId: string): void {
  const state = readState()
  const entry = state.queue.find((e) => e.clientReportId === clientReportId)
  if (entry) {
    const path = pendingGzPath(entry)
    if (path !== null) rmSync(path, { force: true })
  }
  writeState({ ...state, queue: state.queue.filter((e) => e.clientReportId !== clientReportId) })
}

/** Replace one entry in place (after a failed attempt bumped its backoff). */
export function updateQueued(next: QueuedReport): void {
  const state = readState()
  writeState({
    ...state,
    queue: state.queue.map((e) => (e.clientReportId === next.clientReportId ? next : e))
  })
}

/** Entries whose backoff has elapsed, oldest first. */
export function dueEntries(now: number): QueuedReport[] {
  return readState()
    .queue.filter((e) => e.nextAttemptAt <= now)
    .sort((a, b) => a.queuedAt - b.queuedAt)
}

/** Drop entries that have exhausted their attempts or aged past QUEUE_MAX_AGE_MS. */
export function pruneQueue(now: number): number {
  const doomed = readState().queue.filter(
    (e) => e.attempts >= MAX_ATTEMPTS || now - e.queuedAt > QUEUE_MAX_AGE_MS
  )
  for (const e of doomed) removeQueued(e.clientReportId)
  return doomed.length
}

/** Record a failed attempt: bump the count and push the next attempt out exponentially. */
export function backoff(entry: QueuedReport, now: number): void {
  const attempts = entry.attempts + 1
  updateQueued({ ...entry, attempts, nextAttemptAt: now + BACKOFF_BASE_MS * 2 ** (attempts - 1) })
  pruneQueue(now)
}

/** Test/dev seam: forget the memoized state so the next read hits disk again. */
export function resetStateCache(): void {
  cached = null
}
