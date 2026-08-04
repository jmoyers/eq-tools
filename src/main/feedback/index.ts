// feedback/index.ts — THE PUBLIC SURFACE of the in-app feedback library.
//
// Six functions, and everything else in this directory is private to them. The IPC layer
// (`src/main/ipc/feedback.ts`) imports only from here, so the wiring can never reach around
// the façade into the slicer or the queue.
//
// ============================ THE ONE RULE ============================
// THE GAME LOG IS OPENED READ-ONLY AND IS NEVER WRITTEN TO. Every read in this feature goes
// through `slice.ts`, whose only fs call is `open(path, 'r')`.
// ======================================================================
//
// Design notes worth not relearning:
//   * NOTHING here throws. `submitFeedback` resolves a typed result for every outcome, and the
//     preview/save paths resolve null/`{ok:false}` rather than rejecting an IPC call.
//   * The network lives in the MAIN process only. The renderer performs no fetch/XHR —
//     `connect-src 'self'` makes it structurally impossible — and this feature needs ZERO CSP
//     changes. Wanting to widen `connect-src` for feedback is a sign the work is in the wrong
//     process.
//   * The endpoint is a compiled-in constant with no user-configurable override, ever: an
//     overridable ingest URL is an exfiltration primitive (net.ts).

import { dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { FeedbackEnv, LogSliceMeta } from '../../shared/feedback'
import { logError } from '../errorLog'
import { getMainWindow } from '../windows'
import { feedbackEndpointConfigured } from './net'
import { activeLog, cachedSlice, feedbackEnv } from './submit'
import { queuedCount } from './state'

export { installId } from './state'
export { submitFeedback, type SubmitResult } from './submit'
export { flushQueue, startQueueFlush, stopQueueFlush } from './queue'

/** Everything the dialog needs to render its header and gate its controls. */
export interface FeedbackContext {
  env: FeedbackEnv
  /** Does this build have an endpoint compiled in? False ⇒ the UI says so, honestly. */
  endpointConfigured: boolean
  /** Reports waiting to send. */
  queued: number
  /** Is there a character log to slice at all? False on a machine with no EQ install. */
  logAvailable: boolean
}

/**
 * What crosses IPC for the preview: the real metadata plus at most PREVIEW_MAX_LINES of text.
 * The gz bytes NEVER cross — a 2 MB Buffer through the structured clone for a scroll box would
 * be absurd, and the renderer has no use for it.
 */
export interface FeedbackSlicePreview extends LogSliceMeta {
  previewLines: string[]
  truncatedPreview: boolean
  /** The window ACTUALLY used, after any fit-driven halving. The header states this, not the ask. */
  windowMinutes: number
}

/** Header context for the dialog. Cheap enough to call on every open; nothing here is cached. */
export function feedbackContext(): FeedbackContext {
  return {
    env: feedbackEnv(),
    endpointConfigured: feedbackEndpointConfigured(),
    queued: queuedCount(),
    logAvailable: activeLog() !== null
  }
}

/**
 * Build (and cache for this session) a scrubbed slice, returning only what the dialog shows.
 * Null when no character log is resolved, when the log is unreadable, or when the window
 * scrubs down to nothing — all of which the dialog renders as "no log to attach", never as an
 * error.
 */
export async function buildLogSlice(windowMinutes: number): Promise<FeedbackSlicePreview | null> {
  const slice = await cachedSlice(windowMinutes)
  if (slice === null) return null
  const { bytes, lines, dropped, fromMs, toMs, sha256, previewLines, truncatedPreview } = slice
  return {
    bytes,
    lines,
    dropped,
    fromMs,
    toMs,
    sha256,
    previewLines,
    truncatedPreview,
    windowMinutes: slice.windowMinutes
  }
}

/** `eqcompanion-log-2026-08-03-1432.log` — sortable, and obviously ours in a Downloads folder. */
function defaultSliceName(toMs: number): string {
  const d = new Date(toMs)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `eqcompanion-log-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.log`
}

/**
 * Write the FULL slice to a user-chosen path — the "save a copy" escape hatch that makes
 * "you can see exactly what is sent" literally true rather than a claim about a 5,000-line
 * preview.
 *
 * It writes the PLAIN TEXT (not the gz): the upload is exactly `gzip(this file)`, and a user
 * inspecting what they are about to disclose should not have to unzip anything to do it.
 */
export async function saveSliceToFile(
  windowMinutes: number
): Promise<{ ok: boolean; path?: string; canceled?: boolean }> {
  const slice = await cachedSlice(windowMinutes)
  if (slice === null) return { ok: false }
  const win = getMainWindow()
  const opts = {
    title: 'Save log slice',
    defaultPath: defaultSliceName(slice.toMs),
    filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
  }
  const res = win === null ? await dialog.showSaveDialog(opts) : await dialog.showSaveDialog(win, opts)
  if (res.canceled || !res.filePath) return { ok: false, canceled: true }
  try {
    await writeFile(res.filePath, slice.text, 'utf8')
    return { ok: true, path: res.filePath }
  } catch (err) {
    logError('main:feedback', { message: 'saving the slice failed', err })
    return { ok: false }
  }
}
