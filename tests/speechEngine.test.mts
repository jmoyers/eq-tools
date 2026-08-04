// Pure unit tests for the MAIN half of voice alerts — the Kokoro tier (voice-alerts.md W3).
//
// No Electron, no onnxruntime, no network, no fixture, so this file never skips. It pins the
// four decisions that are invisible until they are wrong, and each one is a thing that ends
// with the user hearing the wrong thing, hearing nothing, or a 120 MB download going wrong
// quietly:
//
//   1. CACHE KEYING — the identity of an utterance. A collision means one alert speaking
//      another alert's words, permanently, because this cache has no TTL.
//   2. HASH-PATH VALIDATION — `eqspeech://` is renderer-supplied input that names a file.
//      Everything that is not exactly one 64-hex-character segment must 404 having touched
//      nothing.
//   3. THE PROVISIONING STATE MACHINE — skip-if-verified, resume, sha256 as a hard gate,
//      retry with backoff, and the progress phases the prefs panel renders. Driven against an
//      in-memory fetch, so the real 120 MB download is exercised in shape without a byte of
//      network.
//
// The two DATA FORMATS the tier reads (the `.npz` voice pack and the phoneme vocabulary) are
// pinned next door in tests/speechVoicePack.test.mts.
//
// The inference itself is not unit-tested here: it is onnxruntime plus a 92 MB model, i.e.
// exactly the thing a unit test cannot honestly stand in for. Its proof is the packaging
// smoke — the packed app synthesizing a real phrase — recorded in the wave's commit.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeWav,
  eqSpeechUrl,
  isSpeechCacheHash,
  parseEqSpeechUrl,
  speechCacheKey,
  speechCachePath
} from '../src/main/speech/cache'
import { KOKORO_ASSETS, KOKORO_TOTAL_BYTES } from '../src/main/speech/pinned'
import { assetPath, isKokoroInstalled, kokoroDir, provisionKokoro } from '../src/main/speech/provision'
import type { SpeechInstallProgress } from '../src/shared/alertTypes'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'eqc-speech-'))
}

// ---------------------------------------------------------------- 1. cache keying

test('cache key separates voice from text (the NUL is load-bearing)', () => {
  // Without the separator these two collide: 'af_heart' + 'x' === 'af_heartx' + ''. A
  // collision here is permanent — one alert would speak another's words forever.
  assert.notEqual(speechCacheKey('af_heart', 'x'), speechCacheKey('af_heartx', ''))
})

test('cache key is stable, 64 lowercase hex, and voice-sensitive', () => {
  const a = speechCacheKey('af_heart', 'Mesmerization')
  assert.equal(a, speechCacheKey('af_heart', 'Mesmerization'))
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.notEqual(a, speechCacheKey('bm_george', 'Mesmerization'))
  assert.notEqual(a, speechCacheKey('af_heart', 'mesmerization'))
})

test('an absent voice id is its own identity, not the string "undefined"', () => {
  assert.equal(speechCacheKey(null, 'hi'), speechCacheKey(undefined, 'hi'))
  assert.notEqual(speechCacheKey(null, 'hi'), speechCacheKey('undefined', 'hi'))
})

test('the cache path is always a direct child of the cache dir', () => {
  const hash = speechCacheKey('af_heart', '../../etc/passwd\\..\\x')
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(speechCachePath('/u', hash), join('/u', 'speech-cache', `${hash}.wav`))
})

// ---------------------------------------------------------------- 2. url validation

test('parseEqSpeechUrl accepts exactly one 64-hex segment', () => {
  const hash = 'a'.repeat(64)
  assert.equal(parseEqSpeechUrl(`eqspeech://${hash}`), hash)
  // Chromium appends a trailing slash to a standard scheme's host-only url.
  assert.equal(parseEqSpeechUrl(`eqspeech://${hash}/`), hash)
  assert.equal(parseEqSpeechUrl(`eqspeech://${hash}?t=1#x`), hash)
  assert.equal(parseEqSpeechUrl(eqSpeechUrl(hash)), hash)
})

test('parseEqSpeechUrl rejects everything that is not one of our hashes', () => {
  const hash = 'a'.repeat(64)
  for (const bad of [
    '',
    'eqspeech://',
    `eqspeech://${hash}/extra`,
    `eqspeech://${'a'.repeat(63)}`,
    `eqspeech://${'a'.repeat(65)}`,
    `eqspeech://${'A'.repeat(64)}`, // uppercase: Chromium lowercases a standard host anyway
    'eqspeech://../../secret',
    'eqspeech://..%2F..%2Fsecret',
    `eqspeech://${hash}%00.txt`,
    `eqimg://${hash}`,
    `file://${hash}`,
    `eqspeech://C:\\Windows\\${hash}`
  ]) {
    assert.equal(parseEqSpeechUrl(bad), null, `should reject ${JSON.stringify(bad)}`)
  }
  // `isSpeechCacheHash` is the one gate every file name passes through, so pin it directly.
  assert.equal(parseEqSpeechUrl(123 as unknown as string), null)
  assert.ok(isSpeechCacheHash('f'.repeat(64)) && !isSpeechCacheHash('g'.repeat(64)))
})

// ---------------------------------------------------------------- wav + tokens

test('encodeWav emits a 24 kHz mono 16-bit RIFF and clamps overshoot', () => {
  const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -2]))
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF')
  assert.equal(wav.toString('latin1', 8, 12), 'WAVE')
  assert.equal(wav.readUInt16LE(22), 1) // mono
  assert.equal(wav.readUInt32LE(24), 24_000)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.length, 44 + 5 * 2)
  assert.equal(wav.readInt16LE(44 + 2), 32767)
  assert.equal(wav.readInt16LE(44 + 4), -32767)
  // The point of the clamp: an unclamped 2.0 wraps to a full-scale POSITIVE-to-negative
  // click at the loudest moment of the word.
  assert.equal(wav.readInt16LE(44 + 6), 32767)
  assert.equal(wav.readInt16LE(44 + 8), -32767)
})

// ---------------------------------------------------------------- 3. provisioning

/**
 * The state machine is driven against KILOBYTE stand-ins for the two pinned assets (the
 * `assets` seam on ProvisionOptions). That is the only way to test the SHA256 GATE at all:
 * with the real pins in place, every synthetic body fails the length check first and the
 * digest comparison is never reached, so a green test would be proving the wrong thing.
 * Everything else — paths, retries, resume, progress, atomicity — is identical code.
 */
const BODY_A = Buffer.from('the model, in spirit'.repeat(40))
const BODY_B = Buffer.from('the voices, in spirit'.repeat(30))

const pin = (name: string, body: Buffer) => ({
  name,
  url: `https://github.com/x/y/releases/download/model-files-v1.0/${name}`,
  sha256: createHash('sha256').update(body).digest('hex'),
  bytes: body.length
})

const FAKE_ASSETS = [pin('model.onnx', BODY_A), pin('voices.bin', BODY_B)]
const FAKE_TOTAL = BODY_A.length + BODY_B.length

interface FetchCall {
  url: string
  range?: string
}

/**
 * A fetch served from memory. `honourRange:false` models the real-world server that ignores
 * a Range header and answers 200 with the WHOLE body — the case that must restart rather
 * than append a full body onto a partial file and produce a plausible wrong-length blob.
 */
function fakeFetch(
  bodies: Map<string, Buffer>,
  log: FetchCall[],
  opts: { honourRange?: boolean; truncateFirst?: number } = {}
) {
  let call = 0
  return ((url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    log.push({ url, ...(headers.Range ? { range: headers.Range } : {}) })
    const body = bodies.get(url)
    if (!body) return Promise.resolve(new Response(null, { status: 404 }))
    const wants = headers.Range ? Number(/bytes=(\d+)-/.exec(headers.Range)?.[1] ?? 0) : 0
    const honour = opts.honourRange !== false
    const from = honour ? wants : 0
    let slice = body.subarray(from)
    // Cut the FIRST response short to simulate a dropped connection mid-download.
    if (opts.truncateFirst !== undefined && call === 0) slice = slice.subarray(0, opts.truncateFirst)
    call++
    return Promise.resolve(
      new Response(new Uint8Array(slice), { status: from > 0 ? 206 : 200 })
    )
  }) as unknown as typeof fetch
}

function bodyMap(): Map<string, Buffer> {
  return new Map([
    [FAKE_ASSETS[0].url, BODY_A],
    [FAKE_ASSETS[1].url, BODY_B]
  ])
}

test('the happy path: both assets stream, verify, and land atomically', async () => {
  const root = tempRoot()
  const log: FetchCall[] = []
  const phases: SpeechInstallProgress[] = []
  const result = await provisionKokoro({
    userData: root,
    assets: FAKE_ASSETS,
    fetchImpl: fakeFetch(bodyMap(), log),
    onProgress: (p) => phases.push(p),
    sleep: () => Promise.resolve()
  })
  assert.deepEqual(result, { ok: true })
  assert.equal(log.length, 2, 'ONE request per asset — never a parallel chunk fetcher')
  assert.deepEqual(readFileSync(assetPath(root, FAKE_ASSETS[0])), BODY_A)
  assert.deepEqual(readFileSync(assetPath(root, FAKE_ASSETS[1])), BODY_B)
  // No `.part` survives a success: the file is renamed, never copied.
  assert.ok(!existsSync(join(kokoroDir(root), `${FAKE_ASSETS[0].name}.part`)))
  assert.equal(phases.at(0)?.phase, 'checking')
  assert.equal(phases.at(-1)?.phase, 'done')
  assert.ok(phases.some((p) => p.phase === 'verifying'))
  assert.ok(phases.every((p) => p.total === FAKE_TOTAL))
})

test('a completed install is IDEMPOTENT: a re-run touches the network zero times', async () => {
  const root = tempRoot()
  await provisionKokoro({
    userData: root,
    assets: FAKE_ASSETS,
    fetchImpl: fakeFetch(bodyMap(), []),
    sleep: () => Promise.resolve()
  })
  const log: FetchCall[] = []
  const again = await provisionKokoro({
    userData: root,
    assets: FAKE_ASSETS,
    fetchImpl: fakeFetch(bodyMap(), log),
    sleep: () => Promise.resolve()
  })
  assert.deepEqual(again, { ok: true })
  assert.equal(log.length, 0, 'verified files are skipped without a request')
})

test('a half-finished run RESUMES with a Range request instead of re-fetching', async () => {
  const root = tempRoot()
  const log: FetchCall[] = []
  // First attempt drops after 100 bytes; the retry must ask for the rest, not all of it.
  const result = await provisionKokoro({
    userData: root,
    assets: [FAKE_ASSETS[0]],
    fetchImpl: fakeFetch(bodyMap(), log, { truncateFirst: 100 }),
    sleep: () => Promise.resolve()
  })
  assert.deepEqual(result, { ok: true })
  assert.equal(log.length, 2)
  assert.equal(log[0].range, undefined)
  assert.equal(log[1].range, 'bytes=100-')
  assert.deepEqual(readFileSync(assetPath(root, FAKE_ASSETS[0])), BODY_A)
})

test('a server that IGNORES Range restarts cleanly rather than appending', async () => {
  const root = tempRoot()
  const log: FetchCall[] = []
  const result = await provisionKokoro({
    userData: root,
    assets: [FAKE_ASSETS[0]],
    fetchImpl: fakeFetch(bodyMap(), log, { truncateFirst: 100, honourRange: false }),
    sleep: () => Promise.resolve()
  })
  // The retry asks for a range, gets a 200 with the whole body, throws away its seeded digest
  // and starts over — so the file is correct, not 100 bytes too long.
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(readFileSync(assetPath(root, FAKE_ASSETS[0])), BODY_A)
})

test('sha256 is a HARD gate: wrong bytes are never renamed into place', async () => {
  const root = tempRoot()
  const phases: SpeechInstallProgress[] = []
  const corrupted = new Map([[FAKE_ASSETS[0].url, Buffer.from('x'.repeat(BODY_A.length))]])
  const result = await provisionKokoro({
    userData: root,
    assets: [FAKE_ASSETS[0]],
    fetchImpl: fakeFetch(corrupted, []),
    onProgress: (p) => phases.push(p),
    sleep: () => Promise.resolve()
  })
  assert.equal(result.ok, false)
  // RIGHT LENGTH, wrong digest — so this really is the sha256 check firing, not the length one.
  assert.ok(!existsSync(assetPath(root, FAKE_ASSETS[0])))
  // Nothing half-written survives either: a `.part` from a bad digest is deleted, so the next
  // attempt cannot resume onto poisoned bytes.
  assert.ok(!existsSync(join(kokoroDir(root), `${FAKE_ASSETS[0].name}.part`)))
  assert.equal(phases.at(-1)?.phase, 'failed')
  assert.match(String(phases.at(-1)?.message), /sha256 mismatch/)
})

test('a short body fails on LENGTH before anything is kept', async () => {
  const root = tempRoot()
  const short = new Map([[FAKE_ASSETS[0].url, BODY_A.subarray(0, 10)]])
  const result = await provisionKokoro({
    userData: root,
    assets: [FAKE_ASSETS[0]],
    fetchImpl: fakeFetch(short, []),
    sleep: () => Promise.resolve()
  })
  assert.equal(result.ok, false)
  assert.ok(!existsSync(assetPath(root, FAKE_ASSETS[0])))
})

test('a failed asset is retried exactly MAX_ATTEMPTS times, then stops (no storm)', async () => {
  const root = tempRoot()
  const log: FetchCall[] = []
  const waits: number[] = []
  const result = await provisionKokoro({
    userData: root,
    assets: FAKE_ASSETS,
    fetchImpl: fakeFetch(new Map(), log), // every request 404s
    sleep: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    }
  })
  assert.equal(result.ok, false)
  // Three attempts at the FIRST asset and then the run gives up — the second is never asked
  // for, because there is nothing to be gained by hammering a host that is failing.
  assert.equal(log.length, 3)
  assert.deepEqual(log.map((l) => l.url), Array(3).fill(FAKE_ASSETS[0].url))
  assert.deepEqual(waits, [2000, 4000]) // exponential, and none after the last attempt
})

test('a wrong-digest file already on disk is re-fetched, not trusted', async () => {
  const root = tempRoot()
  mkdirSync(kokoroDir(root), { recursive: true })
  // Right LENGTH, wrong bytes — the install gate must not accept it.
  writeFileSync(assetPath(root, FAKE_ASSETS[0]), Buffer.alloc(BODY_A.length, 3))
  const log: FetchCall[] = []
  const result = await provisionKokoro({
    userData: root,
    assets: [FAKE_ASSETS[0]],
    fetchImpl: fakeFetch(bodyMap(), log),
    sleep: () => Promise.resolve()
  })
  assert.deepEqual(result, { ok: true })
  assert.equal(log.length, 1)
  assert.deepEqual(readFileSync(assetPath(root, FAKE_ASSETS[0])), BODY_A)
})

test('isKokoroInstalled is length-only, and false while anything is missing or short', () => {
  // The CHEAP per-utterance check, deliberately not a digest (see the function's own note).
  const root = tempRoot()
  assert.ok(!isKokoroInstalled(root))
  mkdirSync(kokoroDir(root), { recursive: true })
  writeFileSync(assetPath(root, KOKORO_ASSETS[0]), Buffer.alloc(KOKORO_ASSETS[0].bytes))
  assert.ok(!isKokoroInstalled(root), 'one of two assets is not installed')
  writeFileSync(assetPath(root, KOKORO_ASSETS[1]), Buffer.alloc(KOKORO_ASSETS[1].bytes - 1))
  assert.ok(!isKokoroInstalled(root), 'a truncated asset is not installed')
  writeFileSync(assetPath(root, KOKORO_ASSETS[1]), Buffer.alloc(KOKORO_ASSETS[1].bytes))
  assert.ok(isKokoroInstalled(root))
})

test('progress carries whole-install bytes and exactly one terminal phase', async () => {
  const root = tempRoot()
  const phases: SpeechInstallProgress[] = []
  await provisionKokoro({
    userData: root,
    assets: FAKE_ASSETS,
    fetchImpl: fakeFetch(new Map(), []),
    onProgress: (p) => phases.push(p),
    sleep: () => Promise.resolve()
  })
  assert.ok(phases.every((p) => p.total === FAKE_TOTAL))
  assert.ok(phases.every((p) => p.engine === 'kokoro'))
  const terminal = phases.filter((p) => p.phase === 'done' || p.phase === 'failed')
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0].phase, 'failed')
  assert.ok(terminal[0].message)
})

test('the pinned assets are two immutable, hash-pinned https URLs', () => {
  assert.equal(KOKORO_ASSETS.length, 2)
  for (const asset of KOKORO_ASSETS) {
    assert.match(asset.url, /^https:\/\/github\.com\/.+\/releases\/download\/model-files-v1\.0\//)
    assert.match(asset.sha256, /^[0-9a-f]{64}$/)
    assert.ok(asset.bytes > 0)
  }
  assert.equal(KOKORO_TOTAL_BYTES, KOKORO_ASSETS[0].bytes + KOKORO_ASSETS[1].bytes)
})
