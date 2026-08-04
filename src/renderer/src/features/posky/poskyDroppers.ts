// poskyDroppers.ts — "which mob do I kill for this?" for every Plane of Sky quest item.
//
// The tracker already said WHAT you need and HOW MANY. It could not say WHO DROPS IT in words a
// player can act on: `PoskyItem.who` (from `scripts/scrape-posky.ts`) is what the wiki's quest
// tables literally print, and those tables use SITE ABBREVIATIONS, not names. MEASURED over the
// committed posky.json (2026-08-03, 95 quests / 222 item rows / 128 distinct items) the field
// holds exactly nine distinct values:
//
//   95 "random drop — any Plane of Sky mob"   18 "SL"   17 "BZ"   17 "SotS"   16 "Gorga"
//   16 "EoV"   13 "KoS"   2 "PoS"   2 "Trash"
//
// NONE of them is a mob the catalog knows (checked by exact case-insensitive name against all
// 7,866 rows — "Gorga" is not "Gorgalosk"). So the scrape states a source but never a kill
// target, and "Dropped by: SL" is not an answer.
//
// The answer is already committed elsewhere: `data/eqlegends/mobs.json` carries each mob page's
// `|known_loot`. Invert it — item name -> the mobs that drop it — and the kill target falls out
// by NAME, offline, with no new scrape and no wiki call. Same local-first posture as
// mobSearch.ts, over the identical file.
//
// TWO LAYERS, in authority order (both are committed data; neither guesses):
//   1. an explicit dropper the posky scrape NAMES — used only when the catalog knows a mob by
//      that name. Contributes nothing today (see the nine values above) and is kept because it
//      is the higher authority the moment a future scrape writes real names.
//   2. the reverse index over the catalog.
// An item neither layer resolves gets an EMPTY list — the caller shows nothing rather than a
// guess (law 1). That is 18 of the 128 items: the 15 Wind Runes (which posky already, correctly,
// calls a random drop — there IS no kill target), plus Azarack Blood / Azarack Skin /
// Large Sky Lapis, which no catalog page lists.
//
// SKY-ONLY IS A CORRECTNESS GATE, NOT A PREFERENCE. Item names collide across the game, and a
// non-Sky page's loot list is evidence about a DIFFERENT item. Measured: restricting layer 2 to
// mobs whose zones include Plane of Sky changes the resolved set by exactly ONE item —
// `Bixie Stinger`, which the unrestricted index answers with "a bixie (Kithicor Forest)",
// "a bixie drone" … while posky says Island 6 / BZ and the item's own wiki page opens with
// "Were you looking for Bixie Stinger (Bixie God's Stinger)?". The gate costs one row and the
// row it costs was WRONG. `buildDropperIndex` stays general so the test can pin that.
//
// The reverse index INDEPENDENTLY VALIDATES the scrape's abbreviations — each code maps onto one
// catalog mob with no crossing (SL→The Spiroc Lord ×18, SotS→Sister of the Spire ×17,
// Gorga→Gorgalosk ×16, EoV→Eye of Veeshan ×15, KoS→Keeper of Souls ×13, BZ→the Bazzt Zzzt
// family ×15). Two independent sources agreeing is why this ships without a hand-authored
// abbreviation table (which would be a guess about six strings).
//
// COST. The singleton indexes only the 65 Plane of Sky mobs, and does it ONCE, lazily, on the
// first lookup. MEASURED (throwaway probe, same day): 2.31 ms cold — dominated by the single
// pass over all 7,866 rows that finds those 65, not by the inversion — and 0.43 µs warm, which
// is one Map.get. (Inverting the WHOLE catalog's 32,777 drop entries costs 8.10 ms, so even the
// unrestricted build would have been affordable; the restriction is about correctness, above.)
//
// Pure + React-free by design: node-tested in `tests/poskyDroppers.test.mts` against the REAL
// committed catalog, which is why the value imports below are RELATIVE (the repo-wide
// mobSearch.ts precedent — the `@shared/*` alias exists only inside the vite build).

import type { MobEntry } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'
import { MOB_CATALOG } from '../mobs/mobSearch'

/** The catalog's spelling of the zone this whole tab is about. */
export const SKY_ZONE = 'Plane of Sky'

/** How many droppers a row names inline before it collapses the rest into "+N more". */
export const DROPPER_DISPLAY_CAP = 3

/**
 * One mob that drops an item, as the catalog states it. A projection of `MobEntry`, not the row
 * itself: the drop list is the part we already consumed, and a caller rendering a kill target
 * only ever wants identity + where + how hard.
 */
export interface DropperMob {
  /** RAW in-game name, article and casing exactly as the catalog writes it (law 2: display raw). */
  name: string
  /** wiki page title — the stable id, and what a future MobPage route would resolve. */
  page: string
  /** level EXACTLY as the page states it: a RANGE as often as a number ("63+", "58"). */
  level?: string
  /** the page's home zone(s). Never empty for anything this module returns. */
  zones: string[]
  /**
   * The catalog ROW this projection came from, carried so a click can route to the mob page
   * (`MobTarget.entry`). A name alone can name several pages — MobsView's search results pin
   * the identity half of the page with the row the user actually picked, and a kill target
   * resolved from that same catalog has no reason to be vaguer than a search hit.
   */
  entry: MobEntry
}

/** item counting key -> the mobs that drop it, deduped and deterministically ordered. */
export type DropperIndex = ReadonlyMap<string, DropperMob[]>

/** lowercased mob name -> that mob. Layer 1's resolver. */
export type MobNameIndex = ReadonlyMap<string, DropperMob>

/** Does the catalog place this mob in the Plane of Sky? Exact zone match — never a substring:
 *  "Skyfire Mountains" and "Skyshrine" both contain "sky" and are different places entirely. */
export function isSkyMob(m: Pick<MobEntry, 'zones'>): boolean {
  return (m.zones ?? []).some((z) => z.toLowerCase() === SKY_ZONE.toLowerCase())
}

function toDropper(m: MobEntry): DropperMob {
  const out: DropperMob = { name: m.name, page: m.page, zones: m.zones ?? [], entry: m }
  if (m.level) out.level = m.level
  return out
}

/** Deterministic, source-order-independent: by name (case-folded), then page as the tiebreak.
 *  Nothing in the catalog ranks droppers, so inventing an importance order would be a guess. */
function byName(a: DropperMob, b: DropperMob): number {
  const an = a.name.toLowerCase()
  const bn = b.name.toLowerCase()
  if (an !== bn) return an < bn ? -1 : 1
  return a.page < b.page ? -1 : a.page > b.page ? 1 : 0
}

/**
 * Invert a mob list into item -> droppers.
 *
 * Keys are `itemCountKey` (lowercased, ` +N` stripped) so a lookup folds the upgrade variants the
 * rest of the tracker already folds — ask for `Sphinx Claw +1` and you get Sphinx Claw's dropper.
 * (The catalog itself lists zero ` +N` names today; the folding is on the QUERY side.)
 */
export function buildDropperIndex(mobs: readonly MobEntry[]): DropperIndex {
  const idx = new Map<string, DropperMob[]>()
  for (const m of mobs) {
    for (const drop of m.drops ?? []) {
      const key = itemCountKey(drop)
      if (key === '') continue
      const list = idx.get(key)
      if (list) list.push(toDropper(m))
      else idx.set(key, [toDropper(m)])
    }
  }
  for (const list of idx.values()) list.sort(byName)
  return idx
}

/** Mob rows keyed by lowercased name, for resolving a dropper the scrape named outright. */
export function buildMobNameIndex(mobs: readonly MobEntry[]): MobNameIndex {
  const idx = new Map<string, DropperMob>()
  for (const m of mobs) {
    const key = m.name.toLowerCase()
    if (!idx.has(key)) idx.set(key, toDropper(m))
  }
  return idx
}

/** The droppers an index knows for an item name. Empty when it knows none — never a guess. */
export function droppersFor(itemName: string, index: DropperIndex): DropperMob[] {
  return index.get(itemCountKey(itemName)) ?? []
}

/**
 * LAYER 1 — droppers the posky scrape NAMED, kept only when the catalog confirms the name is a
 * mob. An unconfirmed string ("SL", "random drop — any Plane of Sky mob") is dropped here and
 * survives untouched in `PoskyItem.who`, which the UI still shows.
 */
export function statedDroppers(who: readonly string[] | undefined, names: MobNameIndex): DropperMob[] {
  const out: DropperMob[] = []
  const seen = new Set<string>()
  for (const w of who ?? []) {
    const hit = names.get(w.trim().toLowerCase())
    if (!hit || seen.has(hit.page)) continue
    seen.add(hit.page)
    out.push(hit)
  }
  return out
}

/** Merge the two layers, layer 1 first (authority), deduped by page. */
export function mergeDroppers(stated: readonly DropperMob[], indexed: readonly DropperMob[]): DropperMob[] {
  const out = [...stated]
  const seen = new Set(out.map((m) => m.page))
  for (const m of indexed) {
    if (seen.has(m.page)) continue
    seen.add(m.page)
    out.push(m)
  }
  return out
}

/** What a row shows inline, and how many it had to hold back. */
export interface DropperDisplay {
  shown: DropperMob[]
  /** count beyond `shown` — 0 when everything fits. */
  more: number
}

export function dropperDisplay(
  droppers: readonly DropperMob[],
  cap: number = DROPPER_DISPLAY_CAP
): DropperDisplay {
  return { shown: droppers.slice(0, cap), more: Math.max(0, droppers.length - cap) }
}

/** The one-line inline text: names up to the cap, then the overflow count. Empty for none. */
export function dropperLabel(droppers: readonly DropperMob[], cap: number = DROPPER_DISPLAY_CAP): string {
  const { shown, more } = dropperDisplay(droppers, cap)
  const names = shown.map((m) => m.name).join(', ')
  return more > 0 ? `${names} +${more} more` : names
}

/** "Noble Dojorn · level 63+ · Plane of Sky" — every fact the catalog states, none invented. */
export function dropperFacts(m: DropperMob): string {
  const parts = [m.name]
  if (m.level) parts.push(`level ${m.level}`)
  if (m.zones.length > 0) parts.push(m.zones.join(', '))
  return parts.join(' · ')
}

// ---- WHERE: the island, from posky's own stated field ----
//
// "show which mob AND ISLAND they are on at a top level without needing to mouse over" (owner).
// The island is NOT inferred and NOT parsed out of prose: `PoskyItem.where` is a STATED field
// ("island / location string from the wiki", shared/types.ts), and over the committed posky.json
// it holds exactly three shapes across 222 item rows — `Island 2..8` (103 rows), `Plane of Sky`
// (95 rows, every one of them a wind rune, i.e. the honest "anywhere") and `""` (24 rows). So the
// matcher below is deliberately narrow: an explicit island NUMBER or nothing at all. "Plane of
// Sky" is not an island and must never be dressed up as one.

const ISLAND_RE = /\bisland\s+(\d+)\b/i

/** The island a stated `where` names, normalized to "Island N". Undefined when it names none. */
export function islandOf(where: string | undefined): string | undefined {
  const m = ISLAND_RE.exec(where ?? '')
  return m ? `Island ${m[1]}` : undefined
}

/** Ascending by island NUMBER (so 10 would sort after 9, which a string sort gets wrong). */
function islandNo(island: string): number {
  return Number(ISLAND_RE.exec(island)?.[1] ?? 0)
}

/** "Island 3" / "Islands 3, 5" — a LIST, never a range: a quest whose items sit on islands 3 and
 *  6 must not read as though island 4 and 5 were involved. Empty string for none stated. */
export function islandLabel(islands: readonly string[]): string {
  const sorted = [...new Set(islands)].sort((a, b) => islandNo(a) - islandNo(b))
  if (sorted.length === 0) return ''
  if (sorted.length === 1) return sorted[0]
  return `Islands ${sorted.map((i) => String(islandNo(i))).join(', ')}`
}

// ---- the QUEST-level kill set (the collapsed summary row's "Kill: <boss>" caption) ----

/**
 * The part of an item row this derivation reads. `ItemProgress` (useProgress.ts) satisfies it
 * structurally; spelling the shape out here keeps the module React-free and node-testable.
 */
export interface KillTargetItem {
  need: number
  have: number
  /** posky's stated location string for this item, e.g. "Island 3" */
  where: string
  droppers: readonly DropperMob[]
}

/** One mob standing between the player and a quest, with the evidence behind it. */
export interface KillTarget {
  mob: DropperMob
  /** how many of the quest's STILL-NEEDED items this mob drops */
  covers: number
  /** the islands those items are stated to be on ("Island 3"), ascending. Empty when none. */
  islands: string[]
}

/**
 * Who you still have to kill for a whole quest: the distinct droppers of the items it STILL
 * NEEDS. An item already in hand (`have >= need`) contributes nothing — the caption answers
 * "where do I go next", not "where did this quest come from" — and an item that resolved no
 * dropper contributes nothing either, so a wind-rune quest (posky: "random drop — any Plane of
 * Sky mob") yields an EMPTY set and the caller shows no caption at all. Never a guess (law 1).
 *
 * ORDER IS COUNTED, NOT GUESSED: by how many of the still-needed items that mob covers, then by
 * the module's own name order as the tiebreak. That is what makes the collapsed one-name form
 * honest — "Kill: Gorgalosk +2" names the mob that closes the most of what is left, not
 * whichever name happens to sort first. A caller wanting the whole roster has it in that order.
 *
 * The islands ride PER MOB, from the items that mob is the target for — so "Kill: X · Island 3"
 * says where X's outstanding drops are, never where some other target's are.
 */
export function questKillTargets(items: readonly KillTargetItem[]): KillTarget[] {
  const byPage = new Map<string, { mob: DropperMob; covers: number; islands: Set<string> }>()
  for (const it of items) {
    if (it.have >= it.need) continue
    const island = islandOf(it.where)
    // Per ITEM, so a page listed twice on one item can't inflate its coverage.
    const seen = new Set<string>()
    for (const m of it.droppers) {
      if (seen.has(m.page)) continue
      seen.add(m.page)
      const hit = byPage.get(m.page) ?? { mob: m, covers: 0, islands: new Set<string>() }
      hit.covers += 1
      if (island) hit.islands.add(island)
      byPage.set(m.page, hit)
    }
  }
  return [...byPage.values()]
    .sort((a, b) => (a.covers === b.covers ? byName(a.mob, b.mob) : b.covers - a.covers))
    .map((e) => ({ mob: e.mob, covers: e.covers, islands: [...e.islands].sort((a, b) => islandNo(a) - islandNo(b)) }))
}

/**
 * "Kill: Gorgalosk · Island 3" / "Kill: Gorgalosk +2 · Islands 3, 5" — the lead target, how many
 * others remain, and where the lead's outstanding drops are. The island clause is dropped
 * entirely when posky states none. Empty string for an empty set: the caller renders nothing.
 */
export function killTargetLabel(targets: readonly KillTarget[]): string {
  const lead = targets[0]
  if (!lead) return ''
  const more = targets.length - 1
  const islands = islandLabel(lead.islands)
  return `Kill: ${lead.mob.name}${more > 0 ? ` +${more}` : ''}${islands === '' ? '' : ` · ${islands}`}`
}

/** One roster line: everything the catalog states about the mob, plus posky's island. */
export function killTargetFacts(t: KillTarget): string {
  const islands = islandLabel(t.islands)
  return islands === '' ? dropperFacts(t.mob) : `${dropperFacts(t.mob)} · ${islands}`
}

// ---- the app-wide singleton, built once, lazily, over the committed catalog ----

let SKY_INDEX: DropperIndex | null = null
let SKY_NAMES: MobNameIndex | null = null

function skyMobs(): MobEntry[] {
  return MOB_CATALOG.filter(isSkyMob)
}

function skyIndex(): DropperIndex {
  SKY_INDEX ??= buildDropperIndex(skyMobs())
  return SKY_INDEX
}

function skyNames(): MobNameIndex {
  SKY_NAMES ??= buildMobNameIndex(skyMobs())
  return SKY_NAMES
}

/**
 * THE entry point the tracker calls: every Plane of Sky mob the committed data says drops this
 * item, layer 1 first. Empty means nobody known — render nothing.
 */
export function skyDroppersFor(itemName: string, who?: readonly string[]): DropperMob[] {
  return mergeDroppers(statedDroppers(who, skyNames()), droppersFor(itemName, skyIndex()))
}
