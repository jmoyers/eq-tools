// mobLookup.ts — "what does this thing drop" knowledge service (Task #63).
//
// Answers, for a mob the player just `/con`ed, what it drops — the "I sized this up, is it
// worth killing" question. Keyed off the parsed `consider` family (main/log/parser.ts).
//
// DESIGN — deliberately the SAME architecture as itemLookup.ts (Task #53), field for field, so
// there is one shape of knowledge service in this tree and not two:
//   1. LOCAL-FIRST, three times over. The drop table is NOT fetched per mob in the normal case.
//      a) The scraped MOB CATALOG (`mobs.json`, scripts/scrape-mobs.ts) — the DEFINITIVE drop
//         source, and the one that answers a `/con` instantly and offline. The wiki's drop list
//         is what the mob can drop; it is static content, so it is scraped once and committed,
//         exactly as posky.json and quests.json are.
//      b) YOUR OWN loot history for that mob (`MobLootIndex`, mobLookupParse.ts). The loot
//         family carries the corpse's mob name in `source`, so the app knows what this mob has
//         actually handed YOU, with counts and a last-seen. This is CORROBORATION, not the drop
//         table: it annotates a listed drop with "and you've had 3", and only contributes names
//         of its own for items the page doesn't list (see the UI ordering rule below).
//      c) The scraped wiki QUEST CATALOG's `relatedNpcs` (quests.json), which ties 1,121
//         distinct NPC names to the quests that mention them — so a quest-relevant mob says so
//         with no network at all.
//   2. WIKI lookup — now the FALLBACK, for a mob the catalog doesn't have (a page created since
//      the last `npm run scrape:mobs`, or a name the catalog spells differently). Same MediaWiki
//      API: search → resolve the mob page → parse `|known_loot` / `|level` / `|zone` /
//      `|related_quests` (parseMobWikitext). Polite: a single serialized in-flight queue with a
//      150ms spacing and the SAME Retry-After cooldown contract — a 429/5xx silences the whole
//      queue until the server's cooldown expires (AGENTS.md "Scraper etiquette" is a LAW).
//   3. PERSISTENT CACHE in userData (versioned JSON), negative + offline TTLs, for that fallback
//      only. A catalog hit never touches the cache OR the network.
//
// UI ORDERING (stated here because it is a claim about AUTHORITY, not a layout preference):
// every surface leads with the wiki drop table and annotates it with your counts; items only
// your history has follow as a clearly-labeled secondary list.
//
// WHY ITS OWN QUEUE AND COOLDOWN rather than importing itemLookup's: they are separate
// FILES by ownership and separate CACHES by content (a mob page and an item page share
// nothing), and two serialized queues each spaced 150ms is still two requests in flight at
// most — comfortably polite. The cooldown contract is per-service for the same reason it is
// per-service in itemLookup: the state is "this client was told to be quiet", and honoring it
// twice independently can only make us quieter, never louder.
//
// HONESTY (law 1): every field of a MobKnowledge is present only because a source stated it. A
// mob with no wiki page comes back `notFound` with whatever the two local sources knew — never
// a synthesized drop list, never a guessed level.
//
// The PURE half (wikitext → facts, the own-loot index, the name key) is mobLookupParse.ts,
// unit-tested against verbatim real wikitext in tests/considerWindows.test.mts.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logError } from './errorLog'
import { MobLootIndex, mobKey, parseMobWikitext } from './mobLookupParse'
import { knowledgeFromCatalog, localMobEntry, localMobQuests } from './mobLookupLocal'
import type { MobKnowledge } from '../shared/types'

export { MobLootIndex, mobKey, parseMobWikitext }

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal quest tracker)'

/** Cache schema version. Bump whenever the SHAPE of a stored MobKnowledge changes — positives
 *  never expire, so a stale shape would otherwise be served forever. */
const CACHE_VERSION = 1
const NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000 // negative results: retry after 7 days
const OFFLINE_TTL_MS = 30 * 60 * 1000 // offline misses: retry after 30 min
const REQUEST_SPACING_MS = 150 // polite inter-request delay (wiki)
const REQUEST_TIMEOUT_MS = 8000

// ---- LOCAL 1: the shared own-loot index ---------------------------------------
//
// ONE instance for the whole process: the ConsiderModule folds every loot event into it (it is
// character-scoped + epoch-scoped and reset alongside the other module state), and `lookupMob`
// reads it, so the IPC hover card and the module's own enrichment can never disagree.
export const ownLoot = new MobLootIndex()

// ---- LOCAL 1 + 2: the COMMITTED datasets ---------------------------------------
//
// The mob catalog (definitive drop table) and the quest catalog's relatedNpcs cross-ref both
// live in mobLookupLocal.ts — electron-free, so tests can drive the SHIPPED indexes directly.
// Re-exported here so this module stays the one door callers knock on.
export { localMobEntry, localMobQuests, MOB_CATALOG_SIZE } from './mobLookupLocal'

// ---- wiki client (search → wikitext) ------------------------------------------

/**
 * Server-asked-us-to-back-off state — the same contract itemLookup honors. On 429 (or any 5xx)
 * we obey Retry-After (seconds; 60s fallback) by refusing to issue ANY request until it passes:
 * the whole serialized queue goes quiet, not just the one mob. During the cooldown apiFetch
 * returns null, which callers treat as "offline" — the mob caches as a short-TTL miss and is
 * retried later, so being polite costs nothing.
 */
let cooldownUntil = 0
const RETRY_AFTER_FALLBACK_MS = 60_000

async function apiFetch(params: Record<string, string>): Promise<unknown | null> {
  if (Date.now() < cooldownUntil) return null // server asked for quiet — stay quiet
  const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params }).toString()
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_AFTER_FALLBACK_MS
      cooldownUntil = Date.now() + waitMs
      return null
    }
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null // offline / abort / parse error
  } finally {
    clearTimeout(t)
  }
}

/** Fetch a page's raw wikitext. '' when the page doesn't exist, null on network error. */
async function fetchWikitext(title: string): Promise<string | null | ''> {
  const j = (await apiFetch({ action: 'parse', page: title, prop: 'wikitext', redirects: '1' })) as
    | { parse?: { wikitext?: string }; error?: { code?: string } }
    | null
  if (j === null) return null
  if (j.error) return ''
  return j.parse?.wikitext ?? ''
}

/**
 * Resolve a mob name to candidate wiki page titles. Distinguishes a NETWORK failure ('offline')
 * from a genuine ZERO-hit search ('none' — a real negative worth caching for the full TTL).
 *
 * Returns the EXACT case-insensitive title match first when there is one, else the top hit —
 * but see `lookupMob`: unlike an item, a non-exact top hit is only ACCEPTED once the fetched
 * page's own `|name` field agrees with the mob we asked about. Mob names are short, generic and
 * heavily overlapping ("A noxious spider" ⇒ 0 hits; "Statham" ⇒ 0 hits; a fuzzy hit could
 * easily be a different creature), and attaching one mob's drop list to another would be
 * exactly the kind of invention law 1 forbids.
 */
type ResolveResult =
  | { status: 'ok'; title: string; exact: boolean }
  | { status: 'none' }
  | { status: 'offline' }
async function resolvePage(name: string): Promise<ResolveResult> {
  const j = (await apiFetch({
    action: 'query',
    list: 'search',
    srsearch: name,
    srlimit: '8'
  })) as { query?: { search?: Array<{ title: string }> } } | null
  if (j === null) return { status: 'offline' }
  const hits = j.query?.search ?? []
  if (hits.length === 0) return { status: 'none' }
  const key = mobKey(name)
  const exact = hits.find((h) => mobKey(h.title) === key)
  if (exact) return { status: 'ok', title: exact.title, exact: true }
  return { status: 'ok', title: hits[0].title, exact: false }
}

// ---- persistent cache (userData, versioned) -----------------------------------

interface CacheEntry {
  at: number
  /** the WIKI half only — local sources are re-merged on every read so they stay current. */
  data: MobKnowledge
}
interface CacheFile {
  version: number
  entries: Record<string, CacheEntry>
}

let mem: Map<string, CacheEntry> | null = null

function cacheFilePath(): string {
  return join(app.getPath('userData'), 'mob-knowledge-cache.json')
}

function loadCache(): Map<string, CacheEntry> {
  if (mem) return mem
  mem = new Map()
  try {
    const path = cacheFilePath()
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as CacheFile
      if (parsed && parsed.version === CACHE_VERSION && parsed.entries) {
        for (const [k, v] of Object.entries(parsed.entries)) mem.set(k, v)
      }
    }
  } catch (err) {
    logError('main:mobLookup', { message: 'failed reading mob-knowledge cache', err })
  }
  return mem
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const entries: Record<string, CacheEntry> = {}
      for (const [k, v] of (mem ?? new Map()).entries()) entries[k] = v
      writeFileSync(cacheFilePath(), JSON.stringify({ version: CACHE_VERSION, entries } satisfies CacheFile), 'utf8')
    } catch (err) {
      logError('main:mobLookup', { message: 'failed writing mob-knowledge cache', err })
    }
  }, 1500)
}

/** Usable when it's a positive result, or a still-fresh negative/offline one. */
function cacheHit(entry: CacheEntry): boolean {
  const age = Date.now() - entry.at
  if (entry.data.offline) return age < OFFLINE_TTL_MS
  if (entry.data.notFound) return age < NEG_TTL_MS
  return true // a mob's drop table is static wiki content — positives don't expire
}

// ---- merge + public API -------------------------------------------------------

/**
 * Attach the two LOCAL sources to a (possibly cached) wiki record. Done on EVERY read, never
 * baked into the cache: your own loot history changes with every corpse, and the quest catalog
 * ships with the app, so caching either would immediately be stale.
 */
function mergeLocal(base: MobKnowledge, name: string): MobKnowledge {
  const out: MobKnowledge = { ...base }
  const seen = ownLoot.drops(name)
  if (seen.length) out.dropsSeen = seen
  else delete out.dropsSeen
  const quests = localMobQuests(name)
  // The wiki page's own `|related_quests` links and the catalog's `relatedNpcs` are two views of
  // the same relation, so de-dupe by quest name; local wins (it carries the giver + zone).
  if (quests) {
    const merged = [...quests]
    for (const u of base.quests ?? []) {
      if (!merged.some((x) => x.quest.toLowerCase() === u.quest.toLowerCase())) merged.push(u)
    }
    out.quests = merged
  }
  return out
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Look up a mob's drop knowledge. Local-first, then cache, then a serialized, politely-spaced
 * wiki lookup. NEVER throws — failures degrade to a cached-negative / offline record that still
 * carries whatever the local sources knew.
 */
export async function lookupMob(name: string): Promise<MobKnowledge> {
  const display = name.trim()
  const key = mobKey(display)

  // LOCAL 1 FIRST: the committed catalog is the definitive drop table and needs no network, no
  // cache and no queue. This is the normal path — the fallback below exists for the tail.
  const entry = localMobEntry(display)
  if (entry) return mergeLocal(knowledgeFromCatalog(display, entry), display)

  const cache = loadCache()
  const cached = cache.get(key)
  if (cached && cacheHit(cached)) return mergeLocal({ ...cached.data, cached: true }, display)

  /** Build + persist the WIKI half, then merge the (never-cached) local half on top. */
  const finish = (extra: Partial<MobKnowledge>): MobKnowledge => {
    const data: MobKnowledge = { name: display, cached: false, ...extra }
    cache.set(key, { at: Date.now(), data })
    scheduleSave()
    return mergeLocal(data, display)
  }

  const run = queue.then(async (): Promise<MobKnowledge> => {
    const res = await resolvePage(display)
    if (res.status === 'offline') return finish({ offline: true })
    if (res.status === 'none') return finish({ notFound: true })
    const wt = await fetchWikitext(res.title)
    if (wt === null) return finish({ offline: true })
    if (wt === '') return finish({ notFound: true })
    const facts = parseMobWikitext(wt)
    // IDENTITY GATE for a non-exact search hit: accept it only when the page says it IS this
    // mob. Search happily returns a cousin for a name it doesn't have, and hanging that
    // cousin's drop table off this mob would be inventing loot (law 1).
    if (!res.exact && mobKey(facts.pageName ?? res.title) !== key) return finish({ notFound: true })
    return finish({ page: res.title, ...facts })
  })

  // Keep the queue serialized + spaced regardless of this call's outcome.
  queue = run.then(
    () => new Promise((r) => setTimeout(r, REQUEST_SPACING_MS)),
    () => new Promise((r) => setTimeout(r, REQUEST_SPACING_MS))
  )

  try {
    return await run
  } catch (err) {
    logError('main:mobLookup', { message: `lookup failed for ${display}`, err })
    // A thrown error is transient — degrade to offline WITHOUT persisting a negative, so the
    // next call retries the network (same rule itemLookup follows).
    return mergeLocal({ name: display, cached: false, offline: true }, display)
  }
}
