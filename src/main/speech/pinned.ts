// pinned.ts — THE PINNED KOKORO RELEASE. Two URLs, two sha256s, and the voice roster.
//
// This is the whole "what do we download" decision, isolated in one data file so that
// changing the model version is a reviewable diff and nothing else in the tree has an
// opinion about upstream. It is the sound-pack precedent (AGENTS.md: the shipped default
// pack self-provisions "from its pinned registry tag"), applied to a 120 MB model.
//
// WHY A PINNED TAG AND NOT A BRANCH/`main`. A GitHub *release asset* under an immutable tag
// is the only upstream shape whose bytes cannot change under us. `resolve/main/...` on a
// model hub is a moving target: the maintainer re-uploads a re-quantized model, our sha256
// stops matching, and every user's install silently fails — or, worse, we don't check and
// they get different weights than we tested. The tag + the hash together mean the ONLY two
// outcomes are "exactly the bytes this wave was verified against" or "refuse and say so".
//
// WHY int8 AND NOT fp32/fp16. The full model is 325 MB, fp16 is 177 MB, int8 is 92 MB. This
// is a background alert reader saying "Mesmerization", not a narration engine: the int8
// quantization is inaudible at one-to-three-word utterances, and the download is a stranger's
// bandwidth (decision D4). 92 + 28 MB is already the single largest thing this app fetches.
//
// WHY THE VOICES ARE A SEPARATE FILE. Kokoro's voice identity is a per-token STYLE VECTOR,
// not a second model: `voices-v1.0.bin` is a numpy `.npz` holding 54 arrays of
// (510, 1, 256) float32 — one 256-float style vector per possible token count, per voice.
// It is data the model consumes, so it downloads and verifies exactly like the model does.
//
// MEASURED, NOT COPIED. Every number below was produced by downloading these two assets and
// hashing them during this wave (sizes are the `content-length` GitHub served; the sha256s
// are of the bytes on disk afterwards). The npz layout — 54 STORED (uncompressed) zip
// entries, ZIP64 headers, uniform 522,368-byte payloads — was verified by walking the real
// file, which is what `voicePack.ts` is written against.

import type { SpeechVoice } from '../../shared/types'

/** One file the Kokoro tier needs on disk. */
export interface PinnedAsset {
  /** File name inside `<userData>/speech/kokoro/`. Also the temp-file stem. */
  readonly name: string
  /** Immutable upstream URL (a GitHub release asset under a tag). */
  readonly url: string
  /** sha256 of the complete file, lowercase hex. A mismatch is a HARD failure. */
  readonly sha256: string
  /** Exact byte length. Used for progress + as a cheap pre-hash reject. */
  readonly bytes: number
}

/** The upstream release these assets come from — quoted so a reviewer can find it. */
export const KOKORO_RELEASE_TAG = 'model-files-v1.0'

/**
 * Kokoro-82M v1.0, int8-quantized ONNX. Apache-2.0 (the model) / MIT (kokoro-onnx, the
 * project that publishes these artifacts).
 */
export const KOKORO_MODEL: PinnedAsset = {
  name: 'kokoro-v1.0.int8.onnx',
  url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx',
  sha256: '6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb',
  bytes: 92_361_271
}

/** The 54-voice style-vector pack (`.npz`, stored entries — see voicePack.ts). */
export const KOKORO_VOICES_PACK: PinnedAsset = {
  name: 'voices-v1.0.bin',
  url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin',
  sha256: 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
  bytes: 28_214_398
}

/** Everything the tier needs, in download order (model first — it is the long one). */
export const KOKORO_ASSETS: readonly PinnedAsset[] = [KOKORO_MODEL, KOKORO_VOICES_PACK]

/** Total download, for the prefs UI's "before you download this" line. */
export const KOKORO_TOTAL_BYTES = KOKORO_ASSETS.reduce((n, a) => n + a.bytes, 0)

/** Kokoro emits 24 kHz mono. Not configurable — it is a property of the trained model. */
export const KOKORO_SAMPLE_RATE = 24_000

/**
 * The model's style table has 510 rows, indexed by TOKEN COUNT, so 509 phoneme tokens is the
 * hard ceiling. `MAX_SPEECH_CHARS` (120) makes that unreachable for real alert text — English
 * runs ~1.1 phonemes per character — but the tokenizer clamps anyway rather than trusting it.
 */
export const KOKORO_MAX_TOKENS = 509

// ---- the voice roster -----------------------------------------------------------------
//
// The pack holds 54 voices across 8 languages. We offer the 28 ENGLISH ones, and that is a
// deliberate limit, not an oversight: our phonemizer is espeak-ng (English rules), so a
// Japanese or Mandarin voice fed English-derived phonemes produces confident nonsense. The
// upstream project reaches those voices through language-specific G2P (misaki ja/zh) that we
// do not ship. World-model law 6 applied to a dependency: say what the pipeline can actually
// say. `listKokoroVoices` intersects THIS table with what the downloaded file really
// contains, so a future pack that drops a voice drops it from the picker too.
//
// `lang` decides which espeak dialect phonemizes the text for that voice — 'en-us' for the
// a-prefixed voices, 'en-gb' for the b-prefixed ones. Getting that pairing wrong is audible
// (an American style vector driving British phonemes slurs), so it lives with the voice.

interface KokoroVoiceRow {
  readonly id: string
  readonly label: string
  readonly lang: 'en-US' | 'en-GB'
}

const US = 'en-US'
const GB = 'en-GB'

/** The English voices, in the upstream's own quality order (best first within each group). */
export const KOKORO_VOICE_ROWS: readonly KokoroVoiceRow[] = [
  { id: 'af_heart', label: 'Heart (US, female)', lang: US },
  { id: 'af_bella', label: 'Bella (US, female)', lang: US },
  { id: 'af_nicole', label: 'Nicole (US, female)', lang: US },
  { id: 'af_aoede', label: 'Aoede (US, female)', lang: US },
  { id: 'af_kore', label: 'Kore (US, female)', lang: US },
  { id: 'af_sarah', label: 'Sarah (US, female)', lang: US },
  { id: 'af_nova', label: 'Nova (US, female)', lang: US },
  { id: 'af_sky', label: 'Sky (US, female)', lang: US },
  { id: 'af_alloy', label: 'Alloy (US, female)', lang: US },
  { id: 'af_jessica', label: 'Jessica (US, female)', lang: US },
  { id: 'af_river', label: 'River (US, female)', lang: US },
  { id: 'am_fenrir', label: 'Fenrir (US, male)', lang: US },
  { id: 'am_michael', label: 'Michael (US, male)', lang: US },
  { id: 'am_puck', label: 'Puck (US, male)', lang: US },
  { id: 'am_echo', label: 'Echo (US, male)', lang: US },
  { id: 'am_eric', label: 'Eric (US, male)', lang: US },
  { id: 'am_liam', label: 'Liam (US, male)', lang: US },
  { id: 'am_onyx', label: 'Onyx (US, male)', lang: US },
  { id: 'am_santa', label: 'Santa (US, male)', lang: US },
  { id: 'am_adam', label: 'Adam (US, male)', lang: US },
  { id: 'bf_emma', label: 'Emma (UK, female)', lang: GB },
  { id: 'bf_isabella', label: 'Isabella (UK, female)', lang: GB },
  { id: 'bf_alice', label: 'Alice (UK, female)', lang: GB },
  { id: 'bf_lily', label: 'Lily (UK, female)', lang: GB },
  { id: 'bm_fable', label: 'Fable (UK, male)', lang: GB },
  { id: 'bm_george', label: 'George (UK, male)', lang: GB },
  { id: 'bm_daniel', label: 'Daniel (UK, male)', lang: GB },
  { id: 'bm_lewis', label: 'Lewis (UK, male)', lang: GB }
]

/** The default voice when the user has expressed no preference — upstream's top-graded one. */
export const KOKORO_DEFAULT_VOICE = 'af_heart'

const ROWS_BY_ID = new Map(KOKORO_VOICE_ROWS.map((r) => [r.id, r]))

/** The espeak dialect a voice id wants, or null when the id is not one we offer. */
export function kokoroVoiceLang(id: string): 'en-US' | 'en-GB' | null {
  return ROWS_BY_ID.get(id)?.lang ?? null
}

/**
 * Turn the ids a downloaded pack actually contains into the picker's rows. Order follows the
 * curated table (quality order), not the pack's alphabetical layout, and anything the table
 * doesn't know is dropped — see the roster note above.
 */
export function kokoroVoicesFor(availableIds: ReadonlySet<string>): SpeechVoice[] {
  return KOKORO_VOICE_ROWS.filter((r) => availableIds.has(r.id)).map((r) => ({
    id: r.id,
    label: r.label,
    engine: 'kokoro' as const,
    lang: r.lang
  }))
}
