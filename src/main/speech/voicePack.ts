// voicePack.ts — reading `voices-v1.0.bin`, the Kokoro style-vector pack. PURE, buffer in.
//
// WHAT THE FILE ACTUALLY IS. Upstream calls it `.bin`; it is a numpy `.npz`, which is a ZIP
// archive of `.npy` arrays — one per voice, named `af_heart.npy` and so on. Measured against
// the real pinned file (54 entries, 28,214,398 bytes):
//
//   * every entry is STORED (compression method 0). Nothing has to be inflated; the payload
//     is the file's own bytes at a known offset. That is what makes reading one voice a seek
//     instead of a 28 MB decompress.
//   * every entry carries a ZIP64 extra field: the 32-bit size fields are 0xFFFFFFFF and the
//     real 64-bit sizes live in extra-field id 0x0001. numpy writes ZIP64 unconditionally, so
//     an implementation that only reads the 32-bit fields sees a 4 GB entry and walks off the
//     end. This is not a hypothetical — it is what the first pass of this parser did.
//   * every payload is 522,368 bytes: a 128-byte `.npy` header plus (510, 1, 256) float32.
//
// WHY HAND-ROLLED AND NOT A ZIP LIBRARY. The subset that matters is "stored entries, local
// headers, ZIP64 sizes" — about forty lines — and the alternative is a dependency that can
// decompress, which is a decompression bomb surface pointed at a file we already sha256-pin.
// Pinning the bytes and reading only the shape we verified is the smaller trust surface.
//
// WHY IT IS PURE. The parse is the thing worth pinning in tests (tests/speechEngine.test.mts
// builds a synthetic npz and reads it back), so nothing here opens a file: callers hand over
// bytes. `listVoiceIds` exists for the cheap path — the directory scan main runs to answer
// `speech:voices` — and takes only the header region, so it never needs the whole 28 MB.

/** One entry located inside the pack. */
export interface VoicePackEntry {
  /** Voice id — the entry name with `.npy` stripped ('af_heart'). */
  readonly id: string
  /** Absolute offset of the entry's payload (the `.npy` bytes) within the pack. */
  readonly offset: number
  /** Payload length in bytes. */
  readonly length: number
}

const LOCAL_FILE_HEADER_SIG = 0x04034b50
const LOCAL_FILE_HEADER_LEN = 30
const ZIP64_EXTRA_ID = 0x0001
const STORED = 0

/** Kokoro's style table: one 256-float vector per token count, 510 counts. */
export const STYLE_DIM = 256
export const STYLE_ROWS = 510

/**
 * The 64-bit sizes ZIP64 hides in the extra field, or null when the entry has none.
 * Layout per APPNOTE 4.5.3: [id][size][uncompressed u64][compressed u64], the two values
 * present only when their 32-bit counterparts were 0xFFFFFFFF — we only ask for this when
 * BOTH were, which is what numpy writes.
 */
function zip64Sizes(extra: Buffer): { uncompressed: number; compressed: number } | null {
  let at = 0
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at)
    const size = extra.readUInt16LE(at + 2)
    if (id === ZIP64_EXTRA_ID && size >= 16 && at + 4 + 16 <= extra.length) {
      return {
        uncompressed: Number(extra.readBigUInt64LE(at + 4)),
        compressed: Number(extra.readBigUInt64LE(at + 12))
      }
    }
    at += 4 + size
  }
  return null
}

/**
 * Walk the pack's local file headers. Stops at the first non-header signature (the central
 * directory, which we don't need) or at anything malformed — a truncated/foreign file yields
 * the entries it could read rather than throwing, and the caller decides that's not enough.
 *
 * `buf` may be a PREFIX of the pack: `listVoiceIds` passes only the header region, so the
 * walk must tolerate an entry whose payload runs past the end of what it was given. Such an
 * entry is still reported (its name is known and correct) but the walk stops there.
 */
export function parseVoicePack(buf: Buffer): VoicePackEntry[] {
  const entries: VoicePackEntry[] = []
  let at = 0
  while (at + LOCAL_FILE_HEADER_LEN <= buf.length && buf.readUInt32LE(at) === LOCAL_FILE_HEADER_SIG) {
    const method = buf.readUInt16LE(at + 8)
    let compressed = buf.readUInt32LE(at + 18)
    const nameLen = buf.readUInt16LE(at + 26)
    const extraLen = buf.readUInt16LE(at + 28)
    const nameAt = at + LOCAL_FILE_HEADER_LEN
    const dataAt = nameAt + nameLen + extraLen
    if (dataAt > buf.length) break
    const name = buf.toString('latin1', nameAt, nameAt + nameLen)
    if (compressed === 0xffffffff) {
      compressed = zip64Sizes(buf.subarray(nameAt + nameLen, dataAt))?.compressed ?? -1
    }
    // A compressed entry is not something this reader can serve, and a negative/absurd size
    // means the header lied — either way the walk ends rather than guessing an offset.
    if (method !== STORED || compressed < 0) break
    entries.push({ id: name.replace(/\.npy$/, ''), offset: dataAt, length: compressed })
    at = dataAt + compressed
  }
  return entries
}

/** The voice ids in a set of entries. */
export function voiceIdsIn(entries: readonly VoicePackEntry[]): Set<string> {
  return new Set(entries.map((e) => e.id))
}

/** Hard bound on the directory walk. The pinned pack holds 54; anything claiming more is
 *  malformed, and a malformed file must not be able to spin the thread that reads it. */
export const MAX_PACK_ENTRIES = 256

/**
 * Every voice id in a pack, read through HEADER-SIZED WINDOWS instead of loading 28 MB.
 *
 * Each entry is ~522 KB, so one window only ever reaches the first entry in it; the walk
 * therefore steps the file cursor forward by that entry's (buffer-relative) end and reads
 * again. Two things are load-bearing and both are scar tissue from the same bug — it hung
 * the MAIN PROCESS in the packed-app smoke, taking the log tail and every IPC reply with it:
 *
 *   * the cursor ADVANCES (`at += step`). `parseVoicePack` reports offsets relative to the
 *     buffer it was handed, and every window's first entry sits at the same relative offset —
 *     so assigning `at = entry.offset + entry.length` walks to the same place forever from
 *     the second window onwards.
 *   * the loop is BOUNDED anyway. Nothing that runs where a stall is visible may depend on a
 *     file being well-formed in order to terminate.
 *
 * `readAt` is injected, so this is exercised against an in-memory pack in the unit tests and
 * against a file handle in `provision.ts`.
 */
export async function scanVoiceIds(
  readAt: (offset: number, length: number) => Promise<Buffer>,
  size: number,
  windowBytes = 512
): Promise<Set<string>> {
  const ids = new Set<string>()
  let at = 0
  for (let guard = 0; guard < MAX_PACK_ENTRIES && at + LOCAL_FILE_HEADER_LEN < size; guard++) {
    const entries = parseVoicePack(await readAt(at, windowBytes))
    const first = entries[0]
    // No entry (we have reached the central directory) or a zero-length one ⇒ stop.
    const step = first ? first.offset + first.length : 0
    if (step <= 0) break
    for (const id of voiceIdsIn(entries)) ids.add(id)
    at += step
  }
  return ids
}

/**
 * Decode one entry's `.npy` payload into floats.
 *
 * `.npy` v1: 6-byte magic `\x93NUMPY`, 2 version bytes, a uint16 header length, then that
 * many bytes of a python-dict literal describing dtype/order/shape, then raw data. We assert
 * only what we depend on (little-endian float32, C order) and let the shape be whatever the
 * pack says — `styleVectorFor` indexes by row, so a future pack with more rows still works.
 *
 * The floats are COPIED into a fresh buffer rather than viewed over the pack: a `Float32Array`
 * view requires 4-byte alignment that a zip payload offset does not guarantee, and holding a
 * view would pin the whole 28 MB pack in memory for the lifetime of one voice.
 */
export function decodeNpyFloat32(buf: Buffer, entry: VoicePackEntry): Float32Array | null {
  const start = entry.offset
  if (start + 10 > buf.length) return null
  if (buf.toString('latin1', start, start + 6) !== '\x93NUMPY') return null
  const headerLen = buf.readUInt16LE(start + 8)
  const dataAt = start + 10 + headerLen
  const header = buf.toString('latin1', start + 10, dataAt)
  if (!header.includes("'<f4'") || header.includes('True')) return null
  const dataLen = entry.length - (10 + headerLen)
  if (dataLen <= 0 || dataLen % 4 !== 0 || dataAt + dataLen > buf.length) return null
  const floats = new Float32Array(dataLen / 4)
  // `copy` into the typed array's own buffer: alignment-safe and endianness-correct on every
  // platform this ships to (x64 LE), and a single memcpy.
  Buffer.from(floats.buffer, floats.byteOffset, dataLen).set(buf.subarray(dataAt, dataAt + dataLen))
  return floats
}

/**
 * The 256-float style vector for an utterance of `tokenCount` phonemes.
 *
 * Kokoro conditions on utterance LENGTH: row N of the table is the voice's style for an
 * N-token utterance, which is how one voice keeps its identity across a one-word alert and a
 * full sentence. Out-of-range counts clamp to the last row rather than failing — a longer
 * utterance than the table covers is still speakable, just styled as the longest one it
 * knows. (`tokenizePhonemes` already caps at 509, so the clamp is a belt, not the plan.)
 */
export function styleVectorFor(table: Float32Array, tokenCount: number): Float32Array {
  const rows = Math.floor(table.length / STYLE_DIM)
  const row = Math.min(Math.max(tokenCount, 0), Math.max(rows - 1, 0))
  const at = row * STYLE_DIM
  return table.slice(at, at + STYLE_DIM)
}
