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
  const out: DropperMob = { name: m.name, page: m.page, zones: m.zones ?? [] }
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
