/**
 * Wiki QUEST-CATALOG scraper — the item-first quest index (companion to scrape-posky).
 *
 *   npm run scrape:quests            # incremental: reuses the on-disk wikitext cache
 *   npm run scrape:quests -- --refresh   # ignore the cached index/pages, re-fetch all
 *
 * WHY: item pages only name a quest when someone filled in their `|relatedquests` field,
 * so classic turn-in items look quest-less from the item side (in the user's live cache:
 * 44 quest-flagged items, 10 with ZERO quest uses). The linkage lives on the QUEST pages
 * — this scrapes them once, offline, and commits the index.
 *
 * WHAT IT DOES
 *  1. Enumerates the quest-page universe: Category:Quests, its subcategories (one level),
 *     and every other category whose name ENDS in "Quest"/"Quests" (Repeatable Turn-in
 *     Quests, Ak'Anon Quests, Faydwer Quests — none of which are subcategories of
 *     Category:Quests). Categories that merely CONTAIN "Quest" are deliberately excluded:
 *     "Epic Quests Era" is an era tag holding 340 mob pages, not quests.
 *  2. Enumerates the wiki's ITEM-TITLE set: every page embedding Template:Itempage
 *     (~18.4k) plus Category:Quest Items (~4k). Category:Quest Items alone is NOT enough —
 *     Gnome Meat / Troll Parts / Spider Legs are QUEST ITEM-flagged pages that sit in
 *     Category:Inventory Items, so filtering prose links by that category would silently
 *     drop them.
 *  3. Fetches each quest page's wikitext (disk-cached) and runs the PURE parser in
 *     ./sources/questPage.ts.
 *  4. Writes src/renderer/src/data/eqlegends/quests.json, sorted by page title
 *     (deterministic), consumed by src/main/itemLookup.ts as a local-first source.
 *
 * Scraper etiquette (AGENTS.md LAW): one serialized request at a time with a 110ms delay,
 * exponential backoff honouring Retry-After on 429/5xx, disk cache so a re-run is nearly
 * free, and partial runs resume instead of duplicating work.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { isEmptyParse, parseQuestPage, type ParsedQuestPage } from './sources/questPage'
import type { QuestData, QuestEntry } from '../src/shared/types'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal quest tracker)'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(HERE, 'sources/cache/quests')
const OUT_PATH = resolve(HERE, '../src/renderer/src/data/eqlegends/quests.json')

const DELAY_MS = 110
const MAX_RETRIES = 5

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const refresh = process.argv.slice(2).includes('--refresh')

// ---- polite API client ---------------------------------------------------------

/** Wait before a retry: the server's Retry-After when it gave a usable one, else our backoff. */
function retryDelayMs(res: Response, backoff: number): number {
  const retryAfter = Number(res.headers.get('retry-after'))
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff
}

/** Which request failed, for the thrown message — whichever identifying param it carried. */
function describeRequest(params: Record<string, string>): string {
  return `${params.action} ${params.cmtitle ?? params.eititle ?? params.pageid ?? ''}`
}

/** One serialized GET with exponential backoff on 429/5xx (honours Retry-After). */
async function api<T>(params: Record<string, string>): Promise<T> {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString()}`
  let wait = 1000
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA } })
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err
      await sleep(wait)
      wait *= 2
      continue
    }
    if (res.ok) {
      await sleep(DELAY_MS)
      return (await res.json()) as T
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(res, wait))
      wait *= 2
      continue
    }
    throw new Error(`${res.status} ${res.statusText} for ${describeRequest(params)}`)
  }
}

interface Member {
  pageid: number
  ns: number
  title: string
}

/** All members of a category, following cmcontinue. */
async function categoryMembers(title: string): Promise<Member[]> {
  const out: Member[] = []
  let cont: string | undefined
  for (let page = 0; page < 100; page++) {
    const params: Record<string, string> = {
      action: 'query',
      list: 'categorymembers',
      cmtitle: title,
      cmlimit: '500'
    }
    if (cont) params.cmcontinue = cont
    const j = await api<{ query?: { categorymembers?: Member[] }; continue?: { cmcontinue?: string } }>(params)
    out.push(...(j.query?.categorymembers ?? []))
    cont = j.continue?.cmcontinue
    if (!cont) break
  }
  return out
}

/** Every category on the wiki (allcategories), used to find quest categories generically. */
async function allCategories(): Promise<string[]> {
  const out: string[] = []
  let cont: string | undefined
  for (let page = 0; page < 100; page++) {
    const params: Record<string, string> = { action: 'query', list: 'allcategories', aclimit: '500' }
    if (cont) params.accontinue = cont
    const j = await api<{
      query?: { allcategories?: { category: string }[] }
      continue?: { accontinue?: string }
    }>(params)
    out.push(...(j.query?.allcategories ?? []).map((c) => c.category))
    cont = j.continue?.accontinue
    if (!cont) break
  }
  return out
}

// ---- disk cache ----------------------------------------------------------------

function cachePath(name: string): string {
  return resolve(CACHE_DIR, name)
}

/** Cached JSON, or null when absent/unreadable/`--refresh`. The CALLER names the shape. */
function readCache(name: string): unknown {
  if (refresh) return null
  const p = cachePath(name)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as unknown
  } catch {
    return null
  }
}

function writeCache(name: string, data: unknown): void {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cachePath(name), JSON.stringify(data), 'utf8')
}

/** Page wikitext, cached per pageid so a re-run costs no requests. */
async function fetchWikitext(pageid: number): Promise<string | null> {
  const file = cachePath(`page-${pageid}.wikitext`)
  if (!refresh && existsSync(file)) return readFileSync(file, 'utf8')
  const j = await api<{ parse?: { wikitext?: string }; error?: { code?: string } }>({
    action: 'parse',
    pageid: String(pageid),
    prop: 'wikitext',
    redirects: '1'
  })
  const wt = j.parse?.wikitext
  if (j.error || wt == null) return null
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(file, wt, 'utf8')
  return wt
}

// ---- universe enumeration ------------------------------------------------------

/** Categories that ARE quest lists: Category:Quests + anything ending in "Quest(s)". */
function questCategoryNames(all: string[]): string[] {
  const names = all
    .filter((c) => /\bquests?$/i.test(c))
    .filter((c) => !/^quest items$/i.test(c))
    .map((c) => `Category:${c}`)
  return [...new Set(names)].sort()
}

async function collectQuestPages(): Promise<Member[]> {
  const cached = readCache('quest-pages.json') as Member[] | null
  if (cached) {
    console.log(`Quest pages: ${cached.length} (cached)`)
    return cached
  }
  console.log('Enumerating quest categories…')
  const cats = questCategoryNames(await allCategories())
  console.log(`  ${cats.length} quest categories: ${cats.map((c) => c.replace('Category:', '')).join(', ')}`)

  const byTitle = new Map<string, Member>()
  const seenCats = new Set<string>()
  const queue = [...cats]
  // Category:Quests carries subcategories; walk ONE level down from any listed category.
  // `queue` GROWS during this loop — an array iterator re-reads length on every step, so
  // subcategories pushed below are visited by this same for-of.
  for (const cat of queue) {
    if (seenCats.has(cat)) continue
    seenCats.add(cat)
    const members = await categoryMembers(cat)
    let added = 0
    for (const m of members) {
      if (m.ns === 0 && !byTitle.has(m.title)) {
        byTitle.set(m.title, m)
        added++
      } else if (m.ns === 14 && !seenCats.has(m.title) && /\bquests?$/i.test(m.title)) {
        queue.push(m.title)
      }
    }
    console.log(`  ${cat}: ${members.length} members (+${added} pages)`)
  }
  const pages = [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title))
  writeCache('quest-pages.json', pages)
  console.log(`Quest pages: ${pages.length}`)
  return pages
}

/**
 * The item-page categories. `embeddedin Template:Itempage` looks like the obvious source
 * and is NOT usable: MediaWiki's templatelinks records INDIRECT transclusions, so every
 * NPC page that shows an item box (`{{:Gnome Meat}}`) is reported as embedding Itempage —
 * 18.4k "item pages" that include Guard Oystin, Crushbone and Venril Sathir. Filtering
 * prose links with that set dragged mobs and zones into requiredItems. The item CATEGORIES
 * are authored on the item pages themselves and stay clean (~11.2k titles).
 */
const ITEM_CATEGORIES = [
  'Category:Items',
  'Category:Inventory Items',
  'Category:Quest Items',
  'Category:Player Crafted'
]

/** Lowercased title set of every ITEM page on the wiki (the prose-link filter). */
async function collectItemTitles(): Promise<Set<string>> {
  const cached = readCache('item-titles.json') as string[] | null
  if (cached) {
    console.log(`Item titles: ${cached.length} (cached)`)
    return new Set(cached)
  }
  const titles = new Set<string>()
  for (const cat of ITEM_CATEGORIES) {
    const members = await categoryMembers(cat)
    let added = 0
    for (const p of members) {
      if (p.ns !== 0) continue
      const key = p.title.toLowerCase()
      if (!titles.has(key)) {
        titles.add(key)
        added++
      }
    }
    console.log(`  ${cat}: ${members.length} members (+${added} titles)`)
  }
  const sorted = [...titles].sort()
  writeCache('item-titles.json', sorted)
  console.log(`Item titles: ${sorted.length}`)
  return titles
}

// ---- main ----------------------------------------------------------------------

/**
 * Why this page is NOT a quest, or null when it is one.
 *
 * Category:Quests also holds INDEX pages ("Popular Quests by Level", "Class Race Quest
 * List") — no quest header at all, just hundreds of item links. Indexing those would tie
 * every listed item to a page that is not a quest.
 */
function nonQuestReason(parsed: ParsedQuestPage): string | null {
  const indexPage =
    !parsed.hasTopTable && !parsed.giver && !parsed.startZone && parsed.requiredItems.length > 40
  if (parsed.disambiguation && isEmptyParse(parsed)) return 'disambiguation hub'
  if (indexPage) return `index/list page (${parsed.requiredItems.length} item links, no quest header)`
  if (isEmptyParse(parsed)) return 'no quest fields parsed'
  return null
}

/** Project a parsed page into a catalog entry — ONLY the fields the page actually stated. */
function toQuestEntry(parsed: ParsedQuestPage): QuestEntry {
  const entry: QuestEntry = { name: parsed.page, page: parsed.page }
  if (parsed.startZone) entry.startZone = parsed.startZone
  if (parsed.giver) entry.giver = parsed.giver
  if (parsed.minLevel != null) entry.minLevel = parsed.minLevel
  if (parsed.classes.length) entry.classes = parsed.classes
  if (parsed.relatedZones.length) entry.relatedZones = parsed.relatedZones
  if (parsed.relatedNpcs.length) entry.relatedNpcs = parsed.relatedNpcs
  if (parsed.rewards.length) entry.rewards = parsed.rewards.map((name) => ({ name }))
  if (parsed.requiredItems.length) entry.requiredItems = parsed.requiredItems
  if (parsed.expReward) entry.expReward = true
  return entry
}

function printSummary(quests: QuestEntry[], skipped: { page: string; reason: string }[]): void {
  const indexed = new Set<string>()
  let reqCount = 0
  let rewCount = 0
  for (const q of quests) {
    for (const r of q.requiredItems ?? []) {
      indexed.add(r.toLowerCase())
      reqCount++
    }
    for (const r of q.rewards ?? []) {
      indexed.add(r.name.toLowerCase())
      rewCount++
    }
  }
  console.log(`\nWrote ${quests.length} quests → ${OUT_PATH}`)
  console.log(
    `  items indexed: ${indexed.size} unique (${reqCount} required refs, ${rewCount} reward refs)  ` +
      `givers: ${quests.filter((q) => q.giver).length}  exp: ${quests.filter((q) => q.expReward).length}`
  )
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} pages (nothing parsed):`)
    for (const s of skipped) console.log(`  - ${s.page} — ${s.reason}`)
  }
}

async function main(): Promise<void> {
  const itemTitles = await collectItemTitles()
  const isItem = (title: string): boolean => itemTitles.has(title.toLowerCase().replace(/\s+/g, ' ').trim())

  const pages = await collectQuestPages()
  console.log(`\nFetching + parsing ${pages.length} quest pages…`)

  const quests: QuestEntry[] = []
  const skipped: { page: string; reason: string }[] = []
  let done = 0
  for (const p of pages) {
    let wt: string | null = null
    try {
      wt = await fetchWikitext(p.pageid)
    } catch (err) {
      skipped.push({ page: p.title, reason: `fetch failed: ${(err as Error).message}` })
    }
    if (wt == null) {
      if (!skipped.some((s) => s.page === p.title)) skipped.push({ page: p.title, reason: 'no wikitext' })
    } else {
      const parsed = parseQuestPage(p.title, wt, isItem)
      const reason = nonQuestReason(parsed)
      if (reason) skipped.push({ page: p.title, reason })
      else quests.push(toQuestEntry(parsed))
    }
    if (++done % 100 === 0) console.log(`  ${done}/${pages.length}`)
  }

  quests.sort((a, b) => a.page.localeCompare(b.page))
  const out: QuestData = {
    scrapedAt: new Date().toISOString(),
    source: 'eqlwiki.com — Category:Quests + quest subcategories',
    quests
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))

  printSummary(quests, skipped)
}

void main()
