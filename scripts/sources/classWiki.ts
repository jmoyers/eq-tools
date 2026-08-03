/**
 * eqlwiki wikitext parsers for the class-knowledge scrape (scripts/scrape-classes.ts).
 *
 * Pure functions over already-fetched wikitext — no network, no disk. They live beside
 * eqlegends.ts because the pattern is the same (a `sources/` module knows the wiki's
 * shape; the `scrape-*` entry point knows politeness, caching and output).
 *
 * The one editorial rule, from docs/plans/class-combo-inference.md § 9 R2: the
 * `Stances & Invocations` page states class access THREE times — a prose `Classes`
 * column, a "…by Class" O-matrix, and per-class sections at the bottom — and the three
 * disagree. THE PROSE COLUMN IS THE AUTHORITY; `disputes()` turns every disagreement
 * into a line for `classes.json`'s `disputed[]`. Nothing is silently picked.
 */

// ---- generic wikitext helpers ---------------------------------------------

/** The text between two heading markers (end-exclusive); '' when start is absent. */
export function sliceSection(wt: string, start: RegExp, end: RegExp): string {
  const s = start.exec(wt)
  if (!s) return ''
  const rest = wt.slice(s.index + s[0].length)
  const e = end.exec(rest)
  return e ? rest.slice(0, e.index) : rest
}

/** Wiki table row chunks (everything between `|-` separators; header chunk dropped). */
export function tableRows(block: string): string[] {
  return block.split(/\n\|-[^\n]*\n/).slice(1)
}

/** The `|`-prefixed cell lines of a row chunk (continuation lines belong to the cell above). */
export function rowCells(chunk: string): string[] {
  return chunk
    .split('\n')
    .filter((l) => l.startsWith('|') && !l.startsWith('|}') && !l.startsWith('|+'))
    .map((l) => l.slice(1).trim())
}

/** Strip wiki link/bold markup down to the display text. */
export function plain(cell: string): string {
  return cell
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The known class codes named in a cell, deduped and sorted. */
function abbrsIn(cell: string, known: Set<string>): string[] {
  const found = new Set<string>()
  for (const m of cell.matchAll(/\b([A-Z]{3})\b/g)) if (known.has(m[1])) found.add(m[1])
  return [...found].sort()
}

/** Column order of a matrix header (positional, so it must NOT be deduped or sorted). */
function abbrsInOrder(header: string, known: Set<string>): string[] {
  return [...header.matchAll(/\b([A-Z]{3})\b/g)].map((m) => m[1]).filter((a) => known.has(a))
}

/** `=== <heading> ===` positions, so a section can be sliced to the next one. */
function headings(wt: string, re: RegExp): { name: string; from: number; to: number }[] {
  const heads = [...wt.matchAll(re)]
  return heads.map((h, i) => ({
    name: h[1],
    from: h.index + h[0].length,
    to: i + 1 < heads.length ? heads[i + 1].index : wt.length
  }))
}

// ---- client-string normalization ------------------------------------------

/**
 * The string the CLIENT prints for a stance/invocation, from the wiki's label.
 * parseCasts.ts lowercases the captured name, so these keys are lowercase.
 */
const CLIENT_ALIAS = new Map<string, string>([
  // Prose heads the row "Empower"; the client says "empowering" (15 in the real log).
  ['empower', 'empowering'],
  // Prose says "Over Channel" (the Magician table says "Overchannel"); the client
  // prints one word, "overchannel" (487 in the real log).
  ['over channel', 'overchannel']
])

export function clientKey(name: string): string {
  const k = plain(name).toLowerCase()
  return CLIENT_ALIAS.get(k) ?? k
}

/**
 * The skill name as the CLIENT prints it. The wiki's skill tables use the classic long
 * forms; the EQ Legends client abbreviates. MEASURED against the 55 distinct
 * "You have become better at <X>!" names in the real 1.1M-line log:
 *   "1 Hand Slashing" → "1H Slashing"     "Channelling"           → "Channeling"
 *   "String"          → "Stringed Instruments"  "Specialize Abjuration" → "Specialize Abjure"
 * Anything not listed here is already spelled the client's way.
 */
const SKILL_ALIAS = new Map<string, string>([
  ['channelling', 'Channeling'],
  ['specialize abjuration', 'Specialize Abjure'],
  ['1h slash', '1H Slashing'],
  ['pick pocket', 'Pick Pockets'],
  ['forage (iksar only)', 'Forage'],
  // The Bard table names the four instrument skills by their bare material; the client
  // prints the full skill ("You have become better at Stringed Instruments!", 70×).
  ['brass', 'Brass Instruments'],
  ['percussion', 'Percussion Instruments'],
  ['string', 'Stringed Instruments'],
  ['wind', 'Wind Instruments'],
  // Spelled both ways across the 16 pages; the client uses the -ing forms.
  ['beg', 'Begging'],
  ['track', 'Tracking']
])

function normalizeSkill(label: string): string {
  const s = plain(label).replace(/\s*\*+$/, '').trim()
  const aliased = SKILL_ALIAS.get(s.toLowerCase())
  if (aliased !== undefined) return aliased
  return s.replace(/^(\d) Hand /, '$1H ')
}

// ---- page parsers ----------------------------------------------------------

/** `Character Classes`: the archetype lists spell each class as `[[Name|…]] (ABC)`. */
export function parseClassNames(wt: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const m of wt.matchAll(/\[\[([^\]|]+)\|[^\]]*\]\]\s*\(([A-Z]{3})\)/g)) {
    names.set(m[2], m[1].replace(/_/g, ' ').trim())
  }
  return names
}

/** The prose `Classes` column of a Stances/Invocations table — the AUTHORITY. */
export function parseProseTable(block: string, known: Set<string>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const chunk of tableRows(block)) {
    const cells = rowCells(chunk)
    if (cells.length < 2) continue
    const classes = abbrsIn(cells[cells.length - 1], known)
    if (classes.length > 0) out.set(clientKey(cells[0]), classes)
  }
  return out
}

/** The "…by Class" O-matrix. Second opinion only; prose wins any disagreement. */
export function parseMatrixTable(block: string, known: Set<string>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const header = /^!\s*'''[^']+'''\s*((?:!!\s*[A-Z]{3}\s*)+)$/m.exec(block)
  if (!header) return out
  const cols = abbrsInOrder(header[1], known)
  for (const line of block.split('\n')) {
    const m = /^\|\s*style=[^|]*\|\s*'''(.+?)'''(.*)$/.exec(line)
    if (!m) continue
    const cells = m[2].split('||').slice(1)
    const classes = cols.filter((_c, i) => i < cells.length && cells[i].trim().length > 0)
    if (classes.length > 0) out.set(clientKey(m[1]), classes.slice().sort())
  }
  return out
}

/**
 * The per-class sections at the bottom of `Stances & Invocations` ("=== [[Monk]] ===",
 * each listing that class's "<X> Stance" / "<X> Invocation" rows). THIRD opinion.
 */
export function parsePerClassSections(
  wt: string,
  abbrOf: Map<string, string>
): Map<string, string[]> {
  const byName = new Map<string, Set<string>>()
  for (const sec of headings(wt, /^===\s*\[\[([^\]]+)\]\]\s*===\s*$/gm)) {
    const abbr = abbrOf.get(plain(sec.name).toLowerCase())
    if (abbr === undefined) continue
    for (const key of sectionEntryKeys(wt.slice(sec.from, sec.to))) {
      const set = byName.get(key) ?? new Set<string>()
      set.add(abbr)
      byName.set(key, set)
    }
  }
  return new Map([...byName].map(([k, v]) => [k, [...v].sort()]))
}

/** The "<X> Stance" / "<X> Invocation" row labels of one per-class section. */
function sectionEntryKeys(section: string): string[] {
  return section
    .split('\n')
    .filter((l) => l.startsWith('|') && !l.startsWith('|}') && !l.startsWith('|-') && !l.includes('{{'))
    .map((l) => clientKey(l.slice(1).replace(/\s+(Stance|Invocation)$/i, '')))
    .filter((k) => k.length > 0)
}

/**
 * A class page's `=Skills=` block → the skill names it trains, client-spelled.
 *
 * The 16 pages use THREE different table layouts (Paladin puts the skill in column 3 of a
 * `||`-packed single-line row; Shadow Knight in column 2; Berserker/Beastlord write one
 * cell per line and order the columns differently). Column INDEXES are therefore useless —
 * the skill is the first cell carrying a `[[wiki link]]`, which is true in every layout and
 * drops the numeric cap cells an index-based read mistook for skill names.
 */
export function parseClassSkills(wt: string): string[] {
  const skills: string[] = []
  for (const sub of skillSubsections(sliceSection(wt, /^=\s*Skills\s*=\s*$/m, /^=[^=]/m))) {
    for (const chunk of tableRows(sub)) {
      const cell = rowCells(chunk)
        .flatMap((c) => c.split('||'))
        .find((c) => c.includes('[['))
      if (cell !== undefined) skills.push(...splitSkillCell(cell))
    }
  }
  return skills
}

/**
 * Only the `== … Skills ==` subsections of the Skills block. The Wizard page parks
 * `== Velious Quests ==` / `== Other Quests ==` INSIDE its Skills section, and those
 * tables are all wiki links too — reading the whole block enrolled four quest pages
 * ("Skunk Hunting", "Ice Goblin Beads", …) as Wizard skills.
 */
function skillSubsections(block: string): string[] {
  const subs = headings(block, /^==+\s*(.+?)\s*==+\s*$/gm)
  if (subs.length === 0) return [block]
  return subs.filter((s) => /skill/i.test(s.name)).map((s) => block.slice(s.from, s.to))
}

/** One skill cell → its skill names. `A / B` is TWO skills (Monk's "Dragon Punch / Tail Rake"). */
function splitSkillCell(cell: string): string[] {
  return plain(cell)
    .split(' / ')
    .map((p) => normalizeSkill(p))
    .filter((n) => n.length > 0 && n.length < 40)
}

/** A class page's footnoted abilities ("* Lay on Hands is an Ability, not a Skill"). */
export function parseAbilityFootnotes(wt: string): string[] {
  const out: string[] = []
  for (const m of wt.matchAll(/^:\s*\*+\s*(.+?)\s+is\s+an?\s+[^.\n]*?\bability\b/gim)) {
    const name = plain(m[1])
    if (name.length > 0 && name.length < 40) out.push(name)
  }
  return out
}

/** `Alternate Advancement` § "=== <Class> Class AAs ===" → class-exclusive ability names. */
export function parseAaAbilities(
  wt: string,
  abbrOf: Map<string, string>
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const sec of headings(wt, /^===\s*(.+?)\s+Class AAs\s*===\s*$/gm)) {
    const abbr = abbrOf.get(plain(sec.name).toLowerCase())
    if (abbr === undefined) continue
    for (const name of aaRowNames(wt.slice(sec.from, sec.to))) {
      const set = out.get(name) ?? new Set<string>()
      set.add(abbr)
      out.set(name, set)
    }
  }
  return out
}

/** The Name column of each `| Name || Ranks || Cost || Description` AA row. */
function aaRowNames(section: string): string[] {
  return tableRows(section)
    .map((chunk) => rowCells(chunk)[0]?.split('||') ?? [])
    .filter((cells) => cells.length >= 3)
    .map((cells) => plain(cells[0]))
    .filter((name) => name.length > 0 && name.length <= 40)
}

// ---- disagreement reporting ------------------------------------------------

/** Every row where a second opinion differs from the prose column. */
export function disputes(
  kind: string,
  other: string,
  prose: Map<string, string[]>,
  cmp: Map<string, string[]>
): string[] {
  const out: string[] = []
  for (const [name, classes] of prose) {
    const theirs = cmp.get(name)
    const mine = classes.join(' ')
    if (theirs === undefined) {
      out.push(`${kind} '${name}': ${other} has no row; prose says ${mine} — prose wins`)
    } else if (theirs.join(' ') !== mine) {
      out.push(`${kind} '${name}': prose ${mine} vs ${other} ${theirs.join(' ')} — prose wins`)
    }
  }
  for (const name of cmp.keys()) {
    if (!prose.has(name)) out.push(`${kind} '${name}': only ${other} has it — ignored (prose wins)`)
  }
  return out
}
