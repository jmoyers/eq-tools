/**
 * Spell-database scraper (Task #34).
 *
 * Enumerates every wiki page that embeds `Template:Spellpage` (MediaWiki
 * list=embeddedin, paged) and parses each page's wikitext template fields into a
 * SpellEntry, writing the committed catalog to src/main/data/spells.json.
 *
 *   npm run scrape:spells
 *
 * The catalog is the PRIOR/TRUTH for buff durations and — crucially — the source of
 * the exact chat messages a spell prints when it lands (msg_cast_on_you /
 * msg_cast_on_other) or fades (msg_wears_off). Those messages let the parser emit
 * PRECISE, message-driven buffApply/buffWearOff events (see src/main/data/spellDb.ts),
 * which is how self buffs cast via Quick Buff bursts (no "You begin casting" line)
 * finally become visible.
 *
 * Be polite: modest concurrency, cache raw wikitext under scripts/sources/cache/spells
 * so re-runs don't re-hit the wiki.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { SpellDbFile, SpellEntry } from '../src/shared/types'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal buff tracker)'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(HERE, 'sources/cache/spells')
const OUT_PATH = resolve(HERE, '../src/main/data/spells.json')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Enumerate all page titles embedding Template:Spellpage, following eicontinue. */
async function listSpellPages(): Promise<{ pageid: number; title: string }[]> {
  const out: { pageid: number; title: string }[] = []
  let eicontinue: string | undefined
  for (let page = 0; page < 200; page++) {
    const params = new URLSearchParams({
      action: 'query',
      list: 'embeddedin',
      eititle: 'Template:Spellpage',
      einamespace: '0', // main namespace only (real spell pages, not template docs)
      eilimit: '500',
      format: 'json',
      formatversion: '2'
    })
    if (eicontinue) params.set('eicontinue', eicontinue)
    const res = await fetch(`${API}?${params}`, { headers: { 'User-Agent': UA } })
    if (!res.ok) throw new Error(`embeddedin query failed: ${res.status}`)
    const json = (await res.json()) as {
      query?: { embeddedin?: { pageid: number; title: string }[] }
      continue?: { eicontinue?: string }
    }
    for (const p of json.query?.embeddedin ?? []) out.push(p)
    eicontinue = json.continue?.eicontinue
    if (!eicontinue) break
    await sleep(120)
  }
  return out
}

/** Fetch a page's raw wikitext (cached to disk). */
async function fetchWikitext(pageid: number, title: string): Promise<string | null> {
  const cacheFile = resolve(CACHE_DIR, `${pageid}.wikitext`)
  if (existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8')
  const params = new URLSearchParams({
    action: 'parse',
    pageid: String(pageid),
    prop: 'wikitext',
    format: 'json',
    formatversion: '2'
  })
  const res = await fetch(`${API}?${params}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) return null
  const json = (await res.json()) as { parse?: { wikitext?: string }; error?: unknown }
  const wt = json.parse?.wikitext
  if (json.error || wt == null) return null
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cacheFile, wt)
  await sleep(120) // politeness between live fetches
  return wt
}

/**
 * Pull `| field = value` assignments out of a Template:Spellpage wikitext block. Values
 * run to the next top-level `| field =` or the template's closing `}}`. We slice the
 * Spellpage block first so nested tables/templates (SpellWhereTable, SpellSlotRow) inside
 * a field value don't get mistaken for template fields.
 */
function parseSpellpageFields(wikitext: string): Record<string, string> {
  const start = wikitext.indexOf('{{Spellpage')
  if (start < 0) return {}
  // Find the matching close of the Spellpage template by brace-depth from `start`.
  let depth = 0
  let end = wikitext.length
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') {
      depth++
      i++
    } else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--
      i++
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  const block = wikitext.slice(start, end)

  // Split on top-level "\n| " field markers (depth 0 relative to the block interior).
  const fields: Record<string, string> = {}
  const fieldRe = /\n\s*\|\s*([a-zA-Z_0-9]+)\s*=/g
  const marks: { name: string; valStart: number }[] = []
  let m: RegExpExecArray | null
  while ((m = fieldRe.exec(block)) !== null) {
    // Only accept a marker at template depth 1 (i.e. a direct Spellpage field, not one
    // inside a nested {{…}}). Compute depth up to this position.
    let d = 0
    for (let i = 0; i < m.index; i++) {
      if (block[i] === '{' && block[i + 1] === '{') { d++; i++ }
      else if (block[i] === '}' && block[i + 1] === '}') { d--; i++ }
    }
    if (d === 1) marks.push({ name: m[1], valStart: m.index + m[0].length })
  }
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]
    const valEnd = i + 1 < marks.length ? findFieldValueEnd(block, cur.valStart, marks[i + 1].valStart) : block.length
    let val = block.slice(cur.valStart, valEnd)
    // The LAST field's value runs to block end, which includes the template's closing
    // `}}` (and any trailing categories). Strip a trailing `}}` + whitespace so it never
    // leaks into the value (was: `msg_wears_off = Your illusion fades. }}`).
    val = val.replace(/\}\}\s*$/, '').trim()
    fields[cur.name.toLowerCase()] = val
  }
  return fields
}

/** The value ends at the next field marker's line start (approximate but robust here). */
function findFieldValueEnd(block: string, from: number, nextMarkerValStart: number): number {
  // nextMarkerValStart is just past "| name =" of the following field; walk back to the
  // start of that "\n| name =" so the current value excludes it.
  const slice = block.slice(from, nextMarkerValStart)
  const lastPipe = slice.lastIndexOf('\n|')
  return lastPipe >= 0 ? from + lastPipe : nextMarkerValStart
}

/** Strip wiki markup from a short field value → plain text. */
function clean(v: string | undefined): string | undefined {
  if (v == null) return undefined
  let s = v
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1') // [[Page|Label]] → Label
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1') // [[Page]] → Page
  s = s.replace(/'''?/g, '') // bold/italic
  s = s.replace(/<[^>]+>/g, ' ') // html tags
  s = s.replace(/\{\{[^}]*\}\}/g, ' ') // stray templates
  s = s.replace(/\s+/g, ' ').trim()
  return s || undefined
}

/** ms for one "<num> <unit>" component. Unit forms: sec/second(s), min/minute(s),
 *  hr/hour(s), tick(s). Returns null for an unknown unit. */
function unitMs(n: number, unitRaw: string): number | null {
  const u = unitRaw.toLowerCase()
  if (/^h(ou)?rs?$|^hr$/.test(u)) return Math.round(n * 3_600_000)
  if (/^m(in(ute)?s?)?$/.test(u)) return Math.round(n * 60_000)
  if (/^s(ec(ond)?s?)?$/.test(u)) return Math.round(n * 1000)
  if (/^ticks?$/.test(u)) return Math.round(n * 6000) // EQ tick = 6s
  return null
}

/**
 * Parse an EQ Legends duration string to ms, or null when unparseable/instant. The wiki
 * uses several forms (validated against real pages):
 *   "27 minutes"                          → 1_620_000
 *   "16 Min" / "11 Min"                   → abbreviated unit
 *   "2 Min 30 Sec"                        → COMPOUND (summed)
 *   "1.5 hours"                           → 5_400_000
 *   "4.4 minutes @L44 to 6.0 minutes @L60"→ a LEVEL FORMULA: take the MAX component
 *      (per the user directive — DB duration is the prior, "more or less the max seen").
 *   "instant" / "permanent" / "" / a pure per-tick effect → null (retain the text).
 * A per-tick regen line ("4 per tick") is NOT a duration and yields null.
 */
export function parseDurationMs(text: string | undefined): number | null {
  if (!text) return null
  const t = text.toLowerCase().trim()
  if (!t || /instant|permanent|until\b|special|varies|n\/a|per tick|per level/.test(t)) return null

  // Collect every "<num> <unit>" component. A plain compound ("2 Min 30 Sec") sums; a
  // level formula ("4.4 minutes … to 6.0 minutes …") takes the max — we distinguish by
  // the presence of a range separator ("to"/"@L"/"@ L").
  const comps: number[] = []
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|sec|ticks?)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t)) !== null) {
    const ms = unitMs(parseFloat(m[1]), m[2])
    if (ms != null) comps.push(ms)
  }
  if (comps.length === 0) return null
  const isFormula = /\bto\b|@\s*l\d|@l\d/.test(t)
  if (isFormula) return Math.max(...comps)
  // Compound sum (e.g. "2 Min 30 Sec") — but a single component is just itself.
  return comps.reduce((a, b) => a + b, 0)
}

function parseSpell(title: string, fields: Record<string, string>): SpellEntry {
  const name = clean(fields.spellname) || title
  const durationText = clean(fields.duration)
  const castRaw = clean(fields.casting_time)
  const castSec = castRaw ? parseFloat(castRaw) : NaN
  const manaRaw = clean(fields.mana)
  const mana = manaRaw && /^\d+$/.test(manaRaw) ? Number(manaRaw) : undefined
  // Illusion detection: the effects/slots/description/other text mentioning "Illusion".
  const effectsBlob = [fields.slots, fields.description, fields.effects, fields.other, fields.spellname]
    .filter(Boolean)
    .join(' ')
  const illusion = /illusion/i.test(effectsBlob)

  return {
    name,
    durationText,
    durationMs: parseDurationMs(durationText),
    castTimeMs: Number.isFinite(castSec) ? Math.round(castSec * 1000) : undefined,
    targetType: clean(fields.target_type),
    spellType: clean(fields.spell_type),
    classes: clean(fields.classes),
    msgCastOnYou: clean(fields.msg_cast_on_you),
    msgCastOnOther: clean(fields.msg_cast_on_other),
    msgWearsOff: clean(fields.msg_wears_off),
    illusion,
    mana
  }
}

async function main(): Promise<void> {
  console.log('Enumerating Template:Spellpage pages…')
  const pages = await listSpellPages()
  console.log(`Found ${pages.length} spell pages. Fetching wikitext…`)

  const spells: SpellEntry[] = []
  let done = 0
  for (const p of pages) {
    const wt = await fetchWikitext(p.pageid, p.title)
    if (wt) {
      const fields = parseSpellpageFields(wt)
      if (Object.keys(fields).length) spells.push(parseSpell(p.title, fields))
    }
    if (++done % 100 === 0) console.log(`  ${done}/${pages.length}`)
  }

  spells.sort((a, b) => a.name.localeCompare(b.name))
  const withDur = spells.filter((s) => s.durationMs != null).length
  const withCastMsg = spells.filter((s) => s.msgCastOnYou || s.msgCastOnOther).length
  const withWearsOff = spells.filter((s) => s.msgWearsOff).length
  const illusions = spells.filter((s) => s.illusion).length

  const out: SpellDbFile = {
    scrapedAt: new Date().toISOString(),
    count: spells.length,
    spells
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))

  console.log(`\nWrote ${spells.length} spells → ${OUT_PATH}`)
  console.log(
    `  durations: ${withDur} (${((withDur / spells.length) * 100).toFixed(0)}%)  ` +
      `cast-msg: ${withCastMsg} (${((withCastMsg / spells.length) * 100).toFixed(0)}%)  ` +
      `wears-off: ${withWearsOff} (${((withWearsOff / spells.length) * 100).toFixed(0)}%)  ` +
      `illusion: ${illusions}`
  )
}

void main()
