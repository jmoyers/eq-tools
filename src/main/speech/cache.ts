// cache.ts — the PERMANENT wav cache behind `eqspeech://`, and the protocol that serves it.
//
// THE IMAGECACHE ARGUMENT, APPLIED TO AUDIO (plan decision D3). Alert phrases are STATIC
// strings: "Mesmerization", "Charm break", the alert's own name. The same handful of
// utterances is spoken thousands of times over a character's life, and each one costs ~1
// second of CPU on a machine that is simultaneously running EverQuest. So a synthesized
// utterance is written once and kept forever — no TTL, no eviction, no size cap — exactly as
// `imageCache.ts` keeps a downloaded icon forever. A re-synth is wasted watts.
//
// THE SHAPE, deliberately the same as eqimg:// so there is one story to learn:
//
//     new Audio("eqspeech://<64 hex>")
//        └► protocol.handle('eqspeech')          main process, ONE handler, default session
//             └► <userData>/speech-cache/<hash>.wav exists ⇒ serve the bytes
//                else 404 (the handler NEVER synthesizes and NEVER touches the network)
//
// WHY THE HANDLER CANNOT SYNTHESIZE. `speech:say` is the only door to the engine: it decides,
// under the in-flight dedupe, whether a worker run is warranted, and it hands back a url only
// once the bytes are on disk. If the protocol could synthesize on demand, a renderer could
// spin up unbounded model runs by emitting `<audio>` tags, and a page reload would re-enter
// the engine with no dedupe at all. Read-only is the security property, not a simplification.
//
// THE KEY IS THE IDENTITY. `sha256(voiceId + '\0' + text)` — the NUL separator is what keeps
// ("af_heart", "x") and ("af_heartx", "") apart, which a plain concatenation would fuse. The
// hash is the whole file name, so no part of a renderer-supplied string ever reaches the
// filesystem: `../`, drive letters, UNC prefixes, reserved device names and 300-char paths
// are all structurally impossible, not filtered. Same reasoning as imageCache's `url-` route.
//
// A NOTE ON THE FULL 64 HEX. imageCache truncates its url hash to 24 chars because a few dozen
// wiki images have no collision story. This cache is keyed by ARBITRARY USER TEXT (a custom
// alert phrase), so a collision would mean one alert speaking another's words — cheap to
// avoid, so we keep the whole digest.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KOKORO_SAMPLE_RATE } from './pinned'

/** The scheme the renderer plays from. */
export const EQSPEECH_SCHEME = 'eqspeech'

/** Cache directory, relative to the channel's userData root. */
export const SPEECH_CACHE_DIR_NAME = 'speech-cache'

/** `<userData>/speech-cache` — one flat directory of wavs. */
export function speechCacheDir(userData: string): string {
  return join(userData, SPEECH_CACHE_DIR_NAME)
}

/**
 * The cache identity of one utterance. Also the in-flight dedupe key, so two alerts firing
 * the same phrase in the same tick produce exactly one synthesis.
 *
 * An absent voice id hashes as the empty string rather than being special-cased: "the
 * engine's default voice" is a stable identity too, and it must not collide with a voice
 * literally named "undefined".
 */
export function speechCacheKey(voiceId: string | null | undefined, text: string): string {
  return createHash('sha256').update(`${voiceId ?? ''}\0${text}`, 'utf8').digest('hex')
}

/** Whether a string is one of our hashes — the ONLY thing allowed to name a cache file. */
export function isSpeechCacheHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

/** Absolute path of a cached utterance. Callers must pass a `speechCacheKey` result. */
export function speechCachePath(userData: string, hash: string): string {
  return join(speechCacheDir(userData), `${hash}.wav`)
}

/** The url `speech:say` hands back for a hash. */
export function eqSpeechUrl(hash: string): string {
  return `${EQSPEECH_SCHEME}://${hash}`
}

/**
 * Parse + VALIDATE an `eqspeech://` request, or null.
 *
 * Hand-rolled for the same reason `parseEqImgUrl` is: whether a scheme is registered as
 * `standard` changes how WHATWG URL splits host from path (`eqspeech://abc` is host='abc'
 * when standard, path='//abc' when not), and this must be total over arbitrary renderer
 * input either way. Chromium LOWERCASES a standard scheme's host, which is why the hash
 * alphabet is lowercase hex — an uppercase digest would not survive the round trip.
 */
export function parseEqSpeechUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const prefix = `${EQSPEECH_SCHEME}://`
  if (raw.slice(0, prefix.length).toLowerCase() !== prefix) return null
  let rest = raw.slice(prefix.length)
  const cut = rest.search(/[?#]/)
  if (cut >= 0) rest = rest.slice(0, cut)
  const segments = rest.split('/').filter((s) => s.length > 0)
  if (segments.length !== 1) return null
  return isSpeechCacheHash(segments[0]) ? segments[0] : null
}

// ---- wav encoding ---------------------------------------------------------------------

/**
 * Kokoro's float samples → a 16-bit PCM mono wav.
 *
 * WHY WAV AND NOT SOMETHING SMALLER. The cache is permanent, so size is a real question: a
 * 2-second utterance is ~96 KB here and would be ~16 KB as opus. But encoding opus needs a
 * codec dependency, and Chromium plays a raw wav with zero decode latency from a `new Audio`
 * — which is what an alert needs. A hundred cached phrases is ~10 MB; the model itself is 92.
 *
 * Samples are clamped before scaling: the vocoder can overshoot ±1 slightly, and an
 * unclamped `* 32767` wraps that overshoot into full-scale opposite-sign noise — an audible
 * click at exactly the loudest moment of the word.
 */
export function encodeWav(samples: Float32Array, sampleRate = KOKORO_SAMPLE_RATE): Buffer {
  const count = samples.length
  const dataBytes = count * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'latin1')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'latin1')
  buf.write('fmt ', 12, 'latin1')
  buf.writeUInt32LE(16, 16) // PCM fmt chunk size
  buf.writeUInt16LE(1, 20) // format = PCM
  buf.writeUInt16LE(1, 22) // channels = mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36, 'latin1')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < count; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
  }
  return buf
}

// ---- the protocol ---------------------------------------------------------------------

/**
 * The privilege descriptor for `eqspeech://`. Registered by `appSchemes.ts` in the ONE
 * `registerSchemesAsPrivileged` call this process is allowed to make.
 *
 *   standard  : normal URL semantics, so `eqspeech://<hash>` parses as a subresource url.
 *   secure    : loadable from our secure-context renderer with no mixed-content warning.
 *   supportFetchAPI + stream: what `protocol.handle`'s Response-based API is built on.
 *
 * bypassCSP is deliberately absent — index.html lists `eqspeech:` under media-src, so the
 * policy stays explicit and auditable exactly as it is for eqimg:.
 */
export const EQSPEECH_SCHEME_PRIVILEGES = {
  scheme: EQSPEECH_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
} as const

/** The slice of Electron's `protocol` this file needs (structural, so tests can stub it). */
export interface SpeechProtocolLike {
  handle(
    scheme: string,
    handler: (request: GlobalRequest) => GlobalResponse | Promise<GlobalResponse>
  ): void
}

export interface SpeechCacheOptions {
  readonly userData: string
  readonly onError?: (msg: string, err: unknown) => void
}

const NOT_FOUND = (): GlobalResponse => new Response(null, { status: 404, statusText: 'Not Found' })

/**
 * Install the `eqspeech://` handler on the default session. Call ONCE, after
 * `app.whenReady()`, beside `installImageCacheProtocol` — one handler serves the main window
 * and every overlay, because nothing in this app uses a custom session partition.
 *
 * A miss is a 404, never a synthesis and never an error dialog: the renderer's alert path
 * already treats an unplayable url the way it treats any other failure, and `speech:say`
 * only ever hands out a url for a file it has just confirmed on disk. A 404 here therefore
 * means the entry was deleted between the say and the play, which is nobody's emergency.
 */
export function installSpeechCacheProtocol(
  protocol: SpeechProtocolLike,
  opts: SpeechCacheOptions
): void {
  const dir = speechCacheDir(opts.userData)
  const onError = opts.onError ?? ((): void => undefined)
  protocol.handle(EQSPEECH_SCHEME, async (request) => {
    const hash = parseEqSpeechUrl(request.url)
    if (!hash) return NOT_FOUND()
    // Path is DERIVED from a validated 64-hex hash, so it is always a direct child of `dir`.
    const path = join(dir, `${hash}.wav`)
    if (!existsSync(path)) return NOT_FOUND()
    try {
      const bytes = await readFile(path)
      // Copy into a freshly-owned array: readFile can hand back a view into Node's shared
      // pool, whose ArrayBufferLike doesn't satisfy BodyInit and could be invalidated.
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'content-type': 'audio/wav',
          'cache-control': 'public, max-age=31536000, immutable'
        }
      })
    } catch (err) {
      onError(`speech cache: could not read ${path}`, err)
      return NOT_FOUND()
    }
  })
}
