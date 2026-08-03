/**
 * Class-knowledge scraper (Wave 2 of docs/plans/class-combo-inference.md § 6).
 *
 *   npm run scrape:classes   →   src/main/data/classes.json
 *
 * Produces the STATIC class table the combo-inference module needs and that the
 * log alone cannot supply:
 *
 *   names        abbr → display name (the 16 /who codes)
 *   stances      client stance string      → classes that can assume it
 *   invocations  client invocation string  → classes that can recite it
 *   skills       skill name as the client prints it in
 *                "You have become better at <Skill>!" → classes that train it
 *   abilities    castable things that are NOT Template:Spellpage pages
 *                (Lay on Hands, Holy Steed, …) → classes
 *   disputed     every place the wiki contradicts ITSELF, carried through so the
 *                UI can say so. NOTHING is silently picked.
 *
 * Spell→class is NOT here: spells.json already carries a `classes` field and is
 * parsed at runtime by src/main/data/spellClasses.ts. No spell re-crawl.
 *
 * This file owns politeness, caching and output; the wikitext parsers live in
 * scripts/sources/classWiki.ts (the eqlegends.ts precedent).
 *
 * SCRAPER ETIQUETTE (AGENTS.md, LAW):
 *  - exactly 20 pages, each fetched at most once, DELAY_MS between live fetches;
 *  - 429/5xx → exponential backoff honouring Retry-After;
 *  - raw wikitext cached under scripts/sources/cache/classes, so a re-run is
 *    network-free and a partial run resumes where it stopped;
 *  - output is idempotent: an unchanged payload keeps its original `scrapedAt`,
 *    so a re-run produces a byte-identical file.
 *
 * WHERE THE WIKI DISAGREES WITH ITSELF, PROSE WINS (design § 9 R2). Three
 * independent statements of stance/invocation access exist on one page — the
 * prose `Classes` column, the "…by Class" matrix, and the per-class sections —
 * and they do not agree. The prose column is authoritative; every disagreement
 * is emitted into `disputed[]`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  disputes,
  parseAaAbilities,
  parseAbilityFootnotes,
  parseClassNames,
  parseClassSkills,
  parseMatrixTable,
  parsePerClassSections,
  parseProseTable,
  sliceSection
} from './sources/classWiki'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (personal class-table scraper)'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(HERE, 'sources/cache/classes')
const OUT_PATH = resolve(HERE, '../src/main/data/classes.json')
const SPELLS_PATH = resolve(HERE, '../src/main/data/spells.json')

/** Politeness between LIVE fetches (cache hits never sleep). */
const DELAY_MS = 150
/** First backoff step; doubles per attempt. */
const BACKOFF_MS = 1000
const MAX_ATTEMPTS = 5

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---- fetch layer ----------------------------------------------------------

/** One request, retried with exponential backoff on 429/5xx, honouring Retry-After. */
async function politeFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (res.status !== 429 && res.status < 500) return res
    const retryAfter = Number(res.headers.get('retry-after') ?? '')
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS * 2 ** attempt
    console.warn(`  ${res.status} — backing off ${waitMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`)
    await sleep(waitMs)
  }
  return null
}

function cachePath(title: string): string {
  return resolve(CACHE_DIR, `${title.replace(/[^A-Za-z0-9]+/g, '_')}.wikitext`)
}

/** A page's raw wikitext, from disk when we already have it. */
async function fetchWikitext(title: string): Promise<string | null> {
  const file = cachePath(title)
  if (existsSync(file)) return readFileSync(file, 'utf8')

  const params = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'wikitext',
    format: 'json',
    formatversion: '2',
    redirects: '1'
  })
  const res = await politeFetch(`${API}?${params.toString()}`)
  if (!res?.ok) {
    console.warn(`  ! ${title}: HTTP ${res ? res.status : 'no response'}`)
    return null
  }
  const json = (await res.json()) as { parse?: { wikitext?: string } }
  const wt = json.parse?.wikitext
  if (wt == null) {
    console.warn(`  ! ${title}: no wikitext in response`)
    return null
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(file, wt)
  await sleep(DELAY_MS)
  return wt
}

// ---- cross-checks against the committed spell DB --------------------------

/** Canonical spell keys already covered by spells.json (rank tail stripped, lowercased). */
function spellKeys(): Set<string> {
  const raw = JSON.parse(readFileSync(SPELLS_PATH, 'utf8')) as { spells?: { name?: string }[] }
  const keys = new Set<string>()
  for (const s of raw.spells ?? []) {
    if (typeof s.name === 'string') {
      keys.add(s.name.trim().replace(/ (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/i, '').trim().toLowerCase())
    }
  }
  return keys
}

/**
 * Skills that share a name with a Template:Spellpage spell. MEASURED: three do, and all
 * three carry DIFFERENT class sets — `Frenzy` is the Berserker skill but the Shaman/
 * Beastlord spell; `Smite` the Paladin skill but the Cleric/Paladin spell; `Feign Death`
 * the Monk skill but the Necromancer/Shadow Knight spell. Unioning the two tables would
 * turn the single best Berserker signal into a Shaman signal, so a consumer must resolve
 * a skill-up against `skills` and a cast against spells.json, never against both.
 */
function nameCollisions(skills: Map<string, Set<string>>): string[] {
  const spells = spellKeys()
  return [...skills.keys()]
    .filter((name) => spells.has(name.toLowerCase()))
    .map(
      (name) =>
        `skill '${name}': also a Template:Spellpage spell name with a DIFFERENT class set — ` +
        'resolve skill-ups against skills[] and casts against spells.json; never union them'
    )
}

// ---- assembly -------------------------------------------------------------

interface ClassTableFile {
  scrapedAt: string
  names: Record<string, string>
  stances: Record<string, string[]>
  invocations: Record<string, string[]>
  skills: Record<string, string[]>
  abilities: Record<string, string[]>
  disputed: string[]
}

function sortedRecord<T>(m: Map<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of [...m.keys()].sort()) {
    const v = m.get(k)
    if (v !== undefined) out[k] = v
  }
  return out
}

/** Both halves of `Stances & Invocations`: the authority plus its two dissenters. */
function readStanceInvocation(
  wt: string,
  known: Set<string>,
  abbrOf: Map<string, string>
): { stances: Map<string, string[]>; invocations: Map<string, string[]>; disputed: string[] } {
  const stanceProse = parseProseTable(sliceSection(wt, /^== Stances ==$/m, /^=== Stances by Class/m), known)
  const stanceMatrix = parseMatrixTable(sliceSection(wt, /^=== Stances by Class/m, /^== Invocations ==$/m), known)
  const invProse = parseProseTable(sliceSection(wt, /^== Invocations ==$/m, /^=== Invocations by Class/m), known)
  const invMatrix = parseMatrixTable(sliceSection(wt, /^=== Invocations by Class/m, /^== Pure Melee ==$/m), known)
  const sections = parsePerClassSections(wt, abbrOf)

  const perClass = (t: Map<string, string[]>): Map<string, string[]> =>
    new Map([...sections].filter(([k]) => t.has(k)))

  return {
    stances: stanceProse,
    invocations: invProse,
    disputed: [
      ...disputes('stance', 'the by-class matrix', stanceProse, stanceMatrix),
      ...disputes('stance', 'the per-class sections', stanceProse, perClass(stanceProse)),
      ...disputes('invocation', 'the by-class matrix', invProse, invMatrix),
      ...disputes('invocation', 'the per-class sections', invProse, perClass(invProse))
    ]
  }
}

/** Fetch every class page once; invert its Skills tables and ability footnotes. */
async function readClassPages(
  names: Map<string, string>
): Promise<{ skills: Map<string, Set<string>>; footnotes: Map<string, Set<string>> }> {
  const skills = new Map<string, Set<string>>()
  const footnotes = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, key: string, abbr: string): void => {
    const set = m.get(key) ?? new Set<string>()
    set.add(abbr)
    m.set(key, set)
  }
  for (const abbr of [...names.keys()].sort()) {
    const title = names.get(abbr) ?? abbr
    const wt = await fetchWikitext(title)
    if (wt == null) {
      console.warn(`  ! ${title}: skipped (no wikitext)`)
      continue
    }
    const found = parseClassSkills(wt)
    for (const s of found) add(skills, s, abbr)
    for (const a of parseAbilityFootnotes(wt)) add(footnotes, a, abbr)
    console.log(`  ✓ ${abbr} ${title}: ${found.length} skills`)
  }
  return { skills, footnotes }
}

/** Merge the AA + footnote abilities and drop anything spells.json already covers. */
function buildAbilities(
  aa: Map<string, Set<string>>,
  footnotes: Map<string, Set<string>>
): Map<string, string[]> {
  const known = spellKeys()
  const merged = new Map<string, Set<string>>()
  for (const [name, set] of [...aa, ...footnotes]) {
    const cur = merged.get(name) ?? new Set<string>()
    for (const a of set) cur.add(a)
    merged.set(name, cur)
  }
  const out = new Map<string, string[]>()
  for (const [name, set] of merged) {
    if (known.has(name.toLowerCase())) continue
    out.set(name, [...set].sort())
  }
  return out
}

/** Write only when the payload actually changed, so `scrapedAt` (and the file) is stable. */
function writeIfChanged(next: ClassTableFile): void {
  if (existsSync(OUT_PATH)) {
    const prev = JSON.parse(readFileSync(OUT_PATH, 'utf8')) as ClassTableFile
    const same = JSON.stringify({ ...prev, scrapedAt: '' }) === JSON.stringify({ ...next, scrapedAt: '' })
    if (same) {
      console.log('Payload unchanged — keeping the existing scrapedAt.')
      return
    }
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(next, null, 2) + '\n')
}

async function main(): Promise<void> {
  console.log('Fetching Character Classes…')
  const classesWt = await fetchWikitext('Character Classes')
  if (classesWt == null) throw new Error('Could not fetch Character Classes — nothing to build.')
  const names = parseClassNames(classesWt)
  const known = new Set(names.keys())
  console.log(`  ${known.size} classes: ${[...known].sort().join(' ')}`)

  const abbrOf = new Map<string, string>()
  for (const [abbr, name] of names) {
    abbrOf.set(name.toLowerCase(), abbr)
    abbrOf.set(name.replace(/\s+/g, '').toLowerCase(), abbr) // "Shadowknight" → SHD
  }

  console.log('Fetching Stances & Invocations…')
  const siWt = await fetchWikitext('Stances & Invocations')
  if (siWt == null) throw new Error('Could not fetch Stances & Invocations — nothing to build.')
  const si = readStanceInvocation(siWt, known, abbrOf)

  console.log('Fetching the 16 class pages…')
  const pages = await readClassPages(names)

  console.log('Fetching Alternate Advancement…')
  const aaWt = await fetchWikitext('Alternate Advancement')
  const aa = aaWt == null ? new Map<string, Set<string>>() : parseAaAbilities(aaWt, abbrOf)

  console.log('Fetching Disciplines…')
  const discWt = await fetchWikitext('Disciplines')
  const disputed = [...si.disputed]
  if (discWt == null || !/rogue/i.test(discWt) || !/poison/i.test(discWt)) {
    disputed.push('Disciplines: could not confirm the Rogue-poison statement — poisonCoat exclusivity unverified')
  }
  disputed.push(
    "invocation 'empowering': the prose row is headed \"Empower\"; keyed on the client string"
  )
  disputed.push(
    "invocation 'overchannel': the wiki writes \"Over Channel\" (\"Overchannel\" in the Magician table); keyed on the client string"
  )
  disputed.push(...nameCollisions(pages.skills))
  if (![...pages.skills.keys()].some((k) => k.startsWith('Specialize '))) {
    disputed.push(
      "skill 'Specialize <school>': the class pages list one row, \"Specialization\", and transclude the five " +
        'per-school skills the client actually prints — so 1,251 Specialize skill-ups in the real log resolve to no class'
    )
  }

  const out: ClassTableFile = {
    scrapedAt: new Date().toISOString(),
    names: sortedRecord(names),
    stances: sortedRecord(si.stances),
    invocations: sortedRecord(si.invocations),
    skills: sortedRecord(new Map([...pages.skills].map(([k, v]) => [k, [...v].sort()]))),
    abilities: sortedRecord(buildAbilities(aa, pages.footnotes)),
    disputed: disputed.slice().sort()
  }
  writeIfChanged(out)

  console.log(
    `\nWrote ${Object.keys(out.names).length} classes · ${Object.keys(out.stances).length} stances · ` +
      `${Object.keys(out.invocations).length} invocations · ${Object.keys(out.skills).length} skills · ` +
      `${Object.keys(out.abilities).length} abilities · ${out.disputed.length} disputed → ${OUT_PATH}`
  )
  for (const d of out.disputed) console.log(`  ~ ${d}`)
}

void main()
