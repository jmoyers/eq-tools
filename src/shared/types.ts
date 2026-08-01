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

/** Kill counts keyed by mob name (for drop-rate estimates). */
export type KillCounts = Record<string, number>

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
