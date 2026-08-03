// spellLines.ts — the PURE spell-LINE model behind alert levelling intelligence.
//
// WHAT A "LINE" IS. EQ Legends re-tiers the classic spells as ROMAN-NUMERAL RANKS of one
// base name: the log casts `Mesmerization III`, `Allure VI`, `Lay on Hands X`, `Clarity III`.
// A LINE is therefore exactly the repo's existing rank-fold — `spellCanonKey` (parseCommon.ts)
// — and a RANK is the suffix that fold strips. This module is the one place that keeps the
// suffix instead of discarding it.
//
// TWO SOURCES, AND THEY DISAGREE — say so rather than average them:
//   * the LOG is authoritative for WHICH RANKS EXIST and which you have cast. It prints
//     `You begin casting Mesmerization III.` / `<mob> resisted your Mesmerization III!`.
//   * the committed spell DB (spells.json, scraped from the classic-EQ wiki) is authoritative
//     for the CLASS + LEVEL of a line, and for nothing else here: it holds `Mesmerization`
//     (Enchanter 16) with NO per-rank rows at all. Only 42 of its 1,926 spells form a
//     multi-entry rank line (Rune I–V, Yaulp I–IV, Clarity I–II, the poisons, the AA
//     passives), so the DB CANNOT say what level `Mesmerization III` is.
//   ⇒ a level shown next to a rank is the LINE's level ("Enchanter learns this line at 16"),
//     never the rank's. Callers must label it that way; this module never invents a per-rank
//     level, and `spellLineLevel` returns null rather than guess.
//
// RANK RECENCY. "Which rank am I actually using" is answered by observation, not by the DB:
// the alerts module records the newest ts per rank-preserving DISPLAY name (AlertsSnap
// `spellLastCast`), and `preferredRank` / `rankRecencyOrder` rank a line by it — most recently
// cast first. A rank never cast is never preferred and never offered as an upgrade.
//
// Lives in shared/ so the renderer (suggestions surface, upgrade strip) and any future
// main-side caller compile against ONE implementation; it imports nothing but types.

import type { AlertDef, AlertTrigger, AlertTriggerPrimitive } from './alertTypes'
import type { ClassAbbr } from './classCombo'

/**
 * The rank tail, MIRRORING `spellCanonKey` in src/main/log/parseCommon.ts (I–X, case
 * insensitive). It is repeated rather than imported because parseCommon lives in main and
 * shared/ may not reach into it; the two must stay identical or a line key computed here
 * would not match the key the parser/buffs model uses. `tests/spellLines.test.mts` pins the
 * equality against the real parser helper.
 */
const RANK_TAIL_RE = / (I|II|III|IV|V|VI|VII|VIII|IX|X)$/i

/** Roman numeral → ordinal, for the ten ranks the log and the DB actually use. */
const RANK_VALUE: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10
}

/** One RANK within a line: its display name (suffix intact) and its ordinal. */
export interface SpellRank {
  /** display name exactly as the log/DB spells it ("Mesmerization III", "Clarity"). */
  name: string
  /** 1..10. A name with NO suffix is rank 1 — "Clarity" precedes "Clarity II". */
  rank: number
  /** false when the name carries no roman-numeral suffix (an implicit rank 1). */
  suffixed: boolean
  /** newest ts (ms) this exact rank was observed cast/resisted, or null if never. */
  lastCastMs: number | null
}

/** A spell LINE: the rank-folded key, a display base name, and its ranks (ascending). */
export interface SpellLine {
  /** `spellCanonKey` of every member — lowercased, rank-stripped. */
  key: string
  /** display base name, suffix stripped ("Mesmerization"). */
  base: string
  /** ascending by rank, then by name; deduped by display name. */
  ranks: SpellRank[]
}

/** The line key for a spell display name — mirrors parseCommon.spellCanonKey exactly. */
export function spellLineKey(name: string): string {
  return name.trim().replace(RANK_TAIL_RE, '').trim().toLowerCase()
}

/** Split a display name into its base + rank ordinal. Unsuffixed names are rank 1. */
export function parseSpellRank(name: string): { base: string; rank: number; suffixed: boolean } {
  const trimmed = name.trim()
  const m = RANK_TAIL_RE.exec(trimmed)
  if (!m) return { base: trimmed, rank: 1, suffixed: false }
  return {
    base: trimmed.slice(0, m.index).trim(),
    rank: RANK_VALUE[m[1].toLowerCase()] ?? 1,
    suffixed: true
  }
}

/**
 * Build one line from a set of display names (DB rows ∪ names observed in the log), joined
 * with the rank-preserving recency map. Names are deduped case-insensitively, keeping the
 * FIRST spelling seen — the DB casing wins when the caller passes DB names first (the log
 * and the wiki disagree on case: "Invisibility versus Undead" vs "Invisibility Versus Undead").
 */
export function buildSpellLine(
  key: string,
  names: readonly string[],
  lastCastMs: Readonly<Record<string, number>> = {}
): SpellLine {
  const seen = new Map<string, SpellRank>()
  let base = key
  for (const raw of names) {
    const parsed = parseSpellRank(raw)
    const dedupe = raw.trim().toLowerCase()
    if (seen.has(dedupe)) continue
    base = parsed.base
    seen.set(dedupe, {
      name: raw.trim(),
      rank: parsed.rank,
      suffixed: parsed.suffixed,
      lastCastMs: lookupLastCast(lastCastMs, raw)
    })
  }
  const ranks = [...seen.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
  return { key, base, ranks }
}

/** Case-insensitive read of the recency map (log casing ≠ DB casing). */
function lookupLastCast(lastCastMs: Readonly<Record<string, number>>, name: string): number | null {
  const direct = lastCastMs[name.trim()]
  if (direct != null) return direct
  const wanted = name.trim().toLowerCase()
  for (const [k, v] of Object.entries(lastCastMs)) {
    if (k.toLowerCase() === wanted) return v
  }
  return null
}

/**
 * A line's ranks ordered the way the suggestions surface lists them: MOST RECENTLY CAST
 * first (the owner's rule — the rank you are actually using is the one you want an alert
 * for), then never-cast ranks by DESCENDING rank. Pure; never mutates the input.
 */
export function rankRecencyOrder(ranks: readonly SpellRank[]): SpellRank[] {
  return [...ranks].sort((a, b) => {
    const at = a.lastCastMs
    const bt = b.lastCastMs
    if (at != null && bt != null && at !== bt) return bt - at
    if (at != null && bt == null) return -1
    if (at == null && bt != null) return 1
    return b.rank - a.rank || a.name.localeCompare(b.name)
  })
}

/**
 * The rank a one-click suggestion should target: the most recently CAST rank, else — when
 * the line has never been observed — the highest rank known. Null for an empty line.
 */
export function preferredRank(ranks: readonly SpellRank[]): SpellRank | null {
  return rankRecencyOrder(ranks)[0] ?? null
}

// ---- class levels ------------------------------------------------------------------
//
// The spell DB's `classes` field is the wiki's bullet list collapsed to one line:
//   "* Cleric - Level 1 (Autogranted) * Paladin - Level 9"
// src/main/data/spellClasses.ts parses the same string for the CLASS SET (class-combo
// inference) and discards the level. This is its level-keeping twin: same grammar, same
// closed class vocabulary, and the same honest empty result for the 27 "NPCs only" /
// "No eligible class" rows.

/** One class's entry level for a spell line. */
export interface ClassLevel {
  cls: ClassAbbr
  level: number
}

/** Wiki class name → /who code. Mirrors spellClasses.ts ABBR_BY_NAME (both wiki spellings). */
const ABBR_BY_NAME: Record<string, ClassAbbr> = {
  bard: 'BRD',
  beastlord: 'BST',
  berserker: 'BER',
  cleric: 'CLR',
  druid: 'DRU',
  enchanter: 'ENC',
  magician: 'MAG',
  monk: 'MNK',
  necromancer: 'NEC',
  paladin: 'PAL',
  ranger: 'RNG',
  rogue: 'ROG',
  'shadow knight': 'SHD',
  shadowknight: 'SHD',
  shaman: 'SHM',
  warrior: 'WAR',
  wizard: 'WIZ'
}

/**
 * Parse a `classes` string into per-class entry levels, sorted by level then class. A class
 * named twice (rank variants folded into one line) keeps its LOWEST level — the earliest
 * level at which the line becomes available, which is what a level chip means.
 */
export function parseSpellClassLevels(classes: string | undefined): ClassLevel[] {
  if (classes === undefined) return []
  const best = new Map<ClassAbbr, number>()
  for (const m of classes.matchAll(/\*\s*([A-Za-z][A-Za-z ]*?)\s*-\s*Level\s*(\d+)/g)) {
    const cls = ABBR_BY_NAME[m[1].trim().toLowerCase()]
    if (cls === undefined) continue
    const level = Number(m[2])
    const prev = best.get(cls)
    if (prev === undefined || level < prev) best.set(cls, level)
  }
  return [...best.entries()]
    .map(([cls, level]) => ({ cls, level }))
    .sort((a, b) => a.level - b.level || a.cls.localeCompare(b.cls))
}

/** What a level chip should say — or null when the DB places the line in no class at all. */
export interface LineLevel {
  /** the level to show. */
  level: number
  /** the class it belongs to, when ONE candidate class survives; omitted otherwise. */
  cls?: ClassAbbr
  /**
   * true when the shown level is the MINIMUM across several candidate classes because the
   * loadout is ambiguous/unknown — the UI must say "min", never present it as yours.
   */
  ambiguous: boolean
}

/**
 * The level to display for a line, given the classes the combo module has RESOLVED.
 *
 * Rules (world-model law 1 — never guess):
 *   * resolved ∩ the line's classes has exactly one class ⇒ that class's level, unambiguous.
 *   * it has several ⇒ the MINIMUM of those levels, flagged ambiguous.
 *   * the intersection is EMPTY (loadout unknown, or none of your classes cast it) ⇒ the
 *     minimum across ALL classes that can cast it, flagged ambiguous.
 *   * the DB places the line in no class ⇒ null, and the caller omits the chip.
 */
export function spellLineLevel(
  levels: readonly ClassLevel[],
  resolved: readonly ClassAbbr[]
): LineLevel | null {
  if (levels.length === 0) return null
  const mine = levels.filter((l) => resolved.includes(l.cls))
  const pool = mine.length > 0 ? mine : levels
  const best = pool.reduce((a, b) => (b.level < a.level ? b : a))
  if (mine.length === 1) return { level: best.level, cls: best.cls, ambiguous: false }
  return { level: best.level, ambiguous: true }
}

// ---- upgrade offers ----------------------------------------------------------------
//
// An alert whose trigger names a rank ("Mesmerization III") goes STALE the moment you level
// into the next rank — it simply stops firing, silently. The offer strip is the fix, and it
// is an OFFER: nothing is ever rewritten without a click (AGENTS.md "state, never process";
// world-model law 1).
//
// TWO ACTIONS, and ADD-ALONGSIDE IS THE DEFAULT (owner decision). EQ Legends' loadout system
// means you can be a level-50 Paladin in one trio and a low-level Paladin in another; a swap
// puts you back on the old rank, so REPLACING the alert would silently mute it in the other
// loadout. Keeping both defs is the honest default; Replace is the deliberate "I've abandoned
// that rank" action. Both preserve the user's sound, volume and cooldown choices — the same
// respect-the-user semantics as `migrateAlertSounds` in main/data/defaultPacks.ts.

/** A single pending offer: this line has a rank you now cast that no alert covers yet. */
export interface RankUpgradeOffer {
  /** stable, content-derived id — the per-offer dismissal key. */
  id: string
  /** the alert that would be rewritten by Replace (the highest-ranked def in the line). */
  alertId: string
  alertName: string
  /** the line these defs belong to. */
  lineKey: string
  /** the rank display name that alert references today ("Mesmerization III"). */
  from: string
  /** the rank display name you have since cast ("Mesmerization IV"). */
  to: string
  /** every rank display name already covered by an existing alert, ascending. */
  covered: string[]
}

/**
 * The literal (non-regex) spell name a PRIMITIVE trigger pins, or null. A `/…/` matcher value
 * is a user-authored regex — deliberately left alone, because rewriting a pattern is not a
 * mechanical substitution and we would be guessing at intent.
 */
function primitiveSpell(t: AlertTriggerPrimitive): string | null {
  if (t.type !== 'event') return null
  const spec = t.where?.spell
  if (spec === undefined) return null
  if (spec.length >= 2 && spec.startsWith('/') && spec.endsWith('/')) return null
  return spec.trim() || null
}

/** Every literal spell name a trigger (primitive or composite) pins. */
export function triggerSpells(trigger: AlertTrigger): string[] {
  const conditions: AlertTriggerPrimitive[] =
    'conditions' in trigger ? trigger.conditions : [trigger]
  const out: string[] = []
  for (const c of conditions) {
    const spell = primitiveSpell(c)
    if (spell !== null) out.push(spell)
  }
  return out
}

/** An alert + the ONE rank-suffixed spell it pins. Defs pinning none are not upgradable. */
interface RankedDef {
  def: AlertDef
  spell: string
  rank: number
}

/** Defs that pin a rank-SUFFIXED spell — the only ones a rank upgrade can be about. */
function rankedDefs(defs: readonly AlertDef[]): RankedDef[] {
  const out: RankedDef[] = []
  for (const def of defs) {
    for (const spell of triggerSpells(def.trigger)) {
      const parsed = parseSpellRank(spell)
      if (parsed.suffixed) out.push({ def, spell, rank: parsed.rank })
    }
  }
  return out
}

/** The best not-yet-covered rank for a line: most recently cast, tie-broken by highest rank. */
function upgradeTarget(
  line: SpellLine,
  coveredKeys: ReadonlySet<string>,
  minRank: number
): SpellRank | null {
  const candidates = line.ranks.filter(
    (r) => r.lastCastMs != null && r.rank > minRank && !coveredKeys.has(r.name.toLowerCase())
  )
  return rankRecencyOrder(candidates)[0] ?? null
}

/**
 * Detect upgrade offers across the whole alert list.
 *
 * ALL existing defs in a line are considered together (owner amendment): with ranks III and V
 * already covered, only a rank you have cast ABOVE V and do not already have an alert for is
 * offered — a rank already covered is never re-offered, and adding alongside therefore
 * converges instead of nagging. At most ONE offer per line, so the strip never stacks two
 * rows for the same spell.
 */
export function detectRankUpgrades(
  defs: readonly AlertDef[],
  lines: readonly SpellLine[]
): RankUpgradeOffer[] {
  const byKey = new Map(lines.map((l) => [l.key, l]))
  const grouped = new Map<string, RankedDef[]>()
  for (const rd of rankedDefs(defs)) {
    const key = spellLineKey(rd.spell)
    const list = grouped.get(key)
    if (list) list.push(rd)
    else grouped.set(key, [rd])
  }
  const offers: RankUpgradeOffer[] = []
  for (const [key, members] of grouped) {
    const line = byKey.get(key)
    if (!line) continue
    const covered = [...members].sort((a, b) => a.rank - b.rank)
    const coveredKeys = new Set(covered.map((m) => m.spell.toLowerCase()))
    const top = covered[covered.length - 1]
    const to = upgradeTarget(line, coveredKeys, top.rank)
    if (!to) continue
    offers.push({
      id: `upgrade:${key}:${top.spell.toLowerCase()}>${to.name.toLowerCase()}`,
      alertId: top.def.id,
      alertName: top.def.name,
      lineKey: key,
      from: top.spell,
      to: to.name,
      covered: covered.map((m) => m.spell)
    })
  }
  return offers.sort((a, b) => a.lineKey.localeCompare(b.lineKey))
}

/** Rewrite one primitive's `where.spell` from `from` to `to` (case-insensitive compare). */
function repointPrimitive(
  t: AlertTriggerPrimitive,
  from: string,
  to: string
): AlertTriggerPrimitive {
  if (t.type !== 'event') return t
  if (t.where?.spell?.trim().toLowerCase() !== from.trim().toLowerCase()) return t
  return { ...t, where: { ...t.where, spell: to } }
}

/** Repoint a whole trigger (primitive or composite) at the new rank. */
function repointTrigger(trigger: AlertTrigger, from: string, to: string): AlertTrigger {
  if ('conditions' in trigger) {
    return { ...trigger, conditions: trigger.conditions.map((c) => repointPrimitive(c, from, to)) }
  }
  return repointPrimitive(trigger, from, to)
}

/**
 * REPLACE: the same alert, now pinned to `to`. Id, sound, volume, cooldown and enabled flag
 * are preserved verbatim; only the trigger and the rank inside the display name move.
 */
export function replaceRankInDef(def: AlertDef, from: string, to: string): AlertDef {
  return {
    ...def,
    name: renameForRank(def.name, from, to),
    trigger: repointTrigger(def.trigger, from, to),
    note: `${def.note ? `${def.note} ` : ''}Upgraded from ${from} to ${to}.`
  }
}

/**
 * ADD ALONGSIDE (the default): a NEW alert for `to`, leaving the `from` alert untouched so a
 * loadout swap back to the old rank still fires. Same sound/volume/cooldown — the user's
 * choices are the point of cloning rather than re-seeding.
 */
export function addRankAlongsideDef(def: AlertDef, from: string, to: string): AlertDef {
  return {
    ...replaceRankInDef(def, from, to),
    id: `${def.id}::rank:${spellIdFragment(to)}`,
    note: `Added alongside ${def.name} — same alert for ${to}.`
  }
}

/** Swap the old rank's display name inside an alert name, appending it when absent. */
function renameForRank(name: string, from: string, to: string): string {
  const idx = name.toLowerCase().indexOf(from.trim().toLowerCase())
  if (idx < 0) return `${name} (${to})`
  return name.slice(0, idx) + to + name.slice(idx + from.trim().length)
}

/** A display name reduced to a stable, id-safe fragment ("Mesmerization IV" → `mesmerization-iv`). */
export function spellIdFragment(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
