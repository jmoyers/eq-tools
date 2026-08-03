// itemLookup.ts — "what's this lore/quest item for" knowledge service (Task #53).
//
// Answers, for an item the player looted, whether it's a LORE item and which quests
// it's used in — the "you picked up a coin off the ground, what's it for" question.
// (Ground pickups don't log a line; this keys off the parsed `loot` family. See the
// acquisition-line sweep in the Task #53 notes — the loot family is the ONLY
// item-into-inventory line the log carries.)
//
// DESIGN (per AGENTS.md "Data sources & scrapers" + the Task #34 spell-DB precedent):
//   1. LOCAL-FIRST. The scraped Plane of Sky dataset (posky.json) already knows every
//      Sky class-Test quest item + its quests + giver. Check it BEFORE any network so
//      a known Sky rune/claw/etc. answers INSTANTLY and offline. Its associations are
//      merged with any the wiki adds (deduped).
//   2. WIKI lookup (MediaWiki at eqlwiki.com, same API the posky/spell scrapers use):
//      search → resolve the item page → parse its {{Itempage}} wikitext for the
//      LORE/QUEST flags (statsblock) + the |relatedquests bulleted link list +
//      |notes summary. Polite: a single serialized in-flight queue with a small
//      inter-request delay (mirrors scripts/sources/eqlegends.ts sleep(110)).
//   3. PERSISTENT CACHE in userData (versioned JSON). Negative results (no page) and
//      offline misses are cached too (offline with a short TTL so we retry soon;
//      real negatives for ~7 days). A cache hit never touches the network.
//
// The PURE classification (wikitext → ItemKnowledge fields) is `parseItemWikitext`,
// unit-tested in tests/itemLookup.test.mts against verbatim real wikitext.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logError } from './errorLog'
import { normalizeItemName, parseItemWikitext } from './itemLookupParse'
import type { ItemKnowledge, ItemQuestUse, PoskyData, QuestData } from '../shared/types'

export { normalizeItemName, parseItemWikitext }
// The scraped Plane of Sky dataset is the local-first source. Imported directly so
// electron-vite INLINES it into the main bundle (same reason spells.json is imported,
// not readFileSync'd — a path-relative read misses it in out/main/ in production).
import poskyJson from '../renderer/src/data/eqlegends/posky.json'
// …and the scraped wiki QUEST CATALOG (scripts/scrape-quests.ts) is the second local
// source. Item pages only name a quest when their |relatedquests field was filled in, so
// classic turn-in items (Dwarven Ale, Guard Bracelet, …) read as quest-less from the item
// side; this catalog is built the other way round — from the quest pages themselves.
import questsJson from '../renderer/src/data/eqlegends/quests.json'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal quest tracker)'

// Bumped to 2 when the local quest catalog (quests.json) joined posky as a local source:
// the cache stores the MERGED ItemKnowledge (see `finish()`), and positive entries never
// expire, so every item cached before the catalog existed would otherwise keep serving its
// stale zero-quest answer for the item-page fields. A version mismatch drops the whole file
// (loadCache), so the next lookup re-merges against the new index.
const CACHE_VERSION = 2
const NEG_TTL_MS = 7 * 24 * 60 * 60 * 1000 // negative results: retry after 7 days
const OFFLINE_TTL_MS = 30 * 60 * 1000 // offline misses: retry after 30 min
const REQUEST_SPACING_MS = 150 // polite inter-request delay (wiki)
const REQUEST_TIMEOUT_MS = 8000

// ---- normalization ------------------------------------------------------------

function cacheKey(name: string): string {
  return normalizeItemName(name).toLowerCase()
}

// ---- local (posky) cross-ref --------------------------------------------------

const posky = poskyJson as unknown as PoskyData

/**
 * Index the Plane of Sky dataset by normalized item name → the quests that require it.
 * This is the offline, already-known answer for every Sky class-Test item (runes,
 * Sphinx Claw, Nebulous Sapphire, efreeti drops, …).
 */
const poskyByItem = new Map<string, ItemQuestUse[]>()
for (const q of posky.quests) {
  for (const it of q.items) {
    const key = cacheKey(it.name)
    const uses = poskyByItem.get(key) ?? []
    // De-dupe by quest identity (className + name) — the same item appears under many quests.
    const quest = `${q.className} · ${q.name}`
    if (!uses.some((u) => u.quest === quest)) {
      uses.push({ quest, page: q.source, source: 'posky', giver: q.giver })
    }
    poskyByItem.set(key, uses)
  }
}

// ---- local (wiki quest catalog) cross-ref --------------------------------------

const questData = questsJson as unknown as QuestData

/**
 * Index the scraped quest catalog by normalized item name → the quests that use it, from
 * BOTH sides of a quest: its turn-in/collectible items (role 'required') and the items it
 * hands out (role 'reward'). This is the answer for every classic turn-in item whose own
 * wiki page never listed a quest.
 */
const questsByItem = new Map<string, ItemQuestUse[]>()
for (const q of questData.quests) {
  const add = (itemName: string, role: 'required' | 'reward'): void => {
    const key = cacheKey(itemName)
    const uses = questsByItem.get(key) ?? []
    if (!uses.some((u) => u.page === q.page && u.role === role)) {
      const use: ItemQuestUse = { quest: q.name, page: q.page, source: 'quests', role }
      if (q.giver) use.giver = q.giver
      if (q.startZone) use.zone = q.startZone
      uses.push(use)
    }
    questsByItem.set(key, uses)
  }
  for (const it of q.requiredItems ?? []) add(it, 'required')
  for (const r of q.rewards ?? []) add(r.name, 'reward')
}

/** Quest identity for de-duping across sources: drop a "Class · " prefix + fold case. */
function questIdentity(s: string): string {
  return s
    .replace(/^[^·]*·\s*/, '')
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Local-first answer: the Plane of Sky dataset FIRST (it carries per-item island/giver
 * detail), then the wiki quest catalog, deduped by quest identity. Null when neither
 * local source knows this item.
 */
export function localKnowledge(name: string): ItemQuestUse[] | null {
  const key = cacheKey(name)
  const posky = poskyByItem.get(key)
  const quests = questsByItem.get(key)
  if (!posky && !quests) return null
  const uses: ItemQuestUse[] = [...(posky ?? [])]
  for (const u of quests ?? []) {
    const nu = questIdentity(u.quest)
    if (!uses.some((x) => questIdentity(x.quest) === nu)) uses.push(u)
  }
  return uses
}

// ---- wiki client (search → wikitext) ------------------------------------------

/**
 * Server-asked-us-to-back-off state. When the wiki answers 429 (or any 5xx), we honour its
 * Retry-After (seconds; falls back to 60s when absent/unparseable) by refusing to issue ANY
 * request until the cooldown passes — the whole serialized queue goes quiet, not just the one
 * item. During the cooldown apiFetch returns null, which callers already treat as "offline":
 * the item caches as a short-TTL miss and is retried later, so being polite costs nothing.
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
    return null // offline / abort / parse error — caller distinguishes null via the throw path
  } finally {
    clearTimeout(t)
  }
}

/** Fetch a page's raw wikitext. Returns '' when the page doesn't exist, null on network error. */
async function fetchWikitext(title: string): Promise<string | null | ''> {
  const j = (await apiFetch({ action: 'parse', page: title, prop: 'wikitext', redirects: '1' })) as
    | { parse?: { wikitext?: string }; error?: { code?: string } }
    | null
  if (j === null) return null // network error (offline)
  if (j.error) return '' // missingtitle etc. — a real negative
  return j.parse?.wikitext ?? ''
}

/**
 * Resolve an item name to its wiki page title via search. Distinguishes a NETWORK failure
 * ('offline' — retry soon) from a genuine ZERO-hit search ('none' — a real negative, cache
 * for the full TTL). Prefers an exact case-insensitive title match, else the top hit.
 */
type ResolveResult = { status: 'ok'; title: string } | { status: 'none' } | { status: 'offline' }
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
  const lower = name.toLowerCase()
  const exact = hits.find((h) => h.title.toLowerCase() === lower)
  return { status: 'ok', title: (exact ?? hits[0]).title }
}

// ---- persistent cache (userData, versioned) -----------------------------------

interface CacheEntry {
  at: number
  data: ItemKnowledge
}
interface CacheFile {
  version: number
  entries: Record<string, CacheEntry>
}

let mem: Map<string, CacheEntry> | null = null

function cacheFilePath(): string {
  return join(app.getPath('userData'), 'item-knowledge-cache.json')
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
    logError('main:itemLookup', { message: 'failed reading item-knowledge cache', err })
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
      logError('main:itemLookup', { message: 'failed writing item-knowledge cache', err })
    }
  }, 1500)
}

/** A cache entry is usable when it's a positive result, or a still-fresh negative/offline. */
function cacheHit(entry: CacheEntry): boolean {
  const age = Date.now() - entry.at
  if (entry.data.offline) return age < OFFLINE_TTL_MS
  if (entry.data.notFound) return age < NEG_TTL_MS
  return true // positive results don't expire (item lore/quest data is static)
}

// ---- merge + public API -------------------------------------------------------

/** Merge the LOCAL associations (posky + quest catalog) into a knowledge record; local
 *  wins on identity, so the wiki's `|relatedquests` links only ADD quests we didn't know. */
function mergeLocal(base: Omit<ItemKnowledge, 'cached'>, local: ItemQuestUse[] | null): Omit<ItemKnowledge, 'cached'> {
  if (!local || local.length === 0) return base
  const uses = [...local]
  // Avoid listing the same quest twice. posky labels a quest "Class · Quest Name" where the
  // name often ALREADY carries the class ("Paladin · Paladin Test of Love"), while the wiki
  // link label is the bare "Paladin Test of Love". So compare with the class prefix stripped
  // (drop everything up to a "·") and de-dupe when one normalized name contains the other.
  const norm = questIdentity
  for (const u of base.questUses) {
    const nu = norm(u.quest)
    if (!uses.some((x) => { const nx = norm(x.quest); return nx === nu || nx.includes(nu) || nu.includes(nx) })) uses.push(u)
  }
  return { ...base, quest: true, questUses: uses }
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * Look up an item's knowledge. Local-first (posky), then cache, then a serialized,
 * politely-spaced wiki lookup. Never throws — failures degrade to a cached-negative /
 * offline record (which still carries any posky-local answer).
 */
export async function lookupItem(name: string): Promise<ItemKnowledge> {
  const key = cacheKey(name)
  const display = normalizeItemName(name)
  const local = localKnowledge(name)
  const cache = loadCache()

  const cached = cache.get(key)
  if (cached && cacheHit(cached)) {
    // Re-merge local in case the dataset changed since the cache was written.
    return { ...mergeLocal(cached.data, local), cached: true }
  }

  // Build a knowledge record + persist it to the cache. `extra` carries the
  // notFound/offline flag (or the parsed fields on success). Local posky is always merged.
  const finish = (extra: Partial<Omit<ItemKnowledge, 'cached' | 'name'>>): ItemKnowledge => {
    const base = mergeLocal(
      { name: display, lore: false, quest: (local?.length ?? 0) > 0, questUses: [], ...extra },
      local
    )
    const data: ItemKnowledge = { ...base, cached: false }
    cache.set(key, { at: Date.now(), data })
    scheduleSave()
    return data
  }

  // Serialize wiki requests through a single queue with polite spacing.
  const run = queue.then(async (): Promise<ItemKnowledge> => {
    const res = await resolvePage(display)
    if (res.status === 'offline') return finish({ offline: true }) // network failed — retry soon
    if (res.status === 'none') return finish({ notFound: true }) // zero search hits — real negative
    const wt = await fetchWikitext(res.title)
    if (wt === null) return finish({ offline: true }) // network failed on the page fetch
    if (wt === '') return finish({ notFound: true }) // page missing
    return finish({ page: res.title, ...parseItemWikitext(display, wt) })
  })

  // Keep the queue serialized + spaced regardless of this call's outcome.
  queue = run.then(
    () => new Promise((r) => setTimeout(r, REQUEST_SPACING_MS)),
    () => new Promise((r) => setTimeout(r, REQUEST_SPACING_MS))
  )

  try {
    return await run
  } catch (err) {
    logError('main:itemLookup', { message: `lookup failed for ${display}`, err })
    // Degrade to an offline record (still carries local posky) — but don't persist it as a
    // negative; a thrown error is transient, so the next call should retry the network.
    return { ...mergeLocal({ name: display, lore: false, quest: (local?.length ?? 0) > 0, questUses: [], offline: true }, local), cached: false }
  }
}

/**
 * Fire-and-forget prefetch: warm the cache for a freshly-looted item in the background
 * so the answer is ready by the time the user clicks. No-op if already cached. Throttled
 * naturally by the shared serialized queue.
 */
export function prefetchItem(name: string): void {
  const key = cacheKey(name)
  const cache = loadCache()
  const cached = cache.get(key)
  if (cached && cacheHit(cached)) return
  void lookupItem(name).catch(() => {
    /* prefetch errors are silent — the interactive lookup will retry + surface state */
  })
}
