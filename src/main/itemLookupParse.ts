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
//   |merchant_value, |soldby, |playercrafted, |recipes, |bookcontents, |foraged,
//   |second_image / |third_image  (present in the template; not consumed here)
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
// LOG REALITY (grep of the live log, read-only): there is NO first-person item-upgrade
// or exaltation line family beyond these —
//   `You have successfully merged two items together to create a new item: <Name> +N`
//        — the upgrade event itself, naming the resulting tier. NOT parsed today.
//   `The item you are trying to add will not work, this mote is not sufficiently
//        powerful to upgrade this item.` — a failed merge, no item named.
//   `Your <Item> (Exaltation) shimmers briefly.` (and `feels alive with power.`,
//        `flickers with a pale light.`, `pulses with light as your vision sharpens.`)
//        — a socketed click/proc exaltation firing; names the SOURCE item, not the host.
//   Loot lines already carry the tier suffix (`You have looted a Kitchen Toolbelt +4`).
// Nothing reports item exp, socket contents, or tier for an item we merely hold.
// ===========================================================================

import type { ItemKnowledge, ItemQuestUse } from '../shared/types'
import { parseStatsBlock, type ItemStatBlock } from '../shared/itemStats'

/** Strip a trailing ` +N` upgrade suffix (mirrors renderer itemName.normalizeItemName —
 *  kept local to avoid a main→renderer import). Applied before lookup + as the cache key. */
export function normalizeItemName(name: string): string {
  return name.replace(/ \+\d+$/, '').trim()
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

/**
 * PURE: turn item-page wikitext into the knowledge fields. `|statsblock` carries the
 * LORE/QUEST text flags, `|relatedquests` a bulleted [[link]] list, `|notes` prose.
 *
 * `stats` is the same block parsed into the game item WINDOW's structure (see
 * shared/itemStats.ts) so the UI can draw it with the game's hierarchy and colors
 * instead of dumping monospace text. The raw `statsBlock` string is still returned —
 * it stays the fallback for anything the structured parse doesn't recognize.
 */
export function parseItemWikitext(
  _name: string,
  wikitext: string
): Pick<ItemKnowledge, 'lore' | 'quest' | 'questUses' | 'summary' | 'statsBlock' | 'stats' | 'iconId'> {
  const statsBlock = templateField(wikitext, 'statsblock') ?? undefined
  const relatedRaw = templateField(wikitext, 'relatedquests')
  const notesRaw = templateField(wikitext, 'notes')
  const focusRaw = templateField(wikitext, 'focus_effect')
  const iconRaw = templateField(wikitext, 'lucy_img_ID')

  const flags = (statsBlock ?? '').toUpperCase()
  const lore = /\bLORE ITEM\b/.test(flags) || /\bLORE EQUIPPED\b/.test(flags)
  const questFlag = /\bQUEST ITEM\b/.test(flags)

  const questUses = relatedRaw ? parseQuestLinks(relatedRaw) : []
  const quest = questFlag || questUses.length > 0
  const summary = notesRaw ? cleanSummary(notesRaw) : undefined

  let stats: ItemStatBlock | undefined
  if (statsBlock) {
    stats = parseStatsBlock(statsBlock)
    // `|focus_effect` lives OUTSIDE the stats block (Djarn's Amethyst Ring, Golden
    // Efreeti Boots) but the game window shows it as just another effect line.
    const focus = focusRaw ? cleanSummary(focusRaw) : undefined
    if (focus && !stats.effects.some((e) => e.kind === 'focus')) {
      stats.effects.push({ kind: 'focus', name: focus })
    }
  }

  const iconId = iconRaw && /^\d+$/.test(iconRaw.trim()) ? Number(iconRaw.trim()) : undefined

  return {
    lore,
    quest,
    questUses,
    summary,
    stats,
    iconId,
    statsBlock: statsBlock
      ? statsBlock.replace(/<br\s*\/?>/gi, '\n').replace(/[ \t]{2,}/g, ' ').trim()
      : undefined
  }
}
