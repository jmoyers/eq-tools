// Healing + absorption aggregation (Task #59).
//
// The engine already ROUTED heals (routeHeal: enemy-healing annotation + a flat top-healers
// list). This module holds the full meter-grade accumulation behind that routing — per healer,
// per spell, with crit / min / max / overheal — plus the absorption lanes, and turns it into the
// serializable HealingView the two healing overlays render.
//
// It lives beside the damage aggregate (one HealAccum per Agg), NOT beside it in time: the engine
// folds heals into the SAME Agg objects the damage bars use, so a healing meter inherits fight /
// zone-session selection, the finalized-zone-session freeze, and the encounter history for free.
//
// HONESTY RULES baked in here (AGENTS.md world-model law 6 — say what the log cannot say):
//   - overheal is DERIVED from the `for N (M) hit points` form only. EQ writes the parens exactly
//     when raw > effective, so a plain line contributes 0 and the sum is a FLOOR, never a rate
//     projected over ticks we never saw.
//   - HoT ticks are NOT separated from direct heals. No `healed over time` / `regeneration` line
//     family exists in the log and a regen tick is byte-identical in shape to a direct heal —
//     splitting them would be an invention.
//   - the two `magical skin absorbs` families carry NO amount. They are counted, never valued.
//   - a rune's amount is absorption GRANTED, not damage prevented. The log never says how much
//     of a rune was consumed, so it is kept out of every healing total.

import type {
  HealSourceKind,
  HealSourceView,
  HealSpellView,
  HealingView,
  MitigationView
} from '../../shared/combat'

/** One heal line, already attributed by the engine. */
export interface HealInput {
  /** Effective (landed) heal. */
  amount: number
  /** Raw/pre-overheal amount, present only on the `(M)` lines. */
  rawAmount?: number
  spell?: string
  crit?: boolean
}

interface HealSpellStat {
  name: string
  total: number
  count: number
  crits: number
  max: number
  min?: number
  overheal: number
  fullOverheal: number
}

interface HealSourceStat {
  name: string
  kind: HealSourceKind
  total: number
  count: number
  crits: number
  max: number
  min?: number
  overheal: number
  fullOverheal: number
  bySpell: Map<string, HealSpellStat>
}

/** Spell-less heal lines (482 in the real log) get one honest shared lane. */
export const UNSPECIFIED_SPELL = 'Unspecified'

/** Track the smallest LANDED heal. A 0-effective (fully overhealed) tick still landed a line, so
 *  it participates — unlike the damage model's min, which must never see a miss. */
function accrueMin(cur: number | undefined, amount: number): number {
  return cur === undefined ? amount : Math.min(cur, amount)
}

function newSpell(name: string): HealSpellStat {
  return { name, total: 0, count: 0, crits: 0, max: 0, overheal: 0, fullOverheal: 0 }
}

function newSource(name: string, kind: HealSourceKind): HealSourceStat {
  return {
    name, kind, total: 0, count: 0, crits: 0, max: 0, overheal: 0, fullOverheal: 0, bySpell: new Map()
  }
}

/** The mitigation counters. Amounts exist for runes only — the rest are counts by construction. */
interface MitAccum {
  runeTotal: number
  runeCount: number
  runeMax: number
  runeMin?: number
  absorbedSwings: number
  absorbedDamageShields: number
}

function newMit(): MitAccum {
  return { runeTotal: 0, runeCount: 0, runeMax: 0, absorbedSwings: 0, absorbedDamageShields: 0 }
}

/**
 * The healing half of an aggregate. Two independent ledgers, mirroring the damage model's
 * out/incoming split:
 *   - `friendly`: heals that landed on YOU, your pets, or the player by name — "who kept me
 *     alive". This is the meter's ranking.
 *   - `hostile`: heals that landed on an ENGAGED hostile instance — counter-healing that undid
 *     your damage. Ranked by HEALER (a mob healing itself is its own row).
 * Heals between third parties (other players healing each other) are deliberately NOT collected:
 * the log gives no faction for an arbitrary name, and guessing one would invent a world model.
 */
export class HealAccum {
  friendly = new Map<string, HealSourceStat>()
  hostile = new Map<string, HealSourceStat>()
  mit = newMit()

  addFriendly(key: string, name: string, kind: HealSourceKind, h: HealInput): void {
    add(this.friendly, key, name, kind, h)
  }
  addHostile(key: string, name: string, h: HealInput): void {
    add(this.hostile, key, name, 'enemy', h)
  }
  addRune(amount: number): void {
    const m = this.mit
    m.runeTotal += amount
    m.runeCount += 1
    m.runeMax = Math.max(m.runeMax, amount)
    m.runeMin = m.runeMin === undefined ? amount : Math.min(m.runeMin, amount)
  }
  addAbsorbedSwing(): void {
    this.mit.absorbedSwings += 1
  }
  addAbsorbedDamageShield(): void {
    this.mit.absorbedDamageShields += 1
  }
}

function add(
  m: Map<string, HealSourceStat>,
  key: string,
  name: string,
  kind: HealSourceKind,
  h: HealInput
): void {
  const s = m.get(key) ?? newSource(name, kind)
  if (s.name !== name) s.name = name
  // A healer first seen healing a hostile can later be reclassified (a charmed mob becomes your
  // pet); the LATEST attribution wins, matching how the damage model relabels a source.
  s.kind = kind
  // EQ omits the parens whenever nothing was wasted, so a plain line's raw == effective.
  const raw = h.rawAmount ?? h.amount
  const over = Math.max(0, raw - h.amount)
  s.total += h.amount
  s.count += 1
  if (h.crit) s.crits += 1
  s.max = Math.max(s.max, h.amount)
  s.min = accrueMin(s.min, h.amount)
  s.overheal += over
  if (h.amount === 0) s.fullOverheal += 1

  const spellName = h.spell?.trim() || UNSPECIFIED_SPELL
  const sp = s.bySpell.get(spellName) ?? newSpell(spellName)
  sp.total += h.amount
  sp.count += 1
  if (h.crit) sp.crits += 1
  sp.max = Math.max(sp.max, h.amount)
  sp.min = accrueMin(sp.min, h.amount)
  sp.overheal += over
  if (h.amount === 0) sp.fullOverheal += 1
  s.bySpell.set(spellName, sp)
  m.set(key, s)
}

/** Cap on serialized spell lanes per healer — same spirit as the damage model's 12-skill cap. */
const SPELL_CAP = 14

function spellViews(s: HealSourceStat): HealSpellView[] {
  const rows = [...s.bySpell.values()].sort(
    (a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name)
  )
  const max = Math.max(1, ...rows.map((r) => r.total))
  return rows.slice(0, SPELL_CAP).map((r) => ({
    name: r.name,
    total: r.total,
    pct: (r.total / max) * 100,
    count: r.count,
    crits: r.crits,
    max: r.max,
    ...(r.min !== undefined ? { min: r.min } : {}),
    overheal: r.overheal,
    fullOverheal: r.fullOverheal
  }))
}

function sourceViews(m: Map<string, HealSourceStat>, durationSec: number): HealSourceView[] {
  const rows = [...m.entries()].sort((a, b) => b[1].total - a[1].total || b[1].count - a[1].count)
  const max = Math.max(1, ...rows.map(([, s]) => s.total))
  const dur = Math.max(1, durationSec)
  return rows.map(([key, s]) => ({
    id: key,
    name: s.name,
    kind: s.kind,
    total: s.total,
    hps: s.total / dur,
    pct: (s.total / max) * 100,
    count: s.count,
    crits: s.crits,
    critPct: s.count > 0 ? (s.crits / s.count) * 100 : 0,
    max: s.max,
    ...(s.min !== undefined ? { min: s.min } : {}),
    overheal: s.overheal,
    overhealPct: s.total + s.overheal > 0 ? (s.overheal / (s.total + s.overheal)) * 100 : 0,
    fullOverheal: s.fullOverheal,
    spells: spellViews(s)
  }))
}

function mitigationView(m: MitAccum): MitigationView {
  return {
    runeTotal: m.runeTotal,
    runeCount: m.runeCount,
    runeMax: m.runeMax,
    ...(m.runeMin !== undefined ? { runeMin: m.runeMin } : {}),
    absorbedSwings: m.absorbedSwings,
    absorbedDamageShields: m.absorbedDamageShields
  }
}

/** Serialize an accumulator into the snapshot's HealingView. */
export function buildHealingView(acc: HealAccum, durationSec: number): HealingView {
  const healers = sourceViews(acc.friendly, durationSec)
  const enemyHealers = sourceViews(acc.hostile, durationSec)
  const total = healers.reduce((s, h) => s + h.total, 0)
  return {
    healers,
    total,
    hps: total / Math.max(1, durationSec),
    overheal: healers.reduce((s, h) => s + h.overheal, 0),
    enemyHealers,
    enemyTotal: enemyHealers.reduce((s, h) => s + h.total, 0),
    mitigation: mitigationView(acc.mit)
  }
}
