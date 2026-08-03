// itemLookupParse.ts — the PURE wikitext → ItemKnowledge parsing for Task #53.
//
// Split out from itemLookup.ts (which imports electron `app` for the userData cache) so
// the classification core is importable in the node test runner with NO electron
// dependency. Unit-tested in tests/itemLookup.test.mts against verbatim real wikitext.
//
// The wiki's item pages use a {{Itempage}} template. Fields ACTUALLY present (verified
// 2026-08-02 against Template:Itempage plus a dozen real pages — Red Dragonscale Armor,
// Djarn's Amethyst Ring, Thelvorn Blade of Light, Ghoulbane, Fiery Avenger, Earthshaker,
// Cloak of Flames, Golden Efreeti Boots, Boots of the Long Road, Skycleaver, Sharp Claws,
// Sabertooth Short Bow):
//   |itemname      = display name
//   |lucy_img_ID   = icon id → File:Item <id>.png on the wiki
//   |statsblock    = the in-game item window's text, <br>-separated (flags, Slot,
//                    Class/Race, AC/HP/attributes, SV *, WT/Size, Skill/Atk Delay/DMG,
//                    `Effect:` / `Combat Effect:` / `Click Effect:` lines)
//   |focus_effect  = a focus effect name, OUTSIDE the stats block ("Spell Haste II")
//   |relatedquests = * [[Quest Page|Label]] …   (bulleted link list)
//   |dropsfrom     = zone heading + * [[mob]] bullets
//   |notes         = freeform prose (lore, quirks) — our one-line summary
//   |recipes       = recipes that CONSUME this item (see shapes below)
//   |playercrafted = how this item is itself made (see shapes below)
//   |merchant_value, |soldby, |bookcontents, |foraged,
//   |second_image / |third_image  (present in the template; not consumed here)
//
// TRADESKILL FIELDS — the "QUEST ITEM flag but no quest anywhere" gap. Plenty of items
// carry `QUEST ITEM` in their stats block yet appear in NO quest on the whole wiki: they
// are tradeskill INGREDIENTS, and the item page says so in `|recipes`. Shapes verified
// 2026-08-02 against Gnome Meat, Troll Parts, Spider Legs, Skewers (the one page carrying
// BOTH fields), Gnome Kabobs, Pickled Troll, Fine Steel Long Sword (neither field):
//
//   |recipes  — a TWO-LEVEL bullet list, `*` tradeskill heading / `**` recipe entry, the
//               trivial stated on the recipe line. Spider Legs, verbatim:
//                   * [[Brewing]]
//                   ** [[Gnomish Spirits]] (Trivial: 102)
//                   ** [[Halas Heater]] (Trivial: 135)
//                   * [[Baking]]
//                   ** [[Wooly Spider Crunchies]] (Trivial: 46)
//               → recipes[] = {recipe, tradeskill, trivial, page when the link was piped}.
//
//   |playercrafted — one `*` block PER RECIPE (Skewers has two: Blacksmithing 38 and
//               Pottery 17), the trivial on the TRADESKILL line, then `**` yield + `**` In
//               <container>, then `::` ingredient rows. Gnome Kabobs, verbatim:
//                   * [[Baking]] (Trivial: 56)
//                   ** '''Yield: Gnome Kabobs''' x2
//                   ** In [[Oven]]:
//                   :: {{SmIcon|817}} 1 x [[Gnome Meat]] - Dropped
//                   :: {{SmIcon|1012}} 1 x [[Skewers]] - Crafted, Returned on Failure, …
//               → craftedBy[] = {tradeskill, trivial, container, yieldItem, yieldQty,
//                 ingredients[{name, qty, sources}]}; `{{SmIcon|nnn}}` is dropped.
//
// A bullet WITHOUT a [[link]] is the freeform shape and is never structured — Coin of Tash
// writes `|playercrafted = * Non-Tradeskill (Quest)`, which means "not a tradeskill at all".
// Those fall through to the `cleanSummary` prose fallback (`recipesNote`/`craftedNote`) and
// deliberately leave `playerCrafted` unset: claiming a craft we didn't read would be
// inventing (world-model law 1).
// NOT present anywhere on item pages: tier/item-level state, exaltation socket contents,
// or upgrade progress. Those are per-INSTANCE and the wiki only documents base items.
// (One stray exception: Boots of the Long Road hand-writes `Slot: Ornamentation: empty`
// inside its stats block; the parser understands that shape when a page has it.)
//
// ===========================================================================
// RESEARCH — the item upgrade (tier) + exaltation mechanic
// Sources: eqlwiki.com pages "Item Upgrade System", "Exaltations", "Mote Guide",
// "Marketplace", "Patch Notes" (read 2026-08-02). Everything below is quoted mechanics,
// not inference; anything the wiki doesn't say is deliberately absent.
//
// TIERS ("item level"). All gear starts at tier 0 and can reach tier 10. You raise it by
// MERGING: consume another copy of the same item, or a Mote of Potential, to add item
// EXP. Merged gear at tier T is worth 2^T exp (tier 0 = 1, tier 7 = 128); reaching tier
// T+1 costs 2^T exp, so total exp for tier T is 2^T − 1. The in-game window's
// "Tier N   x / y" row is exactly (exp banked toward the next tier) / (2^N) — which is
// why the screenshots read "Tier 1  0 / 2" and "Tier 7  3 / 128".
//   Stat effect: +10% cumulative per tier, applied to the item's base stats and rounded
//   DOWN; a +1 minimum increase is guaranteed at each tier boundary; partial exp gives a
//   partial (mid-tier) bonus of tier% + (percent-toward-next / 10); weapon DAMAGE scales
//   +5%/tier; weapon DELAY never drops; weight shrinks but never below 0.1.
//   The upgraded item's DISPLAY NAME carries the tier as a ` +N` suffix ("Cloak of
//   Flames +4"), which is the only tier signal that ever reaches the log.
//
// EXALTATIONS (the "slot rows" that vary between screenshots). Every item has exaltation
// SOCKETS whose count is set by its item level, unlocking progressively:
//   +0 Ornamentation · +1 Focus · +2 Click · +3 Worn · +4 Proc
// so a base item shows one socket row and a +4-or-better item shows all five — that is
// the whole reason the Tier 1 window has 2 rows and the Tier 7 window has 5.
// An exaltation is a transferable effect: level an item to the tier that unlocks its
// effect type, and that effect becomes a removable object (named "<Source Item>
// (Exaltation)") which can be pulled out and socketed into a different item. The source
// item LOSES the effect while it's moved. Ornamentation is the odd one out — it is
// cosmetic and is created with an Armor/Weapon Ornamentation Token from the Marketplace
// rather than by leveling. Exaltations carry their source item's CLASS and SLOT
// restrictions and intersect them onto the host item (a 2H proc makes the host
// primary-only; a WAR/PAL/RNG/SHD proc removes ROG/BRD from a 6-class sword).
// Sockets survive loadout swaps (the exact exaltation is restored per loadout).
//
// WHAT THIS MEANS FOR US (law 1 — never invent): the wiki gives BASE item data only. We
// therefore render the tier row ONLY when the observed item NAME carries ` +N`, we never
// draw an exp progress bar (x is unobservable — no log line reports item exp), and we
// never emit "Ornamentation: empty" style socket rows for an item whose sockets we have
// not actually read. What a +N name DOES justify is listing which socket TYPES are
// unlocked at that level, since that is a documented rule of the level, not a claim
// about the instance.
//
// LOG REALITY (full-log sweep, read-only). The complete merge/upgrade/mote/exaltation line
// inventory now lives beside the regexes in main/log/parser.ts; in summary:
//   `You have successfully merged two items together to create a new item: <Name>` (236×)
//        — the upgrade event itself. PARSED (Task #60) as `itemMerge`; 159 name a ` +N`
//        item level, 77 name a Roman SPELL rank instead (the same line covers scroll
//        merges) and claim no tier.
//   `Your request to merge <A> with <B> failed. …` (4×) — PARSED as `itemMergeFailed`
//        ('mismatch'); the only failure shape that names items, and `<A>` carries its tier.
//   `The item you are trying to add will not work, this mote is not sufficiently powerful
//        to upgrade this item.` (9×) / `… you cannot fuse an item to itself.` (4×, the one
//        line in the family that never says "merge") / `… you cannot merge two different
//        types of items.` (1×) / `Request to merge items canceled, both items remain
//        unmodified.` (1×) — PARSED as `itemMergeFailed` with no item named.
//   `You looted <item> … to create a <item> +N` (302×) — auto-merge on pickup, already a
//        loot event (disposition 'combined' + `created`); the tier module folds it.
//   `Your <Item> (Exaltation) shimmers briefly.` (+3 sibling emotes, 6433× total)
//        — a socketed click/proc exaltation FIRING; names the SOURCE item, not the host,
//        and carries no tier. NOT parsed: it identifies nothing we can attribute.
//   `You successfully destroyed 1 <Item> +N.` — the item is gone. NOT parsed.
// Nothing reports item exp, socket contents, or the tier of an item we merely hold — so
// the ItemWindow still draws tier POSITION only, never an exp fill, and observed tiers come
// exclusively from merge evidence (main/modules/itemTiers.ts).
// ===========================================================================

import type {
  ItemCraftRecipe,
  ItemKnowledge,
  ItemQuestUse,
  ItemRecipeUse
} from '../shared/types'
import { itemBaseName, parseStatsBlock, type ItemStatBlock } from '../shared/itemStats'

/** Strip a trailing ` +N` upgrade suffix. Applied before lookup + as the cache key. ONE
 *  definition of the rule for every main-side caller — see shared/itemStats.itemBaseName. */
export function normalizeItemName(name: string): string {
  return itemBaseName(name)
}

/** Extract a named `{{Itempage}}` template field's raw value (`|field = …`). */
export function templateField(wikitext: string, field: string): string | null {
  // Match `|field = <value>` up to the next top-level `|field2 =` or the template close.
  // Values can contain newlines and bullet lists.
  const re = new RegExp(
    `\\|\\s*${field}\\s*=([\\s\\S]*?)(?=\\n\\s*\\|\\s*[a-zA-Z_]+\\s*=|\\n\\s*\\}\\})`,
    'i'
  )
  const m = re.exec(wikitext)
  return m ? m[1].trim() : null
}

/** Parse the `* [[Page|Label]]` / `* [[Page]]` bullet links out of a relatedquests block. */
export function parseQuestLinks(block: string): ItemQuestUse[] {
  const uses: ItemQuestUse[] = []
  const linkRe = /\[\[([^\]]+?)\]\]/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(block)) !== null) {
    const inner = m[1].trim()
    const pipe = inner.indexOf('|')
    const page = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
    const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim()
    if (!label) continue
    if (!uses.some((u) => u.quest === label)) uses.push({ quest: label, page, source: 'wiki' })
  }
  return uses
}

// ---- tradeskill fields (`|recipes` / `|playercrafted`) -------------------------

/** First `[[Page]]` / `[[Page|Label]]` in a line, split into page + display label. */
function firstLink(s: string): { page: string; label: string } | null {
  const m = /\[\[([^\]]+?)\]\]/.exec(s)
  if (!m) return null
  const inner = m[1].trim()
  const pipe = inner.indexOf('|')
  const page = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim()
  const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim()
  return label ? { page, label } : null
}

/** `(Trivial: 56)` — stated on the recipe line in `|recipes`, on the tradeskill line in
 *  `|playercrafted`. Absent on plenty of pages, so it stays optional everywhere. */
const TRIVIAL_RE = /\(\s*Trivial:\s*(\d+)\s*\)/i

/** Split a field into trimmed, non-empty lines (the bullet lists are line-oriented). */
function bulletLines(block: string): string[] {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** The shared tail of both tradeskill parsers: the prose fallback fires ONLY when nothing
 *  structured was read, and `note` is left OFF the object rather than set to undefined. */
function withNote<T>(recipes: T[], leftovers: string[]): { recipes: T[]; note?: string } {
  const note = recipes.length === 0 && leftovers.length > 0 ? cleanSummary(leftovers.join(' ')) : undefined
  return note ? { recipes, note } : { recipes }
}

/** The tradeskill a `*` heading names. Usually a link ([[Baking]]); a bare word is accepted
 *  too, and a heading with neither leaves the current tradeskill unnamed. */
function headingTradeskill(body: string, link: { page: string; label: string } | null): string | undefined {
  return link?.label ?? (body.replace(TRIVIAL_RE, '').trim() || undefined)
}

/** One `**` recipe entry of `|recipes`: the linked recipe, its tradeskill heading and the
 *  trivial stated on the line. `page` only when the link was piped. */
function recipeFromLine(
  body: string,
  link: { page: string; label: string },
  tradeskill: string | undefined
): ItemRecipeUse {
  const trivialM = TRIVIAL_RE.exec(body)
  const use: ItemRecipeUse = { recipe: link.label }
  if (link.page !== link.label) use.page = link.page
  if (tradeskill) use.tradeskill = tradeskill
  if (trivialM) use.trivial = Number(trivialM[1])
  return use
}

/**
 * Parse `|recipes` — the recipes that CONSUME this item. Two-level bullets: `*` names the
 * tradeskill, `**` a recipe (`[[Name]] (Trivial: N)`). A flat single-level list (no `**`
 * anywhere) is read as bare recipes with no tradeskill. Anything that isn't a link falls
 * through to `note`, the prose fallback — we never invent a recipe name.
 */
export function parseRecipeUses(block: string): { recipes: ItemRecipeUse[]; note?: string } {
  const lines = bulletLines(block)
  const nested = lines.some((l) => l.startsWith('**'))
  const recipes: ItemRecipeUse[] = []
  const leftovers: string[] = []
  let tradeskill: string | undefined

  for (const line of lines) {
    if (!line.startsWith('*')) {
      leftovers.push(line)
      continue
    }
    const sub = line.startsWith('**')
    const body = line.replace(/^\*+\s*/, '')
    const link = firstLink(body)
    if (!sub && nested) {
      // A tradeskill heading. Usually a link ([[Baking]]); a bare word is accepted too.
      tradeskill = headingTradeskill(body, link)
      continue
    }
    if (!link) {
      leftovers.push(body)
      continue
    }
    const use = recipeFromLine(body, link, tradeskill)
    if (!recipes.some((r) => r.recipe === use.recipe && r.tradeskill === use.tradeskill)) {
      recipes.push(use)
    }
  }

  return withNote(recipes, leftovers)
}

/** One `::` ingredient row's item, quantity and source list. Null when the row names no
 *  item — we never invent an ingredient. */
function parseIngredientRow(body: string): { name: string; qty?: number; sources?: string[] } | null {
  const link = firstLink(body)
  if (!link) return null
  const ing: { name: string; qty?: number; sources?: string[] } = { name: link.label }
  const qty = /(\d+)\s*x\s*\[\[/.exec(body)
  if (qty) ing.qty = Number(qty[1])
  // " - Bought, Dropped" trails the link; read it only AFTER the link so an item name
  // containing a dash can't be mistaken for the source list.
  const close = body.indexOf(']]')
  const tail = close >= 0 ? /^\s*-\s*(.+)$/.exec(body.slice(close + 2)) : null
  const sources = tail ? tail[1].split(',').map((s) => s.trim()).filter(Boolean) : []
  if (sources.length > 0) ing.sources = sources
  return ing
}

/** Attach a `::` ingredient row to the open recipe. With no recipe open the row's text is
 *  kept as prose instead (it is not an ingredient of anything we read). */
function readIngredientRow(line: string, cur: ItemCraftRecipe | null, leftovers: string[]): void {
  const body = line.replace(/^:+\s*/, '').replace(/\{\{[^}]*\}\}/g, '').trim()
  if (!cur) {
    if (body) leftovers.push(body)
    return
  }
  const ing = parseIngredientRow(body)
  if (ing) cur.ingredients.push(ing)
}

/** A `**` detail line of the open recipe: `'''Yield: X''' xN` or `In [[Container]]:`.
 *  Anything else — or any such line with no recipe open — is prose. */
function readCraftDetail(body: string, cur: ItemCraftRecipe | null, leftovers: string[]): void {
  const y = /^'''\s*Yield:\s*(.+?)\s*'''(?:\s*x\s*(\d+))?/i.exec(body)
  if (y && cur) {
    cur.yieldItem = y[1]
    if (y[2]) cur.yieldQty = Number(y[2])
    return
  }
  const inCont = /^In\s+(.+?):?\s*$/i.exec(body)
  if (inCont && cur) {
    cur.container = firstLink(inCont[1])?.label ?? inCont[1].replace(/:$/, '').trim()
    return
  }
  if (!cur && body) leftovers.push(body)
}

/**
 * Parse `|playercrafted` — how this item is itself made. One `*` block per recipe (the
 * tradeskill + its trivial), `** '''Yield: X''' xN`, `** In [[Container]]:`, then `::`
 * ingredient rows (`{{SmIcon|nnn}} 1 x [[Item]] - Bought, Dropped`). A `*` bullet with no
 * link is NOT a tradeskill (Coin of Tash's `Non-Tradeskill (Quest)`) — it becomes `note`.
 */
export function parseCraftRecipes(block: string): { recipes: ItemCraftRecipe[]; note?: string } {
  const recipes: ItemCraftRecipe[] = []
  const leftovers: string[] = []
  let cur: ItemCraftRecipe | null = null

  for (const line of bulletLines(block)) {
    // Ingredient row.
    if (line.startsWith('::')) {
      readIngredientRow(line, cur, leftovers)
      continue
    }
    if (!line.startsWith('*')) {
      leftovers.push(line)
      continue
    }
    const body = line.replace(/^\*+\s*/, '')
    if (line.startsWith('**')) {
      readCraftDetail(body, cur, leftovers)
      continue
    }
    // Top-level bullet = a new recipe, but ONLY when it names a tradeskill by link.
    const link = firstLink(body)
    if (!link) {
      cur = null
      if (body) leftovers.push(body)
      continue
    }
    cur = { tradeskill: link.label, ingredients: [] }
    const tm = TRIVIAL_RE.exec(body)
    if (tm) cur.trivial = Number(tm[1])
    recipes.push(cur)
  }

  return withNote(recipes, leftovers)
}

/** Collapse a `notes` field to a single trimmed prose line (strips wiki markup, caps length). */
export function cleanSummary(notes: string): string | undefined {
  const text = notes
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1') // [[Page|Label]] -> Label
    .replace(/\[\[([^\]]*)\]\]/g, '$1') // [[Page]] -> Page
    .replace(/<[^>]+>/g, ' ') // strip HTML tags
    .replace(/'''?/g, '') // bold/italic markers
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return undefined
  // First sentence / first 200 chars, whichever is shorter — a one-liner, not an essay.
  const firstSentence = text.split(/(?<=\.)\s/)[0]
  const s = (firstSentence.length <= 200 ? firstSentence : text.slice(0, 200)).trim()
  return s || undefined
}

/** The game item WINDOW's structure for a stats block, with `|focus_effect` folded in. */
function buildStats(statsBlock: string, focusRaw: string | null): ItemStatBlock {
  const stats = parseStatsBlock(statsBlock)
  // `|focus_effect` lives OUTSIDE the stats block (Djarn's Amethyst Ring, Golden
  // Efreeti Boots) but the game window shows it as just another effect line.
  const focus = focusRaw ? cleanSummary(focusRaw) : undefined
  if (focus && !stats.effects.some((e) => e.kind === 'focus')) {
    stats.effects.push({ kind: 'focus', name: focus })
  }
  return stats
}

/** `|lucy_img_ID` → File:Item <id>.png. A bare integer or nothing at all. */
function parseIconId(iconRaw: string | null): number | undefined {
  return iconRaw && /^\d+$/.test(iconRaw.trim()) ? Number(iconRaw.trim()) : undefined
}

/**
 * The tradeskill half of the result. Every field is `undefined` — never an empty list, never
 * a bare `false` — unless the page actually carried a STRUCTURED recipe: `playerCrafted` in
 * particular is asserted only from a parsed craft recipe, and prose-only `|playercrafted`
 * ("Non-Tradeskill (Quest)") is reported as `craftedNote` and nothing more.
 */
function tradeskillFields(
  recipeParse: { recipes: ItemRecipeUse[]; note?: string } | null,
  craftParse: { recipes: ItemCraftRecipe[]; note?: string } | null
): Pick<ItemKnowledge, 'recipes' | 'recipesNote' | 'playerCrafted' | 'craftedBy' | 'craftedNote'> {
  return {
    recipes: recipeParse && recipeParse.recipes.length > 0 ? recipeParse.recipes : undefined,
    recipesNote: recipeParse?.note,
    playerCrafted: craftParse && craftParse.recipes.length > 0 ? true : undefined,
    craftedBy: craftParse && craftParse.recipes.length > 0 ? craftParse.recipes : undefined,
    craftedNote: craftParse?.note
  }
}

/**
 * PURE: turn item-page wikitext into the knowledge fields. `|statsblock` carries the
 * LORE/QUEST text flags, `|relatedquests` a bulleted [[link]] list, `|notes` prose,
 * `|recipes` the tradeskill recipes that CONSUME this item and `|playercrafted` how the
 * item is itself made (shapes documented in the file header).
 *
 * `stats` is the same block parsed into the game item WINDOW's structure (see
 * shared/itemStats.ts) so the UI can draw it with the game's hierarchy and colors
 * instead of dumping monospace text. The raw `statsBlock` string is still returned —
 * it stays the fallback for anything the structured parse doesn't recognize.
 */
export function parseItemWikitext(
  _name: string,
  wikitext: string
): Pick<
  ItemKnowledge,
  | 'lore'
  | 'quest'
  | 'questUses'
  | 'summary'
  | 'statsBlock'
  | 'stats'
  | 'iconId'
  | 'recipes'
  | 'recipesNote'
  | 'playerCrafted'
  | 'craftedBy'
  | 'craftedNote'
> {
  const statsBlock = templateField(wikitext, 'statsblock') ?? undefined
  const relatedRaw = templateField(wikitext, 'relatedquests')
  const notesRaw = templateField(wikitext, 'notes')
  const focusRaw = templateField(wikitext, 'focus_effect')
  const iconRaw = templateField(wikitext, 'lucy_img_ID')
  const recipesRaw = templateField(wikitext, 'recipes')
  const craftedRaw = templateField(wikitext, 'playercrafted')

  const flags = (statsBlock ?? '').toUpperCase()
  const lore = /\bLORE ITEM\b/.test(flags) || /\bLORE EQUIPPED\b/.test(flags)
  const questFlag = /\bQUEST ITEM\b/.test(flags)

  const questUses = relatedRaw ? parseQuestLinks(relatedRaw) : []
  const quest = questFlag || questUses.length > 0
  const summary = notesRaw ? cleanSummary(notesRaw) : undefined

  const stats: ItemStatBlock | undefined = statsBlock ? buildStats(statsBlock, focusRaw) : undefined

  const iconId = parseIconId(iconRaw)

  // Tradeskill knowledge. `playerCrafted` is asserted only from a STRUCTURED craft recipe;
  // a prose-only `|playercrafted` ("Non-Tradeskill (Quest)") is reported as craftedNote and
  // nothing more.
  const recipeParse = recipesRaw ? parseRecipeUses(recipesRaw) : null
  const craftParse = craftedRaw ? parseCraftRecipes(craftedRaw) : null

  return {
    lore,
    quest,
    questUses,
    summary,
    stats,
    iconId,
    ...tradeskillFields(recipeParse, craftParse),
    statsBlock: statsBlock
      ? statsBlock.replace(/<br\s*\/?>/gi, '\n').replace(/[ \t]{2,}/g, ' ').trim()
      : undefined
  }
}
