// TASK #63 TESTS — the MOB CATALOG half of the consider family: wikitext parse goldens, the
// committed mobs.json catalog, and the own-loot index.
//
// Split out of tests/considerWindows.test.mts (which had grown past the 400-code-line
// factoring ceiling). Not one assertion moved or changed; the two files are the same suite cut
// along the seam the section banners already drew — considerWindows.test.mts keeps the parser
// goldens and the module/feed contract, this file keeps the wiki/catalog evidence.
//
// WIKITEXT PARSE GOLDENS run against VERBATIM excerpts of real eqlwiki mob pages, fetched
// read-only on 2026-08-03. The wiki writes `|known_loot` four incompatible ways and states
// rarity in three; each excerpt below is one of them, copied not paraphrased. The merchant
// case pins the NEGATIVE: a page with `|items_sold` and no `|known_loot` yields no drops,
// because a vendor's stock is not loot (law 1).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEvent } from '../src/main/log/parser'
import { MobLootIndex, mobKey, parseMobWikitext, unlink } from '../src/main/mobLookupParse'
import { isMobPage, parseMobPage, splitZones } from '../scripts/sources/mobPage'
import { localMobEntry } from '../src/main/mobLookupLocal'
import mobsJson from '../src/renderer/src/data/eqlegends/mobs.json'
import type { MobData } from '../src/shared/types'
import { readFixture } from './harness.mts'

// =============================================================================
// 2. MOB-PAGE WIKITEXT — verbatim excerpts of real eqlwiki pages (2026-08-03)
// =============================================================================

/** SHAPE 1 — "A zol ghoul knight": rarity WORD in a `drare` span, plus a `ddb` drop-rate span. */
const WT_ZOL_GHOUL_KNIGHT = `{{Classic Era}}{{Namedmobpage

| imagefilename     = npc_a_zol_ghoul_knight.png

| name              = a zol ghoul knight
| race              = Old Froglok Ghoul
| class             = [[Warrior]]
| level             = 36-40

| zone              = [[Lower Guk]]
| location          =

| known_loot =

<ul><li>  {{:Fine Steel Short Sword}}        <span class='drare'>(Uncommon)</span> <span class='ddb'>[Overall: 25.0%]</span>
</li><li> {{:Amber}}                         <span class='drare'>(Rare)</span> <span class='ddb'>[Overall: 5.5%]</span>
</li><li> {{:Undead Froglok Tongue}}         <span class='drare'>(Rare)</span> <span class='ddb'>[Overall: 5.5%]</span>
</li><li> {{:Words of Absorption}}              <span class='drare'>(Rare)</span> <span class='ddb'>[3] 1x 55% (33%)</span>
</li></ul>

| factions =

* [[Undead Frogloks of Guk]] <span class='profac'>(-15)</span>

| related_quests =

* None

}}
`

/** SHAPE 2 — "Baron Telyx V\`Zher": hand-written, NO spans, rarity in bare parentheses. */
const WT_BARON = `{{Classic Era}}
{{Namedmobpage

| name              = Baron Telyx V\`Zher
| race              = [[Dark Elf]]
| level             = 28

| zone              = [[Befallen]]
| respawn_time      = 4:27

| known_loot =

<ul>
<li>{{:Pristine Studded Leather Tunic}} (Common)</li>
<li>{{:The Baron's Blade}} (Rare)</li>
</ul>

| related_quests =

* None

}}
`

/** SHAPE 3 — "The Tenderizer": the rarity span is present but EMPTY (rarity simply unknown). */
const WT_TENDERIZER = `{{Classic Era}}
{{Namedmobpage

| name              = The Tenderizer
| level             = 22

| zone              = [[Najena]]

| known_loot =

<ul><li> {{:Kitchen Toolbelt}}          <span class='drare'></span>
</li><li>  {{:The Tenderizer (Weapon)}}          <span class='drare'></span>
</li></ul>

| related_quests =

* None

}}
`

/** SHAPE 4 — "A giant rat": unclosed <li>s, BARE PERCENTAGE rarity, trailing prose in the field. */
const WT_GIANT_RAT = `{{Classic Era}}{{Namedmobpage

| name              = a giant rat
| level             = 2 - 4

| zone              = Various
| location          = Various

| known_loot =

<ul>
  <li> {{:A Piece of Rat Fur}}   <span class='drare'>(18.4%)</span>
  <li> {{:Giant Rat Ear}}        <span class='drare'>(17.5%)</span>
  <li> {{:Giant Rat Pelt}}       <span class='drare'>(67.5%)</span>
</li></ul>

Does not drop coin.

| related_quests =

* [[Rat Fur Cap Quest]]
* [[Rat Pelt Cape Quest]]

}}
`

/** NEGATIVE — "Key Master" is a {{MerchantPage}}: `|items_sold`, no `|known_loot`. */
const WT_KEY_MASTER = `{{Sky Era}}
{{MerchantPage

| name              = Key Master
| level             = 55

| zone              = [[Plane of Sky]]

| items_sold =

<ul><li>  {{:Box of the Void}}                    <span class='ddp'>(1pp 4sp 9cp)</span>
</li><li> {{:Key of Swords}}                      <span class='ddp'>(542pp 9gp 9sp 9cp)</span>
</li></ul>

}}
`

test('mob page shape 1 (drare span + ddb drop-rate span): rarity WORD, drop-rate ignored', () => {
  const f = parseMobWikitext(WT_ZOL_GHOUL_KNIGHT)
  assert.equal(f.pageName, 'a zol ghoul knight')
  // A RANGE, kept as text — parsing it into one number would pick a side the page didn't.
  assert.equal(f.levelText, '36-40')
  assert.equal(f.zone, 'Lower Guk')
  assert.deepEqual(f.dropsWiki, [
    { item: 'Fine Steel Short Sword', rarity: 'Uncommon' },
    { item: 'Amber', rarity: 'Rare' },
    { item: 'Undead Froglok Tongue', rarity: 'Rare' },
    // The `[3] 1x 55% (33%)` DB span sits AFTER the rarity and must not be read as one.
    { item: 'Words of Absorption', rarity: 'Rare' }
  ])
  // `* None` is not a quest.
  assert.equal(f.quests, undefined)
})

test('mob page shape 2 (bare parentheses, no spans): backtick name + apostrophe item', () => {
  const f = parseMobWikitext(WT_BARON)
  assert.equal(f.pageName, 'Baron Telyx V`Zher')
  assert.equal(f.levelText, '28')
  assert.equal(f.zone, 'Befallen')
  assert.deepEqual(f.dropsWiki, [
    { item: 'Pristine Studded Leather Tunic', rarity: 'Common' },
    { item: "The Baron's Blade", rarity: 'Rare' }
  ])
})

test('mob page shape 3 (EMPTY rarity span): the item is named, the rarity is simply absent', () => {
  const f = parseMobWikitext(WT_TENDERIZER)
  assert.deepEqual(f.dropsWiki, [
    { item: 'Kitchen Toolbelt' },
    // An item name that CONTAINS parentheses must not be mistaken for a rarity annotation.
    { item: 'The Tenderizer (Weapon)' }
  ])
})

test('mob page shape 4 (unclosed <li>, percentage rarity, trailing prose): all four survive', () => {
  const f = parseMobWikitext(WT_GIANT_RAT)
  assert.equal(f.levelText, '2 - 4')
  assert.equal(f.zone, 'Various')
  assert.deepEqual(f.dropsWiki, [
    { item: 'A Piece of Rat Fur', rarity: '18.4%' },
    { item: 'Giant Rat Ear', rarity: '17.5%' },
    { item: 'Giant Rat Pelt', rarity: '67.5%' }
  ])
  assert.deepEqual(f.quests, [
    { quest: 'Rat Fur Cap Quest', page: 'Rat Fur Cap Quest' },
    { quest: 'Rat Pelt Cape Quest', page: 'Rat Pelt Cape Quest' }
  ])
})

test('a MERCHANT page yields NO drops — a vendor\'s stock is not loot', () => {
  const f = parseMobWikitext(WT_KEY_MASTER)
  assert.equal(f.pageName, 'Key Master')
  assert.equal(f.zone, 'Plane of Sky')
  // `|items_sold` is deliberately unread: claiming it as loot would be inventing drops.
  assert.equal(f.dropsWiki, undefined)
})

test('mobKey folds the three ways EQ/the wiki spell an apostrophe, and keeps the article', () => {
  assert.equal(mobKey('Innoruuk`s Chosen'), mobKey("Innoruuk's Chosen"))
  assert.equal(mobKey('Innoruuk`s Chosen'), mobKey('innoruuk’s chosen'))
  // Casing folds (a consider line sentence-cases the article, a slain line does not) …
  assert.equal(mobKey('A zol ghoul knight'), mobKey('a zol ghoul knight'))
  // … but the ARTICLE is part of the identity: "a giant rat" is a different wiki page.
  assert.notEqual(mobKey('a giant rat'), mobKey('giant rat'))
})

test('unlink keeps a wiki link\'s label, drops citation URLs, and leaves plain text alone', () => {
  assert.equal(unlink('[[Lower Guk]]'), 'Lower Guk')
  assert.equal(unlink('[[Giant Rats | Giant Rat]]'), 'Giant Rat')
  assert.equal(unlink('Various'), 'Various')
  // REGRESSION: 59 mob `|name` fields and 7 `|level` fields end in a bare archive.org citation
  // link. Leaving it glued to the name keyed the catalog under something nothing can look up.
  assert.equal(
    unlink('A Gnoll Scout[https://web.archive.org/web/20010423171339/http://eqbeastiary.allakhazam.com:80/search.shtml?id=2964]'),
    'A Gnoll Scout'
  )
  assert.equal(unlink('45[https://web.archive.org/web/2001/x?id=2926]'), '45')
  // A LABELLED external link keeps its label.
  assert.equal(unlink('[https://example.com Some Zone]'), 'Some Zone')
})

// =============================================================================
// 2b. THE SCRAPED MOB CATALOG (scripts/scrape-mobs.ts + its committed dataset)
// =============================================================================

test('isMobPage: a page that CALLS a mob template, era tag on the same line or not', () => {
  assert.equal(isMobPage(WT_ZOL_GHOUL_KNIGHT), true) // `{{Classic Era}}{{Namedmobpage` — SAME line
  assert.equal(isMobPage(WT_BARON), true) // era tag on its own line
  assert.equal(isMobPage(WT_KEY_MASTER), true) // a merchant IS a con-able NPC page
  // REGRESSION GUARD for the measured bug: a start-of-line anchor rejected 660 of the first
  // 2,145 real mob pages because the era tag precedes the template on the same line. Every era
  // prefix the wiki actually uses must still parse.
  for (const era of ['Classic', 'Kunark', 'Velious', 'Fear', 'Hate', 'Chardok Revamp', 'Paineel', 'Luclin']) {
    assert.equal(isMobPage(`{{${era} Era}}{{Namedmobpage\n| name = x\n}}`), true, era)
  }
  // The enumeration trap this filter exists for: MediaWiki reports INDIRECT transclusions, so a
  // quest page that merely SHOWS a mob box is listed as embedding Template:Namedmobpage. Its own
  // wikitext carries the COLON transclusion form, never the template call.
  assert.equal(isMobPage('{{Classic Era}}\n== Reward ==\n<ul><li>{{:A zol ghoul knight}}</li></ul>'), false)
  assert.equal(isMobPage('{{Itempage\n| itemname = Fine Steel Long Sword\n}}'), false)
})

test('parseMobPage: the compact catalog projection (names only, no drop rates)', () => {
  const e = parseMobPage('A zol ghoul knight', WT_ZOL_GHOUL_KNIGHT)
  assert.ok(e)
  assert.equal(e.page, 'A zol ghoul knight')
  // The page's OWN |name — the in-game spelling, with the lowercase article EQ prints.
  assert.equal(e.name, 'a zol ghoul knight')
  assert.equal(e.level, '36-40')
  assert.deepEqual(e.zones, ['Lower Guk'])
  assert.deepEqual(e.drops, ['Fine Steel Short Sword', 'Amber', 'Undead Froglok Tongue', 'Words of Absorption'])
  // A merchant is catalogued (level/zone are real) but has NO drops.
  const merchant = parseMobPage('Key Master', WT_KEY_MASTER)
  assert.ok(merchant)
  assert.equal(merchant.drops, undefined)
  assert.deepEqual(merchant.zones, ['Plane of Sky'])
  // …and a non-mob page yields nothing at all.
  assert.equal(parseMobPage('Druid Epic Quest', '{{Classic Era}}\n{{:A zol ghoul knight}}'), null)
})

test('splitZones: one zone, "Various", and the multi-zone separators', () => {
  assert.deepEqual(splitZones('Lower Guk'), ['Lower Guk'])
  assert.deepEqual(splitZones('Various'), ['Various'])
  assert.deepEqual(splitZones('Befallen<br>Najena'), ['Befallen', 'Najena'])
  assert.deepEqual(splitZones('Befallen, Najena'), ['Befallen', 'Najena'])
  assert.deepEqual(splitZones(undefined), [])
  assert.deepEqual(splitZones('   '), [])
})

test('mobs.json: the committed catalog is well-formed and keyed the way lookups ask', () => {
  const data = mobsJson as unknown as MobData
  assert.ok(data.mobs.length > 1000, `catalog has ${data.mobs.length} mobs`)
  assert.ok(data.scrapedAt && data.source)
  // Deterministic output: sorted by page title, so a re-scrape diffs cleanly.
  const pages = data.mobs.map((m) => m.page)
  assert.deepEqual(pages, [...pages].sort((a, b) => a.localeCompare(b)))
  // IDENTITIES, never frozen counts (the wiki grows):
  for (const m of data.mobs) {
    assert.ok(m.page && m.name, `every entry names a page and a mob: ${JSON.stringify(m)}`)
    // No wikitext blobs leaked into the compact catalog.
    assert.ok(!/[{}[\]]|<span/.test(m.name), `clean name: ${m.name}`)
    for (const d of m.drops ?? []) assert.ok(d && !/[{}]/.test(d), `clean drop name: ${d} (${m.page})`)
    for (const z of m.zones ?? []) assert.ok(z && !/\[\[/.test(z), `clean zone: ${z} (${m.page})`)
  }
  // A mob the real log conned resolves to a real drop table through the SHIPPED index.
  const zol = localMobEntry('A zol ghoul knight')
  assert.ok(zol, 'the catalog knows a mob from the real log (sentence-cased as the con prints it)')
  assert.ok((zol.drops ?? []).length > 0)
  // …and it is the SAME entry however the name is cased or spelled.
  assert.equal(localMobEntry('a zol ghoul knight')?.page, zol.page)
})

// =============================================================================
// 3. THE OWN-LOOT INDEX (mobLookup's LOCAL 1)
// =============================================================================

test('own-loot index: folds real loot lines mob → items with counts, newest lastTs wins', () => {
  const idx = new MobLootIndex()
  let seq = 0
  let folded = 0
  for (const raw of readFixture('w21-stacked.log')) {
    const ev = parseEvent(raw, seq++)
    if (ev?.kind !== 'loot') continue
    idx.note(ev.item, ev.source, ev.ts, ev.count ?? 1)
    folded++
  }
  assert.ok(folded > 0, 'the stacked-loot fixture contains loot lines')
  assert.ok(idx.size > 0, 'and at least one of them named a source mob')

  // IDENTITY: the sum of every per-mob count equals the sum of every folded loot line's count —
  // an index that lost or double-counted an item would break this regardless of the numbers.
  let byIndex = 0
  const mobs = new Set<string>()
  seq = 0
  let byLog = 0
  for (const raw of readFixture('w21-stacked.log')) {
    const ev = parseEvent(raw, seq++)
    if (ev?.kind !== 'loot' || !ev.source) continue
    mobs.add(mobKey(ev.source))
    byLog += ev.count ?? 1
  }
  for (const m of mobs) byIndex += idx.drops(m).reduce((n, d) => n + d.count, 0)
  assert.equal(byIndex, byLog)
})

test('own-loot index: stacked loots add their COUNT, and drops() sorts most-looted first', () => {
  const idx = new MobLootIndex()
  idx.note('Bone Chips', 'an elf skeleton', 1000, 2)
  idx.note('Bone Chips', 'An Elf Skeleton', 2000, 3) // casing folds onto one mob + one item
  idx.note('Rusty Dagger', "an elf skeleton", 1500)
  const drops = idx.drops('AN ELF SKELETON')
  assert.deepEqual(drops, [
    { item: 'Bone Chips', count: 5, lastTs: 2000 },
    { item: 'Rusty Dagger', count: 1, lastTs: 1500 }
  ])
  assert.equal(idx.size, 1)
})

test('own-loot index: a loot line with NO source is skipped, never filed under an empty mob', () => {
  const idx = new MobLootIndex()
  idx.note('A Mote of Potential', undefined, 1000)
  assert.equal(idx.size, 0)
  assert.deepEqual(idx.drops(''), [])
})
