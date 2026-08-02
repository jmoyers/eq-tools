// Types shared across the main process, preload bridge, and renderer.

/** One EverQuest character whose log we watch. */
export interface CharacterRef {
  name: string
  server: string
  logPath: string
  /** log file mtime (ms) — used as "last played" */
  lastPlayed?: number
}

/** A single parsed log line. */
export interface LogLine {
  /** epoch millis from the bracketed timestamp */
  ts: number
  /** the message text after the timestamp */
  text: string
  /** raw line as read from disk */
  raw: string
}

/** A loot event detected in the log ("You have looted a X from <mob>'s corpse"). */
export interface LootEvent {
  ts: number
  item: string
  /** mob the item was looted from, if present */
  source?: string
  /** zone the character was in when it was looted */
  zone?: string
}

/** A completed NPC trade / quest turn-in ("You offered … / complete the trade"). */
export interface TurnInEvent {
  ts: number
  npc: string
  items: string[]
}

/** A level-up ("You have gained a level! Welcome to level N!"). */
export interface LevelEvent {
  ts: number
  level: number
}

/** An AA/ability-point gain ("You have gained N ability point(s)! You now have M"). */
export interface AAEvent {
  ts: number
  /** points gained by this event */
  amount: number
  /** unspent points the game reports after the gain */
  nowHave: number
}

/** An AA purchase ("You have gained the ability X at a cost of N ability points"). */
export interface AASpendEvent {
  ts: number
  /** ability name, including the trailing rank when present (e.g. "Mnemonic Retention 5") */
  ability: string
  cost: number
  /** the rank number when the line is the "You have improved <name> <rank>" form */
  rank?: number
}

/** Aggregated kill info for a mob (for loot sourcing + boss instance tiers). */
export interface KillInfo {
  count: number
  /** highest instance difficulty tier the mob was killed at (0=base … 4=Refined) */
  bestTier: number
  /** first time this mob was killed (ms) */
  firstTs: number
  lastTs: number
  /**
   * Human-readable display name (original casing/article of the first-seen slain
   * line). The KillMap is KEYED by the canonical lowercase name so that
   * sentence-start "A thunder spirit princess" (slain-by lines) and mid-sentence
   * "a thunder spirit princess" (You-have-slain lines) fold into one entry.
   */
  display: string
}

/** Kill info keyed by CANONICAL (lowercase) mob name; see KillInfo.display. */
export type KillMap = Record<string, KillInfo>

// ----- Plane of Sky quest data (produced by scripts/scrape-posky.ts) -----

export interface PoskyItem {
  /** required turn-in item name */
  name: string
  /** mobs/NPCs known to drop it */
  who: string[]
  /** island / location string from the wiki */
  where: string
  /** how many are needed (defaults to 1) */
  count: number
  /** wiki page title for the item (for linking) */
  page?: string
  /** EQ-style stat block text (name/flags/slot/stats), for the hover popover */
  stats?: string
}

export interface PoskyQuest {
  /** class this quest unlocks / belongs to, e.g. "Paladin" */
  className: string
  /** quest name, e.g. "Test of Sacrifice" */
  name: string
  /** quest-giver NPC, if known */
  giver?: string
  /** required wind rune, if listed */
  rune?: string
  /** reward item name */
  reward?: string
  /** reward item stat blob (EQ-style text) */
  rewardStats?: string
  /** wiki page title for the reward item */
  rewardPage?: string
  /** required turn-in items */
  items: PoskyItem[]
  /** source wiki page title */
  source: string
}

export interface PoskyData {
  scrapedAt: string
  quests: PoskyQuest[]
}

// ----- Raid targets (bosses) -----

export interface RaidTarget {
  /** display name */
  name: string
  /** grouping, e.g. "Plane of Hate", "Dragons", "Gods & Avatars" */
  category: string
  /** exact in-log "slain" names to match against kills */
  match: string[]
  /** hotlinked wiki image URL */
  image?: string
  /** home zone / instance */
  zone?: string
}

export interface BossData {
  scrapedAt: string
  targets: RaidTarget[]
}

// ----- Module transport payloads (see main/modules/*) -----
//
// Each built-in module has a Snap (full hydration state) and a Delta (the
// increment applied by useModule). Kept here because preload + renderer both
// need them and shared/types.ts is the one place all three layers import from.

/** Payload of the generic `module:delta` push. */
export interface ModuleDelta<Delta = unknown> {
  moduleId: string
  seq: number
  delta: Delta
}

/** Payload of the generic `module:getSnapshot` reply. */
export interface ModuleSnapshot<Snap = unknown> {
  seq: number
  state: Snap
}

/** loot module. Delta = loot rows appended since the last flush. */
export type LootSnap = LootEvent[]
export type LootDelta = { appended: LootEvent[] }

/** turnins module. Delta = turn-ins appended since the last flush. */
export type TurnInSnap = TurnInEvent[]
export type TurnInDelta = { appended: TurnInEvent[] }

/** kills module. Delta = the per-mob KillInfo entries that changed. */
export type KillsSnap = KillMap
export type KillsDelta = { changed: KillMap }

/** leveling module: levels + AA gains + AA spends. */
export interface LevelingSnap {
  levels: LevelEvent[]
  aaGains: AAEvent[]
  aaSpends: AASpendEvent[]
}
export interface LevelingDelta {
  levels: LevelEvent[]
  aaGains: AAEvent[]
  aaSpends: AASpendEvent[]
}

/** character module: current character + zone. */
export interface CharacterSnap {
  character: CharacterRef | null
  zone?: string
}
export type CharacterDelta = Partial<CharacterSnap>

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
  | 'miss'
  | 'charm'
  | 'uncharm'
  | 'petClaim'
  | 'castBegin'
  | 'castFizzle'
  | 'castInterrupted'
  | 'buffFade'
  | 'playerDeath'
  | 'spellEmote'
  | 'unknown'

/** Renderer-side app signals an alert can fire on (evaluated in the player, not main). */
export type AppSignal = 'bossDefeat'

/**
 * An alert trigger. Three shapes:
 *  - event: match a typed LogEvent by `kind`, with optional field matchers. Each
 *    matcher value is either an exact string (case-insensitive equality on the
 *    stringified field) OR a `/regex/` string (slashes delimit → tested as a
 *    case-insensitive RegExp against the stringified field).
 *  - raw:   match the raw log line with a case-insensitive regex.
 *  - app:   a renderer-side signal (e.g. bossDefeat). Main stores/serves these but
 *           never evaluates them; the always-mounted player fires them.
 */
export type AlertTrigger =
  | { type: 'event'; kind: LogEventKind; where?: Record<string, string> }
  | { type: 'raw'; regex: string }
  | { type: 'app'; signal: AppSignal }

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
export type AlertsSnap = { defs: AlertDef[]; history: Record<string, AlertFireRecord[]> }
export type AlertsDelta = { fired: FiredAlert[] }

// ----- Buffs extension (Task #19) -----
//
// A log-mined buff-duration model. The player's own casts are tracked as a small
// state machine: `You begin casting <S>` → pending; a fizzle/interrupt/new-cast
// clears it; otherwise the cast is treated as LANDED (see BuffsModule for the
// approximation). Each landed cast is paired with the NEXT worn-off of the same
// spell to yield a duration sample; per-spell samples become median/IQR stats,
// which drive an estimated-remaining bar for currently-active buffs.
//
// Scope (v1): only spells that have EVER produced a self/pet buffFade in history
// are treated as buffs — nukes/mez/charm get cast lines too but never self-fade,
// so that fade is the honest discriminator. Durations are mined from the player's
// own buffs (self and pet-targeted; in this Enchanter's log the pet is the main
// buff target — see logEvents.ts BuffFadeEvent).

/**
 * The class a spell is shown under (Task #32 entity model):
 *   'self'   — a buff on the player.
 *   'pet'    — a buff on the player's summoned/charmed pet.
 *   'debuff' — cast on a HOSTILE mob (e.g. Languid Pace slow). Never shown as self.
 * Classified per spell by the disposition of its observed fades; a spell that has EVER
 * faded on a hostile entity is a debuff.
 */
export type BuffClass = 'self' | 'pet' | 'debuff'

/** Per-spell mined duration statistics (milliseconds). */
export interface BuffStat {
  /** spell name (display casing of the first observed cast/fade). */
  spell: string
  /** display class — self buff / pet buff / debuff (Task #32). */
  cls: BuffClass
  /** number of duration samples (landed→fade pairs). */
  n: number
  /** median duration (ms); null when n === 0 (spell seen fading but never cleanly paired). */
  medianMs: number | null
  /** 25th percentile duration (ms), null when n === 0. */
  p25: number | null
  /** 75th percentile duration (ms), null when n === 0. */
  p75: number | null
  /** min / max sample (ms), null when n === 0. */
  minMs: number | null
  maxMs: number | null
}

/** A currently-active (landed, not yet faded) buff. */
export interface ActiveBuff {
  spell: string
  /** display class — self buff / pet buff / debuff (Task #32). */
  cls: BuffClass
  /**
   * The bound entity disposition (Task #32): 'self' | 'summoned' | 'charmed' |
   * 'hostile'. Undefined only for a provisional entry cast before any fade classified
   * the spell. Drives which group the row renders under and the target chip.
   */
  disposition?: 'self' | 'summoned' | 'charmed' | 'hostile'
  /** ts (ms) the cast landed / was last refreshed. */
  startedTs: number
  /** estimated duration from mined median (ms); null when no samples yet. */
  estimatedMs: number | null
  /** p25/p75 spread (ms) for the ± hint; null when no samples. */
  p25: number | null
  p75: number | null
  /** sample count behind the estimate (confidence hint). */
  n: number
  /** 'pet'/pet name for a pet buff, the inferred mob name for a debuff, undefined for self. */
  target?: string
  /**
   * True when `target` is an INFERENCE, not fact (Task #32): a debuff's active target
   * is inferred from the pet's current fight target because castBegin carries no
   * target. The UI must present this as "target: inferred", never as a silent guess.
   */
  inferredTarget?: boolean
  /**
   * True while this is an OPTIMISTIC (not-yet-confirmed) landing (Task #30): shown
   * the instant `castBegin` fires so a buff is visible immediately, before the 15s
   * land timeout / next-cast / fade confirms it. A fizzle/interrupt retracts a
   * provisional entry; confirmation clears the flag. The UI dims provisional rows
   * and shows a subtle "casting…" hint.
   */
  provisional?: boolean
}

/** buffs module snapshot: live active buffs + mined per-spell stats. */
export interface BuffsSnap {
  active: ActiveBuff[]
  stats: Record<string, BuffStat>
}
/** buffs module delta: the module ships a full snapshot each flush (small state). */
export type BuffsDelta = BuffsSnap

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

/** Held-item counts keyed by lowercased item name. */
export type HeldCounts = Record<string, number>

/**
 * How the app decides which items you "have":
 * - 'log'       : count everything the character has ever looted (log parsing)
 * - 'inventory' : count only what's in the latest /outputfile inventory dump
 * - 'both'      : the higher of the two per item
 */
export type CountSource = 'log' | 'inventory' | 'both'

/** Persisted user progress (inventory + quest completion). */
export interface ProgressState {
  /** counts from the last inventory dump, keyed lowercased name */
  inventory: HeldCounts
  /** quest keys (className::name) the user marked complete/turned-in */
  completedQuests: string[]
  /** metadata about the last inventory load */
  inventorySource?: { path: string; loadedAt: string }
}

// ----- Auto-update (Task #27) -----

/**
 * Release channel the auto-updater tracks:
 * - 'main'   : bleeding edge — every push to main publishes a prerelease here
 * - 'stable' : only tagged `v*` releases (the `latest` electron-updater channel)
 */
export type UpdateChannel = 'main' | 'stable'

/**
 * Update lifecycle pushed over `update:status` (main -> renderer). `percent` is
 * present while downloading; `version` once known; `message` on error.
 */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  message?: string
}
