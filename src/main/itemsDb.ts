// itemsDb.ts — the COMMITTED wiki item database: its record shape, its ONE key function,
// and the pure index builder. Electron-free on purpose, so both `scripts/scrape-items.ts`
// (which WRITES the file) and `tests/itemsDb.test.mts` (which asserts on the committed
// bytes) can import the exact same definitions the app reads it with. Nothing here loads
// the JSON — `itemLookup.ts` owns that import, so a script or a test pays for the 8 MB
// only when it actually wants it.
//
// WHY A COMMITTED DATABASE AT ALL (owner decision, 2026-08-03: "we should be shipping the
// database with the bundle and committing it"). Item pages are static wiki content, and
// `itemLookup` was answering every unknown item with a two-request network round trip
// (search → parse) whose result then lived only in that one user's `userData` cache. So a
// fresh install answered nothing offline, every user re-scraped the same 11k items one at a
// time, and the wiki paid for all of it. Scraping the corpus ONCE and committing it is the
// precedent posky.json / quests.json / mobs.json already set, for the same reasons: instant,
// offline, identical for every user, and diffable against the wiki.
//
// SHAPE. A record is *literally* the `ItemKnowledge` fields `parseItemWikitext` produces —
// no projection, no renaming, so the lookup path needs no translation layer. Two
// concessions to bundle size (the JSON is ES-imported, so electron-vite INLINES it into
// every user's main bundle):
//   * false / empty fields are OMITTED rather than stored (`lore: false`, `questUses: []`
//     for ~11k records is pure weight). `knowledgeFromDb` restores the defaults.
//   * `name` is stored only when the page's `|itemname` DIFFERS from its title, which is
//     rare; otherwise the title IS the name.
// Both are restored in ONE place, `knowledgeFromDb`, so no caller ever sees the compact form.

import { itemBaseName } from '../shared/itemStats'
import type { ItemKnowledge } from '../shared/types'

/**
 * The canonical item key — ONE definition for the committed DB, the userData cache, and the
 * scraper. Law 2 (canonicalize at boundaries): strip the ` +N` item-level suffix so
 * "Cloak of Flames +4" and "Cloak of Flames" are the same item, and fold case because loot
 * lines and wiki titles disagree about it constantly.
 */
export function itemKey(name: string): string {
  return itemBaseName(name).toLowerCase()
}

/**
 * One committed item record. `Partial<Omit<ItemKnowledge, …>>` is deliberate rather than a
 * hand-written field list: it makes the record shape an IDENTITY with the knowledge type the
 * app serves, so a field added to `ItemKnowledge` can't silently stop being scraped, and a
 * field renamed there breaks this file instead of quietly producing empty cards.
 *
 * `page` (the wiki page title) is the only required field; it is the record's provenance and
 * the link target. `cached` is a per-answer runtime flag and is never stored.
 */
export interface ItemDbEntry extends Partial<Omit<ItemKnowledge, 'cached' | 'page'>> {
  page: string
}

/** The committed file: `src/main/data/items.json`. */
export interface ItemDbFile {
  /** ISO stamp of the scrape that produced this file. */
  scrapedAt: string
  /** human-readable provenance (which enumeration produced this) */
  source: string
  /** number of DISTINCT item pages (not keys — an item can carry two keys, see below) */
  count: number
  /**
   * `itemKey(name)` → record. A page contributes up to TWO keys: its title and, when the
   * `|itemname` field differs, that name too — a loot line spells the in-game name, which is
   * not always what someone titled the page.
   */
  items: Record<string, ItemDbEntry>
}

/**
 * A stored record → the knowledge record the app serves, with the omitted defaults restored.
 * `name` defaults to the page title (see the shape note in the header).
 */
export function knowledgeFromDb(entry: ItemDbEntry): Omit<ItemKnowledge, 'cached'> {
  return {
    ...entry,
    name: entry.name ?? entry.page,
    lore: entry.lore ?? false,
    quest: entry.quest ?? false,
    questUses: entry.questUses ?? []
  }
}

/**
 * PURE: the committed file → a lookup index. Kept as a function (rather than a bare
 * `Object.entries` at the use site) so the test can build the index from the COMMITTED bytes
 * exactly the way the shipped code does.
 */
export function buildItemDbIndex(file: ItemDbFile): Map<string, ItemDbEntry> {
  return new Map(Object.entries(file.items ?? {}))
}
