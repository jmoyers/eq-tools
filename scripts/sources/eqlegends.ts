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

      // Parse the "Quest Items" cell. Two layouts appear on the page:
      //   (a) the newer checkbox <ul><li> list — ONE item per <li>, e.g.
      //       "<li>Nebulous Sapphire (7-SotS)</li><li>Brass Knuckles</li>"; and
      //   (b) the older flat cell where items are <br>-separated on their own line.
      // Each item looks like "Name (island-who)", "Name (island)", or just "Name".
      //
      // The <li> layout is the efreeti-cycle blind spot (Task #46): a second required
      // item (an efreeti drop like Brass Knuckles / Efreeti War Horn) sits in its OWN
      // <li> with NO parenthetical hint, trailing a first item that HAS one. Splitting
      // the whole cell text by <br> yields a single blob, and the per-item paren regex
      // then matches only the paren'd first item, silently dropping the efreeti item.
      // Iterating <li> boundaries first restores those items. Falls back to <br> for
      // the older flat cells (no <li>).
      const itemsCell = $(tds[cItems])
      const cellHtml = itemsCell.html() ?? ''
      const liEls = itemsCell.find('li')
      const segments = liEls.length
        ? liEls
            .map((_j, li) => $(li).text().replace(/\s+/g, ' ').trim())
            .get()
            .filter(Boolean)
        : cellHtml
            .split(/<br\s*\/?>/i)
            .map((h) => cheerio.load('<x>' + h + '</x>')('x').text().replace(/\s+/g, ' ').trim())
            .filter(Boolean)

      const items: PoskyItem[] = []
      const pushItem = (name: string, inside?: string): void => {
        const itemName = name.replace(/^[,;]+/, '').trim()
        if (!itemName) return
        let where = ''
        let who: string[] = []
        if (inside !== undefined) {
          const dash = inside.trim().split('-')
          const island = dash[0]?.trim()
          const w = dash.slice(1).join('-').trim()
          who = w ? [w] : []
          where = island && /^[\d.]/.test(island) ? `Island ${island}` : island ?? ''
        }
        items.push({ name: itemName, who, where, count: 1, page: pageByName[normName(itemName)] })
      }

      for (const seg of segments) {
        const matches = [...seg.matchAll(/([^,()]+?)\s*\(([^)]+)\)/g)]
        if (matches.length) {
          for (const mm of matches) pushItem(mm[1], mm[2])
        } else {
          pushItem(seg)
        }
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

    // Every quest also requires the wind rune listed in the Rune column — fold it
    // in as a required item (it drops randomly from any Plane of Sky mob).
    for (const q of quests) {
      const canonical = q.rune?.trim()
      const hasRune = q.items.some((i) => /\brune\b/i.test(i.name))
      if (canonical && !hasRune) for (const ri of runeItems(canonical)) q.items.push(ri)
    }

    const items = quests.reduce((s, q) => s + q.items.length, 0)
    if (quests.length) console.log(`  ✓ ${cls}: ${quests.length} quests, ${items} items`)
    else console.warn(`  ! ${cls}: no quests found`)
    all.push(...quests)
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

  console.log(`\nScraped ${all.length} quests across ${new Set(all.map((q) => q.className)).size} classes.`)
  return { scrapedAt: new Date().toISOString(), quests: all }
}

export const eqlegendsSource: QuestSource = {
  id: 'eqlegends',
  label: 'EverQuest Legends (eqlwiki.com)',
  scrape
}
