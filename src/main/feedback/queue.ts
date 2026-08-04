// feedback/queue.ts — the offline retry drain.
//
// A user files the bug when the app misbehaves, which correlates uncomfortably well with
// "their network is also unhappy". So a transport failure is not the end of a report: it is
// spooled (state.ts) and re-attempted later, over exactly the same wire, carrying the SAME
// `clientReportId`. That id is the server's idempotency key — a retry that races a successful
// first attempt gets the original `reportId` back, never a duplicate row (§6.4).
//
// The drain is deliberately dumb: it never re-slices the log (the bytes were captured when the
// user pressed Send and are what they previewed), never rewrites `env` (the environment the bug
// happened in is the interesting one), and gives up permanently on a 4xx.
//
// NOT WIRED INTO STARTUP BY THIS WAVE. `startQueueFlush()` is exported and unused until the
// composition root calls it (+30 s after the tail attaches, then every 30 min) — src/main/index.ts
// belongs to another agent, and a queue nobody drains is a bounded, self-pruning inconvenience
// rather than a broken build.

import { E2E } from '../e2e'
import { logInfo } from '../errorLog'
import type { SubmitRequest } from '../../shared/feedback'
import { FEEDBACK_API_URL } from './net'
import { sendReport } from './submit'
import {
  backoff,
  dueEntries,
  installId,
  pruneQueue,
  readPendingGz,
  removeQueued,
  type QueuedReport
} from './state'

/** First drain, after the log tail has attached and startup has settled. */
export const FIRST_FLUSH_DELAY_MS = 30 * 1000
/** Steady-state drain cadence. */
export const FLUSH_INTERVAL_MS = 30 * 60 * 1000

/** Rebuild the wire request from a spooled entry — same shape, same idempotency key. */
function requestOf(entry: QueuedReport): SubmitRequest {
  return {
    v: 1,
    draft: entry.draft,
    env: entry.env,
    installId: installId(),
    clientReportId: entry.clientReportId,
    clientTs: entry.clientTs,
    log: entry.log
  }
}

/**
 * Attempt every due report. Returns how many were accepted by the server.
 *
 * A spooled gz that has gone missing is not fatal: the report goes without its log, because a
 * report without its log beats a lost report. The server simply mints no presign for it — the
 * metadata says `log: null` only if it was never attached, so a missing file yields an upload
 * that does not happen and a `logUploaded:false` we do not surface anywhere.
 */
export async function flushQueue(): Promise<number> {
  if (E2E || FEEDBACK_API_URL === '') return 0
  const now = Date.now()
  pruneQueue(now)
  let sent = 0
  for (const entry of dueEntries(now)) {
    const res = await sendReport(requestOf(entry), readPendingGz(entry))
    if (res.ok) {
      removeQueued(entry.clientReportId)
      sent++
      continue
    }
    // A 4xx will never succeed on a retry — drop it rather than burn five attempts on it.
    if (res.retry === true) backoff(entry, Date.now())
    else removeQueued(entry.clientReportId)
  }
  if (sent > 0) logInfo(`[everquest-companion] feedback queue: sent ${sent} report(s)`)
  return sent
}

let first: ReturnType<typeof setTimeout> | null = null
let repeat: ReturnType<typeof setInterval> | null = null

/** Start the periodic drain. Idempotent; a no-op in e2e and in a build with no endpoint. */
export function startQueueFlush(): void {
  if (E2E || FEEDBACK_API_URL === '' || first !== null || repeat !== null) return
  const run = (): void => {
    void flushQueue()
  }
  // `unref` so a pending timer can never be the reason the process stays alive.
  first = setTimeout(run, FIRST_FLUSH_DELAY_MS)
  first.unref()
  repeat = setInterval(run, FLUSH_INTERVAL_MS)
  repeat.unref()
}

/** Stop the periodic drain (app shutdown / tests). */
export function stopQueueFlush(): void {
  if (first !== null) clearTimeout(first)
  if (repeat !== null) clearInterval(repeat)
  first = null
  repeat = null
}
