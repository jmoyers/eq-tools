// Pure unit tests for the two DATA FORMATS the Kokoro tier reads (voice-alerts.md W3).
//
// No Electron, no onnxruntime, no network, no fixture, so this file never skips. Its sibling
// tests/speechEngine.test.mts owns the cache, the url boundary and the provisioning state
// machine; what is left here is everything between "we have the pinned bytes" and "we have
// tensors":
//
//   * THE VOICE PACK — `voices-v1.0.bin` is a numpy `.npz`, i.e. a ZIP of `.npy` arrays. Two
//     properties of the real file are load-bearing and both were measured, not assumed: every
//     entry is STORED (so a voice is a seek, not a 28 MB decompress) and every entry carries
//     ZIP64 sizes (numpy writes them unconditionally, and reading only the 32-bit fields
//     walks off the end — the first version of the parser did exactly that).
//   * THE DIRECTORY WALK — read through header-sized windows, which is where an off-by-one in
//     the cursor hung the packed app's main process. Pinned below.
//   * PHONEME TOKENIZATION — espeak's alphabet reconciled with Kokoro's, and the style vector
//     indexed by TOKEN COUNT rather than by voice alone.
//   * THE ROSTER — the pack holds 54 voices in 8 languages; we offer the 28 English ones,
//     because our phonemizer is English-only and a Japanese voice fed English-derived
//     phonemes produces confident nonsense (world-model law 6 applied to a dependency).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KOKORO_DEFAULT_VOICE,
  kokoroVoiceLang,
  kokoroVoicesFor
} from '../src/main/speech/pinned'
import { normalizeEspeakPhonemes, phonemeCount, tokenizePhonemes } from '../src/main/speech/phonemes'
import {
  STYLE_DIM,
  decodeNpyFloat32,
  parseVoicePack,
  scanVoiceIds,
  styleVectorFor
} from '../src/main/speech/voicePack'
import { resolveKokoroVoice } from '../src/main/speech/engine'

test('tokenizePhonemes wraps with the boundary token and drops unknown marks', () => {
  const tokens = tokenizePhonemes('mˈɛs', 509)
  assert.equal(tokens[0], 0)
  assert.equal(tokens.at(-1), 0)
  assert.equal(phonemeCount(tokens), 4)
  // A mark outside Kokoro's vocabulary costs that mark, never the utterance.
  assert.equal(phonemeCount(tokenizePhonemes('m\u0361ˈɛs', 509)), 4)
  assert.equal(phonemeCount(tokenizePhonemes('', 509)), 0)
})

test('tokenizePhonemes truncates at the style table height, boundaries excluded', () => {
  const tokens = tokenizePhonemes('a'.repeat(2000), 509)
  assert.equal(phonemeCount(tokens), 509)
  assert.equal(tokens.length, 511)
})

test('espeak normalization maps the four symbols Kokoro spells differently', () => {
  // `r` is the important one: it EXISTS in Kokoro's vocab, so leaving it alone would be
  // silently wrong (a trill where English wants an approximant) rather than dropped.
  assert.equal(normalizeEspeakPhonemes('rat ʲ x ɬ'), 'ɹat j k l')
})

// ---------------------------------------------------------------- 4. the voice pack

/** Build a synthetic `.npz` in the exact shape numpy writes: STORED entries, ZIP64 sizes. */
function fakeNpz(voices: Record<string, Float32Array>): Buffer {
  const parts: Buffer[] = []
  for (const [id, data] of Object.entries(voices)) {
    const header = Buffer.alloc(128)
    header.write('\x93NUMPY', 0, 'latin1')
    header[6] = 1
    header[7] = 0
    header.writeUInt16LE(118, 8)
    header.write(
      `{'descr': '<f4', 'fortran_order': False, 'shape': (${data.length / STYLE_DIM}, 1, ${STYLE_DIM}), }`.padEnd(
        118,
        ' '
      ),
      10,
      'latin1'
    )
    const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const payload = Buffer.concat([header, body])
    const name = Buffer.from(`${id}.npy`, 'latin1')
    // ZIP64 extra: 32-bit size fields sentinelled, real sizes in extra id 0x0001.
    const extra = Buffer.alloc(20)
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(16, 2)
    extra.writeBigUInt64LE(BigInt(payload.length), 4)
    extra.writeBigUInt64LE(BigInt(payload.length), 12)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(0, 8) // method = STORED
    local.writeUInt32LE(0xffffffff, 18)
    local.writeUInt32LE(0xffffffff, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    parts.push(local, name, extra, payload)
  }
  const end = Buffer.alloc(4)
  end.writeUInt32LE(0x02014b50, 0) // central directory signature — the walk stops here
  parts.push(end)
  return Buffer.concat(parts)
}

test('the voice pack reader walks ZIP64 stored entries (the real file shape)', () => {
  const rows = 4
  const a = Float32Array.from({ length: rows * STYLE_DIM }, (_, i) => i)
  const b = Float32Array.from({ length: rows * STYLE_DIM }, (_, i) => -i)
  const pack = fakeNpz({ af_heart: a, bm_george: b })
  const entries = parseVoicePack(pack)
  assert.deepEqual(
    entries.map((e) => e.id),
    ['af_heart', 'bm_george']
  )
  const decoded = decodeNpyFloat32(pack, entries[1])
  assert.ok(decoded)
  assert.equal(decoded.length, rows * STYLE_DIM)
  assert.equal(decoded[1], -1)
  // A truncated/foreign pack yields what it could read rather than throwing or over-reading.
  assert.deepEqual(parseVoicePack(pack.subarray(0, 60)), [])
  assert.deepEqual(parseVoicePack(Buffer.alloc(0)), [])
})

test('the style vector is indexed by TOKEN COUNT and clamps past the table', () => {
  const rows = 4
  const table = Float32Array.from({ length: rows * STYLE_DIM }, (_, i) => Math.floor(i / STYLE_DIM))
  assert.equal(styleVectorFor(table, 0)[0], 0)
  assert.equal(styleVectorFor(table, 2)[0], 2)
  assert.equal(styleVectorFor(table, 3).length, STYLE_DIM)
  // Longer than the table knows ⇒ styled as the longest it knows, never a throw.
  assert.equal(styleVectorFor(table, 9999)[0], rows - 1)
  assert.equal(styleVectorFor(table, -5)[0], 0)
})

test('scanVoiceIds walks a whole pack through header-sized windows', async () => {
  // THE REGRESSION THIS PINS: the walk reads 512-byte windows, and `parseVoicePack` reports
  // offsets relative to the window it was handed — so the cursor must ADVANCE by them. The
  // first version assigned instead of adding, which meant every window after the first landed
  // on the same offset FOREVER. It hung the packed app's main process (log tail, meter, every
  // IPC reply) until the smoke test was killed. Three entries is enough to catch it: a
  // one-entry pack passes either way.
  const rows = 2
  const voices = Object.fromEntries(
    ['af_heart', 'bm_george', 'jf_alpha'].map((id) => [id, new Float32Array(rows * STYLE_DIM)])
  )
  const pack = fakeNpz(voices)
  let reads = 0
  const ids = await scanVoiceIds((offset, length) => {
    reads++
    return Promise.resolve(pack.subarray(offset, offset + length))
  }, pack.length)
  assert.deepEqual([...ids].sort(), ['af_heart', 'bm_george', 'jf_alpha'])
  assert.ok(reads <= 4, `one read per entry, got ${reads}`)
})

test('scanVoiceIds terminates on a malformed pack instead of spinning', async () => {
  // Nothing that runs where a stall is visible may depend on a file being well-formed.
  const zeros = Buffer.alloc(4096)
  const ids = await scanVoiceIds(
    (offset, length) => Promise.resolve(zeros.subarray(offset, offset + length)),
    1_000_000_000
  )
  assert.equal(ids.size, 0)
})

// ---------------------------------------------------------------- the pinned roster

test('the pinned roster only offers voices the English phonemizer can drive', () => {
  assert.equal(kokoroVoiceLang('af_heart'), 'en-US')
  assert.equal(kokoroVoiceLang('bm_george'), 'en-GB')
  // Present in the 54-voice pack, deliberately not offered — we ship no Japanese G2P.
  assert.equal(kokoroVoiceLang('jf_alpha'), null)
  assert.equal(kokoroVoiceLang('af_heart '), null)
})

test('kokoroVoicesFor reports only what the installed pack actually contains', () => {
  const voices = kokoroVoicesFor(new Set(['bm_george', 'af_heart', 'jf_alpha', 'nope']))
  assert.deepEqual(voices.map((v) => v.id), ['af_heart', 'bm_george'])
  assert.ok(voices.every((v) => v.engine === 'kokoro'))
  assert.equal(voices[0].lang, 'en-US')
  assert.deepEqual(kokoroVoicesFor(new Set()), [])
})

test('a voice id from the other tier resolves to a voice that exists', () => {
  // The prefs blob holds ONE voiceId across both tiers, so a SAPI URI arrives here whenever
  // the user switches engines. Never-silent beats never-substituted.
  assert.equal(resolveKokoroVoice('urn:moz-tts:sapi:Microsoft David'), KOKORO_DEFAULT_VOICE)
  assert.equal(resolveKokoroVoice(null), KOKORO_DEFAULT_VOICE)
  assert.equal(resolveKokoroVoice('bf_emma'), 'bf_emma')
})

