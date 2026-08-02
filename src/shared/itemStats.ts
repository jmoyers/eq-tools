// itemStats.ts — the EQ item WINDOW model: raw stat-block text → structured fields.
//
// Shared main↔renderer (pure, zero deps) because BOTH sides hold stat-block text:
//   - main: the wiki `{{Itempage}} |statsblock` (see itemLookupParse.ts), and
//   - renderer: the posky scrape's `PoskyItem.stats` (scraped from the same pages'
//     rendered HTML), which the hover tooltip renders with no main round-trip.
// One parser so both surfaces draw the SAME game-style window.
//
// The stat block is the in-game item window's text, verbatim. Real samples (fetched
// from eqlwiki.com, 2026-08-02) that this parser is written against:
//
//   Red Dragonscale Armor        Djarn's Amethyst Ring       Skycleaver
//   ---------------------        ---------------------       ----------
//   MAGIC ITEM                   MAGIC ITEM  LORE ITEM       Lore Equipped, No Trade
//   Slot: CHEST                  Slot: FINGER                Slot: PRIMARY
//   AC: 21                       AGI: +9  HP: +80            Class: BER
//   STR: +20                     WT: 0.1  Size: TINY         Race: ALL
//   SV FIRE: +10  SV MAGIC: +10  Class: ALL                  Skill: 2H Slashing  Atk Delay: 35
//   WT: 2.5  Size: LARGE         Race: ALL                   DMG: 30  Dmg Bon: 24
//   Class: WAR PAL RNG SHD ...   (|focus_effect = Spell      STA: +5  DEX: +10
//   Race: ALL                     Haste II)                  SV DISEASE: +5
//                                                            WT: 8.0  Size: GIANT
//                                                            Combat Effect: Haste (Req Level 30)
//
// Line grammar (all observed): a line is a sequence of `Key: value` pairs separated by
// whitespace (`WIS: +9  INT: +9 SV POISON: +1` — sometimes only ONE space, and
// `Skill: Hand to Hand Atk Delay: 24` has no separator at all). So values are scanned
// to the next KNOWN key rather than split on whitespace. A line with no known key is a
// FLAGS line (`NO TRADE MAGIC ITEM  LORE ITEM`, `Lore Equipped, Attunable`).
//
// LAW 1 (never invent): anything not recognized is preserved verbatim in `extras` and
// rendered as-is — never dropped, never guessed at. Absent fields stay `undefined`
// (unknown), which the UI renders as "no row", NOT as an empty/zero row.

// ---- types --------------------------------------------------------------------

/** Which exaltation/effect socket an effect line belongs to (see itemLookupParse.ts). */
export type ItemEffectKind = 'combat' | 'focus' | 'click' | 'worn' | 'proc' | 'effect'

export interface ItemEffect {
  kind: ItemEffectKind
  /** spell/effect name, wiki markup stripped */
  name: string
  /** the parenthetical as written ("Combat, Casting Time: Instant", "Must Equip", "Worn") */
  detail?: string
  /** level requirement, from `(Req Level N)` or `at Level N` */
  reqLevel?: number
}

/** A `KEY: value` stat pair, key normalized upper-case, value verbatim ("+20", "36%"). */
export interface ItemStat {
  key: string
  value: string
}

/**
 * An exaltation SOCKET as the item window lists it. Only ever populated from text that
 * actually says so (`Slot: Ornamentation: empty`) — we never synthesize socket rows for
 * an item whose sockets we haven't observed.
 */
export interface ItemExaltationSlot {
  type: string
  /** socket contents; undefined = the source didn't say (unknown ≠ empty) */
  content?: string
  /** true only when the source explicitly said "empty" */
  empty?: boolean
}

export interface ItemStatBlock {
  /** "No Trade", "Lore Item", "Magic Item", … display-cased, source order */
  flags: string[]
  /** equip slot as written ("CHEST", "PRIMARY SECONDARY") */
  slot?: string
  /** usable classes ("ALL" collapses to `['ALL']`) */
  classes?: string[]
  races?: string[]
  skill?: string
  atkDelay?: number
  dmg?: number
  dmgBonus?: number
  backstab?: number
  ac?: number
  weight?: string
  size?: string
  range?: string
  /** everything else in `KEY: value` form, source order (STR/HP/MANA/Haste/…) */
  stats: ItemStat[]
  /** the SV * subset, split out because the game window right-aligns them */
  saves: ItemStat[]
  effects: ItemEffect[]
  exaltationSlots: ItemExaltationSlot[]
  /** recognized-but-unmodeled lines, verbatim (rendered as-is; never dropped) */
  extras: string[]
}

// ---- key tables ---------------------------------------------------------------

const SAVE_KEYS = [
  'SV FIRE', 'SV COLD', 'SV MAGIC', 'SV DISEASE', 'SV POISON',
  'SV VOID', 'SV CORRUPTION', 'SV CHROMATIC', 'SV PRISMATIC', 'SV ALL'
]

const EFFECT_KEYS = ['Combat Effect', 'Click Effect', 'Worn Effect', 'Proc Effect', 'Focus Effect', 'Effect']

const STRUCT_KEYS = [
  'Slot', 'Class', 'Race', 'Skill', 'Atk Delay', 'Delay', 'DMG', 'Dmg Bon', 'Damage Bonus',
  'BACKSTAB', 'Backstab', 'WT', 'Weight', 'Size', 'Range', 'AC'
]

/** Plain `KEY: value` stats that land in the attribute grid. */
const STAT_KEYS = [
  'STR', 'STA', 'AGI', 'DEX', 'WIS', 'INT', 'CHA', 'HP', 'MANA', 'END', 'ENDURANCE',
  'Haste', 'Attack', 'Regen', 'Mana Regen', 'Charges', 'Rec Level', 'Recommended Level',
  'Required Level', 'Req Level', 'Cast Time', 'Cooldown', 'Recast', 'Range Damage'
]

const ALL_KEYS = [...SAVE_KEYS, ...EFFECT_KEYS, ...STRUCT_KEYS, ...STAT_KEYS]

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Longest-first so `Dmg Bon` wins over `DMG` and `Atk Delay` over `Delay` at the same spot.
const KEY_ALT = [...ALL_KEYS].sort((a, b) => b.length - a.length).map(esc).join('|')
const KEY_RE = new RegExp(`(?:^|\\s)(${KEY_ALT})\\s*:\\s*`, 'gi')

/** Flag phrases the game prints above the stats. Longest-first; matched case-insensitively. */
const FLAG_PHRASES = [
  'LORE EQUIPPED', 'MAGIC ITEM', 'LORE ITEM', 'QUEST ITEM', 'NO DROP', 'NO TRADE', 'NO RENT',
  'NO STORAGE', 'ATTUNABLE', 'TEMPORARY', 'EXPENDABLE', 'PLACEABLE', 'ARTIFACT', 'AUGMENTATION'
].sort((a, b) => b.length - a.length)

const EXALT_SLOT_NAMES = ['Ornamentation', 'Focus', 'Click', 'Worn', 'Proc']

// ---- text cleanup -------------------------------------------------------------

/** `[[Page|<span…>Label</span>]]` / `[[Page]]` / HTML → plain text. */
export function stripWikiMarkup(s: string): string {
  return s
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/'''?/g, '')
}

// ---- parsing ------------------------------------------------------------------

function parseFlagLine(line: string, out: string[]): void {
  let rest = line
  for (const phrase of FLAG_PHRASES) {
    const re = new RegExp(`(?:^|[\\s,])${esc(phrase)}(?=$|[\\s,])`, 'i')
    const m = re.exec(rest)
    if (!m) continue
    out.push(titleCase(phrase))
    rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length)
  }
  // Anything left over is an unknown flag — keep it VERBATIM rather than dropping it.
  for (const chunk of rest.split(/,|\s{2,}/)) {
    const t = chunk.trim()
    if (t) out.push(t)
  }
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

function parseEffect(key: string, rawValue: string): ItemEffect {
  const value = rawValue.trim()
  const paren = /\(([^)]*)\)/.exec(value)
  const detail = paren?.[1]?.trim()
  const name = value
    .replace(/\([^)]*\)/g, '')
    .replace(/\bat Level\s+\d+/i, '')
    .trim()
    .replace(/[,;]$/, '')
  const lvl = /Req(?:uires)?\.?\s*Level\s*[: ]\s*(\d+)/i.exec(value) ?? /\bat Level\s+(\d+)/i.exec(value)

  const k = key.toLowerCase()
  let kind: ItemEffectKind = 'effect'
  if (k.startsWith('combat')) kind = 'combat'
  else if (k.startsWith('click')) kind = 'click'
  else if (k.startsWith('worn')) kind = 'worn'
  else if (k.startsWith('proc')) kind = 'proc'
  else if (k.startsWith('focus')) kind = 'focus'
  else if (detail) {
    // Bare `Effect:` — the parenthetical says which socket it is.
    const d = detail.toLowerCase()
    if (d.startsWith('combat')) kind = 'combat'
    else if (d.startsWith('worn')) kind = 'worn'
    else if (d.includes('must equip') || d.includes('any slot') || d.includes('casting time')) kind = 'click'
  }
  return { kind, name, detail, ...(lvl ? { reqLevel: Number(lvl[1]) } : {}) }
}

const num = (s: string): number | undefined => {
  const m = /-?\d+(?:\.\d+)?/.exec(s)
  return m ? Number(m[0]) : undefined
}

/**
 * Parse an EQ item stat block (wikitext `|statsblock` OR scraped page text) into the
 * fields the item window draws. Never throws; unknown text survives in `extras`.
 */
export function parseStatsBlock(raw: string): ItemStatBlock {
  const out: ItemStatBlock = { flags: [], stats: [], saves: [], effects: [], exaltationSlots: [], extras: [] }
  const lines = stripWikiMarkup(raw)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)

  for (const line of lines) {
    KEY_RE.lastIndex = 0
    const hits: Array<{ key: string; from: number; to: number }> = []
    let m: RegExpExecArray | null
    while ((m = KEY_RE.exec(line)) !== null) {
      hits.push({ key: m[1], from: m.index, to: m.index + m[0].length })
      // Zero-width guard (a key can't be empty, but be safe against pathological input).
      if (KEY_RE.lastIndex === m.index) KEY_RE.lastIndex++
    }

    if (hits.length === 0) {
      parseFlagLine(line, out.flags)
      continue
    }
    // Text before the first key on a line that DOES have keys is unmodeled — keep it.
    const lead = line.slice(0, hits[0].from).trim()
    if (lead) out.extras.push(lead)

    for (let i = 0; i < hits.length; i++) {
      const key = hits[i].key
      const value = line.slice(hits[i].to, i + 1 < hits.length ? hits[i + 1].from : line.length).trim()
      applyPair(out, key, value)
    }
  }
  return out
}

function applyPair(out: ItemStatBlock, keyRaw: string, value: string): void {
  const key = keyRaw.trim()
  const upper = key.toUpperCase()

  if (EFFECT_KEYS.some((k) => k.toUpperCase() === upper)) {
    if (value) out.effects.push(parseEffect(key, value))
    return
  }
  if (SAVE_KEYS.includes(upper)) {
    if (value) out.saves.push({ key: upper, value })
    return
  }

  switch (upper) {
    case 'SLOT': {
      // `Slot: Ornamentation: empty` — an EXALTATION socket row, not the equip slot.
      const sub = /^(\w+)\s*:\s*(.*)$/.exec(value)
      if (sub && EXALT_SLOT_NAMES.some((n) => n.toLowerCase() === sub[1].toLowerCase())) {
        const content = sub[2].trim()
        out.exaltationSlots.push(
          /^empty$/i.test(content) ? { type: titleCase(sub[1]), empty: true } : { type: titleCase(sub[1]), content }
        )
        return
      }
      if (value) out.slot = out.slot ? `${out.slot} ${value}` : value
      return
    }
    case 'CLASS':
      if (value) out.classes = value.split(/[\s,]+/).filter(Boolean)
      return
    case 'RACE':
      if (value) out.races = value.split(/[\s,]+/).filter(Boolean)
      return
    case 'SKILL':
      if (value) out.skill = value
      return
    case 'ATK DELAY':
    case 'DELAY':
      out.atkDelay = num(value)
      return
    case 'DMG':
      out.dmg = num(value)
      return
    case 'DMG BON':
    case 'DAMAGE BONUS':
      out.dmgBonus = num(value)
      return
    case 'BACKSTAB':
      out.backstab = num(value)
      return
    case 'AC':
      out.ac = num(value)
      return
    case 'WT':
    case 'WEIGHT':
      if (value) out.weight = value
      return
    case 'SIZE':
      if (value) out.size = value
      return
    case 'RANGE':
      if (value) out.range = value
      return
    default:
      if (value) out.stats.push({ key: upper, value })
  }
}

// ---- display helpers ----------------------------------------------------------

const STAT_LABEL: Record<string, string> = {
  STR: 'Strength', STA: 'Stamina', AGI: 'Agility', DEX: 'Dexterity',
  WIS: 'Wisdom', INT: 'Intelligence', CHA: 'Charisma',
  HP: 'HP', MANA: 'Mana', END: 'Endurance', ENDURANCE: 'Endurance',
  AC: 'AC', HASTE: 'Haste', ATTACK: 'Attack', REGEN: 'Regen'
}

/** In-window label for a stat key ("STR" → "Strength", "SV FIRE" → "SV Fire"). */
export function statLabel(key: string): string {
  const k = key.toUpperCase()
  if (STAT_LABEL[k]) return STAT_LABEL[k]
  if (k.startsWith('SV ')) return 'SV ' + titleCase(k.slice(3))
  return titleCase(k)
}

/** The game's damage/delay ratio. Derived arithmetic, not a claimed data field. */
export function damageRatio(dmg?: number, delay?: number): number | undefined {
  if (!dmg || !delay) return undefined
  return dmg / delay
}

export const EFFECT_LABEL: Record<ItemEffectKind, string> = {
  combat: 'Combat Effect',
  focus: 'Focus Effect',
  click: 'Click Effect',
  worn: 'Worn Effect',
  proc: 'Proc Effect',
  effect: 'Effect'
}

// ---- item level / tier + exaltation sockets ------------------------------------
// Sourced from eqlwiki.com "Item Upgrade System" and "Exaltations" (see the research
// block in src/main/itemLookupParse.ts). Rules, not per-item data.

export const ITEM_MAX_TIER = 10

/** Exp needed to go from `tier` to `tier + 1` (the "x / y" denominator). null at max. */
export function expToNextTier(tier: number): number | null {
  if (tier < 0 || tier >= ITEM_MAX_TIER) return null
  return 2 ** tier
}

/** Cumulative stat bonus at a tier: +10% per tier. */
export function tierBonusPct(tier: number): number {
  return Math.max(0, Math.min(ITEM_MAX_TIER, tier)) * 10
}

export interface ExaltationSlotType {
  type: string
  /** item level at which this socket unlocks */
  unlocksAt: number
  what: string
}

/** The five exaltation socket types, in unlock order (wiki: "Exaltations"). */
export const EXALTATION_SLOT_TYPES: ExaltationSlotType[] = [
  { type: 'Ornamentation', unlocksAt: 0, what: 'Appearance copied from another item (visible gear only)' },
  { type: 'Focus', unlocksAt: 1, what: 'A Focus Effect moved from another item' },
  { type: 'Click', unlocksAt: 2, what: 'A Click Effect moved from another item' },
  { type: 'Worn', unlocksAt: 3, what: 'A passive Worn Effect moved from another item' },
  { type: 'Proc', unlocksAt: 4, what: 'A Proc Effect moved from another item' }
]

/** Which socket types an item of this level has unlocked. */
export function unlockedExaltationSlots(tier: number): ExaltationSlotType[] {
  return EXALTATION_SLOT_TYPES.filter((s) => tier >= s.unlocksAt)
}

/**
 * The item level encoded in a display name's ` +N` suffix ("Cloak of Flames +4" → 4).
 * This is the ONLY tier signal we ever observe — the log prints upgraded names in loot
 * and merge lines. Returns undefined for a base-name item: unknown, NOT tier 0.
 */
export function itemTierFromName(name: string): number | undefined {
  const m = / \+(\d+)$/.exec(name.trim())
  return m ? Number(m[1]) : undefined
}
