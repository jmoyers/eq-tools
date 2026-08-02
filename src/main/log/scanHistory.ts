import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { setImmediate as yieldToLoop } from 'timers/promises'
import { parseEvent } from './parser'
import type { LogBus } from './bus'

export interface ScanResult {
  /**
   * Byte offset (into the file) of the end of the last complete line processed.
   * The live tailer resumes here so no bytes appended during the scan are lost
   * and none are double-read. See FIX 1 in AGENTS notes.
   */
  endOffset: number
  /**
   * The next sequence number to use. The scan stamps events [startSeq, seq); the
   * tailer continues from here so the whole scan+tail stream is one monotonic
   * sequence for the character.
   */
  seq: number
}

/**
 * Stream the log once and emit every canonical LogEvent onto the bus with
 * live:false. This is the historical feeder: it produces the exact same event
 * stream the live tailer will continue, so every consumer (loot/kills/levels/AA
 * reducers, the combat engine) is rebuilt from one parse pass instead of three
 * hand-synced pipelines.
 *
 * Streaming (FIX 2): reads via a byte stream with a chunk-based line splitter and
 * yields to the event loop periodically, so the Electron main process is never
 * blocked for the multi-second duration of a 68MB scan. Events are emitted in
 * strict file order.
 *
 * Bounded (FIX 1): captures the file size S up front, processes only bytes [0, S),
 * and returns `endOffset` = the byte offset of the end of the last complete line
 * at or before S. The caller hands this to the tailer as its start offset for a
 * gapless handoff.
 */
export async function scanLog(
  logPath: string,
  bus: LogBus,
  startSeq = 0,
  profileId?: string
): Promise<ScanResult> {
  let size: number
  try {
    size = (await stat(logPath)).size
  } catch {
    return { endOffset: 0, seq: startSeq }
  }
  if (size === 0) return { endOffset: 0, seq: startSeq }

  let seq = startSeq

  const handle = (raw: string): void => {
    const ev = parseEvent(raw, seq, profileId)
    if (!ev) return // not a log line at all (no timestamp)
    seq++
    bus.emit(ev, false)
  }

  // Byte-accurate line splitting. We track bytes consumed (not chars) so the
  // returned offset lines up exactly with the file for the tailer handoff.
  // `endOffset` advances to just past each newline of a fully-processed line.
  let endOffset = 0
  // Bytes buffered for the current, not-yet-terminated line.
  let pendingBytes = 0
  let leftover = '' // decoded text of the current partial line
  let chunkCount = 0

  const stream = createReadStream(logPath, { start: 0, end: size - 1, highWaterMark: 1 << 20 })

  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer
      let lineStart = 0
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0x0a) continue // find '\n'
        // Bytes for this line = pending (from prior chunks) + [lineStart..i] incl. '\n'.
        const segBytes = i - lineStart + 1
        endOffset += pendingBytes + segBytes
        let raw = leftover + buf.toString('utf8', lineStart, i)
        if (raw.endsWith('\r')) raw = raw.slice(0, -1)
        if (raw) handle(raw)
        leftover = ''
        pendingBytes = 0
        lineStart = i + 1
      }
      // Carry the trailing partial line to the next chunk.
      if (lineStart < buf.length) {
        pendingBytes += buf.length - lineStart
        leftover += buf.toString('utf8', lineStart, buf.length)
      }
      // Yield to the event loop so IPC / UI stay responsive during a big scan.
      if (++chunkCount % 4 === 0) await yieldToLoop()
    }
  } catch {
    // Partial results are still valid up to endOffset; fall through and return.
  }

  // A trailing partial line (no final newline) is intentionally NOT counted in
  // endOffset — the tailer will re-read those bytes and complete the line when
  // the game appends the rest, avoiding a dropped/duplicated final entry.
  return { endOffset, seq }
}
