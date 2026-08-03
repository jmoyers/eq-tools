/**
 * EQ Legends quest-data source: scrapes Plane of Sky class-unlock quest data from
 * the main Plane of Sky page on the EQ Legends wiki (MediaWiki at eqlwiki.com),
 * which is the server's authoritative compact table:
 *   [Quest, Quest Giver, Trigger, Rune, Quest Items, Reward]
 * and enriches each item with an EQ-style stat block from its item page.
 */
import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { PoskyData, PoskyItem, PoskyQuest } from '../../src/shared/types'
import type { QuestSource } from './types'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal quest tracker)'

const CLASSES = [
  'Bard',
  'Beastlord',
  'Berserker',
  'Cleric',
  'Druid',
  'Enchanter',
  'Magician',
  'Monk',
  'Necromancer',
  'Paladin',
  'Ranger',
  'Rogue',
  'Shadow Knight',
  'Shaman',
  'Warrior',
  'Wizard'
]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function fetchParsedHtml(title: string): Promise<string | null> {
  const url = `${API}?action=parse&page=${encodeURIComponent(
    title
  )}&prop=text&format=json&formatversion=2&redirects=1`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) return null
  const json = (await res.json()) as { parse?: { text?: string }; error?: unknown }
  if (json.error || !json.parse?.text) return null
  return json.parse.text
}

/** Collapse MediaWiki's doubled link text ("FooFoo" -> "Foo"). */
function dedupeDoubled(s: string): string {
  const t = s.trim()
  const half = t.length / 2
  if (t.length % 2 === 0 && t.slice(0, half) === t.slice(half)) return t.slice(0, half)
  return t
}

function cleanHeading(s: string): string {
  return s.replace(/\[\s*edit[^\]]*\]/gi, '').trim()
}

/** The h2/h3/h4 that opens a class's block ("Bard" or "Bard (Cilin Spellsinger)"). */
function findClassHeading($: cheerio.CheerioAPI, cls: string): AnyNode | null {
  let heading: AnyNode | null = null
  $('h2,h3,h4').each((_i, el) => {
    if (heading) return
    const t = cleanHeading($(el).text()).toLowerCase()
    if (t === cls.toLowerCase() || t.startsWith(cls.toLowerCase() + ' (')) heading = el
  })
  return heading
}

/** Walk forward from a class heading to its table, stopping at the NEXT class heading. */
function findTableAfter($: cheerio.CheerioAPI, heading: AnyNode): cheerio.Cheerio<AnyNode> | null {
  let sib = $(heading).parent().next()
  for (let steps = 0; sib.length && steps < 15; steps++, sib = sib.next()) {
    const tag = (sib[0] as unknown as { tagName?: string }).tagName?.toLowerCase()
    if (tag === 'table') return sib
    if (sib.find('table').length) return sib.find('table').first()
    if (sib.find('h2,h3,h4').length) break
  }
  return null
}

/** Column positions in the compact per-class table. Quest + Quest Items are REQUIRED. */
interface QuestColumns {
  quest: number
  giver: number
  rune: number
  items: number
  reward: number
}

function questColumns($: cheerio.CheerioAPI, table: cheerio.Cheerio<AnyNode>): QuestColumns | null {
  const headers = table
    .find('tr')
    .first()
    .find('th,td')
    .map((_i, c) => $(c).text().trim().toLowerCase())
    .get()
  const colExact = (name: string): number => headers.indexOf(name)
  const cols: QuestColumns = {
    quest: colExact('quest'),
    giver: colExact('quest giver'),
    rune: colExact('rune'),
    items: colExact('quest items'),
    reward: colExact('reward')
  }
  return cols.quest < 0 || cols.items < 0 ? null : cols
}

/** Item display name → wiki page title, read off the cell's anchors. */
function pageTitlesInCell(
  $: cheerio.CheerioAPI,
  cell: cheerio.Cheerio<AnyNode>
): Record<string, string> {
  const pageByName: Record<string, string> = {}
  cell.find('a').each((_j, a) => {
    const t = $(a).text().trim()
    const title = $(a).attr('title')?.trim()
    if (t && title) pageByName[normName(t)] = title
  })
  return pageByName
}

/**
 * Split the "Quest Items" cell into ONE text segment per item. Two layouts appear on the page:
 *   (a) the newer checkbox <ul><li> list — ONE item per <li>, e.g.
 *       "<li>Nebulous Sapphire (7-SotS)</li><li>Brass Knuckles</li>"; and
 *   (b) the older flat cell where items are <br>-separated on their own line.
 * Each item looks like "Name (island-who)", "Name (island)", or just "Name".
 *
 * The <li> layout is the efreeti-cycle blind spot (Task #46): a second required item (an
 * efreeti drop like Brass Knuckles / Efreeti War Horn) sits in its OWN <li> with NO
 * parenthetical hint, trailing a first item that HAS one. Splitting the whole cell text by
 * <br> yields a single blob, and the per-item paren regex then matches only the paren'd first
 * item, silently dropping the efreeti item. Iterating <li> boundaries first restores those
 * items. Falls back to <br> for the older flat cells (no <li>).
 */
function itemSegments($: cheerio.CheerioAPI, cell: cheerio.Cheerio<AnyNode>): string[] {
  const liEls = cell.find('li')
  if (liEls.length) {
    return liEls
      .map((_j, li) => $(li).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean)
  }
  return (cell.html() ?? '')
    .split(/<br\s*\/?>/i)
    .map((h) => cheerio.load('<x>' + h + '</x>')('x').text().replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** An item's "(island-who)" hint → the island/who pair the item window shows. */
function parseItemHint(inside: string | undefined): { where: string; who: string[] } {
  if (inside === undefined) return { where: '', who: [] }
  const dash = inside.trim().split('-')
  const island = dash[0]?.trim()
  const w = dash.slice(1).join('-').trim()
  return {
    who: w ? [w] : [],
    where: island && /^[\d.]/.test(island) ? `Island ${island}` : island ?? ''
  }
}

/** The required items a "Quest Items" cell states, in source order. */
function parseItemsCell($: cheerio.CheerioAPI, cell: cheerio.Cheerio<AnyNode>): PoskyItem[] {
  const pageByName = pageTitlesInCell($, cell)
  const items: PoskyItem[] = []
  const pushItem = (name: string, inside?: string): void => {
    const itemName = name.replace(/^[,;]+/, '').trim()
    if (!itemName) return
    const { where, who } = parseItemHint(inside)
    items.push({ name: itemName, who, where, count: 1, page: pageByName[normName(itemName)] })
  }
  for (const seg of itemSegments($, cell)) {
    const matches = [...seg.matchAll(/([^,()]+?)\s*\(([^)]+)\)/g)]
    if (matches.length) {
      for (const mm of matches) pushItem(mm[1], mm[2])
    } else {
      pushItem(seg)
    }
  }
  return items
}

/** What the Reward column states: the linked item, its wiki page, and the cell's stat text. */
interface RewardCell {
  reward?: string
  rewardStats?: string
  rewardPage?: string
}

function parseRewardCell($: cheerio.CheerioAPI, cell: cheerio.Cheerio<AnyNode> | null): RewardCell {
  if (!cell) return {}
  const anchor = cell.find('a').filter((_j, a) => !!$(a).text().trim()).first()
  const reward = anchor.length ? dedupeDoubled(anchor.text()) : undefined
  const page = anchor.attr('title')?.trim() ?? ''
  let stats = cell.text().replace(/\s+/g, ' ').trim()
  // MediaWiki doubles the linked item's text inside the cell; collapse it once.
  if (reward) stats = stats.replace(reward + reward, reward)
  return {
    reward,
    rewardStats: stats.length > 0 && stats.length < 600 ? stats : undefined,
    rewardPage: page.length > 0 ? page : undefined
  }
}

/** Everything a row needs that does not vary from row to row. */
interface RowContext {
  $: cheerio.CheerioAPI
  cls: string
  source: string
  cols: QuestColumns
  giverFromHeading: string | undefined
}

/** One table row → a quest, or null when the row is short or carries no quest name. */
function parseQuestRow(ctx: RowContext, tr: AnyNode): PoskyQuest | null {
  const { $, cols } = ctx
  const tds = $(tr).find('td,th')
  if (tds.length <= cols.items) return null
  const name = $(tds[cols.quest]).text().replace(/\s+/g, ' ').trim()
  if (!name) return null

  const colText = (col: number): string =>
    col >= 0 ? $(tds[col]).text().replace(/\s+/g, ' ').trim() : ''
  const giver = colText(cols.giver)
  const rune = colText(cols.rune)
  const reward = parseRewardCell($, cols.reward >= 0 ? $(tds[cols.reward]) : null)

  return {
    className: ctx.cls,
    name,
    // An ABSENT or empty giver cell means "the row didn't say" — fall back to the heading.
    giver: giver.length > 0 ? giver : ctx.giverFromHeading,
    rune: rune.length > 0 ? rune : undefined,
    reward: reward.reward,
    rewardStats: reward.rewardStats,
    rewardPage: reward.rewardPage,
    items: parseItemsCell($, $(tds[cols.items])),
    source: ctx.source
  }
}

/**
 * Layout B: the main "Plane of Sky" page has a uniform compact table per class
 * under an h3 heading like "Bard (Cilin Spellsinger)", with columns
 * [Quest, Quest Giver, Trigger Phrases, Rune, Quest Items, Reward].
 * Used as a fallback for classes without a usable dedicated tests page.
 */
function parseMainPageClass($: cheerio.CheerioAPI, cls: string, source: string): PoskyQuest[] {
  const heading = findClassHeading($, cls)
  if (!heading) return []

  const gm = /\(([^)]+)\)/.exec(cleanHeading($(heading).text()))
  const giverFromHeading = gm?.[1]?.trim()

  const table = findTableAfter($, heading)
  if (!table) return []
  const cols = questColumns($, table)
  if (!cols) return []

  const ctx: RowContext = { $, cls, source, cols, giverFromHeading }
  const quests: PoskyQuest[] = []
  table
    .find('tr')
    .slice(1)
    .each((_i, tr) => {
      const quest = parseQuestRow(ctx, tr)
      if (quest) quests.push(quest)
    })

  return quests
}

function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}


/** Turn a Rune-column value ("Wind Rune Meda") into required rune item(s). */
function runeItems(runeText: string): PoskyItem[] {
  return runeText
    .split(/,|\band\b/)
    .map((r) => r.trim())
    .filter((r) => /\brune\b/i.test(r))
    .map((name) => ({
      name,
      who: ['random drop — any Plane of Sky mob'],
      where: 'Plane of Sky',
      count: 1
    }))
}

/**
 * Extract the EQ-style stat block from an item's wiki page: everything from the
 * item name down to the "Drops From" section (flags, slot, damage, stats, saves).
 */
function parseItemStats(html: string, itemName: string): string | undefined {
  const $ = cheerio.load(html)
  const root = $('.mw-parser-output').first()
  if (!root.length) return undefined
  const before = root.text().split(/Drops From/i)[0] ?? ''
  const lines = before
    .split('\n')
    .map((l) => l.replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
  while (lines.length && normName(lines[0]) === normName(itemName)) lines.shift()
  const stats = lines.join('\n').trim()
  return stats && stats.length < 500 ? stats : undefined
}

/**
 * Every quest also requires the wind rune listed in the Rune column — fold it in as a
 * required item (it drops randomly from any Plane of Sky mob). A quest that already lists a
 * rune among its items is left alone.
 */
function foldRuneItems(quests: PoskyQuest[]): void {
  for (const q of quests) {
    const canonical = q.rune?.trim()
    const hasRune = q.items.some((i) => /\brune\b/i.test(i.name))
    if (canonical && !hasRune) q.items.push(...runeItems(canonical))
  }
}

/** Every wiki page an item or a reward points at, deduped. */
function itemPageTitles(all: PoskyQuest[]): Set<string> {
  const pages = new Set<string>()
  for (const q of all) {
    for (const it of q.items) if (it.page) pages.add(it.page)
    if (q.rewardPage) pages.add(q.rewardPage)
  }
  return pages
}

/** Fetch each unique item/reward wiki page ONCE (politely) and attach its stat block. */
async function attachItemStats(all: PoskyQuest[]): Promise<void> {
  const pages = itemPageTitles(all)
  console.log(`\nFetching stat blocks for ${pages.size} unique items...`)
  const statByPage = new Map<string, string>()
  let done = 0
  for (const page of pages) {
    const html = await fetchParsedHtml(page)
    if (html) {
      const stats = parseItemStats(html, page)
      if (stats) statByPage.set(page, stats)
    }
    if (++done % 25 === 0) console.log(`   ${done}/${pages.size}`)
    await sleep(110)
  }
  for (const q of all) {
    for (const it of q.items) if (it.page && statByPage.has(it.page)) it.stats = statByPage.get(it.page)
    if (q.rewardPage && statByPage.has(q.rewardPage)) q.rewardStats = statByPage.get(q.rewardPage)
  }
  console.log(`Attached stats for ${statByPage.size}/${pages.size} items.`)
}

async function scrape(): Promise<PoskyData> {
  const all: PoskyQuest[] = []

  // The main "Plane of Sky" page's compact per-class table is the authoritative
  // source: quest name, giver, trigger, wind rune, required items, and reward.
  // (The dedicated "<Class> Plane of Sky Tests" pages carry stale/older data and
  // are intentionally NOT used.)
  const mainHtml = await fetchParsedHtml('Plane of Sky')
  const $main = mainHtml ? cheerio.load(mainHtml) : null
  if (!$main) throw new Error('Could not fetch the Plane of Sky page.')

  for (const cls of CLASSES) {
    const quests = parseMainPageClass($main, cls, 'Plane of Sky')
    foldRuneItems(quests)

    const items = quests.reduce((s, q) => s + q.items.length, 0)
    if (quests.length) console.log(`  ✓ ${cls}: ${quests.length} quests, ${items} items`)
    else console.warn(`  ! ${cls}: no quests found`)
    all.push(...quests)
  }

  await attachItemStats(all)

  console.log(`\nScraped ${all.length} quests across ${new Set(all.map((q) => q.className)).size} classes.`)
  return { scrapedAt: new Date().toISOString(), quests: all }
}

export const eqlegendsSource: QuestSource = {
  id: 'eqlegends',
  label: 'EverQuest Legends (eqlwiki.com)',
  scrape
}
