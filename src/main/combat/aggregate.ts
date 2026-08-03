// The combat engine's AGGREGATION primitives — extracted verbatim from engine.ts.
//
// Everything here is pure accumulation over a segment (an encounter or a zone session):
// per-source / per-category / per-skill damage stats, the accuracy + resist counters, the
// melee-rounds heuristic, the proc ledger, and the `Agg` that binds them together with the
// healing ledger (healing.ts). No engine state, no world model, no time — the state machine
// that decides WHICH aggregate a line belongs to lives in routing.ts.

import { HealAccum } from './healing'
import { addSpellProc, type SpellProcLane } from './procDetect'
import { WindowAccum } from './procWindows'
import type { MissType } from '../../shared/logEvents'
import type { DamageCategory, DamageType, MissBreakdown, SourceKind } from '../../shared/combat'

/**
 * The engine's internal damage record. Sourced from the canonical `damage`
 * LogEvent, but with a non-null attacker (caster-less other-player DoTs — which
 * carry attacker:null — are ignored by the engine before this is built).
 */
export interface DamageEvent {
  ts: number
  attacker: string
  target: string
  amount: number
  dtype: DamageType
  dclass?: string
  skill: string
  crit: boolean
  modifier?: string
  /** Taxonomy category (Task #51). Derived from dtype+modifiers if the event omits it
   *  (older events / synthesized miss probes), so aggregation always has a category. */
  category: DamageCategory
  /** Parsed paren-modifier tokens (Task #51), e.g. ["Riposte","Critical"]. */
  modifiers: string[]
}

/** The identity of a meter ROW (aggregate key + display name + kind). Bundled because the
 *  three always travel together — the outgoing routing paths resolve them once (outSource)
 *  and hand the same triple to every Agg method. */
export interface SourceRef {
  id: string
  name: string
  kind: SourceKind
}

export interface SkillStat {
  name: string
  total: number
  hits: number
  crits: number
  max: number
  /** Smallest LANDED amount on this lane; 0 = "no landed hit yet" (see accrueMin). */
  min: number
  misses: number
  /** Spell resists on this spell/dot lane (Task #51 v2). */
  resists: number
}

/** Per-category rollup within a source (Task #51 drill-down level 2). Holds the
 *  category total + its own per-skill/per-spell breakdown (level 3). */
export interface CategoryStat {
  category: DamageCategory
  total: number
  hits: number
  crits: number
  max: number
  /** Spell resists rolled into this category (spell/dot only; Task #51 v2). */
  resists: number
  bySkill: Map<string, SkillStat>
}

/** Multi-attack "rounds" heuristic accumulator (Task #51). A round = the set of a
 *  source's melee/slay hits sharing the same 1-second bucket (floor(ts/1000)) with the
 *  same skill; roundsByHits[k] counts rounds that landed exactly k hits. The log does
 *  NOT record double/triple attack, so this is an HONEST cluster heuristic, never a
 *  fabricated multi-attack flag. Off-hand vs main-hand is not distinguishable. */
export interface RoundsAccum {
  /** key = `${skillLower}|${floor(ts/1000)}` → hit count in that bucket (in progress). */
  bucket: Map<string, number>
  /** finalized rounds: index = hits-1, value = count of rounds with that many hits. */
  hist: number[]
}
function newMissBreakdown(): MissBreakdown {
  return { miss: 0, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 0 }
}
export interface SourceStat {
  name: string
  kind: SourceKind
  total: number
  hits: number
  crits: number
  ambiguousHits: number
  ambiguousTotal: number
  /** Avoided swings by this source, all outcomes. */
  misses: number
  miss: MissBreakdown
  /** Spell resists against this source's detrimental spells (Task #51 v2). */
  resists: number
  bySkill: Map<string, SkillStat>
  /** Per-category rollup (Task #51 drill-down level 2 + 3). */
  byCategory: Map<DamageCategory, CategoryStat>
  /** Melee-rounds heuristic accumulator (Task #51). */
  rounds: RoundsAccum
}

export function newSkill(name: string): SkillStat {
  return { name, total: 0, hits: 0, crits: 0, max: 0, min: 0, misses: 0, resists: 0 }
}

/**
 * Fold a LANDED amount into a per-skill running minimum. 0 is the "nothing landed yet"
 * sentinel: route() drops amount <= 0, so every value reaching here is > 0 and a lane that
 * only ever missed/resisted keeps min 0 (never a fabricated "min 3 → min 0" from a whiff).
 */
function accrueMin(prev: number, amount: number): number {
  return prev === 0 ? amount : Math.min(prev, amount)
}

/** Merge two per-skill minima under the same sentinel rule (used by the combine-pets fold). */
export function mergeMin(a: number, b: number): number {
  if (a === 0) return b
  if (b === 0) return a
  return Math.min(a, b)
}

export function newCategory(category: DamageCategory): CategoryStat {
  return { category, total: 0, hits: 0, crits: 0, max: 0, resists: 0, bySkill: new Map() }
}

function newRounds(): RoundsAccum {
  return { bucket: new Map(), hist: [] }
}

/** Fold a melee/slay hit into the rounds heuristic: bump the (skill, second) bucket. */
function accrueRound(r: RoundsAccum, skill: string, ts: number): void {
  const key = `${skill.toLowerCase()}|${Math.floor(ts / 1000)}`
  r.bucket.set(key, (r.bucket.get(key) ?? 0) + 1)
}

/** Collapse the in-progress buckets into the hits-per-round histogram. Idempotent-ish:
 *  we rebuild `hist` from the current bucket map each time (buckets are the source of
 *  truth), so calling it at snapshot/finalize is safe and cheap (buckets ≈ #seconds). */
export function finalizeRounds(r: RoundsAccum): number[] {
  const hist: number[] = []
  for (const hits of r.bucket.values()) {
    const idx = Math.max(0, hits - 1)
    hist[idx] = (hist[idx] ?? 0) + 1
  }
  for (let i = 0; i < hist.length; i++) hist[i] ??= 0
  r.hist = hist
  return hist
}

function addToSource(src: SourceStat, ev: DamageEvent, ambiguous: boolean): void {
  src.total += ev.amount
  src.hits += 1
  if (ev.crit) src.crits += 1
  if (ambiguous) {
    src.ambiguousHits += 1
    src.ambiguousTotal += ev.amount
  }
  const s = src.bySkill.get(ev.skill) ?? newSkill(ev.skill)
  s.total += ev.amount
  s.hits += 1
  if (ev.crit) s.crits += 1
  s.max = Math.max(s.max, ev.amount)
  s.min = accrueMin(s.min, ev.amount)
  src.bySkill.set(ev.skill, s)

  // Category rollup (drill-down level 2/3): same skill breakdown, but partitioned by
  // taxonomy category so a source can be opened into melee/slay/spell/dot/ds.
  const c = src.byCategory.get(ev.category) ?? newCategory(ev.category)
  c.total += ev.amount
  c.hits += 1
  if (ev.crit) c.crits += 1
  c.max = Math.max(c.max, ev.amount)
  const cs = c.bySkill.get(ev.skill) ?? newSkill(ev.skill)
  cs.total += ev.amount
  cs.hits += 1
  if (ev.crit) cs.crits += 1
  cs.max = Math.max(cs.max, ev.amount)
  cs.min = accrueMin(cs.min, ev.amount)
  c.bySkill.set(ev.skill, cs)
  src.byCategory.set(ev.category, c)

  // Melee-rounds heuristic: only melee/slay swings cluster into "rounds" (spells/dots
  // are single applications). Bucket by (skill, whole-second).
  if (ev.category === 'melee' || ev.category === 'slay') {
    accrueRound(src.rounds, ev.skill, ev.ts)
  }
}

/** Fold a miss (avoided swing) into a source's accuracy stats. */
function addMissToSource(src: SourceStat, mtype: MissType, skill: string): void {
  src.misses += 1
  src.miss[mtype] += 1
  const s = src.bySkill.get(skill) ?? newSkill(skill)
  s.misses += 1
  src.bySkill.set(skill, s)
}

/**
 * Fold a spell RESIST into a source's stats (Task #51 v2). A resist is the caster-side
 * analogue of a miss: it attaches to the resisted spell's lane (`spell`, display name) in
 * the given taxonomy category (spell/dot). It carries no damage, so only the resist
 * COUNTERS move — the source's damage total is byte-for-byte unchanged (the tripwire).
 * The lane is created lazily if the source hasn't landed that spell yet, so a spell that
 * was ALWAYS resisted still shows a row (0 hits / N resists → 0% land).
 */
function addResistToSource(src: SourceStat, spell: string, category: DamageCategory): void {
  src.resists += 1
  const s = src.bySkill.get(spell) ?? newSkill(spell)
  s.resists += 1
  src.bySkill.set(spell, s)
  const c = src.byCategory.get(category) ?? newCategory(category)
  c.resists += 1
  const cs = c.bySkill.get(spell) ?? newSkill(spell)
  cs.resists += 1
  c.bySkill.set(spell, cs)
  src.byCategory.set(category, c)
}

export function newSource(name: string, kind: SourceKind): SourceStat {
  return {
    name, kind, total: 0, hits: 0, crits: 0, ambiguousHits: 0, ambiguousTotal: 0,
    misses: 0, miss: newMissBreakdown(), resists: 0, bySkill: new Map(), byCategory: new Map(), rounds: newRounds()
  }
}

/**
 * The per-segment proc accumulator (Task #64). Pure counters — every one of them is
 * incremented on ingest from a line the game actually printed, so a downsampled or truncated
 * timeline can never move a number here (the timeline MARKERS are a separate, draw-only
 * concern; see TimelineMarker).
 */
export class ProcAccum {
  /** Strike name → landings. Keyed by the DISPLAY name we show, ambiguity included. */
  strikes = new Map<string, { name: string; count: number; ambiguous: boolean }>()
  /** Weakening-Strike landings — broken out because it is the one we time. */
  slowLands = 0
  /** Absolute ts of the FIRST slow landing in this segment (0 = none). */
  firstSlowTs = 0
  /** Outgoing lanes whose damage type was poison: skill → hits + total. */
  poisonDamage = new Map<string, { name: string; count: number; total: number }>()
  /** Dispel landings on engaged mobs (DISPEL_FAMILY only): tier label → count. Every lane is
   *  ambiguous by construction — each message tier is shared by 2–3 spells. */
  dispels = new Map<string, { name: string; count: number }>()
  /** YOUR coats applied inside this segment, in order. */
  coats: { poison: string; ts: number }[] = []
  stanceSwitches = 0
  invocationSwitches = 0
  /**
   * YOUR logged swing attempts in this segment: melee + slay hits, plus your misses. The
   * MECHANICAL denominator for a chance-on-hit proc rate, and the only one of the three with
   * no active-time ambiguity. Main-hand vs off-hand and double/triple attack are
   * undistinguishable in this log (law 6), so this is swings-AS-LOGGED.
   *
   * A COUNT, not an amount: it moves no damage total, which is what keeps this whole feature
   * inside law 8's tripwire.
   */
  swings = 0
  /**
   * SPELL-PROC lanes (proc-analytics §4.1): spell effects with no own cast behind them, keyed
   * by `spellCanonKey`. The damage they carry is ALREADY inside this segment's outgoing total
   * — this is an INDEX over damage already counted, never a second accumulation of it.
   */
  spellProcs = new Map<string, SpellProcLane>()

  /** Count one detected cast-less spell effect. */
  addSpellProc(spell: string, amount: number, isHeal: boolean): void {
    addSpellProc(this.spellProcs, spell, amount, isHeal)
  }

  addStrike(name: string, ambiguous: boolean, ts: number, isSlow: boolean): void {
    const s = this.strikes.get(name) ?? { name, count: 0, ambiguous }
    s.count++
    this.strikes.set(name, s)
    if (isSlow) {
      this.slowLands++
      if (this.firstSlowTs === 0) this.firstSlowTs = ts
    }
  }
  addPoisonDamage(skill: string, amount: number): void {
    const s = this.poisonDamage.get(skill) ?? { name: skill, count: 0, total: 0 }
    s.count++
    s.total += amount
    this.poisonDamage.set(skill, s)
  }
  addDispel(label: string): void {
    const s = this.dispels.get(label) ?? { name: label, count: 0 }
    s.count++
    this.dispels.set(label, s)
  }
}

export class Agg {
  // Keyed by INSTANCE id (or 'you'/'pet:<instanceId>'); `name` holds display.
  out = new Map<string, SourceStat>()
  inc = new Map<string, SourceStat>()
  targets = new Map<string, { name: string; amount: number }>()
  /** Healing received by hostile instances engaged here (instanceId → total). */
  enemyHeal = new Map<string, { name: string; amount: number }>()
  /** Healing received by You / your pets: healerKey → { name, total, count }. */
  incHeal = new Map<string, { name: string; amount: number; count: number }>()
  /** The meter-grade HEALING + ABSORPTION ledger (Task #59). Lives on the SAME aggregate as the
   *  damage bars, so the healing overlays inherit fight / zone-session selection, the finalized
   *  zone-session freeze and the encounter history without any parallel machinery. Deliberately
   *  ADDITIVE: `enemyHeal`/`incHeal` above are untouched, so every existing damage/heal total
   *  (and the enemyHealTotal annotation) stays byte-identical. */
  heal = new HealAccum()
  /**
   * PROC LEDGER (Task #64) — rogue-poison Strikes, poison-typed damage lanes, non-damage spell
   * landings on engaged mobs, and the stance/coat bookkeeping. On the Agg for exactly the same
   * reason the healing ledger is: an encounter and a finalized zone session then get it for
   * free, and the numbers are folded on INGEST so they never depend on the event ring.
   */
  procs = new ProcAccum()
  /**
   * THE MINUTE-WINDOW LEDGER (proc-analytics §5.1) — the matched-window sample the Tier-B
   * counterfactual is computed from. On the `Agg` for the third time and for the third
   * identical reason: a finalized zone session inherits it FROZEN, so "how much DPS did X add
   * this session" survives the zone change that produced it, with no parallel machinery and no
   * dependence on any event ring.
   */
  windows = new WindowAccum()
  addOut(ref: SourceRef, ev: DamageEvent, ambiguous = false): void {
    const s = this.out.get(ref.id) ?? newSource(ref.name, ref.kind)
    if (s.name !== ref.name) s.name = ref.name
    addToSource(s, ev, ambiguous)
    this.out.set(ref.id, s)
  }
  addInc(id: string, name: string, ev: DamageEvent): void {
    const s = this.inc.get(id) ?? newSource(name, 'enemy')
    addToSource(s, ev, false)
    this.inc.set(id, s)
  }
  addOutMiss(ref: SourceRef, mtype: MissType, skill: string): void {
    const s = this.out.get(ref.id) ?? newSource(ref.name, ref.kind)
    if (s.name !== ref.name) s.name = ref.name
    addMissToSource(s, mtype, skill)
    this.out.set(ref.id, s)
  }
  addIncMiss(id: string, name: string, mtype: MissType, skill: string): void {
    const s = this.inc.get(id) ?? newSource(name, 'enemy')
    addMissToSource(s, mtype, skill)
    this.inc.set(id, s)
  }
  addOutResist(ref: SourceRef, spell: string, category: DamageCategory): void {
    const s = this.out.get(ref.id) ?? newSource(ref.name, ref.kind)
    if (s.name !== ref.name) s.name = ref.name
    addResistToSource(s, spell, category)
    this.out.set(ref.id, s)
  }
  addIncResist(id: string, name: string, spell: string, category: DamageCategory): void {
    const s = this.inc.get(id) ?? newSource(name, 'enemy')
    addResistToSource(s, spell, category)
    this.inc.set(id, s)
  }
  addEnemyHeal(id: string, name: string, amount: number): void {
    const t = this.enemyHeal.get(id) ?? { name, amount: 0 }
    t.amount += amount
    this.enemyHeal.set(id, t)
  }
  addIncHeal(healerKey: string, name: string, amount: number): void {
    const t = this.incHeal.get(healerKey) ?? { name, amount: 0, count: 0 }
    t.amount += amount
    t.count += 1
    this.incHeal.set(healerKey, t)
  }
  bumpTarget(id: string, name: string, amount: number): void {
    const t = this.targets.get(id) ?? { name, amount: 0 }
    t.amount += amount
    this.targets.set(id, t)
  }
}

export function sumHeal(m: Map<string, { amount: number }>): number {
  let t = 0
  for (const v of m.values()) t += v.amount
  return t
}

export function sumMap(m: Map<string, SourceStat>): number {
  let t = 0
  for (const s of m.values()) t += s.total
  return t
}

export const MISS_KEYS: MissType[] = ['miss', 'dodge', 'parry', 'riposte', 'block', 'absorb']
