// mobLookupParse.ts — the PURE half of "what does this mob drop" (Task #63).
//
// Split out from mobLookup.ts (which imports electron `app` for the userData cache) exactly the
// way itemLookupParse.ts is split from itemLookup.ts, so the wikitext classification and the
// own-loot index are importable in the node test runner with NO electron dependency. Unit-tested
// in tests/considerWindows.test.mts against VERBATIM real wikitext.
//
// ===========================================================================
// THE MOB PAGE, as it actually is (fetched read-only from eqlwiki.com on 2026-08-03:
// "A zol ghoul knight", "A Froglok Gaz Knight", "Baron Telyx V`Zher", "The Tenderizer",
// "A giant rat", "A hill giant", "An ashenbone drake", "Key Master")
//
// Mob pages use {{Namedmobpage}} — the same `|field = value` grammar {{Itempage}} uses, so
// `templateField` is REUSED rather than re-implemented. Fields we read:
//   |name          = a zol ghoul knight        (the page's own spelling — the identity check)
//   |level         = 36-40 | 18 | 2 - 4 | 28   (a RANGE as often as a number → kept as TEXT)
//   |zone          = [[Lower Guk]] | Various
//   |known_loot    = an HTML <ul> of {{:Item}} transclusions (four shapes, below)
//   |related_quests = * [[Quest Page]] bullets, or the literal `* None`
//
// KNOWN_LOOT — FOUR verbatim shapes observed across those pages. The ONE invariant across all
// of them is the `{{:Item Name}}` transclusion; the list markup and the rarity annotation vary,
// so the parse keys off the transclusion and treats everything else as optional decoration:
//
//   (1) a zol ghoul knight / a froglok gaz knight — one <li> per line, rarity WORD + a drop-rate
//       span the wiki renders from its own DB:
//         <ul><li>  {{:Fine Steel Short Sword}}  <span class='drare'>(Uncommon)</span> <span class='ddb'>[Overall: 25.0%]</span>
//         </li><li> {{:Amber}}                   <span class='drare'>(Rare)</span> <span class='ddb'>[Overall: 5.5%]</span>
//   (2) Baron Telyx V`Zher — hand-written, NO spans at all, rarity in bare parentheses:
//         <li>{{:Pristine Studded Leather Tunic}} (Common)</li>
//         <li>{{:The Baron's Blade}} (Rare)</li>
//   (3) The Tenderizer — the rarity span is present but EMPTY (rarity simply unknown):
//         <li> {{:Kitchen Toolbelt}}          <span class='drare'></span>
//   (4) a giant rat — unclosed <li>s, rarity as a bare PERCENTAGE, and trailing prose inside
//       the field ("Does not drop coin."):
//           <li> {{:A Piece of Rat Fur}}   <span class='drare'>(18.4%)</span>
//
// So `rarity` is whatever text the page put in parentheses right after the item, VERBATIM
// ("Uncommon", "Ultra Rare", "18.4%"), and absent when there was none. It is never mapped onto a
// scale of our own — the wiki uses at least two incompatible ones (law 1).
//
// NOT A DROP LIST: a MerchantPage (Key Master) has `|items_sold`, not `|known_loot`. Reading
// that as drops would claim a vendor's stock is loot, so nothing here looks at it — a merchant
// simply comes back with no `dropsWiki`.

import { templateField } from './itemLookupParse'
import type { MobDrop, MobQuestUse, MobSeenDrop } from '../shared/types'

/**
 * Canonical identity key for a MOB name. The same rule as parser.idKey (lowercase + trim) plus
 * a QUOTE FOLD: the log writes ``Innoruuk`s Chosen`` with a backtick, the wiki writes it with a
 * typographic or straight apostrophe, and the quest catalog uses whatever its page did. Folding
 * all three to `'` is what lets one mob be one key across the three sources.
 *
 * Deliberately does NOT strip the leading article: "a giant rat" and "giant rat" are different
 * page titles on the wiki, and the log always prints the article, so keeping it is both honest
 * and lossless. Article-insensitive matching is a BOSS-matching rule (law 2), not this one.
 */
export function mobKey(name: string): string {
  return name.trim().toLowerCase().replace(/[`’´]/g, "'").replace(/\s+/g, ' ')
}

/**
 * Reduce a short field value to plain text. Used for `|name`, `|level` and `|zone`, which are
 * mostly plain but carry three kinds of markup on real pages:
 *   - `[[Page|Label]]` / `[[Page]]` wiki links   → the label   (`|zone = [[Lower Guk]]`)
 *   - `[https://… Label]` EXTERNAL links         → the label, or nothing when bare. 59 mob
 *     `|name` fields and 7 `|level` fields end in a bare archive.org citation link, e.g.
 *     `A Gnoll Scout[https://web.archive.org/…?id=2964]`. Dropping only `[[…]]` left the whole
 *     URL glued to the mob's NAME, which then keys the catalog under a name nothing can look
 *     up. (Found by the dataset-integrity test, not by reading pages.)
 *   - stray HTML tags                            → removed
 * Wiki links are handled BEFORE external links so `[[…]]` is never mistaken for `[…]`.
 */
export function unlink(value: string): string {
  return value
    .replace(/\[\[([^\]]+?)\]\]/g, (_m, inner: string) => {
      const pipe = String(inner).indexOf('|')
      return (pipe >= 0 ? String(inner).slice(pipe + 1) : String(inner)).trim()
    })
    .replace(/\[(?:https?|ftp):\/\/\S*(?:\s+([^\]]*))?\]/gi, (_m, label?: string) => (label ?? '').trim())
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Parse a mob page's `|known_loot` field into drops. Anchored on the `{{:Item}}` transclusion
 * (the one invariant across all four observed shapes); the rarity is the FIRST parenthesized
 * run that follows it, before the next transclusion — which covers the `<span class='drare'>`
 * wrapper, the bare-parenthesis form and the bare-percentage form alike, and yields nothing for
 * the empty-span form. `[Overall: 25.0%]` / `[3] 1x 55% (33%)` drop-rate spans sit AFTER the
 * rarity and are deliberately not read: they are square-bracketed DB dumps in three mutually
 * incompatible formats, and the rarity word is what a glanceable card wants.
 */
export function parseMobLoot(block: string): MobDrop[] {
  const drops: MobDrop[] = []
  const seen = new Set<string>()
  const re = /\{\{:\s*([^}|]+?)\s*\}\}/g
  const marks: { item: string; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) marks.push({ item: m[1].trim(), end: re.lastIndex })
  for (let i = 0; i < marks.length; i++) {
    const item = marks[i].item
    if (!item) continue
    // Look only as far as the NEXT transclusion, so one item can never borrow another's rarity.
    const tail = block.slice(marks[i].end, i + 1 < marks.length ? marks[i + 1].end : undefined)
    // The rarity annotation, in any of its three spellings. `[^()]*` keeps it to a single
    // parenthesized run; the leading `[^[]*?` stops the scan at a `[Overall: …]` DB span.
    const r = /^[^([{]*?\(([^()]+)\)/.exec(tail.replace(/<\/?span[^>]*>/g, ''))
    const rarity = r ? r[1].trim() : undefined
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    drops.push(rarity ? { item, rarity } : { item })
  }
  return drops
}

/** `* [[Quest Page]]` bullets from `|related_quests`. The literal `* None` yields nothing. */
export function parseMobQuestLinks(block: string): MobQuestUse[] {
  const uses: MobQuestUse[] = []
  const re = /\[\[([^\]]+?)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    const inner = m[1].trim()
    const pipe = inner.indexOf('|')
    const page = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
    const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim()
    if (!label || /^none$/i.test(label)) continue
    if (!uses.some((u) => u.quest === label)) uses.push({ quest: label, page })
  }
  return uses
}

/** What a mob page states. Every field is optional — absent means "the page didn't say". */
export interface MobPageFacts {
  /** the page's own `|name` value, for the identity check on a non-exact search hit */
  pageName?: string
  levelText?: string
  zone?: string
  dropsWiki?: MobDrop[]
  quests?: MobQuestUse[]
}

/**
 * Classify a mob page's wikitext. Pure — no network, no cache, no electron.
 * A page with no `|known_loot` field (a MerchantPage, a stub) yields no `dropsWiki` at all,
 * which is the honest answer: we did not read a drop list, so we do not have one.
 */
export function parseMobWikitext(wikitext: string): MobPageFacts {
  const out: MobPageFacts = {}
  const name = templateField(wikitext, 'name')
  if (name) out.pageName = unlink(name)
  const level = templateField(wikitext, 'level')
  if (level) {
    const t = unlink(level)
    if (t) out.levelText = t
  }
  const zone = templateField(wikitext, 'zone')
  if (zone) {
    const t = unlink(zone)
    if (t) out.zone = t
  }
  const loot = templateField(wikitext, 'known_loot')
  if (loot) {
    const drops = parseMobLoot(loot)
    if (drops.length) out.dropsWiki = drops
  }
  const quests = templateField(wikitext, 'related_quests')
  if (quests) {
    const uses = parseMobQuestLinks(quests)
    if (uses.length) out.quests = uses
  }
  return out
}

// ---- LOCAL 1: the own-loot index -----------------------------------------------

/**
 * mob → what WE have looted off it, folded from the parsed `loot` event family (whose `source`
 * is the corpse's mob name). This is the source no wiki can be: personal, offline, always
 * current, and countable.
 *
 * Deliberately a plain in-memory index owned by the caller rather than a persisted cache: it is
 * CHARACTER-SCOPED and EPOCH-SCOPED (a pre-launch character's loot is a dead character's — see
 * AGENTS.md), and the loot history it is derived from is already replayed on every start. So it
 * is rebuilt by the same replay that rebuilds the loot module and can never drift from it.
 *
 * Stacked loots add their `count` (a `--You have looted 2 Bone Chips …--` is two items, not
 * one). A loot line with NO source ("from <mob>'s corpse" absent) is skipped rather than filed
 * under an empty mob — there is no mob to attribute it to.
 */
export class MobLootIndex {
  private byMob = new Map<string, Map<string, MobSeenDrop>>()

  reset(): void {
    this.byMob.clear()
  }

  /** Fold one loot event. `source` is the corpse's mob name (parser strips the `'s`). */
  note(item: string, source: string | undefined, ts: number, count = 1): void {
    if (!item || !source) return
    const key = mobKey(source)
    let items = this.byMob.get(key)
    if (!items) {
      items = new Map()
      this.byMob.set(key, items)
    }
    const ik = item.trim().toLowerCase()
    const row = items.get(ik)
    if (row) {
      row.count += count
      if (ts > row.lastTs) row.lastTs = ts
    } else {
      items.set(ik, { item: item.trim(), count, lastTs: ts })
    }
  }

  /** What we've looted off this mob — most-looted first, ties broken by recency. Never null. */
  drops(mob: string): MobSeenDrop[] {
    const items = this.byMob.get(mobKey(mob))
    if (!items) return []
    return [...items.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs)
  }

  /** How many distinct mobs we have loot for (test/diagnostic handle). */
  get size(): number {
    return this.byMob.size
  }
}
