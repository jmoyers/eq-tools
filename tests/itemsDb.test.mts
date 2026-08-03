// ITEM-DATABASE TESTS: identity checks on the COMMITTED item corpus
// (src/main/data/items.json, written by `npm run scrape:items`) and on the pure record
// helpers it is read with (src/main/itemsDb.ts).
//
// WHY the database exists: item pages are static wiki content, but `itemLookup.ts` used to
// answer every unknown item with a live two-request round trip whose result lived only in
// that one user's userData cache — so a fresh install knew nothing offline and every user
// re-scraped the same 11k items one at a time. The corpus is now scraped ONCE, committed,
// ES-imported (electron-vite inlines it into the main bundle) and consulted FIRST; the wiki
// path survives as the fallback for pages created since the last refresh.
//
// No Electron here, and NOTHING SKIPS: itemsDb.ts is electron-free on purpose and the JSON
// is committed, so this file asserts on exactly the bytes the app ships.
//
// Assertions are IDENTITIES and FLOORS, never frozen counts (AGENTS.md: "frozen numbers
// rot" — the wiki gains item pages, so a re-scrape must be able to grow this file without
// turning the suite red). The floors are set below what the 2026-08-03 scrape actually
// produced (11,247 items / 11,351 keys); the cross-source check is a true identity.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildItemDbIndex, itemKey, knowledgeFromDb, type ItemDbFile } from '../src/main/itemsDb'
import itemsJson from '../src/main/data/items.json'
import poskyJson from '../src/renderer/src/data/eqlegends/posky.json'
import type { PoskyData } from '../src/shared/types'

const db = itemsJson as unknown as ItemDbFile
const posky = poskyJson as unknown as PoskyData
const index = buildItemDbIndex(db)

/** Corpus floors — comfortably under the 2026-08-03 scrape so a growing wiki stays green. */
const MIN_ITEMS = 11_000
const MIN_KEYS = 11_000

test('items.json carries a parseable scrapedAt from a real scrape', () => {
  const t = Date.parse(db.scrapedAt)
  assert.ok(Number.isFinite(t), `scrapedAt must parse, got ${JSON.stringify(db.scrapedAt)}`)
  // Not the stub's epoch stamp, and not from the future — this must be a real run.
  assert.ok(t > Date.parse('2026-01-01T00:00:00Z'), 'scrapedAt looks like the placeholder stub')
  assert.ok(t < Date.now() + 24 * 60 * 60 * 1000, 'scrapedAt is in the future')
  assert.ok(db.source.includes('eqlwiki.com'), 'source must state its provenance')
})

test('the corpus is the whole wiki, not a sample', () => {
  assert.ok(db.count >= MIN_ITEMS, `only ${db.count} items — expected >= ${MIN_ITEMS}`)
  assert.ok(index.size >= MIN_KEYS, `only ${index.size} keys — expected >= ${MIN_KEYS}`)
  // Keys >= items: a page contributes its title AND, when `|itemname` differs, that name.
  assert.ok(index.size >= db.count, 'key count must be at least the item count')
})

test('every key is canonical, and derived from the record it points at', () => {
  for (const [key, entry] of index) {
    // Law 2: the key is `+N`-stripped and case-folded. A key that is not its own canonical
    // form could never be hit by a lookup, so it would be dead weight in the bundle.
    assert.equal(itemKey(key), key, `non-canonical key: ${JSON.stringify(key)}`)
    assert.ok(entry.page.length > 0, `entry under ${key} has no page title`)
    const fromTitle = itemKey(entry.page) === key
    const fromName = entry.name != null && itemKey(entry.name) === key
    assert.ok(fromTitle || fromName, `key ${key} matches neither page ${entry.page} nor name ${entry.name}`)
  }
})

test('knowledgeFromDb restores every field ItemKnowledge requires', () => {
  for (const [, entry] of index) {
    const k = knowledgeFromDb(entry)
    assert.equal(typeof k.name, 'string')
    assert.ok(k.name.length > 0)
    assert.equal(typeof k.lore, 'boolean')
    assert.equal(typeof k.quest, 'boolean')
    assert.ok(Array.isArray(k.questUses))
  }
})

test('a flagged record is flagged because the page said so', () => {
  // The LORE/QUEST flags come from the stats block's text, so a record can only carry one
  // when it actually has that block. This is the guard against a scraper that defaults.
  for (const [key, entry] of index) {
    if (entry.lore === true || entry.quest === true) {
      const stated = entry.statsBlock != null || (entry.questUses?.length ?? 0) > 0
      assert.ok(stated, `${key} is flagged but states neither a stats block nor a quest use`)
    }
    assert.notEqual(entry.lore, false, `${key} stores a false flag (should be omitted)`)
    assert.notEqual(entry.quest, false, `${key} stores a false flag (should be omitted)`)
  }
})

// --- cross-source identity ---------------------------------------------------------
//
// posky.json (scrape:posky) and items.json (scrape:items) are two INDEPENDENT scrapes of the
// same wiki, so their overlap is checkable without inventing an expectation. Every Plane of
// Sky quest item whose posky row recorded a real wiki page must be in the item corpus.
//
// The filter is exact, not a fudge: posky reads its page titles off the anchor `title`
// attribute, and MediaWiki writes "<Name> (page does not exist)" for a REDLINK. Three Sky
// items are redlinks on the live wiki today (Azarack Skin, Azarack Blood, Large Sky Lapis —
// verified against the API 2026-08-03), and the wind runes are synthesized posky rows with
// no page at all. Neither can be in a corpus enumerated from pages that exist.

/** Plane of Sky quest items whose posky row names a page that really exists on the wiki. */
function poskyItemsWithRealPages(): string[] {
  const names = new Set<string>()
  for (const q of posky.quests) {
    for (const it of q.items) {
      if (it.page != null && !it.page.includes('(page does not exist)')) names.add(it.name)
    }
  }
  return [...names].sort()
}

test('every Plane of Sky quest item with a real wiki page is in the corpus', () => {
  const names = poskyItemsWithRealPages()
  assert.ok(names.length >= 100, `expected posky to name >= 100 real item pages, got ${names.length}`)
  const missing = names.filter((n) => !index.has(itemKey(n)))
  assert.deepEqual(missing, [], `posky items absent from items.json: ${missing.join(', ')}`)
})

test('known Sky items resolve to the knowledge the wiki states', () => {
  // Stable, load-bearing Sky items: a class-Test turn-in and an efreeti drop. Both are
  // asserted on PROPERTIES the page states (LORE/QUEST flags, an icon, a stats block), not
  // on exact text that a wiki edit would churn.
  for (const name of ['Nebulous Sapphire', 'Sphinx Claw']) {
    const entry = index.get(itemKey(name))
    assert.ok(entry, `${name} missing from items.json`)
    assert.equal(entry.page, name)
    assert.equal(entry.lore, true, `${name} should carry the LORE ITEM flag`)
    assert.equal(entry.quest, true, `${name} should carry the QUEST ITEM flag`)
    assert.ok(typeof entry.iconId === 'number' && entry.iconId > 0, `${name} should carry an icon id`)
    assert.match(entry.statsBlock ?? '', /LORE ITEM/)
  }
})

test('the `+N` item level never reaches the database', () => {
  // A looted "Cloak of Flames +4" must resolve to the base item — the wiki documents base
  // items only, and the key function strips the tier suffix. Both directions are checked so
  // the corpus can't quietly acquire a tiered duplicate.
  const base = index.get(itemKey('Cloak of Flames'))
  assert.ok(base, 'Cloak of Flames missing from items.json')
  assert.equal(index.get(itemKey('Cloak of Flames +4')), base)
  for (const key of index.keys()) assert.doesNotMatch(key, / \+\d+$/, `tiered key in corpus: ${key}`)
})
