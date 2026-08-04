// worker.ts — Kokoro inference, on a WORKER THREAD. The only file that loads onnxruntime.
//
// WHY THIS IS NOT ON THE MAIN THREAD (plan decision D2, and the whole reason this file
// exists). Main runs the log pipeline: the tailer, `parseEvent`, every module's fold, the
// combat engine, the 1s tick. A Kokoro synthesis is 0.9–1.4 seconds of pegged CPU inside a
// native call that does not yield — measured on this machine, this model. On the main thread
// that is a second of frozen DPS meter, a second of un-tailed log, a second of alerts not
// evaluating, every time an alert says a word it has not said before. There is no amount of
// "it's usually cached" that makes that acceptable, because the uncached case is precisely
// the exciting moment (a new mob, a new spell) the meter is being watched for.
//
// SO: `new Worker()` on first `speech:say`, kept warm afterwards. The ~500 ms session
// creation and the ~170 ms espeak-ng WASM warm-up are paid ONCE per app run, on a thread
// nothing else is waiting on.
//
// THE PIPELINE, end to end:
//
//   text ──espeak-ng(wasm)──► IPA ──normalize──► token ids ──┐
//                                                            ├──► onnxruntime ──► float samples
//   voice id ──► style vector for THIS token count ──────────┘         (int8 Kokoro v1.0)
//                                                                              │
//                                            <userData>/speech-cache/<hash>.wav ◄─ 16-bit wav
//
// PHONEMIZATION IS espeak-ng COMPILED TO WASM (`phonemizer`, Apache-2.0, zero dependencies,
// no install script, ~1.3 MB of pure JS). Kokoro's reference JS port uses exactly this
// package. A NATIVE espeak-ng binding was rejected on purpose: it would be the tree's only
// module needing a compile step, it would collide with `.npmrc ignore-scripts=true`, and it
// would need per-platform prebuilds for a feature that is off by default.
//
// SERIALIZED BY CONSTRUCTION. Jobs run one at a time through a promise chain. onnxruntime
// would happily run two sessions concurrently and eat two cores — on a machine that is also
// running EverQuest, which is the entire point of this app. One alert at a time is also the
// natural rate: they are spoken one after another anyway.
//
// EVERY FAILURE IS A MESSAGE, NEVER A CRASH. A missing model, a corrupt voice pack, an
// unknown voice, a phonemizer throw — each answers `{ok:false, error}` for that one job. The
// worker stays alive, and `engine.ts` turns the failure into `{ok:false}` on `speech:say`,
// which W2's renderer already degrades to the system voice (the fallback seam, unbroken).

import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import * as ort from 'onnxruntime-node'
import { phonemize } from 'phonemizer'
import { encodeWav } from './cache'
import { normalizeEspeakPhonemes, phonemeCount, tokenizePhonemes } from './phonemes'
import { KOKORO_MAX_TOKENS, kokoroVoiceLang } from './pinned'
import { decodeNpyFloat32, parseVoicePack, styleVectorFor } from './voicePack'
import type { SpeechWorkerInit, SpeechWorkerJob, SpeechWorkerReply } from './engine'

const init = workerData as SpeechWorkerInit
const port = parentPort

/** The model's input/output names, as published by the pinned int8 build: `tokens`, `style`,
 *  `speed` in; `audio` out. Read from the session rather than hardcoded — the HF mirror of
 *  the same weights names them `input_ids`/`waveform`, and a future re-pin should not need a
 *  code change to keep working. */
interface SessionNames {
  tokens: string
  style: string
  speed: string
  audio: string
}

interface LoadedSession {
  session: ort.InferenceSession
  names: SessionNames
}

let sessionPromise: Promise<LoadedSession> | null = null
let packPromise: Promise<Buffer> | null = null
const styleTables = new Map<string, Float32Array>()
/** The serialization chain — every job appends itself to it. */
let queue: Promise<unknown> = Promise.resolve()

/** Create (once) the inference session and work out what it calls its tensors. */
function loadSession(): Promise<LoadedSession> {
  const existing = sessionPromise
  if (existing) return existing
  const created = ort.InferenceSession.create(init.modelPath).then((session): LoadedSession => {
    const [tokens, style, speed] = session.inputNames
    const [audio] = session.outputNames
    if (!tokens || !style || !speed || !audio) throw new Error('unexpected model signature')
    return { session, names: { tokens, style, speed, audio } }
  })
  sessionPromise = created
  return created
}

/** The voice pack, read once and held: 28 MB resident, versus a 28 MB read per utterance. */
function loadPack(): Promise<Buffer> {
  const existing = packPromise
  if (existing) return existing
  const created = readFile(init.voicesPath)
  packPromise = created
  return created
}

/** One voice's (510, 1, 256) style table, decoded on first use of that voice. */
async function styleTableFor(voiceId: string): Promise<Float32Array> {
  const cached = styleTables.get(voiceId)
  if (cached) return cached
  const pack = await loadPack()
  const entry = parseVoicePack(pack).find((e) => e.id === voiceId)
  if (!entry) throw new Error(`voice '${voiceId}' is not in the pack`)
  const table = decodeNpyFloat32(pack, entry)
  if (!table) throw new Error(`voice '${voiceId}' has an unreadable style table`)
  styleTables.set(voiceId, table)
  return table
}

/**
 * Text → phoneme token ids for one voice's dialect.
 *
 * espeak returns one string per sentence-ish chunk; they are joined with a space so that a
 * two-clause alert ("Charm broke, run") keeps the pause a comma implies instead of running
 * the clauses together.
 */
async function tokensFor(text: string, lang: 'en-US' | 'en-GB'): Promise<number[]> {
  // espeak's own dialect spelling, which is not the BCP-47 tag we surface to the picker.
  const parts = await phonemize(text, lang === 'en-GB' ? 'en' : 'en-us')
  return tokenizePhonemes(normalizeEspeakPhonemes(parts.join(' ')), KOKORO_MAX_TOKENS)
}

/** Synthesize one utterance and land it in the cache. Returns nothing; throws on failure. */
async function synthesize(job: SpeechWorkerJob): Promise<void> {
  const lang = kokoroVoiceLang(job.voiceId)
  if (!lang) throw new Error(`voice '${job.voiceId}' is not offered by this build`)
  const tokens = await tokensFor(job.text, lang)
  if (phonemeCount(tokens) === 0) throw new Error('nothing to say (no phonemes)')
  const [{ session, names }, table] = await Promise.all([loadSession(), styleTableFor(job.voiceId)])
  const style = styleVectorFor(table, phonemeCount(tokens))
  const feeds: Record<string, ort.Tensor> = {
    [names.tokens]: new ort.Tensor('int64', BigInt64Array.from(tokens, BigInt), [1, tokens.length]),
    [names.style]: new ort.Tensor('float32', style, [1, style.length]),
    // Speed stays 1.0: the cache key is (voice, text), so a rate baked into the audio would
    // make one key mean two different sounds. Playback rate is the renderer's to apply.
    [names.speed]: new ort.Tensor('float32', Float32Array.from([1]), [1])
  }
  const output = (await session.run(feeds))[names.audio]
  const samples = output.data
  if (!(samples instanceof Float32Array)) throw new Error('model returned non-float audio')
  await writeAtomic(job.hash, encodeWav(samples))
}

/**
 * Write the wav where the protocol handler will find it — temp file in the SAME directory,
 * then rename. Identical reasoning to imageCache.ts: this cache has no TTL, so a torn file
 * would be a permanently wrong answer, and rename is atomic within a directory.
 */
async function writeAtomic(hash: string, bytes: Buffer): Promise<void> {
  const path = join(init.cacheDir, `${hash}.wav`)
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await writeFile(tmp, bytes)
    await rename(tmp, path)
  } catch (err) {
    // Best-effort cleanup: the outcome that matters is already decided, and a failed unlink
    // gives the caller nothing to act on (imageCache.ts's `ignoreCleanupFailure` precedent).
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

port?.on('message', (job: SpeechWorkerJob) => {
  queue = queue.then(async () => {
    let reply: SpeechWorkerReply
    try {
      await synthesize(job)
      reply = { id: job.id, ok: true }
    } catch (err) {
      reply = { id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    port.postMessage(reply)
  })
})
