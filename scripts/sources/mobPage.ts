/**
 * PURE mob-page wikitext parser (no network) — the parsing half of `scripts/scrape-mobs.ts`.
 * Sibling of ./questPage.ts, and unit-tested against verbatim wikitext in
 * tests/considerWindows.test.mts.
 *
 * IT DELIBERATELY DOES NOT RE-IMPLEMENT THE WIKITEXT READING. `parseMobWikitext` in
 * src/main/mobLookupParse.ts is the SHIPPED definition of "what a mob page says" (it backs the
 * app's live-wiki fallback), and it is electron-free by construction, so the scraper imports it
 * instead of growing a second definition that could drift. What lives here is the scraper's own
 * two concerns:
 *
 *   1. IS THIS A MOB PAGE AT ALL. The enumeration is deliberately over-broad (see
 *      scrape-mobs.ts), and MediaWiki's `embeddedin` reports INDIRECT transclusions — a quest
 *      page that shows a mob box (`{{:A zol ghoul knight}}`) is listed as embedding
 *      Template:Namedmobpage. Only a page whose OWN wikitext opens the template counts.
 *   2. THE COMPACT PROJECTION. The committed catalog is names only (see MobEntry) — no drop
 *      rates, no wikitext — because it is inlined into the main bundle.
 */
import { parseMobWikitext } from '../../src/main/mobLookupParse'
import type { MobEntry } from '../../src/shared/types'

/**
 * The page templates that MAKE a page a mob page, verified against the live wiki (2026-08-03):
 *   {{Namedmobpage}}  6,516 pages report embedding it (incl. indirect) — the mob/NPC template,
 *                     carrying |level, |zone, |known_loot, |related_quests.
 *   {{MerchantPage}}  1,361 — a vendor NPC. SAME header fields, but `|items_sold` instead of
 *                     `|known_loot`. Kept in the catalog (a merchant is a thing you can `/con`,
 *                     and its level/zone are real) with NO drops — a vendor's stock is not loot.
 *
 * DELIBERATELY UNANCHORED. The obvious `^\s*\{\{Namedmobpage` is WRONG and was measured to be:
 * most pages open with an ERA tag on the SAME LINE — `{{Classic Era}}{{Namedmobpage`, and also
 * Kunark/Velious/Fear/Hate/Chardok Revamp/Paineel/Temple/Luclin/Epics Era — so a start-of-line
 * anchor rejected 660 of the first 2,145 real mob pages (30%). Matching anywhere is SAFE
 * because the transclusion form a non-mob page carries is `{{:A zol ghoul knight}}` (the colon
 * makes it a page transclusion, not a template call): the indirect-transclusion candidates the
 * enumeration drags in — "Druid Epic Quest" and friends — contain zero occurrences of this
 * literal, verified against the live page.
 */
const MOB_TEMPLATE_RE = /\{\{\s*(Namedmobpage|MerchantPage)\b/i

/** True when the page's OWN wikitext opens a mob template (not merely transcludes a mob box). */
export function isMobPage(wikitext: string): boolean {
  return MOB_TEMPLATE_RE.test(wikitext)
}

/**
 * Split a `|zone` field into zone names. Verified shapes: a single link (`[[Lower Guk]]`), the
 * bare word `Various`, and multi-zone pages that separate with `<br>` or a comma. Zone names in
 * this game contain no commas, so both separators are safe; anything else is left as one value
 * rather than guessed apart.
 */
export function splitZones(zone: string | undefined): string[] {
  if (!zone) return []
  return zone
    .split(/\s*(?:<br\s*\/?>|,|\/)\s*/i)
    .map((z) => z.trim())
    .filter((z) => z.length > 0 && z.length < 60)
}

/**
 * Project one mob page into a catalog entry, or null when the page is not a mob page.
 * `title` is the wiki page title; `wikitext` is its raw source.
 *
 * The entry's `name` is the page's OWN `|name` when it states one (the in-game name, with the
 * lowercase article EQ actually prints) and the page title otherwise — never a name we made up.
 */
export function parseMobPage(title: string, wikitext: string): MobEntry | null {
  if (!isMobPage(wikitext)) return null
  const facts = parseMobWikitext(wikitext)
  // `|name` can be present-but-empty (or unlink to nothing), and an EMPTY name is "the page
  // does not state one" — so the fallback is on emptiness, not merely on absence.
  const stated = facts.pageName ?? ''
  const entry: MobEntry = { page: title, name: stated.length > 0 ? stated : title }
  if (facts.levelText) entry.level = facts.levelText
  const zones = splitZones(facts.zone)
  if (zones.length) entry.zones = zones
  const drops = (facts.dropsWiki ?? []).map((d) => d.item)
  if (drops.length) entry.drops = drops
  return entry
}
