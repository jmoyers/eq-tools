/**
 * Wiki MOB-CATALOG scraper — what every mob DROPS (Task #63; companion to scrape-quests).
 *
 *   npm run scrape:mobs                # incremental: reuses the on-disk wikitext cache
 *   npm run scrape:mobs -- --refresh   # ignore the cached index/pages, re-fetch everything
 *
 * WHY A SCRAPED CATALOG AND NOT (ONLY) A LIVE LOOKUP: the wiki's drop list is the DEFINITIVE
 * answer to "what does this drop", and a `/con` needs that answer instantly, offline, and
 * without a network round trip per mob you happen to look at. So it is scraped once, committed,
 * and read locally — the same local-first precedent posky.json and quests.json set.
 * `src/main/mobLookup.ts` still keeps its polite live lookup as the FALLBACK, for a mob whose
 * page was created after the last refresh.
 *
 * ENUMERATION (probed against the live wiki, 2026-08-03). Four candidate sources were measured:
 *   Category:NPCs                          7,879 ns0 pages  (+ subcats Merchants / Named Mobs /
 *                                          Raid Encounters, which it already contains)
 *   Category:Named Mobs                    6,518 ns0 pages  (a subset of the above)
 *   embeddedin Template:Namedmobpage       6,516 pages      (INCLUDES INDIRECT transclusions —
 *                                          "Druid Epic Quest" is in this list because it shows a
 *                                          mob box; the same trap scrape-quests hit with
 *                                          Template:Itempage's 18,366)
 *   embeddedin Template:MerchantPage       1,361 pages      (same caveat)
 * SETTLED ON: the UNION of all four, then a per-page filter that requires the page's OWN
 * wikitext to open `{{Namedmobpage}}` or `{{MerchantPage}}` (`isMobPage`, sources/mobPage.ts).
 * The union costs nothing but a few index requests and catches a mob page missing from either
 * the category or the template index; the direct-template filter is what makes over-broad
 * enumeration safe, so quest/zone/index pages are dropped by evidence instead of by a guess.
 *
 * Scraper etiquette (AGENTS.md LAW): one serialized request at a time with a 110ms delay,
 * exponential backoff honouring Retry-After on 429/5xx, a disk cache under
 * scripts/sources/cache/mobs so a re-run is nearly free, and partial runs resume rather than
 * duplicating work. Output is sorted by page title, so a re-scrape produces a clean diff.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { isMobPage, parseMobPage } from './sources/mobPage'
import type { MobData, MobEntry } from '../src/shared/types'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal quest tracker)'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(HERE, 'sources/cache/mobs')
const OUT_PATH = resolve(HERE, '../src/renderer/src/data/eqlegends/mobs.json')

const DELAY_MS = 110
const MAX_RETRIES = 5

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const refresh = process.argv.slice(2).includes('--refresh')

// ---- polite API client (identical contract to scrape-quests.ts) ------------------

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

/** All ns0 members of a category, following cmcontinue. */
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

/** Every ns0 page that (directly or indirectly) transcludes a template. */
async function embeddedIn(template: string): Promise<Member[]> {
  const out: Member[] = []
  let cont: string | undefined
  for (let page = 0; page < 100; page++) {
    const params: Record<string, string> = {
      action: 'query',
      list: 'embeddedin',
      eititle: template,
      einamespace: '0',
      eilimit: '500'
    }
    if (cont) params.eicontinue = cont
    const j = await api<{ query?: { embeddedin?: Member[] }; continue?: { eicontinue?: string } }>(params)
    out.push(...(j.query?.embeddedin ?? []))
    cont = j.continue?.eicontinue
    if (!cont) break
  }
  return out
}

// ---- disk cache ------------------------------------------------------------------

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

// ---- universe enumeration --------------------------------------------------------

/** Categories the mob universe lives in. Subcategories of NPCs are listed explicitly so a
 *  future re-parent of one of them can't silently shrink the corpus. */
const MOB_CATEGORIES = [
  'Category:NPCs',
  'Category:Named Mobs',
  'Category:Merchants',
  'Category:Raid Encounters'
]
const MOB_TEMPLATES = ['Template:Namedmobpage', 'Template:MerchantPage']

async function collectCandidatePages(): Promise<Member[]> {
  const cached = readCache('mob-pages.json') as Member[] | null
  if (cached) {
    console.log(`Candidate pages: ${cached.length} (cached)`)
    return cached
  }
  const byTitle = new Map<string, Member>()
  for (const cat of MOB_CATEGORIES) {
    const members = await categoryMembers(cat)
    let added = 0
    for (const m of members) {
      if (m.ns !== 0 || byTitle.has(m.title)) continue
      byTitle.set(m.title, m)
      added++
    }
    console.log(`  ${cat}: ${members.length} members (+${added} new)`)
  }
  for (const tpl of MOB_TEMPLATES) {
    const members = await embeddedIn(tpl)
    let added = 0
    for (const m of members) {
      if (m.ns !== 0 || byTitle.has(m.title)) continue
      byTitle.set(m.title, m)
      added++
    }
    console.log(`  embeddedin ${tpl}: ${members.length} pages (+${added} new)`)
  }
  const pages = [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title))
  writeCache('mob-pages.json', pages)
  console.log(`Candidate pages: ${pages.length}`)
  return pages
}

// ---- main ------------------------------------------------------------------------

/** A page that carried a mob template but produced nothing, or couldn't be read at all. */
interface PageSkip {
  reason: string
}

/**
 * One candidate page → a mob entry, the counted 'not-mob' verdict, or a LOGGED skip reason.
 * Every non-entry outcome is named here so `main` never has to guess why a page vanished.
 */
async function readMobPage(p: Member): Promise<MobEntry | 'not-mob' | PageSkip> {
  let wt: string | null
  try {
    wt = await fetchWikitext(p.pageid)
  } catch (err) {
    return { reason: `fetch failed: ${(err as Error).message}` }
  }
  if (wt == null) return { reason: 'no wikitext' }
  // Expected and NUMEROUS: `embeddedin` reports indirect transclusions, so quest/zone/index
  // pages that merely show a mob box land in the candidate list. Counted, not enumerated.
  if (!isMobPage(wt)) return 'not-mob'
  return parseMobPage(p.title, wt) ?? { reason: 'mob template present but nothing parsed' }
}

interface RunSummary {
  mobs: MobEntry[]
  pageCount: number
  notMob: number
  /** Every skipped page is LOGGED with its reason — a silent skip hides a parser gap. */
  skipped: { page: string; reason: string }[]
  startedAt: number
}

function printSummary(s: RunSummary): void {
  const withDrops = s.mobs.filter((m) => m.drops?.length)
  const dropEdges = s.mobs.reduce((n, m) => n + (m.drops?.length ?? 0), 0)
  const distinctItems = new Set<string>()
  for (const m of s.mobs) for (const d of m.drops ?? []) distinctItems.add(d.toLowerCase())
  const mins = ((Date.now() - s.startedAt) / 60000).toFixed(1)
  console.log(`\nWrote ${s.mobs.length} mobs → ${OUT_PATH}  (${mins} min)`)
  console.log(
    `  pages enumerated: ${s.pageCount}   parsed as mobs: ${s.mobs.length}   not a mob page: ${s.notMob}   skipped: ${s.skipped.length}`
  )
  console.log(
    `  drop edges: ${dropEdges} across ${withDrops.length} mobs (${distinctItems.size} distinct items)  ` +
      `levels: ${s.mobs.filter((m) => m.level).length}  zones: ${s.mobs.filter((m) => m.zones?.length).length}`
  )
  if (s.skipped.length) {
    console.log(`\nSkipped ${s.skipped.length} pages:`)
    for (const row of s.skipped.slice(0, 50)) console.log(`  - ${row.page} — ${row.reason}`)
    if (s.skipped.length > 50) console.log(`  … and ${s.skipped.length - 50} more`)
  }
}

async function main(): Promise<void> {
  const started = Date.now()
  console.log('Enumerating the mob universe…')
  const pages = await collectCandidatePages()
  console.log(`\nFetching + parsing ${pages.length} candidate pages…`)

  const mobs: MobEntry[] = []
  const skipped: { page: string; reason: string }[] = []
  let done = 0
  let notMob = 0
  for (const p of pages) {
    const outcome = await readMobPage(p)
    if (outcome === 'not-mob') notMob++
    else if ('reason' in outcome) skipped.push({ page: p.title, reason: outcome.reason })
    else mobs.push(outcome)
    if (++done % 250 === 0) console.log(`  ${done}/${pages.length}  (mobs so far: ${mobs.length})`)
  }

  mobs.sort((a, b) => a.page.localeCompare(b.page))
  const out: MobData = {
    scrapedAt: new Date().toISOString(),
    source:
      'eqlwiki.com — Category:NPCs/Named Mobs/Merchants/Raid Encounters ∪ embeddedin Template:Namedmobpage/MerchantPage, filtered to pages opening a mob template',
    mobs
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))

  printSummary({ mobs, pageCount: pages.length, notMob, skipped, startedAt: started })
}

void main()
