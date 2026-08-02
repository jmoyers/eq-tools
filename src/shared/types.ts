// Types shared across the main process, preload bridge, and renderer.

import type { LootDisposition } from './logEvents'

export type { LootDisposition }

/**
 * The two spawnable overlay window KINDS (Task #54 — overlay v2):
 *   - 'fight'   : the CURRENT-fight meter + a FIGHT selector (recent encounters).
 *   - 'overall' : the ZONE meter + a ZONE-session selector.
 * Each kind has its own independently-persisted OverlayConfig (bounds/alpha/lock/topN) and can
 * be open simultaneously. IPC channels + the store are keyed by this.
 */
export type OverlayKind = 'fight' | 'overall'
export const OVERLAY_KINDS: OverlayKind[] = ['fight', 'overall']

/**
 * Persisted config for one floating overlay DPS-meter window (Task #52; keyed by kind in
 * Task #54). Stored in electron-store under `overlays.<kind>`. Small + JSON-serializable.
 */
export interface OverlayConfig {
  /** Was the overlay open when the app last quit? Restored on launch. */
  open: boolean
  /** Locked = click-through (mouse passes to the game); unlocked = interactive. */
  locked: boolean
  /** Background translucency, 0..1 (alpha of the dark panel fill). */
  bgAlpha: number
  /** How many source bars to show (5 or 10). */
  topN: number
  /** Persisted window bounds so position + size survive a restart. */
  bounds?: { x: number; y: number; width: number; height: number }
}

/** One EverQuest character whose log we watch. */
export interface CharacterRef {
  name: string
  server: string
  logPath: string
  /** log file mtime (ms) — used as "last played" */
  lastPlayed?: number
}

/**
 * The effective EQ install-dir configuration surfaced to the Settings UI. `root`
 * is the directory in use (override ?? auto-discovery ?? default); `source` says
 * how it was chosen; `characterCount` is how many `eqlog_*.txt` logs were found
 * under `<root>\Logs` (0 ⇒ show the empty-state prompt).
 */
export interface EqConfig {
  root: string
  logsDir: string
  source: 'manual' | 'auto' | 'default'
  characterCount: number
  /** Whether a manual override is currently persisted (vs auto-detecting). */
  overridden: boolean
}

/** Result of picking/validating an EQ install dir from the Settings folder-picker. */
export interface EqConfigResult {
  /** false when the user cancelled the OS folder dialog. */
  ok: boolean
  config: EqConfig
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
  /**
   * Auto-disposition (Tasks #40/#47) for looted-and-routed lines — currency/hoard/depot
   * are kept (held), sold is gone, combined is net-zero (consumed into `created`). The
   * ONE held-count rule lives in computeHeldCounts (features/posky/heldCounts.ts).
   * Undefined for ordinary kept loot.
   */
  disposition?: LootDisposition
  /** Stack size when the line names one (`2 Bone Chips`); undefined = 1 (Task #47). */
  count?: number
  /** The upgraded item a 'combined' loot created (`… to create a <item> +N`). */
  created?: string
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

// ----- Item knowledge ("what's this lore/quest item for", Task #53) -----

/** One quest an item is used in (or given by), as learned from the wiki / posky. */
export interface ItemQuestUse {
  /** quest display name (e.g. "Paladin Test of Love", "Coin of Tash (Tashania spell)") */
  quest: string
  /** wiki page title to resolve the quest (for future linking); may equal `quest` */
  page?: string
  /** where this association came from: the local posky dataset or the wiki */
  source: 'posky' | 'wiki'
  /** quest-giver NPC, when known (posky only) */
  giver?: string
}

/** The "what's this item for" knowledge card for a single item name. */
export interface ItemKnowledge {
  /** the item name looked up (as requested; display name, not normalized) */
  name: string
  /** the wiki page title actually resolved (may differ via redirect/search) */
  page?: string
  /** LORE ITEM flag (only one may be held at a time) */
  lore: boolean
  /** QUEST ITEM flag OR any related-quest association (a quest/collectible piece) */
  quest: boolean
  /** quests this item is required by / used in */
  questUses: ItemQuestUse[]
  /** one-line freeform summary (from the wiki `notes` field), trimmed */
  summary?: string
  /** the raw stat/flag block text from the item page (LORE/NO DROP/slot/…) */
  statsBlock?: string
  /** whether this result was served from cache (vs a fresh network lookup) */
  cached: boolean
  /** true when the wiki lookup was attempted but found no page (negative result) */
  notFound?: boolean
  /** true when the wiki was unreachable (offline) — local posky data may still apply */
  offline?: boolean
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
 * Whether a spell is a beneficial BUFF or a detrimental DEBUFF (Task #35).
 *
 * This is a property of the SPELL, not of who it's on. It comes from the scraped spell
 * DB's `spellType` (Beneficial → 'buff', Detrimental → 'debuff'); for a spell absent
 * from the DB it falls back to the plurality of its observed fade-target dispositions (a
 * spell that mostly fades on hostile entities is a debuff).
 *
 * NOTE (Task #35 model correction): there is deliberately NO 'pet' class. A buff cast on
 * the pet is just a 'buff' bound to the pet ENTITY — "pet" is a priority/grouping concern
 * for the UI (show self first, then other entities), not a data-model taxonomy. Do not
 * reintroduce a 'pet' BuffClass.
 */
export type BuffClass = 'buff' | 'debuff'

/** Per-spell mined duration statistics (milliseconds). */
export interface BuffStat {
  /** spell name (display casing of the first observed cast/fade). */
  spell: string
  /** buff vs debuff — a spell property (Task #35). */
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
  /**
   * The AUTHORITATIVE wiki duration (ms) for this spell, when the scraped DB knows it
   * (Task #34). This is the prior/truth and takes precedence over mined samples in the
   * estimator; null when the DB has no duration (mined-only spell).
   */
  dbDurationMs?: number | null
  /**
   * The value the estimator uses for the remaining-time bar (Task #34): the DB duration
   * when known, else the recency-weighted MAX of mined samples. Provenance in
   * `estimatorSource`. Null when neither is available (n=0, no DB duration).
   */
  estimateMs?: number | null
  /** Where `estimateMs` came from: 'db' | 'observed'. */
  estimatorSource?: 'db' | 'observed'
  /**
   * The newest event ts (ms epoch) this spell was seen — the last castBegin / apply / fade
   * involving it (Task #45). The RECENCY signal the suggested-alerts wizard sorts by (recent
   * spells over merely-frequent ones). Absent when the spell was never seen live.
   */
  lastSeenMs?: number | null
}

/** A currently-active (landed, not yet faded) buff INSTANCE = (spell, target entity). */
export interface ActiveBuff {
  spell: string
  /** buff vs debuff — a SPELL property (Task #35), not who it's on. */
  cls: BuffClass
  /**
   * True when this instance is on the PLAYER (self). False when it's on some other
   * entity (a pet, another player, or — for a debuff — a hostile mob). The UI shows
   * self instances first ("Your buffs"), then per-entity groups (Task #35).
   */
  self: boolean
  /**
   * The bound entity disposition (Task #32), kept for the module's own censor logic:
   * 'self' | 'summoned' | 'charmed' | 'hostile'. Undefined only for a provisional entry
   * cast before its target was known. The UI groups by `self`/`target`, not by this.
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
  /**
   * The bound entity's display name for a NON-self instance (the pet's name, another
   * player, or the inferred mob for a debuff); undefined for a self instance. This is
   * both the group key and the target chip in the UI (Task #35).
   */
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
  /**
   * Where `estimatedMs` came from (Task #34):
   *   'db'       — the authoritative wiki duration (spells.json). The prior/truth.
   *   'observed' — the recency-weighted MAX of mined samples (no DB duration known).
   *   undefined  — no estimate (n=0 and no DB duration).
   */
  durationSource?: 'db' | 'observed'
  /**
   * True when this buff is PERMANENT (Task #34): an illusion-flagged spell the player
   * self-cast while the Permanent Illusion AA is owned (self-cast illusions last forever
   * on the player). The UI shows "permanent · illusion AA" and no countdown.
   */
  permanent?: boolean
  /**
   * True when this active was applied by an EXACT chat MESSAGE match (Task #34) — a
   * msg_cast_on_you / msg_cast_on_other / self-heal-by-buff line — rather than inferred
   * from cast timing. Message-driven applies are confident (no provisional dimming).
   */
  messageDriven?: boolean
}

// ----- Observed-message overlay (Task #36) -----
//
// The user's directive: "augment the spell database with our own method of verifying
// variations of the cast messages for everything we encounter." During replay AND live
// the buffs model MINES associations between the messages the game prints and the spell
// the player was casting at the time, then derives a per-message VERDICT. The overlay is a
// learned layer ON TOP of the scraped spells.json — where the overlay disagrees, it wins
// (the wiki is known-inaccurate in places, e.g. Symbol of Pinzarn's landing message).
//
// A future agent should consult the overlay BEFORE trusting a wiki cast message: a message
// the overlay marks SHARED can NOT identify a spell on its own (resolve via cast history);
// a CONTRADICTS-WIKI verdict means the wiki's msg_* field for that spell is wrong.

/** The verdict the overlay derives for one observed message text (Task #36). */
export type OverlayVerdict =
  | 'verified' // consistently follows exactly ONE spell (n≥2) — a reliable identifier.
  | 'shared' // follows MULTIPLE spells (e.g. "You feel different.") — can't name a spell.
  | 'contradicts-wiki' // observed pairing differs from spells.json's msg_* for that spell.
  | 'unknown' // too few observations to judge (n<2, single spell).

/** One observed message and what the overlay learned about it (Task #36). */
export interface OverlayMessage {
  /** The exact message text as it appears in the log (a landing or wears-off line). */
  text: string
  /** Whether it was observed as a landing message or a wears-off message. */
  role: 'landing' | 'wearsOff'
  /** The overlay's verdict for this message. */
  verdict: OverlayVerdict
  /** Per-spell observation counts (spell display name → times seen following that cast). */
  spells: { spell: string; count: number }[]
  /** Total observations of this message across all spells. */
  total: number
  /**
   * For a CONTRADICTS-WIKI verdict: the spell whose spells.json msg_* field this message
   * contradicts, and what the wiki claims. Undefined otherwise.
   */
  wikiConflict?: { spell: string; wikiText: string }
}

/**
 * The persisted/served overlay (Task #36). `messages` is the learned registry; `corrections`
 * is the subset the buffs model should APPLY over spells.json (verified single-spell landing
 * messages the DB was missing, and contradiction fixes). Versioned so a schema change can
 * invalidate a stale on-disk snapshot.
 */
export interface MessageOverlay {
  version: number
  /** When this overlay was last derived (ISO). */
  updatedAt: string
  /** The full learned message registry (for the audit UI). */
  messages: OverlayMessage[]
  /** Summary counts for the diagnostics header. */
  stats: { verified: number; shared: number; contradictions: number; unknown: number }
}

/** buffs module snapshot: live active buffs + mined per-spell stats + the message overlay. */
export interface BuffsSnap {
  active: ActiveBuff[]
  stats: Record<string, BuffStat>
  /** The observed-message overlay (Task #36) — for the diagnostics/audit UI. */
  overlay?: MessageOverlay
}
/** buffs module delta: the module ships a full snapshot each flush (small state). */
export type BuffsDelta = BuffsSnap

// ----- Spell database (Task #34) -----
//
// A committed, scraped catalog of EQ Legends spells from the wiki (Template:Spellpage).
// It is the PRIOR/TRUTH for buff durations and the source of the exact chat messages a
// spell prints when it lands / wears off — which lets the parser emit PRECISE buffApply/
// buffWearOff events (message-driven, not cast-timing-mined). See scripts/scrape-spells.ts
// and src/main/data/spellDb.ts (the derived lookup tables + parser injection).

/** One scraped spell (a Template:Spellpage page). Fields are best-effort; null when the
 *  wiki page omits/uses an unparseable value (the raw text is retained where useful). */
export interface SpellEntry {
  /** Spell name (page title / spellname field). Rank variants are separate entries. */
  name: string
  /** Raw duration text from the wiki ("27 minutes", "instant", a level formula). */
  durationText?: string
  /** Parsed duration in ms; null when durationText is unparseable/absent/instant. */
  durationMs: number | null
  /** Casting time in ms (from casting_time seconds), when present. */
  castTimeMs?: number
  /** target_type ("Single Friendly (or Self)", "Single Hostile", …). */
  targetType?: string
  /** spell_type ("Beneficial" / "Detrimental"). */
  spellType?: string
  /** classes text ("Enchanter - Level 26"). */
  classes?: string
  /** msg_cast_on_you — printed to the caster when it lands on THEM ("A cool breeze …"). */
  msgCastOnYou?: string
  /** msg_cast_on_other — printed when it lands on someone else ("Someone looks tranquil."). */
  msgCastOnOther?: string
  /** msg_wears_off — printed when the buff fades ("The cool breeze fades."). */
  msgWearsOff?: string
  /** True when the effects/description text mentions an Illusion (Permanent Illusion AA). */
  illusion: boolean
  /** mana cost, when present. */
  mana?: number
}

/** The committed spells.json shape: metadata + the spell list. */
export interface SpellDbFile {
  scrapedAt: string
  count: number
  spells: SpellEntry[]
}

// ----- Suggested-alerts wizard (Task #38) -----
//
// A slim, searchable catalog derived from spells.json + live usage. For each spell the
// renderer needs just enough to (a) filter/sort (name, buff/debuff, illusion, usageCount)
// and (b) know which one-click alert TEMPLATES the spell database can actually support —
// each template maps to a LogEvent kind that can genuinely fire (validated against
// logEvents.ts + the AlertsModule matcher). Built in main from the effective DB; usage is
// folded in from the buffs module's snapshot stats (per-spell sample count `n`).

/** Which suggested-alert templates a spell supports (a template is offered only when its
 *  trigger can actually fire — gated by the DB fields the parser needs). */
export interface SpellTemplateFlags {
  /** Beneficial + has a wears-off message → "wears off you" (kind: buffWearOff). */
  wearsOff: boolean
  /** Beneficial → "fades on your pet/target" (kind: buffFade). */
  fade: boolean
  /** Detrimental + has a cast-on-other message → "lands on a target" (kind: buffApply). */
  lands: boolean
}

/** One catalog row: a spell the wizard can build alerts for. */
export interface SpellCatalogEntry {
  /** Canonical (lowercased, rank-stripped) key — the stable id for suggestion ids. */
  key: string
  /** Display name (DB casing). */
  name: string
  /** 'Beneficial' | 'Detrimental' | undefined (unknown). */
  spellType?: string
  /** True when the spell is an Illusion (offered the shared illusion-fade suggestion). */
  illusion: boolean
  /** Which one-click alert templates this spell supports. */
  templates: SpellTemplateFlags
  /** How often the buffs model has observed this spell (land→fade sample count `n`); 0 = never. */
  usageCount: number
  /**
   * Newest event ts (ms epoch) this spell was seen live (last cast/apply/fade), or null when
   * never seen (Task #45). The wizard sorts USED spells by this DESC (recency over
   * frequency), tie-breaking on usageCount, then the never-used alphabetical tail.
   */
  lastSeenMs?: number | null
}

/** Reply of `spells:catalog`: the catalog + summary stats for the wizard header. */
export interface SpellCatalog {
  entries: SpellCatalogEntry[]
  /** Total spells in the DB. */
  total: number
  /** How many entries have usageCount > 0 (the "frequent" set). */
  withUsage: number
  /** Whether ANY illusion spell exists (the shared illusion-fade suggestion is offerable). */
  hasIllusions: boolean
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
 *
 * No longer user-selectable (Task #55): the stored value is read internally so
 * existing installs keep their feed; new installs default to 'main'.
 */
export type UpdateChannel = 'main' | 'stable'

/**
 * Update lifecycle pushed over `update:status` (main -> renderer) AND returned by
 * the `update:getStatus` pull (a late-mounting Preferences view would otherwise
 * miss every push). `percent` is present while downloading; `version` once known;
 * `message` on error; `checkedAt` is epoch millis of the last COMPLETED check
 * (not-available / available / error all count) and rides along on every
 * subsequent status so "Last checked" never blanks mid-download.
 */
export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  message?: string
  checkedAt?: number
}
