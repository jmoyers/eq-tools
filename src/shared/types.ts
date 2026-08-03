// Types shared across the main process, preload bridge, and renderer.

import type { ConsiderFaction, LootDisposition } from './logEvents'
import type { ItemStatBlock } from './itemStats'

export type { LootDisposition }
export type { ItemStatBlock }

/**
 * The spawnable overlay window KINDS (Task #54 — overlay v2; 'events' added in Task #59):
 *   - 'fight'   : the CURRENT-fight meter + a FIGHT selector (recent encounters).
 *   - 'overall' : the ZONE meter + a ZONE-session selector.
 *   - 'events'  : the EVENT LOG — a live reverse-chronological feed of alerts firing,
 *                 notable loot, and quest completions (see FeedEvent below).
 *   - 'heal-fight' / 'heal-overall' (Task #59): the HEALING pair — the same two selection
 *                 semantics as the damage pair ('heal-fight' = current encounter, 'heal-overall'
 *                 = zone session), rendering `SegmentView.healing` instead of the damage bars.
 * Each kind has its own independently-persisted OverlayConfig (bounds/alpha/lock/topN/drill) and
 * can be open simultaneously. IPC channels + the store are keyed by this.
 */
export type OverlayKind = 'fight' | 'overall' | 'events' | 'heal-fight' | 'heal-overall'
export const OVERLAY_KINDS: OverlayKind[] = ['fight', 'overall', 'events', 'heal-fight', 'heal-overall']

/** True for the two HEALING overlay kinds (they render HealMeter, not OverlayMeter). */
export function isHealOverlayKind(kind: OverlayKind): boolean {
  return kind === 'heal-fight' || kind === 'heal-overall'
}

/** True for the kinds whose selector lists FIGHTS (the others list zone sessions). */
export function isFightOverlayKind(kind: OverlayKind): boolean {
  return kind === 'fight' || kind === 'heal-fight'
}

/**
 * The overlay meter's mini drill-down (Task #54): which entity's flat skill/spell list is on
 * screen. `null` (or absent) = level 1, the entity bars.
 */
export interface OverlayDrill {
  entityId: string
}

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
  /**
   * Persisted mini drill-down: the entity whose flat skill list is showing, or null for the
   * entity bars. Remembered state, not a preference — a drill survives a restart exactly like
   * position does. A stale id (per-session `pet:<instanceId>` ids don't survive a restart; the
   * fight changed; 'you' is briefly absent between fights) renders level 1 WITHOUT clearing the
   * stored value, so the drill re-applies the moment the entity reappears. Only an explicit
   * back/undrill (or picking a different fight/zone session) clears it.
   */
  drill?: OverlayDrill | null
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

// ----- Wiki quest catalog (produced by scripts/scrape-quests.ts) -----
//
// The SECOND local-first source for item knowledge. Item pages only carry a quest
// association when someone filled in their `|relatedquests` field, so classic turn-in
// items (Dwarven Ale, Guard Bracelet, …) look quest-less from the item side. The linkage
// actually lives on the QUEST pages, which this catalog indexes item-first.

/** One quest scraped from an eqlwiki quest page (Category:Quests + quest subcategories). */
export interface QuestEntry {
  /** display name (the wiki page title) */
  name: string
  /** wiki page title (linkable) */
  page: string
  /** "Start Zone" cell */
  startZone?: string
  /** "Quest Giver" NPC */
  giver?: string
  /** "Minimum Level" (numeric part only) */
  minLevel?: number
  /** classes the quest is offered to ("All" when unrestricted) */
  classes?: string[]
  /** "Related Zones" cell */
  relatedZones?: string[]
  /** "Related NPCs" cell */
  relatedNpcs?: string[]
  /** reward items (from the Reward section's item boxes/links) */
  rewards?: { name: string }[]
  /** items the quest body references (turn-ins / collectibles), reward items excluded */
  requiredItems?: string[]
  /** page carries an experience-reward marker */
  expReward?: boolean
}

export interface QuestData {
  scrapedAt: string
  /** human-readable provenance, e.g. "eqlwiki.com Category:Quests (+ subcategories)" */
  source: string
  quests: QuestEntry[]
}

// ----- Item knowledge ("what's this lore/quest item for", Task #53) -----

/** One quest an item is used in (or given by), as learned from the wiki / posky. */
export interface ItemQuestUse {
  /** quest display name (e.g. "Paladin Test of Love", "Coin of Tash (Tashania spell)") */
  quest: string
  /** wiki page title to resolve the quest (for future linking); may equal `quest` */
  page?: string
  /**
   * Where this association came from: the local Plane of Sky dataset, the local scraped
   * wiki quest catalog (`quests.json`), or a live item-page `|relatedquests` lookup.
   */
  source: 'posky' | 'quests' | 'wiki'
  /** quest-giver NPC, when known (posky / quests) */
  giver?: string
  /**
   * How the item relates to the quest, when the source knows: a turn-in/collectible
   * ('required') or something the quest hands out ('reward'). Omitted by posky/wiki uses.
   */
  role?: 'required' | 'reward'
  /** the quest's start zone, when known (quests catalog only) */
  zone?: string
  /**
   * What the quest HANDS OUT, for a `role: 'required'` use — i.e. the outcome of turning
   * this item in. Names only (capped; see MAX_ATTACHED_REWARDS), so the UI can offer the
   * reward item as its own hoverable card without a second index. Present ONLY on the
   * 'quests' source and ONLY when the catalog actually names rewards (law 1: never
   * invented), and never on a 'reward'-role use — an item is not its own outcome.
   */
  rewards?: string[]
}

/**
 * One tradeskill recipe that CONSUMES this item as an ingredient (item page `|recipes`).
 * This is the answer for the large family of items whose stats block says QUEST ITEM but
 * which appear in no quest anywhere on the wiki: they are tradeskill components.
 */
export interface ItemRecipeUse {
  /** the recipe / result item name ("Gnome Kabobs") */
  recipe: string
  /** wiki page title, when the link was piped and differs from the label */
  page?: string
  /** the tradeskill it sits under ("Baking"), when the field grouped it */
  tradeskill?: string
  /** trivial level, when the line states one */
  trivial?: number
}

/** One ingredient line of a recipe that PRODUCES this item. */
export interface ItemCraftIngredient {
  name: string
  /** how many the combine consumes, when stated */
  qty?: number
  /** where the ingredient comes from, verbatim ("Bought", "Dropped", "Crafted", …) */
  sources?: string[]
}

/** One way this item is itself player-crafted (item page `|playercrafted`). */
export interface ItemCraftRecipe {
  /** "Baking", "Blacksmithing", "Pottery" … */
  tradeskill?: string
  trivial?: number
  /** the combine container ("Oven", "Forge", "Kiln") */
  container?: string
  /** what the combine yields — normally this item */
  yieldItem?: string
  yieldQty?: number
  ingredients: ItemCraftIngredient[]
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
  /**
   * The same stat block parsed into the in-game item WINDOW's structure (flags, slot,
   * class/race, attributes, saves, effects) so the UI can draw it with the game's
   * hierarchy instead of dumping monospace text. Base/wiki data only — it carries no
   * tier or exaltation-socket state, because item pages don't have any.
   */
  stats?: ItemStatBlock
  /** wiki icon id (`lucy_img_ID`) → File:Item <id>.png on eqlwiki */
  iconId?: number
  /** tradeskill recipes that USE this item as an ingredient (`|recipes`) */
  recipes?: ItemRecipeUse[]
  /** prose fallback when `|recipes` wasn't a parseable bullet list */
  recipesNote?: string
  /** true ONLY when a structured `|playercrafted` recipe was read (never inferred) */
  playerCrafted?: boolean
  /** how this item is made — one entry per craft recipe (`|playercrafted`) */
  craftedBy?: ItemCraftRecipe[]
  /** prose fallback when `|playercrafted` wasn't a structured recipe ("Non-Tradeskill (Quest)") */
  craftedNote?: string
  /** whether this result was served from cache (vs a fresh network lookup) */
  cached: boolean
  /** true when the wiki lookup was attempted but found no page (negative result) */
  notFound?: boolean
  /** true when the wiki was unreachable (offline) — local posky data may still apply */
  offline?: boolean
}

// ----- Scraped MOB catalog (produced by scripts/scrape-mobs.ts) -----
//
// The DEFINITIVE drop source. The wiki's mob pages state what a mob drops; your own loot
// history only corroborates it ("and you've had 3 of these"). So the drop list is scraped ONCE,
// committed, and consulted LOCALLY — the same local-first precedent posky.json and quests.json
// set, for the same reasons: instant, offline, and no per-mob network call to answer a `/con`.
//
// Deliberately COMPACT: names only, no wikitext blobs, no drop-rate spans. The catalog is
// ES-imported (electron-vite inlines it into the main bundle), so every field costs bundle size
// on every user's disk; rarity annotations and the rest of a page stay behind the live-wiki
// FALLBACK, which mobLookup still uses for a mob the catalog doesn't have yet.

/** One mob/NPC page from the wiki, reduced to what a consider card needs. */
export interface MobEntry {
  /** wiki page title (linkable, and the resolve key for the live fallback) */
  page: string
  /** the page's own `|name` — the IN-GAME name, article and casing as the wiki writes it */
  name: string
  /** level EXACTLY as the page states it — a RANGE as often as a number ("36-40", "2 - 4") */
  level?: string
  /** home zone(s) from the `|zone` field; "Various" is a real value, not a placeholder */
  zones?: string[]
  /** item names from `|known_loot`. Absent when the page has no loot section at all. */
  drops?: string[]
}

export interface MobData {
  scrapedAt: string
  /** human-readable provenance (which enumeration produced this) */
  source: string
  mobs: MobEntry[]
}

// ----- Mob knowledge ("what does this thing drop", Task #63) -----
//
// The consider answer: you `/con` something, and the app says what it drops. THREE sources,
// mirroring itemLookup's local-first architecture (main/mobLookup.ts):
//   LOCAL 1 — your OWN loot history for that mob (`dropsSeen`). Personal, offline, always
//             current, and the only source that can say "you've had 3 of these off it".
//   LOCAL 2 — the scraped quest catalog's `relatedNpcs` (`quests`), so a mob that matters to a
//             quest says so without a network call.
//   WIKI    — the mob page's `|known_loot` list (`dropsWiki`), plus the level/zone it states.
// Every field is present only when a source actually said it (law 1) — a mob with no page, or a
// page with no loot section, comes back with `notFound` and no invented drop list.

/** One item a mob's wiki page lists under `|known_loot`. */
export interface MobDrop {
  /** item name, exactly as the `{{:Item Name}}` transclusion spells it */
  item: string
  /**
   * Rarity EXACTLY as the page states it — the wiki writes it three different ways
   * ("Rare" / "Ultra Rare" / "Common", a bare "18.4%", or an empty span meaning "unstated").
   * Absent when the span was empty or missing; never normalized into a scale we'd be inventing.
   */
  rarity?: string
}

/** One item the CURRENT character has actually looted off this mob (own loot history). */
export interface MobSeenDrop {
  item: string
  /** how many we've looted (stacked loots add their `count`, not 1) */
  count: number
  /** most recent loot timestamp */
  lastTs: number
}

/** One quest the local catalog associates with this mob (`relatedNpcs`). */
export interface MobQuestUse {
  quest: string
  page?: string
  giver?: string
  zone?: string
}

/** The "what does this drop" card for a single mob name. */
export interface MobKnowledge {
  /** the mob name looked up, as requested (raw display casing) */
  name: string
  /** the wiki page title actually resolved */
  page?: string
  /**
   * Level EXACTLY as the page states it — a RANGE at least as often as a number ("36-40",
   * "2 - 4", "18"). Kept as text rather than parsed into a number we'd have to pick a side of.
   */
  levelText?: string
  /** home zone from the page ("Lower Guk", "Various"); wiki link markup stripped. */
  zone?: string
  /** the page's `|known_loot` list. Absent when the page has no such field (e.g. a merchant). */
  dropsWiki?: MobDrop[]
  /** what YOU have looted off it, newest/most-looted first. Absent when you never have. */
  dropsSeen?: MobSeenDrop[]
  /** quests the local catalog ties to this mob. Absent when none do. */
  quests?: MobQuestUse[]
  /** served from the persistent cache (vs a fresh network lookup) */
  cached: boolean
  /** the wiki lookup ran and found no page for this mob (a real negative) */
  notFound?: boolean
  /** the wiki was unreachable — local sources may still have answered */
  offline?: boolean
}

// ----- consider module (Task #63) -----

/**
 * One row of the "recently considered" ring — ONE PER MOB, most recent con wins. A mob conned
 * five times in a pull is one row with `cons: 5`, not five rows: the ring answers "what have I
 * been sizing up", and five identical lines answer it worse than one.
 */
export interface ConsiderRow {
  /** stable id (the canonical mob key) — the React key AND the delta merge handle */
  id: string
  /** RAW display name of the most recent con (see logEvents.ConsiderEvent.mob) */
  mob: string
  /** timestamp of the most recent con */
  ts: number
  rare: boolean
  level?: number
  faction: ConsiderFaction
  /** VERBATIM difficulty clause — considerDifficultyShort() renders it */
  difficulty: string
  /** the zone we were in when we conned it, when known */
  zone?: string
  /** how many times this mob has been conned since the last reset */
  cons: number
  /** async enrichment (mobLookup). Absent until it lands — never blocks the event path. */
  knowledge?: MobKnowledge
}

/** consider module. Delta = the rows that changed (new cons + landed enrichment). */
export type ConsiderSnap = ConsiderRow[]
export interface ConsiderDelta {
  upserted: ConsiderRow[]
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
export interface LootDelta {
  appended: LootEvent[]
}

/** turnins module. Delta = turn-ins appended since the last flush. */
export type TurnInSnap = TurnInEvent[]
export interface TurnInDelta {
  appended: TurnInEvent[]
}

/** kills module. Delta = the per-mob KillInfo entries that changed. */
export type KillsSnap = KillMap
export interface KillsDelta {
  changed: KillMap
}

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

/**
 * itemTiers module (Task #60): the OBSERVED item level of an item the CURRENT character has
 * merged. One row per base item name; absent = unknown (never tier 0). See
 * main/modules/itemTiers.ts for what counts as evidence.
 */
export interface ItemTierRow {
  /** `itemTierKey(name)` — lowercased, ` +N` stripped (the loot counting key) */
  key: string
  /** RAW base name for display ("Thelvorn, Blade of Light") */
  name: string
  /** HIGHEST tier observed. Undefined on a merge that named no item level (spell scroll). */
  tier?: number
  /** tier named by the MOST RECENT observation (several copies climb in parallel) */
  lastTier?: number
  /** how many merges we watched land on this item name */
  merges: number
  firstAt: number
  lastAt: number
}
/** kills-style map transport: full map to hydrate, changed rows as the delta. */
export type ItemTiersSnap = Record<string, ItemTierRow>
export interface ItemTiersDelta {
  changed: ItemTiersSnap
}

// ----- Event feed / event-log overlay (Task #59) -----
//
// A capped, LIVE-ONLY stream of "things worth noticing" — what the 'events' overlay renders in
// reverse-chronological order. The feed module (main/modules/eventFeed.ts) is the single source
// of truth; it is fed from three places, all of them already-existing detectors:
//   'alert' — the alerts module fired (main-side event/raw triggers) or the renderer routed an
//             'app'-signal fire through alerts:appFired.
//   'loot'  — a LIVE loot line whose item resolved (itemLookup, cache-first) to a NOTABLE
//             record (lore / quest / used by a quest). Same predicate as the loot tab's
//             "notable pickups" strip (shared/itemKnowledge.ts).
//   'quest' — a Sky quest completed live (the renderer's useProgress turn-in detector, reported
//             over `feed:report`).
//
// HONESTY (world-model law 1): every field here is either observed or scraped. `reward` exists
// only when the quest dataset actually names a reward item — an unknown reward shows NO item
// hover rather than a fabricated one, and `page` is absent when no wiki page is known.

export type FeedEventKind = 'alert' | 'loot' | 'quest' | 'con'

/**
 * The consider context of a 'con' row (Task #63). Carried structurally instead of baked into
 * `detail` so the overlay can color the row by FACTION rung and its hover card can lead with
 * the same facts without re-parsing a sentence. Every field came off the log line.
 */
export interface FeedConsider {
  faction: ConsiderFaction
  level?: number
  rare: boolean
  /** VERBATIM difficulty clause */
  difficulty: string
}

/** The item a quest awards, when the quest data actually names one. */
export interface FeedReward {
  /** reward item display name */
  item: string
  /** wiki page title for the reward item (for the hover card's link), when known */
  page?: string
  /** EQ-style stat blob from the scraped quest data — renders offline, before any lookup */
  stats?: string
}

/** One entry in the live event feed. */
export interface FeedEvent {
  /** stable id (monotonic, per session) — the React key + dedupe handle */
  id: string
  kind: FeedEventKind
  /** epoch millis of the underlying log line / signal */
  ts: number
  /** headline: the alert name, the item name, or the quest name */
  title: string
  /** supporting line: what triggered the alert, the source mob, the quest's class */
  detail?: string
  /** wiki page TITLE this row links to (quest page for quests, item page for loot) */
  page?: string
  /** for a quest that awards an item: what you got. Absent when the data doesn't say. */
  reward?: FeedReward
  /** for a 'con' row: the consider facts, structurally (Task #63). */
  con?: FeedConsider
}

/** eventFeed module. Delta = feed entries appended since the last flush. */
export type FeedSnap = FeedEvent[]
export interface FeedDelta {
  appended: FeedEvent[]
}

/**
 * What the RENDERER may report into the feed over `feed:report` (main owns ids + the ring).
 * Today: quest completions, which only the renderer's posky/turn-in machinery can detect.
 */
export interface FeedReport {
  kind: 'quest'
  ts: number
  title: string
  detail?: string
  page?: string
  reward?: FeedReward
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

// ----- Cross-window deep link ("take me to this in the app", Task #64) -----
//
// An overlay window is a GLANCE surface: it says a thing happened, in a few square inches, over
// the game. When the thing it named deserves a real answer — a con row's mob and everything it
// drops — the overlay's job ends and the MAIN WINDOW's begins. This is the payload that hands
// off: the overlay asks main to focus the app on a view, main shows/focuses the window and
// forwards the same payload to the app's renderer, which switches tabs and drills.
//
// Deliberately a small, CLOSED union rather than a route string: a renderer window asking
// another window to navigate is a capability, and the set of destinations it may name is
// spelled out here (and re-validated at the IPC handler) instead of being whatever text the
// asking window happened to send.

/** Destinations a deep link may name. One today; the union is the extension point. */
export type AppFocusView = 'mobs'

/** "Focus the app on this." `mob` is the RAW display name, as the log printed it. */
export interface AppFocus {
  view: AppFocusView
  /** the mob to drill into, when the request targets a specific one */
  mob?: string
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
  /** The updater machinery is OFF for this process (dev / unpackaged build). The UI must say
   *  so instead of showing an eternally-stale "not checked yet" that reads as a broken
   *  updater — dev is the only place that state can persist. */
  disabled?: boolean
}

// ----- Split-out sections -----
//
// Alerts + sound packs, and the spell/buff model, used to live in this file verbatim. They
// were moved out purely for file mass (max-lines). `shared/types` stays the ONE import site
// for every consumer, so nothing downstream changed.
// The re-export is EXPLICIT (never `export *`): the test suite runs these modules through
// tsx's CJS transform, where a star re-export becomes a runtime property copy that the ESM
// named-import linker cannot see — `import { X } from '../src/shared/types'` in a .mts test
// would fail to link. Naming each export also keeps this list a readable index.
export type {
  LogEventKind,
  AppSignal,
  AlertTriggerPrimitive,
  AlertTriggerComposite,
  AlertTrigger,
  AlertSoundRef,
  AlertDef,
  AlertPrefs,
  FiredAlert,
  AlertFireRecord,
  AlertsSnap,
  AlertsDelta,
  PackSound,
  SoundPackManifest,
  SoundPack,
  SoundData,
  RegistryPack,
  RegistryPackView,
  RegistryListResult,
  PackInstallProgress,
  PackMutationResult,
  PackPreviewSound,
  PackPreviewList
} from './alertTypes'

export type {
  BuffClass,
  BuffStat,
  ActiveBuff,
  OverlayVerdict,
  OverlayMessage,
  MessageOverlay,
  BuffsSnap,
  BuffsDelta,
  SpellEntry,
  SpellDbFile,
  SpellTemplateFlags,
  SpellCatalogEntry,
  SpellCatalog
} from './buffTypes'

export type { ProgressionSnap, ProgressionDropFront, ProgressionDelta } from './progressionTypes'
