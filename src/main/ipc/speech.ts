// IPC: voice alerts / text-to-speech (docs/plans/voice-alerts.md §3).
//
// WHAT SHIPS HERE, AND WHAT DELIBERATELY DOES NOT. Wave 1 is the model + content layer: the
// three engine channels below are HONEST STUBS. They are registered, typed, documented and
// validated exactly as the finished handlers will be, and they answer with a STATE rather than
// a lie or a rejection:
//
//   speech:say      → {ok:false, reason:'engine-not-installed'}
//   speech:voices   → []            (the downloaded tier has no voices until it is installed)
//   speech:install  → {ok:false, reason:'not-implemented'}
//
// That is the difference between a stub and a placeholder: `SpeechSayResult` is the shape wave 3
// will return, so the renderer written against it today keeps working when the engine lands, and
// a UI that says "not installed" is telling the truth about this build instead of failing
// silently. Nothing here downloads, spawns a worker, or touches the filesystem.
//
// WHY THE 'system' TIER IS ABSENT. Chromium's `speechSynthesis` lives in the renderer; routing
// it through main would add a hop and a serialization boundary for nothing. Only the downloaded
// Kokoro tier needs main (a worker thread, a pinned model, a wav cache, a protocol handler), and
// only that tier is what these channels are for.
//
// THE PREFS PAIR IS REAL. `voicePrefs:get`/`set` are not stubs: electron-store is main-owned, so
// this is the Preferences panel's only door to §2's blob. Both sides normalize through the ONE
// shared normalizer (`normalizeVoicePrefs`), which is also what schema migration 3→4 runs — the
// file, the read and the write cannot disagree about what a legal value is.
//
// VALIDATED AT THE HANDLER (AGENTS.md trust boundary). Every argument below is a renderer value
// and is checked here, not trusted because today's only caller is the app's own UI:
//   * `speech:say`'s text     — non-empty string, capped at MAX_SPEECH_CHARS. It becomes part of
//                               a cache key (`sha256(voiceId + '\0' + text)`) and, in wave 3, a
//                               file name in `<userData>/speech-cache/`.
//   * `speech:say`'s voiceId  — optional string, bounded. Same cache-key reasoning.
//   * `speech:install`'s arg  — must be a member of the closed SPEECH_ENGINES set. An unknown
//                               engine never reaches a provisioning path, today or later.
//   * `voicePrefs:set`'s arg  — clamped field by field; anything unrecognized becomes the
//                               documented default rather than being written back verbatim.
// A rejected payload answers `{ok:false, reason:'invalid-request'}` — never a thrown rejection
// the caller has to catch, and never a silent success.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { MAX_SPEECH_CHARS, SPEECH_ENGINES, normalizeVoicePrefs } from '../../shared/speechText'
import { getVoicePrefs, setVoicePrefs } from '../store'
import type {
  SpeechInstallResult,
  SpeechSayResult,
  SpeechVoice,
  VoicePrefs
} from '../../shared/types'

/** Longest voice id this app will accept from the renderer. SAPI voice URIs are the long ones
 *  (`urn:moz-tts:sapi:Microsoft David - English (United States)?en-US`) and sit far inside this. */
const MAX_VOICE_ID_CHARS = 256

/** The `speech:say` payload, once it has been proven to be one. */
interface ValidSayRequest {
  text: string
  voiceId?: string
}

/** Narrow an arbitrary renderer value to a say request, or null when it is not one. */
function validateSayRequest(raw: unknown): ValidSayRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { text, voiceId } = raw as { text?: unknown; voiceId?: unknown }
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_SPEECH_CHARS) return null
  if (voiceId === undefined) return { text: trimmed }
  if (typeof voiceId !== 'string' || voiceId.length > MAX_VOICE_ID_CHARS) return null
  return { text: trimmed, voiceId }
}

export function registerSpeechIpc(): void {
  ipcMain.handle(IPC.speechSay, (_e, raw: unknown): SpeechSayResult => {
    const request = validateSayRequest(raw)
    if (!request) return { ok: false, reason: 'invalid-request' }
    // WAVE 3 fills this in: cache lookup on sha256(voiceId + '\0' + text) → worker synth →
    // atomic write → `{ok:true, url:'eqspeech://<hash>'}`. Until then the answer is the truth
    // about this build, and the UI renders an "install the voice engine" state from it.
    return { ok: false, reason: 'engine-not-installed' }
  })

  ipcMain.handle(IPC.speechVoices, (): SpeechVoice[] => {
    // The downloaded tier ships no voices until it is provisioned; an empty list is not an
    // error, it is the accurate inventory. System-tier voices come from the renderer's own
    // `speechSynthesis.getVoices()` and never appear here.
    return []
  })

  ipcMain.handle(IPC.speechInstall, (_e, engine: unknown): SpeechInstallResult => {
    if (typeof engine !== 'string' || !(SPEECH_ENGINES as readonly string[]).includes(engine)) {
      return { ok: false, reason: 'invalid-request' }
    }
    return { ok: false, reason: 'not-implemented' }
  })

  ipcMain.handle(IPC.voicePrefsGet, (): VoicePrefs => getVoicePrefs())

  ipcMain.handle(IPC.voicePrefsSet, (_e, prefs: unknown): VoicePrefs => {
    // Normalized HERE (the trust boundary) so `setVoicePrefs` keeps a typed signature for
    // main-side callers, and again inside it — the function is idempotent, and an unparseable
    // payload writes the documented defaults rather than rejecting. The setter's contract is
    // "the store now holds something legal", which is always satisfiable.
    return setVoicePrefs(normalizeVoicePrefs(prefs))
  })
}
