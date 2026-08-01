/**
 * Scrapes Plane of Sky class-unlock quest data from the EQ Legends wiki
 * (MediaWiki at eqlwiki.com) and writes src/renderer/src/data/posky.json.
 *
 * Run offline with:  npm run scrape:posky
 *
 * Page model (validated against "Paladin Plane of Sky Tests"):
 *   h1  = quest-giver NPC              (e.g. "Gregori Lightbringer")
 *   h2  = quest name                   (e.g. "Paladin Test of Sacrifice")
 *   between h2 and its table = reward item box (name + stats)
 *   table headers [Item, Who, Where]   = required turn-in items
 */
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import * as cheerio from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { PoskyData, PoskyItem, PoskyQuest } from '../src/shared/types'

const API = 'https://eqlwiki.com/api.php'
const UA = 'eq-tools-scraper/0.1 (personal quest tracker)'

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

/** Alternate page titles to try when the canonical one is missing. */
function candidateTitles(cls: string): string[] {
  const titles = [`${cls} Plane of Sky Tests`]
  if (cls === 'Shadow Knight') titles.push('Shadowknight Plane of Sky Tests')
  return titles
}

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

const NON_QUEST_H2 = new Set(['contents', 'checklist', 'quest start', 'quest starter', 'notes'])

function isItemTable(headers: string[]): boolean {
  const h = headers.map((x) => x.toLowerCase())
  return h.includes('item') && h.includes('who') && h.includes('where')
}

function parseClassPage(cls: string, html: string, sourceTitle: string): PoskyQuest[] {
  const $ = cheerio.load(html)
  const quests: PoskyQuest[] = []

  // Walk h1/h2/table in document order.
  const nodes = $('h1, h2, table').toArray()
  let giver: string | undefined
  let pendingQuest: { name: string; headingEl: AnyNode } | null = null

  for (const el of nodes) {
    const tag = (el as unknown as { tagName: string }).tagName?.toLowerCase()

    if (tag === 'h1') {
      giver = cleanHeading($(el).text())
      continue
    }
    if (tag === 'h2') {
      const name = cleanHeading($(el).text())
      pendingQuest = NON_QUEST_H2.has(name.toLowerCase()) ? null : { name, headingEl: el }
      continue
    }
    if (tag === 'table') {
      const headerCells = $(el)
        .find('tr')
        .first()
        .find('th,td')
        .map((_i, c) => $(c).text().trim())
        .get()
      if (!isItemTable(headerCells) || !pendingQuest) continue

      const idx = headerCells.map((h) => h.toLowerCase())
      const itemCol = idx.indexOf('item')
      const whoCol = idx.indexOf('who')
      const whereCol = idx.indexOf('where')

      const items: PoskyItem[] = []
      $(el)
        .find('tr')
        .slice(1)
        .each((_i, tr) => {
          const tds = $(tr).find('td,th')
          if (tds.length < 3) return
          const name = $(tds[itemCol]).text().replace(/\s+/g, ' ').trim()
          if (!name) return
          const who = $(tds[whoCol])
            .text()
            .replace(/\s+/g, ' ')
            .trim()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          const page = $(tds[itemCol]).find('a').first().attr('title')?.trim()
          items.push({
            name,
            who,
            where: $(tds[whereCol]).text().replace(/\s+/g, ' ').trim(),
            count: 1,
            page: page || undefined
          })
        })

      if (items.length === 0) continue

      // Reward = first item link between the heading and this table.
      const range = $(pendingQuest.headingEl).parent().nextUntil(el)
      const rewardAnchor = range.find('a').filter((_i, a) => !!$(a).text().trim()).first()
      const reward = rewardAnchor.length ? dedupeDoubled(rewardAnchor.text()) : undefined
      const rewardPage = rewardAnchor.attr('title')?.trim()
      let rewardStats = range.text().replace(/\n{2,}/g, '\n').replace(/[ \t]{2,}/g, ' ').trim() || undefined
      if (reward && rewardStats) rewardStats = rewardStats.replace(reward + reward, reward)

      quests.push({
        className: cls,
        name: pendingQuest.name,
        giver,
        reward,
        rewardStats: rewardStats && rewardStats.length < 600 ? rewardStats : undefined,
        rewardPage: rewardPage || undefined,
        items,
        source: sourceTitle
      })
      pendingQuest = null
    }
  }

  return quests
}

/**
 * Layout B: the main "Plane of Sky" page has a uniform compact table per class
 * under an h3 heading like "Bard (Cilin Spellsinger)", with columns
 * [Quest, Quest Giver, Trigger Phrases, Rune, Quest Items, Reward].
 * Used as a fallback for classes without a usable dedicated tests page.
 */
function parseMainPageClass($: cheerio.CheerioAPI, cls: string, source: string): PoskyQuest[] {
  // Find the class heading ("Bard (Cilin Spellsinger)").
  let heading: AnyNode | null = null
  $('h2,h3,h4').each((_i, el) => {
    if (heading) return
    const t = cleanHeading($(el).text()).toLowerCase()
    if (t === cls.toLowerCase() || t.startsWith(cls.toLowerCase() + ' (')) heading = el
  })
  if (!heading) return []

  const gm = /\(([^)]+)\)/.exec(cleanHeading($(heading).text()))
  const giverFromHeading = gm?.[1]?.trim()

  // Walk forward to the next table (stop at the next class heading).
  let sib = $(heading).parent().next()
  let table: cheerio.Cheerio<AnyNode> | null = null
  for (let steps = 0; sib.length && steps < 15; steps++, sib = sib.next()) {
    const tag = (sib[0] as unknown as { tagName?: string }).tagName?.toLowerCase()
    if (tag === 'table') {
      table = sib
      break
    }
    if (sib.find('table').length) {
      table = sib.find('table').first()
      break
    }
    if (sib.find('h2,h3,h4').length) break
  }
  if (!table) return []

  const headers = table
    .find('tr')
    .first()
    .find('th,td')
    .map((_i, c) => $(c).text().trim().toLowerCase())
    .get()
  const colExact = (name: string): number => headers.indexOf(name)
  const cQuest = colExact('quest')
  const cGiver = colExact('quest giver')
  const cRune = colExact('rune')
  const cItems = colExact('quest items')
  const cReward = colExact('reward')
  if (cQuest < 0 || cItems < 0) return []

  const quests: PoskyQuest[] = []
  table
    .find('tr')
    .slice(1)
    .each((_i, tr) => {
      const tds = $(tr).find('td,th')
      if (tds.length <= cItems) return
      const name = $(tds[cQuest]).text().replace(/\s+/g, ' ').trim()
      if (!name) return

      // Map item name -> wiki page title from the cell's anchors.
      const pageByName: Record<string, string> = {}
      $(tds[cItems])
        .find('a')
        .each((_j, a) => {
          const t = $(a).text().trim()
          const title = $(a).attr('title')?.trim()
          if (t && title) pageByName[normName(t)] = title
        })

      // Parse the "Quest Items" cell: entries look like "Name (island-who)".
      const itemsText = $(tds[cItems]).text().replace(/\s+/g, ' ').trim()
      const items: PoskyItem[] = []
      const re = /([^,()]+?)\s*\(([^)]+)\)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(itemsText))) {
        const itemName = m[1].replace(/^[,;]+/, '').trim()
        const inside = m[2].trim()
        const dash = inside.split('-')
        const island = dash[0]?.trim()
        const who = dash.slice(1).join('-').trim()
        if (itemName) {
          items.push({
            name: itemName,
            who: who ? [who] : [],
            where: island && /^[\d.]/.test(island) ? `Island ${island}` : island ?? '',
            count: 1,
            page: pageByName[normName(itemName)]
          })
        }
      }
      if (items.length === 0 && itemsText) {
        items.push({ name: itemsText, who: [], where: '', count: 1, page: pageByName[normName(itemsText)] })
      }

      const rune = cRune >= 0 ? $(tds[cRune]).text().replace(/\s+/g, ' ').trim() : undefined
      const giver = cGiver >= 0 ? $(tds[cGiver]).text().replace(/\s+/g, ' ').trim() : giverFromHeading
      const rewardCell = cReward >= 0 ? $(tds[cReward]) : null
      const rewardAnchor = rewardCell?.find('a').filter((_j, a) => !!$(a).text().trim()).first()
      const reward = rewardAnchor?.length ? dedupeDoubled(rewardAnchor.text()) : undefined
      const rewardPage = rewardAnchor?.attr('title')?.trim()
      let rewardStats = rewardCell?.text().replace(/\s+/g, ' ').trim()
      if (reward && rewardStats) rewardStats = rewardStats.replace(reward + reward, reward)

      quests.push({
        className: cls,
        name,
        giver: giver || giverFromHeading,
        rune: rune || undefined,
        reward,
        rewardStats: rewardStats && rewardStats.length < 600 ? rewardStats : undefined,
        rewardPage: rewardPage || undefined,
        items,
        source
      })
    })

  return quests
}

function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
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

async function main(): Promise<void> {
  const all: PoskyQuest[] = []

  // Fetch the overview page once. Its compact per-class table is both the fallback
  // item source for classes without a dedicated page AND the source of the wind
  // rune that every class quest requires.
  const mainHtml = await fetchParsedHtml('Plane of Sky')
  const $main = mainHtml ? cheerio.load(mainHtml) : null

  const compactByClass: Record<string, PoskyQuest[]> = {}
  for (const cls of CLASSES) compactByClass[cls] = $main ? parseMainPageClass($main, cls, 'Plane of Sky') : []

  // Quest name -> rune string, across every class.
  const runeByQuest = new Map<string, string>()
  for (const cls of CLASSES)
    for (const q of compactByClass[cls]) if (q.rune) runeByQuest.set(`${cls}::${normName(q.name)}`, q.rune)

  for (const cls of CLASSES) {
    let quests: PoskyQuest[] = []
    let usedTitle = ''

    // Layout A: dedicated tests page with Item/Who/Where tables (richest drop data).
    for (const title of candidateTitles(cls)) {
      const html = await fetchParsedHtml(title)
      if (html) {
        const parsed = parseClassPage(cls, html, title)
        if (parsed.length) {
          quests = parsed
          usedTitle = title
          break
        }
      }
      await sleep(120)
    }

    // Layout B: fall back to the compact table on the main page.
    if (quests.length === 0) {
      quests = compactByClass[cls]
      usedTitle = 'Plane of Sky (compact)'
    }

    // Every Plane of Sky class quest also requires a wind rune. Some dedicated
    // pages already list it (with inconsistent casing like "rune neza"); the rest
    // need it folded in from the compact table's Rune column. Normalize either way
    // so a quest never shows the rune twice.
    for (const q of quests) {
      const canonical = (runeByQuest.get(`${cls}::${normName(q.name)}`) ?? q.rune)?.trim()
      const existing = q.items.findIndex((i) => /\brune\b/i.test(i.name))
      if (existing >= 0) {
        q.items[existing].name = canonical || titleCase(q.items[existing].name)
        q.items[existing].who = ['random drop — any Plane of Sky mob']
        q.items[existing].where = 'Plane of Sky'
      } else if (canonical) {
        for (const ri of runeItems(canonical)) q.items.push(ri)
      }
    }

    const items = quests.reduce((s, q) => s + q.items.length, 0)
    if (quests.length) console.log(`  ✓ ${cls}: ${quests.length} quests, ${items} items  (${usedTitle})`)
    else console.warn(`  ! ${cls}: no quests found`)
    all.push(...quests)
    await sleep(200)
  }

  // Fetch each unique item/reward wiki page once and attach its stat block.
  const pages = new Set<string>()
  for (const q of all) {
    for (const it of q.items) if (it.page) pages.add(it.page)
    if (q.rewardPage) pages.add(q.rewardPage)
  }
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

  const data: PoskyData = { scrapedAt: new Date().toISOString(), quests: all }
  const here = dirname(fileURLToPath(import.meta.url))
  const outPath = resolve(here, '../src/renderer/src/data/posky.json')
  writeFileSync(outPath, JSON.stringify(data, null, 2))
  console.log(
    `\nWrote ${all.length} quests across ${new Set(all.map((q) => q.className)).size} classes → ${outPath}`
  )
}

void main()
