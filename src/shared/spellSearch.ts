// spellSearch — ONE search box that finds everything, as a pure tokenizer + matcher.
//
// docs/plans/suggest-dialog-redesign.md §1. The owner's ask was "search should be
// comprehensive (level, type, name, spell text)", and the design rule that answers it without
// inventing knowledge the app does not have:
//
//   BARE TEXT MATCHES THE SPELL'S OWN WORDS. `SpellCatalogEntry.searchText` is name + rank
//   names + the three message texts, prejoined and lowercased in main. So "slower" finds every
//   spell whose landing emote says it and "dispelled" finds the dispel family — from the game's
//   own strings, never from a hand-built effect taxonomy that would rot (world-model law 1).
//
// FOUR TOKEN FORMS, whitespace-split, AND-composed (every token must match):
//   `slow`        text     — substring of searchText
//   `25`          number   — a class entry level OR a substring of searchText (rank numerals)
//   `level:25`    level    — a class entry level; `level:20-30` is the inclusive range
//   `class:shm`   class    — the line's classLevels contain that class (abbr or full name)
//   `type:buff`   facet    — buff | debuff | illusion | poison | seen, and NOTHING else
//
// THE FACETS ARE EXACTLY WHAT THE DATA CAN ANSWER. Beneficial/Detrimental and the illusion
// flag are DB fields; `poison` reads the shared/poisons.ts roster + its Strike emotes (imported,
// never copied); `seen` is the buffs model's own usage count. There is deliberately no
// `type:slow` / `type:heal` — those go through the message text, which is ground truth. A token
// that names an unknown class or facet matches NOTHING: a typo must narrow to zero rather than
// silently widen to everything.
//
// Lives in shared/ (pure, no imports beyond types + poisons/spellLines) so the dialog and the
// node test suite compile against ONE implementation.

import type { ClassAbbr } from './classCombo'
import type { SpellCatalogEntry } from './buffTypes'
import { classAbbrFor } from './spellLines'
import { POISONS, POISON_PROCS } from './poisons'

/** The five facets `type:` can name — the ones the catalog can answer honestly. */
export type SpellFacet = 'buff' | 'debuff' | 'illusion' | 'poison' | 'seen'

const FACETS: ReadonlySet<string> = new Set<SpellFacet>([
  'buff',
  'debuff',
  'illusion',
  'poison',
  'seen'
])

/** One parsed token. `raw` is kept for the UI (chips/echo) and for debugging a truth table. */
export type SpellSearchToken =
  | { kind: 'text'; raw: string; text: string }
  | { kind: 'number'; raw: string; text: string; n: number }
  | { kind: 'level'; raw: string; lo: number; hi: number }
  | { kind: 'class'; raw: string; cls: ClassAbbr | null }
  | { kind: 'facet'; raw: string; facet: SpellFacet | null }

/** The subset of a catalog row the matcher reads (so tests can state one inline). */
export type SearchableSpell = Pick<
  SpellCatalogEntry,
  'name' | 'searchText' | 'spellType' | 'illusion' | 'usageCount' | 'classLevels'
>

/** `level:20-30` / `level:25`. Returns null for anything else (the caller falls back to text). */
function parseLevelToken(raw: string, value: string): SpellSearchToken | null {
  const range = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(value)
  if (range) {
    const a = Number(range[1])
    const b = Number(range[2])
    return { kind: 'level', raw, lo: Math.min(a, b), hi: Math.max(a, b) }
  }
  const one = /^(\d{1,3})$/.exec(value)
  if (!one) return null
  const n = Number(one[1])
  return { kind: 'level', raw, lo: n, hi: n }
}

/**
 * A `<prefix>:<value>` token, or null when the prefix is not one of ours / the value is
 * unusable — the caller then treats the whole word as text.
 *
 * An EMPTY value ("level:", "class:") is a HALF-TYPED token, not a filter: falling back to text
 * lets the row set stay put while the user finishes the word instead of blanking mid-keystroke.
 */
function parsePrefixedToken(prefix: string, value: string, raw: string): SpellSearchToken | null {
  if (value === '') return null
  if (prefix === 'level' || prefix === 'lvl') return parseLevelToken(raw, value)
  if (prefix === 'class') return { kind: 'class', raw, cls: classAbbrFor(value) }
  if (prefix === 'type') {
    return { kind: 'facet', raw, facet: FACETS.has(value) ? (value as SpellFacet) : null }
  }
  return null
}

/** A single whitespace-delimited word → its token. Prefixes win; everything else is text. */
function parseToken(word: string): SpellSearchToken {
  const lower = word.toLowerCase()
  const colon = lower.indexOf(':')
  const prefixed =
    colon > 0 ? parsePrefixedToken(lower.slice(0, colon), lower.slice(colon + 1), word) : null
  if (prefixed) return prefixed
  const bare = /^(\d{1,3})$/.exec(lower)
  if (bare) return { kind: 'number', raw: word, text: lower, n: Number(bare[1]) }
  return { kind: 'text', raw: word, text: lower }
}

/** Split a query into tokens. Whitespace-delimited; an empty query yields no tokens. */
export function tokenizeSpellQuery(query: string): SpellSearchToken[] {
  return query
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '')
    .map(parseToken)
}

/** Roster names + Strike names, lowercased — the `type:poison` membership test's first half. */
const POISON_NAMES: ReadonlySet<string> = new Set(
  POISONS.flatMap((p) => [p.name.toLowerCase(), ...p.strikes.map((s) => s.toLowerCase())])
)

/** The Strike landing emotes, lowercased — the second half (a Strike the roster doesn't name). */
const POISON_EMOTES: readonly string[] = POISON_PROCS.map((p) => p.suffix.toLowerCase())

/**
 * Is this row a rogue poison? The roster IS the answer (shared/poisons.ts — imported, never
 * copied): a coatable poison, one of its Strikes, or a row whose own emote is a Strike emote.
 */
export function isPoisonSpell(entry: SearchableSpell): boolean {
  if (POISON_NAMES.has(entry.name.trim().toLowerCase())) return true
  return POISON_EMOTES.some((e) => entry.searchText.includes(e))
}

/** Does the row satisfy one facet? */
function matchesFacet(entry: SearchableSpell, facet: SpellFacet | null): boolean {
  switch (facet) {
    case 'buff':
      return entry.spellType === 'Beneficial'
    case 'debuff':
      return entry.spellType === 'Detrimental'
    case 'illusion':
      return entry.illusion
    case 'poison':
      return isPoisonSpell(entry)
    case 'seen':
      return entry.usageCount > 0
    default:
      // An unknown facet names nothing the catalog holds — narrow to zero, never widen.
      return false
  }
}

/** Does any class entry level fall in [lo, hi]? */
function matchesLevel(entry: SearchableSpell, lo: number, hi: number): boolean {
  return (entry.classLevels ?? []).some((c) => c.level >= lo && c.level <= hi)
}

/** Does ONE token match? */
function matchesToken(entry: SearchableSpell, token: SpellSearchToken): boolean {
  switch (token.kind) {
    case 'text':
      return entry.searchText.includes(token.text)
    // A bare number is genuinely two questions ("level 25" and "Rune 2"), and the user has not
    // said which — so it is OR, and the explicit `level:` spelling is there when they mean one.
    case 'number':
      return matchesLevel(entry, token.n, token.n) || entry.searchText.includes(token.text)
    case 'level':
      return matchesLevel(entry, token.lo, token.hi)
    case 'class':
      return token.cls !== null && (entry.classLevels ?? []).some((c) => c.cls === token.cls)
    case 'facet':
      return matchesFacet(entry, token.facet)
  }
}

/** AND across every token — an empty token list matches everything. */
export function matchesSpellQuery(
  entry: SearchableSpell,
  tokens: readonly SpellSearchToken[]
): boolean {
  return tokens.every((t) => matchesToken(entry, t))
}

/** Tokenize + filter in one call (the renderer memoizes the token list separately). */
export function filterSpells<T extends SearchableSpell>(
  entries: readonly T[],
  tokens: readonly SpellSearchToken[]
): T[] {
  if (tokens.length === 0) return [...entries]
  return entries.filter((e) => matchesSpellQuery(e, tokens))
}

// ---- sections ------------------------------------------------------------------------
//
// The spell list is sectioned by what the DATA STATES, in the order the redesign lists them
// (§2.3). Poison wins over the buff/debuff split because a coat's spellType ('Beneficial' — it
// lands on your own blades) is technically true and completely unhelpful; illusion wins over
// buff for the same reason. Everything left is the DB's own Beneficial/Detrimental.

/** Which spell section a row belongs to. A row appears in exactly one. */
export type SpellSection = 'buffs' | 'debuffs' | 'illusions' | 'poisons'

/** Section ids in display order. */
export const SPELL_SECTIONS: readonly SpellSection[] = ['buffs', 'debuffs', 'illusions', 'poisons']

/** Human label per section (one spelling, shared by header and count). */
export const SPELL_SECTION_LABEL: Record<SpellSection, string> = {
  buffs: 'Buffs',
  debuffs: 'Debuffs',
  illusions: 'Illusions',
  poisons: 'Poisons'
}

/**
 * The section for one row. Detrimental → Debuffs; a poison or an illusion is named as such;
 * everything else is a buff — which the catalog guarantees is honest, since a row earns its
 * place only by a Beneficial template or the illusion flag (spellDb.ts buildSpellCatalog).
 */
export function sectionFor(entry: SearchableSpell): SpellSection {
  if (isPoisonSpell(entry)) return 'poisons'
  if (entry.illusion) return 'illusions'
  if (entry.spellType === 'Detrimental') return 'debuffs'
  return 'buffs'
}

/**
 * Partition rows into the four sections, PRESERVING the caller's order inside each (the
 * catalog is already sorted recency-then-alphabetical, and a section must not re-sort it).
 * Every input row lands in exactly one bucket, so the four counts sum to the input length.
 */
export function groupSpellSections<T extends SearchableSpell>(
  entries: readonly T[]
): Record<SpellSection, T[]> {
  const out: Record<SpellSection, T[]> = { buffs: [], debuffs: [], illusions: [], poisons: [] }
  for (const e of entries) out[sectionFor(e)].push(e)
  return out
}
