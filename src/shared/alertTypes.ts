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
}
export interface AlertsDelta {
  fired: FiredAlert[]
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
