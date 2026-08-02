// itemLookupParse.ts — the PURE wikitext → ItemKnowledge parsing for Task #53.
//
// Split out from itemLookup.ts (which imports electron `app` for the userData cache) so
// the classification core is importable in the node test runner with NO electron
// dependency. Unit-tested in tests/itemLookup.test.mts against verbatim real wikitext.
//
// The wiki's item pages use a {{Itempage}} template (observed on Coin of Tash, Sphinx
// Claw, Nebulous Sapphire, Water Flask, Bone Chips):
//   |statsblock    = LORE ITEM  NO DROP  QUEST ITEM<br>Slot: …   (text flags + stats)
//   |relatedquests = * [[Quest Page|Label]] …                    (bulleted link list)
//   |notes         = freeform prose                              (a one-line summary)

import type { ItemKnowledge, ItemQuestUse } from '../shared/types'

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
 */
export function parseItemWikitext(
  _name: string,
  wikitext: string
): Pick<ItemKnowledge, 'lore' | 'quest' | 'questUses' | 'summary' | 'statsBlock'> {
  const statsBlock = templateField(wikitext, 'statsblock') ?? undefined
  const relatedRaw = templateField(wikitext, 'relatedquests')
  const notesRaw = templateField(wikitext, 'notes')

  const flags = (statsBlock ?? '').toUpperCase()
  const lore = /\bLORE ITEM\b/.test(flags)
  const questFlag = /\bQUEST ITEM\b/.test(flags)

  const questUses = relatedRaw ? parseQuestLinks(relatedRaw) : []
  const quest = questFlag || questUses.length > 0
  const summary = notesRaw ? cleanSummary(notesRaw) : undefined

  return {
    lore,
    quest,
    questUses,
    summary,
    statsBlock: statsBlock
      ? statsBlock.replace(/<br\s*\/?>/gi, '\n').replace(/[ \t]{2,}/g, ' ').trim()
      : undefined
  }
}
