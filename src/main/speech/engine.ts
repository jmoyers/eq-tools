// engine.ts — main's side of the Kokoro tier: the cache, the dedupe, and one warm worker.
//
// THE DIVISION OF LABOUR. `worker.ts` knows how to turn text into a wav. This file knows
// WHEN that is worth doing, and it is the only thing that ever asks:
//
//   speech:say {text, voiceId}
//        │
//        ├─ hash = sha256(voiceId \0 text)
//        ├─ <userData>/speech-cache/<hash>.wav on disk?  ──yes──►  eqspeech://<hash>   (0 ms)
//        ├─ tier not installed?                          ──yes──►  {ok:false}          (0 ms)
//        ├─ already being synthesized?                    ──yes──►  join that promise
//        └─ else: spawn-or-reuse the worker, queue the job, await, then serve the url
//
// EVERY BRANCH ABOVE EXISTS TO NOT RUN THE MODEL. The cache is permanent (D3), so the steady
// state of a long play session is branch one: a phrase said for the thousandth time costs a
// file read. The dedupe covers the case that actually happens in this app — three buffs
// fading at once, all resolving to the same word — which without it would be three concurrent
// model runs producing three identical files.
//
// THE WORKER IS LAZY AND THEN WARM. Nothing spawns at startup: a user who never enables voice
// alerts never pays for onnxruntime being on disk, let alone loaded. The first cache MISS
// spawns it, and it stays for the life of the app, holding the ~90 MB session and the 28 MB
// voice pack — which is why the second uncached phrase is ~0.9 s instead of ~1.6 s.
//
// A DEAD WORKER STAYS DEAD (politely). If the thread cannot start at all — the native module
// failed to load in a packaged build, say — that is a property of the installation, not of
// this request. It is recorded ONCE and every later call answers `{ok:false}` immediately
// rather than re-attempting a failing spawn per alert. `{ok:false}` is the fallback seam W2
// already handles: the alert is spoken by the system voice, and the user hears their alert.
//
// ELECTRON-FREE ON PURPOSE. `userData` and the worker path are injected, so this module can
// be constructed in a test (and so that ipc/speech.ts stays the only place that knows about
// `app`). The same rule imageCache.ts follows.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { eqSpeechUrl, speechCacheDir, speechCacheKey, speechCachePath } from './cache'
import { isKokoroInstalled, kokoroDir } from './provision'
import { KOKORO_ASSETS, KOKORO_DEFAULT_VOICE, kokoroVoiceLang } from './pinned'
import type { SpeechSayResult } from '../../shared/types'

// ---- the worker's message contract (shared with worker.ts) ------------------------------

/** `workerData` — the three paths the worker needs, resolved once by the parent. */
export interface SpeechWorkerInit {
  readonly modelPath: string
  readonly voicesPath: string
  readonly cacheDir: string
}

/** One synthesis request. `hash` is the cache identity, computed by the parent so that both
 *  sides agree on the file name without re-deriving it. */
export interface SpeechWorkerJob {
  readonly id: number
  readonly hash: string
  readonly text: string
  readonly voiceId: string
}

/** The worker's answer. `ok` means the wav is on disk under `hash`. */
export type SpeechWorkerReply =
  | { readonly id: number; readonly ok: true }
  | { readonly id: number; readonly ok: false; readonly error: string }

// ---- the engine -------------------------------------------------------------------------

export interface SpeechEngineOptions {
  readonly userData: string
  /** Absolute path of the built worker bundle (out/main/speechWorker.js). */
  readonly workerPath: string
  readonly onError?: (message: string, err: unknown) => void
  readonly onInfo?: (message: string) => void
}

export interface SpeechEngine {
  /** Synthesize (or serve from cache) one utterance. Never rejects. */
  say(text: string, voiceId: string | null | undefined): Promise<SpeechSayResult>
  /** Tear the worker down (app quit). Safe to call when it never started. */
  dispose(): void
}

/**
 * Resolve the voice a request should actually use.
 *
 * A stored `voiceId` is engine-scoped, and the prefs blob holds ONE id across both tiers — so
 * a user who picked a Windows SAPI voice and then switched to Kokoro arrives here with an id
 * this tier has never heard of. Falling back to the tier's own default voice is the
 * never-silent answer (world-model law 1 applied to audio): the alert is spoken, in a voice
 * that exists, rather than refused because a preference from the other tier came along.
 */
export function resolveKokoroVoice(voiceId: string | null | undefined): string {
  return voiceId && kokoroVoiceLang(voiceId) ? voiceId : KOKORO_DEFAULT_VOICE
}

export function createSpeechEngine(opts: SpeechEngineOptions): SpeechEngine {
  const cacheDir = speechCacheDir(opts.userData)
  const onError = opts.onError ?? ((): void => undefined)
  const onInfo = opts.onInfo ?? ((): void => undefined)

  let worker: Worker | null = null
  /** Set once when the thread proves it cannot run here — see the header. */
  let workerBroken = false
  let nextJobId = 1
  const pending = new Map<number, (reply: SpeechWorkerReply) => void>()
  /** hash → the in-flight synthesis for it. */
  const inFlight = new Map<string, Promise<SpeechSayResult>>()

  /** Fail every outstanding job with one reason (the thread died under them). */
  function failAllPending(error: string): void {
    for (const [id, resolve] of pending) resolve({ id, ok: false, error })
    pending.clear()
  }

  function ensureWorker(): Worker | null {
    if (workerBroken) return null
    if (worker) return worker
    const init: SpeechWorkerInit = {
      modelPath: join(kokoroDir(opts.userData), KOKORO_ASSETS[0].name),
      voicesPath: join(kokoroDir(opts.userData), KOKORO_ASSETS[1].name),
      cacheDir
    }
    try {
      mkdirSync(cacheDir, { recursive: true })
      worker = new Worker(opts.workerPath, { workerData: init })
    } catch (err) {
      workerBroken = true
      onError('speech: the synthesis worker could not be started; using the system voice', err)
      return null
    }
    worker.on('message', (reply: SpeechWorkerReply) => {
      pending.get(reply.id)?.(reply)
      pending.delete(reply.id)
    })
    worker.on('error', (err) => {
      // A thread-level error (module load failure, an uncaught throw) kills the thread. Do
      // not respawn in a loop: record it and let every later call answer immediately.
      workerBroken = true
      worker = null
      onError('speech: the synthesis worker failed; using the system voice', err)
      failAllPending('worker error')
    })
    worker.on('exit', () => {
      worker = null
      failAllPending('worker exited')
    })
    // `unref` so a warm worker never holds the process open at quit — the model is a
    // convenience, not a reason for the app to linger.
    worker.unref()
    onInfo('[everquest-companion] Speech: Kokoro worker started')
    return worker
  }

  /** Post one job and wait for its reply. Resolves false on any failure. */
  function runJob(hash: string, text: string, voiceId: string): Promise<boolean> {
    const w = ensureWorker()
    if (!w) return Promise.resolve(false)
    const id = nextJobId++
    return new Promise<boolean>((resolve) => {
      pending.set(id, (reply) => {
        if (!reply.ok) onError(`speech: synthesis failed — ${reply.error}`, null)
        resolve(reply.ok)
      })
      w.postMessage({ id, hash, text, voiceId } satisfies SpeechWorkerJob)
    })
  }

  async function synthesize(hash: string, text: string, voiceId: string): Promise<SpeechSayResult> {
    const ok = await runJob(hash, text, voiceId)
    // Trust the FILE, not the reply: the url we hand back is a promise that the protocol
    // handler will find bytes there, and only the filesystem can keep that promise.
    if (!ok || !existsSync(speechCachePath(opts.userData, hash))) {
      return { ok: false, reason: 'engine-not-installed' }
    }
    return { ok: true, url: eqSpeechUrl(hash) }
  }

  return {
    async say(text, voiceId) {
      const voice = resolveKokoroVoice(voiceId)
      const hash = speechCacheKey(voice, text)
      // 1. The steady state: already synthesized, some session long ago. No worker, no model.
      if (existsSync(speechCachePath(opts.userData, hash))) {
        return { ok: true, url: eqSpeechUrl(hash) }
      }
      // 2. Nothing to synthesize WITH. Checked after the cache so that an already-spoken
      //    phrase keeps working even if the user deleted the model behind our back.
      if (!isKokoroInstalled(opts.userData)) return { ok: false, reason: 'engine-not-installed' }
      // 3. Someone is already synthesizing exactly this. Join them.
      const existing = inFlight.get(hash)
      if (existing) return existing
      const run = synthesize(hash, text, voice).finally(() => inFlight.delete(hash))
      inFlight.set(hash, run)
      return run
    },
    dispose() {
      const w = worker
      worker = null
      failAllPending('shutting down')
      void w?.terminate()
    }
  }
}
