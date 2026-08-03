// Spell → class table (Wave 2 of docs/plans/class-combo-inference.md § 3.1 / § 6).
//
// NO SCRAPE IS INVOLVED. src/main/data/spells.json ALREADY carries a `classes` field on
// every spell, straight from the wiki's Template:Spellpage — it is a bullet list that
// scrape-spells.ts's clean() collapsed to a single line, losing the newlines but no data:
//
//   "* Beastlord - Level 1 (Autogranted) * Cleric - Level 1 (Autogranted) * Druid - Level 1
//    (Autogranted) * Paladin - Level 1 * Ranger - Level 1 * Shaman - Level 1"
//
// So this module is a PURE PARSE of committed data, done ONCE at module init (1,926
// entries, ~1,899 of which state classes). The other 27 say "This spell is cast by NPCs
// only." / "No eligible class" and simply produce no entry — absence is honest here.
//
// KEYED BY spellCanonKey, the repo's existing rank-normalizer (parseCommon.ts), because
// casts print a Roman-numeral rank ("You begin casting Lay on Hands VII.") that fades and
// fizzles drop. Two spells that canonicalize to the same key UNION their class sets:
// union is the CONSERVATIVE direction (it widens the candidate set, never narrows it), so
// a rank-strip collision can only ever make the inference less certain, never wrong
// (design § 9 R9).
//
// MEASURED coverage over the committed DB, and this is a hard "say what the log cannot
// say" boundary: BER, MNK and WAR have LITERALLY ZERO spells and ROG has nine. Three of
// sixteen classes are invisible to cast evidence entirely; skill-ups, stances and poison
// coats are the only way to see them.
import { spellCanonKey } from '../log/parseCommon'
// ES-imported so electron-vite INLINES it into the main bundle — a path-relative readFile
// would miss under out/main/ (AGENTS.md, Toolchain gotchas). Same rule as spellDb.ts.
import spellsJson from './spells.json'
import type { SpellDbFile } from '../../shared/types'

/**
 * The 16 EQ Legends classes by their /who three-letter code.
 *
 * DECLARED LOCALLY ON PURPOSE. The canonical home for this type is
 * `src/shared/classCombo.ts`, which Wave 3 owns and which does not exist yet; a local
 * copy keeps Wave 2's file ownership disjoint from Wave 3's. When that file lands its
 * `ClassAbbr` SUPERSEDES this one and this alias should be re-pointed at it.
 */
export type ClassAbbr =
  | 'BER'
  | 'BRD'
  | 'BST'
  | 'CLR'
  | 'DRU'
  | 'ENC'
  | 'MAG'
  | 'MNK'
  | 'NEC'
  | 'PAL'
  | 'RNG'
  | 'ROG'
  | 'SHD'
  | 'SHM'
  | 'WAR'
  | 'WIZ'

/**
 * Wiki class name → /who code. The wiki spells the Shadow Knight BOTH ways across its own
 * spell pages ("Shadow Knight" 75×, "Shadowknight" 15× in the committed DB); both
 * canonicalize to SHD.
 */
const ABBR_BY_NAME = new Map<string, ClassAbbr>([
  ['bard', 'BRD'],
  ['beastlord', 'BST'],
  ['berserker', 'BER'],
  ['cleric', 'CLR'],
  ['druid', 'DRU'],
  ['enchanter', 'ENC'],
  ['magician', 'MAG'],
  ['monk', 'MNK'],
  ['necromancer', 'NEC'],
  ['paladin', 'PAL'],
  ['ranger', 'RNG'],
  ['rogue', 'ROG'],
  ['shadow knight', 'SHD'],
  ['shadowknight', 'SHD'],
  ['shaman', 'SHM'],
  ['warrior', 'WAR'],
  ['wizard', 'WIZ']
])

/**
 * One `classes` field → the classes it names, deduped and sorted.
 *
 * Each bullet is `* <Class> - Level <n>` with an optional trailing note ("(Autogranted)").
 * Anything that does not match that shape — the NPC-only and "No eligible class" strings —
 * yields an empty list rather than a guess.
 */
export function parseSpellClassString(classes: string | undefined): ClassAbbr[] {
  if (classes === undefined) return []
  const found = new Set<ClassAbbr>()
  for (const m of classes.matchAll(/\*\s*([A-Za-z][A-Za-z ]*?)\s*-\s*Level\s*\d+/g)) {
    const abbr = ABBR_BY_NAME.get(m[1].trim().toLowerCase())
    if (abbr !== undefined) found.add(abbr)
  }
  return [...found].sort()
}

/** Build the canon-key → class-set index once, at module init. */
function buildIndex(): Map<string, Set<ClassAbbr>> {
  const index = new Map<string, Set<ClassAbbr>>()
  for (const spell of (spellsJson as SpellDbFile).spells) {
    const classes = parseSpellClassString(spell.classes)
    if (classes.length === 0) continue
    const key = spellCanonKey(spell.name)
    const set = index.get(key) ?? new Set<ClassAbbr>()
    for (const abbr of classes) set.add(abbr)
    index.set(key, set)
  }
  return index
}

const INDEX: ReadonlyMap<string, ReadonlySet<ClassAbbr>> = buildIndex()

/** The whole table: rank-normalized spell key → the classes that can cast it. */
export function spellClassIndex(): ReadonlyMap<string, ReadonlySet<ClassAbbr>> {
  return INDEX
}

/**
 * The classes that can cast `spell`, sorted. Takes the DISPLAY name (rank suffix and all —
 * it is normalized here), and returns `[]` for anything the DB does not place, which is
 * the honest answer for NPC-only spells, item clickies and abilities that are not
 * Template:Spellpage pages (those live in classes.json's `abilities`).
 */
export function classesForSpell(spell: string): ClassAbbr[] {
  const set = INDEX.get(spellCanonKey(spell))
  return set === undefined ? [] : [...set].sort()
}
