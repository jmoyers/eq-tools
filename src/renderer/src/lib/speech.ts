// speech.ts — THE ENGINE SEAM for voice alerts (docs/plans/voice-alerts.md §3).
//
// `speechText.ts` (shared) answers WHAT is said. This module answers WHO SAYS IT and WHEN —
// and it is the ONLY place in the renderer that touches a speech engine. Every caller (the
// alert firing path, the editor's ▶ test, the preferences preview) goes through `speak()`, so
// there is exactly one answer to "which voice, at what rate, through which tier, and does this
// build utter at all".
//
// TWO TIERS BEHIND ONE CALL (decision D1):
//   'system'  → Chromium's own `speechSynthesis`. It lives in the renderer, so it never crosses
//               IPC: an utterance is constructed here, given the prefs' rate/volume and the
//               matched voice, and handed to the browser. Zero download, zero latency.
//   'kokoro'  → `window.eq.speechSay` into main (a worker, a pinned model, a wav cache). In THIS
//               build that handler is an honest stub answering `{ok:false,
//               reason:'engine-not-installed'}` — so this module FALLS BACK to the system tier
//               and warns ONCE to the console. A user who ticked "kokoro" before wave 3 exists
//               still hears their alert; they do not get an error dialog for a tier they were
//               invited to pick. Surfacing the install state as UI is W3's job.
//
// NEVER SILENT is the through-line (world-model law 1, applied to audio): a fallback, a missing
// voice, an engine that answers 'not-implemented' — none of them turn an alert into nothing.
// The only things that produce silence are the alerts module's own master MUTE, an empty
// utterance, and the e2e channel.
//
// THE E2E CHANNEL NEVER UTTERS. `npm run test:e2e` runs beside the user's game (AGENTS.md: no
// window is ever shown, the store is a temp dir). A headless test that spoke out loud would be
// the single most intrusive thing this repo does. So `speak()` records the utterance on
// `window.__eqSpeech` and returns BEFORE any engine is touched whenever `window.eq.isE2E` is
// true — and that same recording ring is what the e2e spec asserts against, which is the point:
// the test observes the seam, not the sound card.
//
// NODE-TESTABLE BY CONSTRUCTION. `speechPlan` and `pickVoice` are pure and carry the two
// decisions worth pinning (what a firing does with sound vs speech; which voice a stored id
// resolves to), so they are unit-tested with no DOM at all. Nothing at module scope touches
// `window`. Value imports from `shared/` are RELATIVE, never `@shared/*` — the repo-wide rule
// for anything node:test loads (AGENTS.md toolchain gotchas, the mobSearch.ts precedent).

import type {
  AlertAudio,
  AlertDef,
  FiredAlert,
  SpeechEngine,
  SpeechSayResult,
  SpeechVoice,
  VoicePrefs
} from '@shared/types'
import {
  DEFAULT_VOICE_PREFS,
  MAX_SPEECH_RATE,
  MIN_SPEECH_RATE,
  speechTextFor
} from '../../../shared/speechText'

// ------------------------------------------------------------------ the pure decisions

/**
 * What ONE firing of an alert should actually do. The whole sound-vs-speech question, decided
 * in one pure function so the firing path, the editor's preview and the tests agree.
 *
 *  - `sound`  play the def's pack sound.
 *  - `speak`  the utterance, or null for "say nothing".
 *  - `after`  the 'both' contract (D5): the sound plays FIRST and the speech is queued behind
 *             it, so the two never talk over each other. Only ever true when both are set.
 */
export interface SpeechPlan {
  sound: boolean
  speak: string | null
  after: boolean
}

const SILENT: SpeechPlan = { sound: false, speak: null, after: false }
const SOUND_ONLY: SpeechPlan = { sound: true, speak: null, after: false }

/**
 * Resolve a def + firing + prefs into what to play.
 *
 * MUTE IS ABSOLUTE. The alerts module's master mute is a promise that the app makes no noise;
 * speech is noise. A muted module speaks nothing, whatever the voice prefs say (§2).
 *
 * VOICE-OFF DEGRADES TO SOUND, IT DOES NOT MUTE. Voice is off by default (D4), so a def that
 * asks for `audio:'speech'` can perfectly well be read by a build/profile where speech is
 * disabled — an imported alert set is exactly that case. Degrading to the def's SOUND keeps the
 * alert alerting; silently dropping it would mute an alert the user can still see is enabled.
 */
export function speechPlan(
  def: Pick<AlertDef, 'name' | 'audio' | 'speech'>,
  firing: Pick<FiredAlert, 'spell'> | null,
  prefs: VoicePrefs,
  muted: boolean
): SpeechPlan {
  if (muted) return SILENT
  const action: AlertAudio = def.audio ?? 'sound'
  if (action === 'sound') return SOUND_ONLY
  if (!prefs.enabled) return SOUND_ONLY
  const text = speechTextFor(def, firing)
  if (!text) return SOUND_ONLY
  return action === 'both' ? { sound: true, speak: text, after: true } : { sound: false, speak: text, after: false }
}

/** The minimum a voice has to state for `pickVoice` to match it (a `SpeechSynthesisVoice` does). */
export interface VoiceLike {
  name: string
  voiceURI?: string
  lang?: string
}

/**
 * The id a stored pref holds for one system voice. `voiceURI` is the stable identifier Chromium
 * gives (`urn:moz-tts:sapi:Microsoft David - English (United States)?en-US`); `name` is the
 * fallback for engines that state no URI.
 */
export function voiceIdOf(voice: VoiceLike): string {
  return voice.voiceURI ?? voice.name
}

/**
 * Resolve a stored voice id against the voices this machine actually has, or null for "let the
 * engine choose".
 *
 * WHY THIS IS FUZZY-ON-PURPOSE-AND-BOUNDED. A voice id is persisted (and can arrive in an
 * imported settings bundle) but the voice LIST is per-machine: SAPI voice URIs differ between
 * Windows builds while the human name ("Microsoft David Desktop") is stable. So the match walks
 * exact URI → exact name → case-insensitive URI → case-insensitive name and then STOPS. It
 * never falls back to "the first voice", because picking a stranger's voice is worse than the
 * engine's own default, and it never substring-matches (AGENTS.md law 12: renames are
 * knowledge, not spelling).
 */
export function pickVoice<T extends VoiceLike>(
  voices: readonly T[],
  wanted: string | null | undefined
): T | null {
  if (!wanted) return null
  const exact = voices.find((v) => voiceIdOf(v) === wanted || v.name === wanted)
  if (exact) return exact
  const lower = wanted.toLowerCase()
  return voices.find((v) => voiceIdOf(v).toLowerCase() === lower || v.name.toLowerCase() === lower) ?? null
}

/** Clamp a number into [lo, hi]; anything non-finite becomes `fallback`. */
function clamp(value: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(hi, Math.max(lo, value))
}

// ------------------------------------------------------------------ the prefs cache

// The voice prefs are main-owned (electron-store) but read on EVERY firing, so the renderer
// keeps one hydrated copy here — beside the engine that consumes it — rather than making each
// of the three call sites own its own async read. `loadVoicePrefs()` hydrates it, the
// preferences panel pushes updates through `applyVoicePrefs()`, and `currentVoicePrefs()` is
// the synchronous read every caller uses.

let prefs: VoicePrefs = DEFAULT_VOICE_PREFS

export function currentVoicePrefs(): VoicePrefs {
  return prefs
}

/** Adopt prefs the app already has in hand (the preferences panel, after a successful save). */
export function applyVoicePrefs(next: VoicePrefs): void {
  prefs = next
}

/** Re-read the prefs blob from main. Never rejects — a failed read keeps the last known copy. */
export async function loadVoicePrefs(): Promise<VoicePrefs> {
  try {
    prefs = await window.eq.getVoicePrefs()
  } catch {
    // Keep whatever we had; speech simply behaves as it did a moment ago.
  }
  return prefs
}

// ------------------------------------------------------------------ system-tier voices

/**
 * `speechSynthesis.getVoices()` IS ASYNC IN DISGUISE. On a cold renderer it returns an EMPTY
 * array and fires `voiceschanged` once the platform's voice list has actually loaded — so a
 * picker built from the first call renders "no voices" forever, and an utterance built from it
 * silently gets the default voice. This is the dance: answer immediately when the list is
 * already there, otherwise wait for the event, with a deadline so a platform that never fires
 * it (or has genuinely zero voices) resolves empty instead of hanging.
 *
 * The promise is cached because the list is stable for the app's lifetime — EXCEPT when it
 * resolved empty, which is the one answer worth retrying.
 */
const VOICES_TIMEOUT_MS = 2000
let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null

function synth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
}

export function loadSystemVoices(): Promise<SpeechSynthesisVoice[]> {
  if (voicesPromise) return voicesPromise
  const s = synth()
  if (!s) return Promise.resolve([])
  const ready = s.getVoices()
  if (ready.length) {
    voicesPromise = Promise.resolve(ready)
    return voicesPromise
  }
  voicesPromise = new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      s.removeEventListener('voiceschanged', finish)
      resolve(s.getVoices())
    }
    timer = setTimeout(finish, VOICES_TIMEOUT_MS)
    s.addEventListener('voiceschanged', finish)
  }).then((list) => {
    // An empty answer is not knowledge — drop the cache so the next caller asks again.
    if (!list.length) voicesPromise = null
    return list
  })
  return voicesPromise
}

/** Forget the cached voice list (the preferences panel's refresh). */
export function forgetSystemVoices(): void {
  voicesPromise = null
}

/** One tier's voices, in the shared shape the pickers render. Never rejects. */
export async function listVoices(engine: SpeechEngine): Promise<SpeechVoice[]> {
  if (engine === 'kokoro') {
    try {
      return await window.eq.speechVoices()
    } catch {
      return []
    }
  }
  const voices = await loadSystemVoices()
  return voices.map((v) => ({
    id: voiceIdOf(v),
    label: v.name,
    engine: 'system' as const,
    ...(v.lang ? { lang: v.lang } : {})
  }))
}

// ------------------------------------------------------------------ the e2e / test hook

/**
 * One recorded utterance. `uttered` is the whole point: it says whether an engine was actually
 * reached, so the e2e spec can assert BOTH that the seam was invoked and that the e2e channel
 * stayed quiet — two claims one boolean would conflate.
 */
export interface SpokenRecord {
  text: string
  engine: SpeechEngine
  voiceId: string | null
  uttered: boolean
  ts: number
}

/** Bounded: this is a debugging/e2e window, never a log. */
const SPOKEN_CAP = 50

interface SpeechTestHook {
  spoken: SpokenRecord[]
}

function hook(): SpeechTestHook | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { __eqSpeech?: SpeechTestHook }
  w.__eqSpeech ??= { spoken: [] }
  return w.__eqSpeech
}

function record(entry: SpokenRecord): void {
  const h = hook()
  if (!h) return
  h.spoken.push(entry)
  if (h.spoken.length > SPOKEN_CAP) h.spoken.splice(0, h.spoken.length - SPOKEN_CAP)
}

/** True in the headless integration-test channel, where nothing may make a sound. */
function isE2E(): boolean {
  return typeof window !== 'undefined' && window.eq.isE2E
}

// ------------------------------------------------------------------ speaking

/** Extra knobs on one utterance. `gain` is the alerts module's own effective volume (§2). */
export interface SpeakOptions {
  /** per-alert voice override (`AlertSpeech.voiceId`); absent ⇒ the global default. */
  voiceId?: string
  /** 0..1 multiplier applied on top of `VoicePrefs.volume` — the alerts master × per-alert volume. */
  gain?: number
}

/** Warn once per session, not once per alert: a fallback is a state, not an event stream. */
let warnedFallback = false

function warnKokoroFallback(reason: string): void {
  if (warnedFallback) return
  warnedFallback = true
  // A DIAGNOSTIC, not an error: nothing failed for the user (they still hear their alert), so
  // this must not reach `reportError`/errors.log, which is the channel for things that broke.
  // `console.warn` is the tree's own convention for exactly that (main/errorLog.ts logWarn).
  // eslint-disable-next-line no-console
  console.warn(
    `[everquest-companion] voice: the downloaded speech engine is unavailable (${reason}) — ` +
      'speaking with the system voice instead.'
  )
}

/**
 * Say something. The ONE entry point; every caller in the app funnels through it.
 *
 * Resolves once the utterance has been HANDED to an engine, not when it finishes — an alert
 * must not make the firing path wait on speech synthesis.
 */
export async function speak(text: string, voicePrefs: VoicePrefs, opts: SpeakOptions = {}): Promise<void> {
  const said = text.trim()
  if (!said) return
  const voiceId = opts.voiceId ?? voicePrefs.voiceId
  const uttered = !isE2E()
  record({ text: said, engine: voicePrefs.engine, voiceId, uttered, ts: Date.now() })
  if (!uttered) return
  if (voicePrefs.engine === 'kokoro') {
    const ok = await sayThroughEngine(said, voicePrefs, opts)
    if (ok) return
    // Fall through: the downloaded tier is not there yet, and an alert that says nothing is
    // worse than one that says it in the wrong voice.
  }
  speakSystem(said, voicePrefs, opts)
}

/** The Kokoro tier: main synthesizes + caches and hands back a playable url. False ⇒ fall back. */
async function sayThroughEngine(
  text: string,
  voicePrefs: VoicePrefs,
  opts: SpeakOptions
): Promise<boolean> {
  let result: SpeechSayResult
  try {
    const voiceId = opts.voiceId ?? voicePrefs.voiceId
    result = await window.eq.speechSay({ text, ...(voiceId ? { voiceId } : {}) })
  } catch {
    warnKokoroFallback('the speech channel is unavailable')
    return false
  }
  if (!result.ok) {
    warnKokoroFallback(result.reason)
    return false
  }
  const audio = new Audio(result.url)
  audio.volume = clamp(voicePrefs.volume * (opts.gain ?? 1), 0, 1, 1)
  void audio.play().catch(() => undefined)
  return true
}

/** The system tier: Chromium's own synthesizer, right here in the renderer. */
function speakSystem(text: string, voicePrefs: VoicePrefs, opts: SpeakOptions): void {
  const s = synth()
  if (!s) return
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = clamp(voicePrefs.rate, MIN_SPEECH_RATE, MAX_SPEECH_RATE, DEFAULT_VOICE_PREFS.rate)
  utterance.volume = clamp(voicePrefs.volume * (opts.gain ?? 1), 0, 1, 1)
  // The voice list may still be loading on the very first alert of a session; in that case the
  // utterance goes out in the engine's default voice rather than waiting (an alert is late or
  // it is not an alert), and every later one gets the chosen voice.
  const voice = pickVoice(s.getVoices(), opts.voiceId ?? voicePrefs.voiceId)
  if (voice) {
    utterance.voice = voice
    if (voice.lang) utterance.lang = voice.lang
  }
  s.speak(utterance)
}
