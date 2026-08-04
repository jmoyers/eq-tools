// alertTypes.ts — the ALERTS half of the shared type surface: what an alert IS (trigger →
// sound), what it records when it fires, and the sound packs (local, registry, preview) its
// `sound` points at.
//
// Split out of types.ts, which had grown past the 400-code-line factoring ceiling. The section
// text is UNCHANGED and every name here is still exported from `shared/types` (which
// re-exports this module), so no importer moved and no import path changed.

// ----- Alerts extension (Task #18) -----
//
// An alert = a trigger (matched against the live LogEvent stream, a raw log line,
// or a renderer-side app signal) → a sound to play. Definitions are stored in
// electron-store (main-owned) and served over IPC. The shape is deliberately
// JSON-serializable and flat enough that a future agent can author one from a
// sentence ("alert me on charm breaks") by writing a def via alerts:save.

/** The kinds a LogEvent can carry — mirrors the `kind` discriminants in logEvents.ts. */
export type LogEventKind =
  | 'zone'
  | 'loot'
  | 'offer'
  | 'trade'
  | 'level'
  | 'aaGain'
  | 'aaSpend'
  | 'death'
  | 'damage'
  | 'heal'
  | 'mitigation'
  | 'miss'
  | 'resist'
  | 'charm'
  | 'uncharm'
  | 'cc'
  | 'petClaim'
  | 'castBegin'
  | 'castFizzle'
  | 'castInterrupted'
  | 'buffFade'
  | 'playerDeath'
  | 'spellEmote'
  | 'buffApply'
  | 'buffWearOff'
  | 'aaActivate'
  | 'illusionFade'
  | 'buffExpired'
  | 'epoch'
  | 'stanceChange'
  | 'invocationChange'
  | 'consider'
  // ROGUE POISONS (docs/plans/poison-slow-alerts.md §1). The parser has emitted these three
  // families since Task #64 and the matcher has always been a plain string compare on `kind`
  // — this curated allowlist was the ONLY thing gating them out of the editor and out of a
  // group def. `poisonProc` carries `{strike, candidates, effect, target}` (so
  // `where:{effect:'slow'}` is the rogue slow landing), `poisonCoat` `{poison, group, who}`,
  // `poisonDry` `{group}`.
  | 'poisonProc'
  | 'poisonCoat'
  | 'poisonDry'
  | 'unknown'

/** Renderer-side app signals an alert can fire on (evaluated in the player, not main). */
export type AppSignal = 'bossDefeat' | 'questComplete'

/**
 * A PRIMITIVE alert trigger — the three original shapes:
 *  - event: match a typed LogEvent by `kind`, with optional field matchers. Each
 *    matcher value is either an exact string (case-insensitive equality on the
 *    stringified field) OR a `/regex/` string (slashes delimit → tested as a
 *    case-insensitive RegExp against the stringified field). For a `target` field,
 *    the convention is `where:{target:'self'}` matches only the player-side expiry
 *    and OMITTING target matches any (self OR another entity) — Task #47.
 *  - raw:   match the raw log line with a case-insensitive regex.
 *  - app:   a renderer-side signal (e.g. bossDefeat). Main stores/serves these but
 *           never evaluates them; the always-mounted player fires them.
 */
export type AlertTriggerPrimitive =
  | { type: 'event'; kind: LogEventKind; where?: Record<string, string> }
  | { type: 'raw'; regex: string }
  | { type: 'app'; signal: AppSignal }

/**
 * A COMPOSITE trigger (Task #47) — combine primitive conditions with OR/AND:
 *  - type 'any': fires when ANY condition matches a single incoming event (OR).
 *  - type 'all': fires only when ALL conditions match THE SAME event (AND).
 *
 * SEMANTICS (documented, deliberately narrow): 'all' is same-event correlation only —
 * every condition must match the ONE incoming event. Cross-event correlation windows
 * (e.g. "buff X faded AND boss Y is up") are OUT OF SCOPE. Conditions are the primitive
 * shapes above; nesting is not supported (depth 1), which keeps evaluation O(conditions)
 * per event and the storage flat & JSON-serializable. Cooldown applies at the ALERT
 * level as today (a composite fires at most once per cooldown, not per matching condition).
 *
 * 'app' conditions inside a composite are ignored by the main-side matcher (they depend on
 * renderer-derived boss state); compose event/raw conditions for main-side alerts.
 */
export interface AlertTriggerComposite {
  type: 'any' | 'all'
  conditions: AlertTriggerPrimitive[]
}

/** An alert trigger: a primitive shape or an any/all composite (Task #47). */
export type AlertTrigger = AlertTriggerPrimitive | AlertTriggerComposite

/** Which sound a fired alert plays: a pack id + a sound id within that pack. */
export interface AlertSoundRef {
  packId: string
  soundId: string
}

// ----- Voice alerts (docs/plans/voice-alerts.md §1) -----
//
// An alert can SPEAK as well as (or instead of) play a sound. Everything below is the
// CONTENT model — what is said and by which voice. The engine plumbing (system
// speechSynthesis vs the Kokoro tier) is deliberately absent from these shapes: a def
// names a mode and, optionally, a voice, and nothing else. The runtime constants that go
// with these types (the mode list, the char cap, the pref defaults) live beside the
// resolver in `shared/speechText.ts`, which is the one module both sides already import.

/**
 * WHAT an alert says when it speaks.
 *  - 'custom'         → the def's own `phrase`, verbatim.
 *  - 'alertName'      → the alert's display name. Also the universal FALLBACK: a spell mode
 *                       on a firing that carries no spell resolves here rather than to
 *                       silence or to a guess (world-model law 1).
 *  - 'spellName'      → the triggering spell's display name, RANK-STRIPPED ("Mesmerization
 *                       III" → "Mesmerization"). Roman numerals are noise aloud.
 *  - 'spellFirstWord' → the first word of that rank-stripped name ("Swift Like the Wind" →
 *                       "Swift"). The owner's headline ask: the shortest useful utterance.
 */
export type SpeechMode = 'custom' | 'alertName' | 'spellName' | 'spellFirstWord'

/**
 * WHICH audio channel a fired alert uses (decision D5). Absent ⇒ 'sound', which is exactly
 * what every alert written before voice alerts existed meant — so the field is optional and
 * no migration has to touch a def that never asked to speak.
 * 'both' plays the sound first and queues the speech after it; cooldowns are unchanged.
 */
export type AlertAudio = 'sound' | 'speech' | 'both'

/** Per-alert speech configuration. Absent on a def ⇒ treated as `{ mode: 'alertName' }`. */
export interface AlertSpeech {
  mode: SpeechMode
  /** Required iff mode === 'custom'; capped at MAX_SPEECH_CHARS (shared/speechText.ts). */
  phrase?: string
  /** Voice override for this alert; absent ⇒ the global default voice (VoicePrefs.voiceId). */
  voiceId?: string
}

/**
 * The two engine tiers (decision D1). 'system' is Chromium's own `speechSynthesis` (Windows
 * SAPI voices — zero download, instant); 'kokoro' is the downloaded Kokoro-82M ONNX tier.
 * Chatterbox is a NAMED SEAM, deliberately not a member.
 */
export type SpeechEngine = 'system' | 'kokoro'

/** Global voice preferences (main-owned, persisted under the store's `voice` key). */
export interface VoicePrefs {
  /** Master switch. Off by default — an unasked-for feature never speaks. */
  enabled: boolean
  engine: SpeechEngine
  /** Default voice id within the chosen engine; null = "whatever the engine defaults to". */
  voiceId: string | null
  /** Speaking rate multiplier, 0.5–2. */
  rate: number
  /** 0..1, applied on top of the alerts module's own master volume. */
  volume: number
}

/** One voice a tier can speak with, as surfaced to the renderer by `speech:voices`. */
export interface SpeechVoice {
  /** engine-scoped id (a SAPI voice URI, or a Kokoro voice name). */
  id: string
  /** human label for the picker. */
  label: string
  engine: SpeechEngine
  /** BCP-47 tag when the engine states one ('en-US'); absent when it does not. */
  lang?: string
}

/**
 * Why a speech request could not be served. These are STATES, not errors — the UI says
 * what is missing instead of failing silently:
 *  - 'engine-not-installed' → the selected tier has no model/voices on disk yet.
 *  - 'not-implemented'      → this build ships the channel but not the engine behind it.
 *  - 'disabled'             → voice is switched off in preferences.
 *  - 'invalid-request'      → the handler rejected the payload (see ipc/speech.ts).
 */
export type SpeechUnavailableReason =
  | 'engine-not-installed'
  | 'not-implemented'
  | 'disabled'
  | 'invalid-request'

/** Args of `speech:say` — re-validated at the handler, never trusted. */
export interface SpeechSayRequest {
  /** the resolved utterance (see `speechTextFor`), already capped by the caller. */
  text: string
  /** voice override; absent ⇒ VoicePrefs.voiceId. */
  voiceId?: string
}

/**
 * Reply of `speech:say`. On success `url` is a playable source the renderer hands to its
 * existing alert audio element (W3 serves `eqspeech://<hash>` from the wav cache).
 */
export type SpeechSayResult =
  | { ok: true; url: string }
  | { ok: false; reason: SpeechUnavailableReason }

/** Reply of `speech:install` — provisioning a downloadable engine tier. */
export type SpeechInstallResult =
  | { ok: true }
  | { ok: false; reason: SpeechUnavailableReason; message?: string }

/**
 * WHERE A RUNNING INSTALL IS (W3). `speech:install` resolves only when provisioning has
 * FINISHED — a ~120 MB download — so the panel that started it needs a second channel to say
 * anything meanwhile. These land on `speech:installProgress` (main → renderer, broadcast to
 * the main window) while that one invoke is outstanding.
 *
 * The phases are STATES the UI renders, not log lines:
 *  - 'checking'    → deciding what is already on disk (a re-run of a finished install spends
 *                    its whole life here and then reports 'done').
 *  - 'downloading' → bytes are moving; `received`/`total` are the WHOLE install, so a single
 *                    progress bar is correct across both assets.
 *  - 'verifying'   → the file is complete and its sha256 is being checked. Deliberately its
 *                    own phase: it takes a visible second on 92 MB and a bar that sat at 100%
 *                    in silence reads as a hang.
 *  - 'done' / 'failed' → terminal, and always sent exactly once (the same verdict the
 *                    `speech:install` reply carries — this channel never disagrees with it).
 */
export interface SpeechInstallProgress {
  engine: SpeechEngine
  phase: 'checking' | 'downloading' | 'verifying' | 'done' | 'failed'
  /** File currently being worked on, when one is ('kokoro-v1.0.int8.onnx'). */
  asset?: string
  /** Bytes secured across the whole install so far. */
  received: number
  /** Total bytes the install will move (0 while unknown). */
  total: number
  /** Human-readable detail for a 'failed' phase. Never shown for the others. */
  message?: string
}

/** A single alert definition (persisted, JSON-serializable). */
export interface AlertDef {
  id: string
  name: string
  enabled: boolean
  trigger: AlertTrigger
  sound: AlertSoundRef
  /** 0..1, multiplied by the global volume. Defaults to 1. */
  volume?: number
  /** Minimum ms between two fires of this alert. Defaults to 2000. */
  cooldownMs?: number
  /** Freeform provenance note (e.g. "authored by agent from: alert me on charm breaks"). */
  note?: string
  /**
   * Which audio channel this alert uses (D5). Absent ⇒ 'sound' — the meaning every def
   * written before voice alerts already had, which is why this is additive and optional.
   */
  audio?: AlertAudio
  /** What to say when `audio` includes speech. Absent ⇒ `{ mode: 'alertName' }`. */
  speech?: AlertSpeech
  /**
   * OPT OUT of cross-alert audio coalescing (renderer/features/alerts/audioThrottle.ts).
   *
   * By default every alert's audio is throttled ACROSS alerts — three buffs fading at once is
   * one audio alert, not three — because a smear of simultaneous sounds carries less than one.
   * `true` marks an alert that must never be swallowed by that window (a charm break, a raid
   * call): it always plays, and it does not itself occupy the window. Absent ⇒ throttled,
   * which is the default the owner asked for and the meaning every def written before this
   * existed already had — so it needs no store migration (readers default; electron-store
   * round-trips the key untouched).
   */
  alwaysPlay?: boolean
}

/** Global sound preferences (main-owned, persisted). */
export interface AlertPrefs {
  /** 0..1 master volume applied on top of each alert's own volume. */
  globalVolume: number
  /** When true, no alert sounds play (the player still receives deltas). */
  muted: boolean
}

/** One alert that fired, carried in the alerts module delta. */
export interface FiredAlert {
  alertId: string
  ts: number
  /** The text that matched (raw line for raw/event triggers), for debugging/UI. */
  matchedText: string
  /**
   * SPELL CONTEXT for the speech modes (docs/plans/voice-alerts.md §1) — the triggering
   * spell's DISPLAY name with its rank suffix INTACT ("Mesmerization III"), exactly as the
   * log spelled it. Rank-stripping is the resolver's job (`speechTextFor`), not the
   * producer's: a consumer that wants the rank must still be able to see it.
   *
   * ABSENT whenever the matched event names no spell — most of the event families, every
   * 'raw' trigger that matched a spell-less line, and every renderer-evaluated 'app' signal
   * (bossDefeat / questComplete). Which families DO carry one is enumerated in
   * `SPELL_FIELD_BY_KIND` (main/modules/alerts.ts). Never synthesized, never guessed.
   */
  spell?: string
}

/** One recorded fire in an alert's recent-fires ring buffer (Task #22). */
export interface AlertFireRecord {
  ts: number
  /** The matched log line (event/raw) or the app-signal context (e.g. boss name). */
  matchedText: string
}

/**
 * alerts module snapshot. `defs` are the alert definitions; `history` is a
 * per-alert ring buffer of recent fires (last ~20, newest last) — the single
 * source of truth for the "recent fires" UI, fed by BOTH main-side event/raw
 * fires and renderer-routed app fires (alerts:appFired). Keyed by alert id.
 */
export interface AlertsSnap {
  defs: AlertDef[]
  history: Record<string, AlertFireRecord[]>
  /**
   * RANK-PRESERVING cast recency (spell levelling intelligence): spell DISPLAY name with its
   * roman-numeral rank intact ("Mesmerization III") → the newest ts you began casting it.
   *
   * The buffs model's per-spell `lastSeenMs` is keyed by `spellCanonKey`, which STRIPS the
   * rank, so it cannot say which rank you are on; `castBegin` is the only event family that
   * keeps the suffix. Populated during replay as well as live, so it is complete at hydration.
   * Optional — a snapshot from a build before this existed simply has no ranks to offer.
   */
  spellLastCast?: Record<string, number>
  /**
   * ROGUE SLOW POISONS OBSERVED (docs/plans/poison-slow-alerts.md §1.3) — what the
   * "alert when a mob gets slowed?" offer is built on.
   *
   * Recorded exactly as `spellLastCast` is: on REPLAY as well as live, so the offer is
   * complete the moment the renderer hydrates rather than waiting for the next proc, and it
   * rides the alerts snapshot/delta that already flow over useModule (zero new IPC).
   *
   * Absent when no `poisonProc { effect: 'slow' }` has ever been seen — which is the honest
   * encoding of "this character is not fighting beside a rogue", and the state in which no
   * offer is made.
   */
  poisonSlowSeen?: PoisonSlowRecency
}

/**
 * Recency of the rogue slow proc (`<mob>'s limbs move slower!` → `poisonProc`, effect 'slow').
 * A count and a last sighting, nothing derived: the offer says "N slows landed", never a rate.
 */
export interface PoisonSlowRecency {
  /** newest ts (ms) a slow landing was observed. */
  lastAt: number
  /** how many have been observed for this character (replay + live). */
  count: number
  /** RAW display name of the mob the newest one landed on (canonicalize with idKey). */
  lastTarget: string
}
/** One rank-preserving cast observed since the last flush. */
export interface SpellCastRecency {
  /** display name, rank suffix intact. */
  spell: string
  ts: number
}
export interface AlertsDelta {
  fired: FiredAlert[]
  /** cast-recency entries that advanced since the last flush; merge by `spell`. */
  cast?: SpellCastRecency[]
  /**
   * The slow-proc recency AS OF THIS FLUSH (absolute, not an increment) — present only when a
   * slow landed since the last one. Absolute because the record is a running total the module
   * already owns; merging a delta of counts would drift if a delta were ever dropped.
   */
  poisonSlow?: PoisonSlowRecency
}

/** A discovered sound within a pack manifest. */
export interface PackSound {
  /** relative file name inside the pack dir (e.g. "victory.wav") */
  file: string
  /** human label shown in the sound picker */
  label: string
}

/** A sound pack manifest ({ id, name, sounds }). */
export interface SoundPackManifest {
  id: string
  name: string
  sounds: Record<string, PackSound>
  /** SPDX-ish license string copied from the pack's source manifest, when declared. */
  license?: string
}

/** A pack as surfaced to the renderer (manifest + where it came from). */
export interface SoundPack extends SoundPackManifest {
  /** 'bundled' (shipped default) or 'user' (dropped into <userData>/soundpacks). */
  source: 'bundled' | 'user'
}

/** Reply of sounds:getData — audio bytes as base64 so the renderer builds a Blob URL. */
export interface SoundData {
  mime: string
  dataBase64: string
}

// ----- Sound-pack registry (openpeon.com integration, Task #29) -----
//
// The openpeon.com registry (https://peonping.github.io/registry/index.json) lists
// community sound packs. We surface it in-app: browse → install (download the pack's
// GitHub release tarball, convert its CESP openpeon.json into our manifest.json,
// write into <userData>/soundpacks/<name>/) → the pack appears in the sound pickers
// immediately. Bundled packs are never in this registry list.

/** One pack as listed in the registry index (subset of fields we use). */
export interface RegistryPack {
  /** stable pack name (also the install dir name + our manifest id). */
  name: string
  display_name: string
  /** "Owner/Repo" the release tarball is fetched from. */
  source_repo: string
  /** git tag of the release (e.g. "v1.0.1"). */
  source_ref: string
  /** subdir within the extracted archive that is the pack root ("." for repo root). */
  source_path: string
  categories: string[]
  sound_count: number
  total_size_bytes: number
  description?: string
  license?: string
  version?: string
}

/** A registry pack annotated with whether it's already installed locally. */
export interface RegistryPackView extends RegistryPack {
  installed: boolean
}

/** Reply of packs:registry — the reconciled list plus a soft error (offline, etc.). */
export interface RegistryListResult {
  packs: RegistryPackView[]
  /** present when the live index couldn't be fetched (cached/empty list returned). */
  error?: string
  /** true when the list came from the on-disk/in-memory cache, not a live fetch. */
  fromCache?: boolean
}

/** Progress push over `packs:progress` while a pack installs. */
export interface PackInstallProgress {
  name: string
  phase: 'downloading' | 'extracting' | 'converting' | 'done' | 'error'
  /** 0..100 during downloading, when a content-length is known. */
  percent?: number
  message?: string
}

/** Reply of packs:install / packs:uninstall. */
export interface PackMutationResult {
  ok: boolean
  error?: string
}

// ----- Registry pack PREVIEW (Task #31) -----
//
// Before installing, the registry browser can preview a pack's sounds: fetch the
// pack's CESP openpeon.json off GitHub raw, list its sounds, and stream a single
// audio file's bytes on demand — all without writing anything to disk.

/** One previewable sound within an un-installed registry pack. */
export interface PackPreviewSound {
  /** stable id derived the same way an install would (category + basename). */
  soundId: string
  /** human label (category prefix + CESP label), matching the installed picker. */
  label: string
  /** the source-relative audio path (e.g. "sounds/ab_add_player_01.mp3"). */
  file: string
}

/** Reply of packs:previewList — a pack's sounds without installing it. */
export interface PackPreviewList {
  sounds: PackPreviewSound[]
  /** present when the manifest couldn't be fetched/parsed. */
  error?: string
}
