// feedback/slice.ts — turn the live EverQuest log into a small, scrubbed, previewable artifact.
//
// ============================ THE ONE RULE ============================
// THE GAME LOG IS OPENED READ-ONLY AND IS NEVER WRITTEN TO. `open(path, 'r')`, one `read()`
// of the tail, `close()`. Not `'a'`, not `'w'`, not `'r+'`, not ever. The user is PLAYING
// while this runs; the log is the game's file and the app is a guest in it.
// ======================================================================
//
// The pipeline, in this order, because each step exists to make the next one affordable
// (docs/plans/feedback-triage.md §5.2):
//
//   1. BYTE-BOUNDED TAIL READ — at most the last TAIL_READ_CAP (16 MB). The live log is over
//      a million lines and grows every second; no report may ever load it whole. The first,
//      possibly-partial line of a truncated read is discarded.
//   2. TIME WINDOW anchored on the LAST LINE'S timestamp, never `Date.now()`. A user who
//      alt-tabbed out twenty minutes ago must not get an empty slice — the window means "the
//      last N minutes OF PLAY", which is the thing they are reporting about.
//   3. SCRUB — `src/shared/logScrub.ts scrubLines`, with the ACTIVE CHARACTER's name as
//      `selfName` so their own `/who` row survives and every stranger's does not. DROP the
//      line, never rewrite it (the scrub law: a rewritten line still parses into a fake event).
//   4. LINE CAP — keep the LAST MAX_SLICE_LINES (50k): the lines nearest the problem.
//   5. GZIP level 9. EQ logs are extremely repetitive and compress ~8-12x.
//   6. SIZE FIT — over MAX_UPLOAD_BYTES (2 MB gz), halve the window and retry, at most 3
//      times, then hard-truncate from the FRONT. Whatever survives is what the metadata
//      reports: the displayed span is always the ACTUAL span, never the requested one.
//
// This module is deliberately Electron-free and takes the log path + character name as
// PARAMETERS. That is what lets tests/feedbackSlice.test.mts drive the whole pipeline against
// synthetic files in a temp dir — the real game log is never touched by a test.

import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import {
  MAX_SLICE_LINES,
  MAX_UPLOAD_BYTES,
  PREVIEW_MAX_LINES,
  type LogSliceMeta
} from '../../shared/feedback'
import { scrubLines } from '../../shared/logScrub'
// REUSE, never a second timestamp parser. The log's `[Sat Aug 01 13:00:28 2026]` prefix is
// parsed by exactly one function in this repo, and this is it.
import { parseEqTimestamp } from '../log/parser'

/** The memory guarantee: the most of the log we will ever read, in bytes. */
export const TAIL_READ_CAP = 16 * 1024 * 1024
/** How many times the window is halved trying to fit MAX_UPLOAD_BYTES before brute force. */
export const FIT_HALVINGS = 3
/** Preview head, when the slice is longer than PREVIEW_MAX_LINES (§5.4: first 500 + last 4,500). */
const PREVIEW_HEAD_LINES = 500

export interface SliceRequest {
  /** The active character's log file. Resolved by the caller through `log/config.ts` — never
   *  hardcoded here (AGENTS: route every path through `effectiveEqRoot()`/`eqLogsDir()`). */
  readonly logPath: string
  /** One of LOG_WINDOW_CHOICES. Validated at the IPC handler, not here. */
  readonly windowMinutes: number
  /** The active character's name, so their own `/who` row survives the scrub. */
  readonly selfName?: string
}

/**
 * A built slice: the metadata that travels in the JSON body, the gz bytes that go to S3, the
 * full text (what "Save a copy…" writes), and the capped preview that crosses IPC.
 */
export interface FeedbackSlice extends LogSliceMeta {
  /** The bytes the presigned POST uploads. */
  readonly gz: Buffer
  /** The complete scrubbed text — exactly what `gz` is the gzip of. */
  readonly text: string
  readonly previewLines: string[]
  readonly truncatedPreview: boolean
  /** The window ACTUALLY used, after any fit-driven halving. Minutes, may be fractional. */
  readonly windowMinutes: number
}

/** A log line with its parsed timestamp; `ts === 0` means the prefix was unparseable. */
interface TsLine {
  readonly ts: number
  readonly line: string
}

/** The `[Day Mon DD HH:MM:SS YYYY]` prefix. Same shape the parser's LINE_RE matches. */
const PREFIX_RE = /^\[([^\]]+)\]/

/** Epoch millis for one raw line, or 0 when it carries no parseable prefix. */
export function lineTs(line: string): number {
  const m = PREFIX_RE.exec(line)
  return m === null ? 0 : parseEqTimestamp(m[1])
}

/**
 * Read at most the last `cap` bytes of `path`, READ-ONLY.
 *
 * Returns null when the file is missing or empty. `truncated` says whether we started
 * mid-file, in which case the first line is a fragment and the caller drops it.
 */
async function readTail(
  path: string,
  cap: number
): Promise<{ text: string; truncated: boolean } | null> {
  // 'r' — READ-ONLY. See the module header. This is the only fs call this module makes.
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    if (size <= 0) return null
    const start = size > cap ? size - cap : 0
    const length = size - start
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return { text: buf.subarray(0, bytesRead).toString('utf8'), truncated: start > 0 }
  } finally {
    await fh.close()
  }
}

/** Split a tail read into timestamped lines, discarding the leading fragment when truncated. */
function toTsLines(text: string, truncated: boolean): TsLine[] {
  const raw = text.split(/\r?\n/)
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const from = truncated && raw.length > 0 ? 1 : 0
  const out: TsLine[] = []
  for (let i = from; i < raw.length; i++) out.push({ ts: lineTs(raw[i]), line: raw[i] })
  return out
}

/** The anchor: the LAST line that carries a real timestamp. 0 when the tail has none. */
export function anchorMs(lines: readonly TsLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].ts > 0) return lines[i].ts
  }
  return 0
}

/**
 * The lines whose timestamp falls in `[fromMs, toMs]`.
 *
 * Lines with an unparseable prefix are CONTINUATIONS (a wrapped or malformed line). They are
 * kept only when they fall BETWEEN two in-window lines — buffered as they arrive and flushed
 * by the next in-window line, dropped otherwise. That is the honest reading of "it belongs to
 * the window": a continuation with no in-window line after it has nothing to continue into.
 */
function windowLines(lines: readonly TsLine[], fromMs: number, toMs: number): string[] {
  const out: string[] = []
  let pending: string[] = []
  let seenInWindow = false
  for (const { ts, line } of lines) {
    if (ts === 0) {
      if (seenInWindow) pending.push(line)
      continue
    }
    if (ts >= fromMs && ts <= toMs) {
      for (const p of pending) out.push(p)
      pending = []
      out.push(line)
      seenInWindow = true
    } else {
      pending = []
    }
  }
  return out
}

/** `[first, last]` timestamps of a kept slice, falling back to `anchor` when it has none. */
function spanOf(lines: readonly string[], anchor: number): { fromMs: number; toMs: number } {
  let fromMs = 0
  let toMs = 0
  for (const line of lines) {
    const ts = lineTs(line)
    if (ts <= 0) continue
    if (fromMs === 0) fromMs = ts
    toMs = ts
  }
  return fromMs === 0 ? { fromMs: anchor, toMs: anchor } : { fromMs, toMs }
}

/** Join + gzip at level 9. A slice always ends with a newline, like the log it came from. */
function gzipOf(lines: readonly string[]): { text: string; gz: Buffer } {
  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`
  return { text, gz: gzipSync(Buffer.from(text, 'utf8'), { level: 9 }) }
}

/** Window → scrub → keep the LAST MAX_SLICE_LINES. `dropped` counts SCRUB removals only. */
function assemble(
  lines: readonly TsLine[],
  window: { fromMs: number; toMs: number },
  selfName: string | undefined
): { kept: string[]; dropped: number } {
  const { kept, dropped } = scrubLines(windowLines(lines, window.fromMs, window.toMs), { selfName })
  return { kept: kept.length > MAX_SLICE_LINES ? kept.slice(-MAX_SLICE_LINES) : kept, dropped }
}

/**
 * Last resort when even a 1/8th window is over the byte cap: drop the FRONT half repeatedly
 * until it fits. Geometric, so at most ~16 gzips for a 50k-line slice, and it terminates —
 * a one-line slice halves to zero lines, whose gzip is 20 bytes.
 *
 * The front is what goes, because the lines nearest the end are the lines nearest the problem.
 */
function truncateToFit(kept: readonly string[]): { kept: string[]; text: string; gz: Buffer } {
  let lines = kept.slice()
  let out = gzipOf(lines)
  while (out.gz.length > MAX_UPLOAD_BYTES && lines.length > 0) {
    lines = lines.slice(Math.ceil(lines.length / 2))
    out = gzipOf(lines)
  }
  return { kept: lines, text: out.text, gz: out.gz }
}

/**
 * The capped preview that crosses IPC (§5.4). A 4 MB string never goes over the wire: a slice
 * longer than PREVIEW_MAX_LINES is shown as its first 500 and last 4,500 lines with an
 * explicit omission marker, and "Save a copy…" writes the complete text to disk — so "you can
 * see exactly what is sent" stays literally true instead of being a claim about a truncated view.
 */
export function previewOf(lines: readonly string[]): {
  previewLines: string[]
  truncatedPreview: boolean
} {
  if (lines.length <= PREVIEW_MAX_LINES) return { previewLines: lines.slice(), truncatedPreview: false }
  const tail = PREVIEW_MAX_LINES - PREVIEW_HEAD_LINES
  const omitted = lines.length - PREVIEW_MAX_LINES
  return {
    previewLines: [
      ...lines.slice(0, PREVIEW_HEAD_LINES),
      `… ${omitted.toLocaleString()} lines omitted from this preview — use “Save a copy…” to read all ${lines.length.toLocaleString()} …`,
      ...lines.slice(-tail)
    ],
    truncatedPreview: true
  }
}

/**
 * Build a scrubbed, windowed, gzipped slice of the character log.
 *
 * Returns null when there is nothing to send: no file, an empty file, no timestamped line to
 * anchor on, or a window that scrubs down to zero lines. `log: null` is then what travels in
 * the report — an empty attachment is not an attachment.
 *
 * Throws only what the filesystem throws (ENOENT is caught here; a permission error is the
 * caller's to handle — `index.ts` turns it into a null slice and an honest UI state).
 */
export async function buildSlice(req: SliceRequest): Promise<FeedbackSlice | null> {
  let tail: { text: string; truncated: boolean } | null
  try {
    tail = await readTail(req.logPath, TAIL_READ_CAP)
  } catch {
    return null // missing/unreadable log — the dialog shows "no log available", never an error
  }
  if (tail === null) return null

  const lines = toTsLines(tail.text, tail.truncated)
  const anchor = anchorMs(lines)
  if (anchor === 0) return null

  // Fit the byte cap: halve the window up to FIT_HALVINGS times, then brute-force from the front.
  let windowMs = Math.max(1, Math.round(req.windowMinutes * 60_000))
  let built = assemble(lines, { fromMs: anchor - windowMs, toMs: anchor }, req.selfName)
  let out = gzipOf(built.kept)
  for (let i = 0; i < FIT_HALVINGS && out.gz.length > MAX_UPLOAD_BYTES; i++) {
    windowMs = Math.max(1, Math.floor(windowMs / 2))
    built = assemble(lines, { fromMs: anchor - windowMs, toMs: anchor }, req.selfName)
    out = gzipOf(built.kept)
  }
  let kept = built.kept
  if (out.gz.length > MAX_UPLOAD_BYTES) {
    const fitted = truncateToFit(kept)
    kept = fitted.kept
    out = { text: fitted.text, gz: fitted.gz }
  }
  if (kept.length === 0) return null

  const { fromMs, toMs } = spanOf(kept, anchor)
  return {
    bytes: out.gz.length,
    lines: kept.length,
    dropped: built.dropped,
    fromMs,
    toMs,
    sha256: createHash('sha256').update(out.gz).digest('hex'),
    gz: out.gz,
    text: out.text,
    windowMinutes: windowMs / 60_000,
    ...previewOf(kept)
  }
}

/** The metadata half of a built slice — what travels in the JSON body. */
export function sliceMeta(slice: FeedbackSlice): LogSliceMeta {
  const { bytes, lines, dropped, fromMs, toMs, sha256 } = slice
  return { bytes, lines, dropped, fromMs, toMs, sha256 }
}
