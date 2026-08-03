// The combat engine: a formal state machine over the log stream.
//
// State it maintains:
//   petNames: Set<name>           — names of your ACTIVE pets, charmed OR summoned
//                                   (name-keyed). This is purely an ATTRIBUTION set —
//                                   it is NOT a charm roster. The world model owns the
//                                   charmed/summoned distinction (Instance.petKind).
//   zone:     string              — current zone (resets the overall aggregate)
//   current:  Encounter | null    — the in-progress/most-recent fight
//   history:  Encounter[]         — finalized fights
//   zoneAgg:  Agg                 — damage aggregated for the whole zone
//
// Transitions (one per ingested line):
//   zone     → finalize current, reset zoneAgg
//   charm    → petNames.add(mob)  (`<mob> has been charmed.` — only the charmer sees it)
//   petClaim → petNames.add(name) (`<Name> told you, '… Master.'` — the ONLY binding
//              signal for a random-named SUMMONED class pet; charmed mobs send it too)
//   uncharm/death(charm spell/mob death) → petNames.delete(mob)
//   cc     → mark the mob's instance engaged + CC-held (mez/root keep-alive)
//   damage → route to current encounter + zoneAgg (see route())
//
// Attribution rule (damage `A → B` for N):
//   A = You            → your outgoing
//   A ∈ petNames       → your pet's outgoing (unless B is friendly)
//   B = You            → incoming
//   otherwise          → not your fight (ignored)
//
// Encounter segmentation (Task #20 — death-closed, replacing the old idle-gap
// rule). A fight CLOSES when either:
//   - every engaged hostile instance is GONE (retired = dead/zoned; or still alive but
//     with no PRESENCE evidence for PRESENCE_GONE_MS) AND LINGER_MS passes with no new
//     attributed damage → crisp pull boundaries from the death timeline. A multi-mob
//     pull is therefore ONE encounter: killing one add cannot close it while another is
//     demonstrably still swinging/casting/being healed (Task #55).
//   - OR no attributed damage AND no CC event for FALLBACK_IDLE_MS (fled/deagro).
// A CC (mez/root) application or refresh HOLDS the encounter open regardless of
// damage gaps while the CC'd instance is alive (the mez-and-wait case). Pet swap
// (uncharm/charm) is NOT a boundary event. Closure is time-driven, so it's evaluated
// both on the next ingested event and in snapshot(now) — finalization always stamps
// the encounter's own lastTs (a damage ts), never the eval moment. DPS uses
// (lastHit − firstHit), so it freezes when a fight ends. Each encounter also tracks
// activeMs (Σ capped gaps between hits) for an active-time DPS stat.
//
// Seeding: the engine is fed the entire log on load (recording=false) so charm
// and encounter state reflect reality before the live tail (recording=true)
// takes over — this is why a pet charmed before the app opened is still tracked.

import { idKey } from '../log/parser'
import { WorldModel } from './world'
import { damageCategory } from './taxonomy'
import { HealAccum, buildHealingView } from './healing'
import { searchFights } from './fightSearch'
import type { LogEvent, MissType, MitigationEvent } from '../../shared/logEvents'
import { DISPEL_FAMILY, SLOW_STRIKE, isSlowCapable } from '../../shared/poisons'
import type { DamageCategory, DamageType } from '../../shared/combat'
import { CATEGORY_ORDER } from '../../shared/combat'
import type {
  BladeCoatState,
  CategoryView,
  ClassifiedLine,
  CoatSlot,
  CombatSnapshot,
  FightSearchResult,
  HealSourceKind,
  HealerView,
  MissBreakdown,
  PoisonState,
  ProcLane,
  ProcsView,
  RoundsView,
  SegmentSummary,
  SegmentView,
  SkillView,
  SlowRollup,
  SnapshotOpts,
  SourceKind,
  SourceView,
  StanceSpan,
  StanceState,
  TimelineEvent,
  TimelineMarker,
  TimelineMarkerKind,
  TimelineView,
  ZoneSessionSummary
} from '../../shared/combat'

/**
 * The engine's internal damage record. Sourced from the canonical `damage`
 * LogEvent, but with a non-null attacker (caster-less other-player DoTs — which
 * carry attacker:null — are ignored by the engine before this is built).
 */
interface DamageEvent {
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

interface SkillStat {
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
interface CategoryStat {
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
interface RoundsAccum {
  /** key = `${skillLower}|${floor(ts/1000)}` → hit count in that bucket (in progress). */
  bucket: Map<string, number>
  /** finalized rounds: index = hits-1, value = count of rounds with that many hits. */
  hist: number[]
}
function newMissBreakdown(): MissBreakdown {
  return { miss: 0, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 0 }
}
interface SourceStat {
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

function newSkill(name: string): SkillStat {
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
function mergeMin(a: number, b: number): number {
  if (a === 0) return b
  if (b === 0) return a
  return Math.min(a, b)
}

function newCategory(category: DamageCategory): CategoryStat {
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
function finalizeRounds(r: RoundsAccum): number[] {
  const hist: number[] = []
  for (const hits of r.bucket.values()) {
    const idx = Math.max(0, hits - 1)
    hist[idx] = (hist[idx] ?? 0) + 1
  }
  for (let i = 0; i < hist.length; i++) if (hist[i] == null) hist[i] = 0
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

function newSource(name: string, kind: SourceKind): SourceStat {
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
class ProcAccum {
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
  coats: Array<{ poison: string; ts: number }> = []
  stanceSwitches = 0
  invocationSwitches = 0

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

class Agg {
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
  addOut(id: string, name: string, kind: SourceKind, ev: DamageEvent, ambiguous = false): void {
    const s = this.out.get(id) ?? newSource(name, kind)
    if (s.name !== name) s.name = name
    addToSource(s, ev, ambiguous)
    this.out.set(id, s)
  }
  addInc(id: string, name: string, ev: DamageEvent): void {
    const s = this.inc.get(id) ?? newSource(name, 'enemy')
    addToSource(s, ev, false)
    this.inc.set(id, s)
  }
  addOutMiss(id: string, name: string, kind: SourceKind, mtype: MissType, skill: string): void {
    const s = this.out.get(id) ?? newSource(name, kind)
    if (s.name !== name) s.name = name
    addMissToSource(s, mtype, skill)
    this.out.set(id, s)
  }
  addIncMiss(id: string, name: string, mtype: MissType, skill: string): void {
    const s = this.inc.get(id) ?? newSource(name, 'enemy')
    addMissToSource(s, mtype, skill)
    this.inc.set(id, s)
  }
  addOutResist(id: string, name: string, kind: SourceKind, spell: string, category: DamageCategory): void {
    const s = this.out.get(id) ?? newSource(name, kind)
    if (s.name !== name) s.name = name
    addResistToSource(s, spell, category)
    this.out.set(id, s)
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

/**
 * A finalized ZONE SESSION (Task #54). When the player zones, the live zoneAgg is frozen into
 * one of these (kept in a capped ring) instead of being discarded, so a past zone's overall
 * meter is still selectable. Holds the frozen Agg + timing + accumulated durations, plus a
 * memoized summary (computed once at finalize — the aggregate is immutable thereafter, mirroring
 * the Encounter.summary cached-summary pattern).
 */
interface ZoneSession {
  id: string
  zone: string
  agg: Agg
  /** first/last attributed-damage ts (0 if the session saw no damage — those are dropped). */
  startTs: number
  lastTs: number
  /** Σ finalized-encounter wall durations (ms) — the DPS denominator, matching the live path. */
  finalizedMs: number
  /** Σ finalized-encounter activeMs. */
  activeMs: number
  /** Memoized summary fields (the aggregate is frozen at finalize). */
  summary: ZoneSessionSummary
}

interface Encounter {
  id: string
  zone?: string
  startTs: number
  lastTs: number
  agg: Agg
  engaged: Set<string>
  /** instanceId → ts we last saw ANY evidence this instance is still in the fight.
   *  This is the PRESENCE (liveness) axis, deliberately distinct from the damage
   *  timeline: landed damage refreshes it, but so do misses (either direction),
   *  resists, CC, and heals involving the instance — a mob that whiffs for eight
   *  seconds, or spends them casting, is emphatically still here. It drives ONLY the
   *  "gone" staleness in evalClosure (see PRESENCE_GONE_MS); it never feeds
   *  firstHit/lastHit/DPS/activeMs, which stay damage-driven (AGENTS.md law 8). */
  engagedSeen: Map<string, number>
  /** Active-combat time accumulator (ms): on each attributed damage hit we add
   *  min(ts - prevDamageTs, ACTIVE_MS). First hit adds 0. See ACTIVE_MS. */
  activeMs: number
  /** ts of the previous attributed damage hit, for the activeMs delta. */
  prevDamageTs?: number
  /** instanceId → epoch-ms until which this engaged instance is CC-held. While any
   *  engaged instance is alive (CC'd instances count as alive), the encounter stays
   *  OPEN regardless of damage gaps — the mez-and-wait case. */
  ccActiveUntil: Map<string, number>
  /** Memoized SegmentSummary, populated once at finalize time. A finalized
   *  encounter is immutable, so its summary is stable for the rest of the session
   *  — recomputing it for all ~1,400 history entries on every snapshot() (2×+/sec)
   *  was the dominant snapshot cost (Task #17). */
  summary?: SegmentSummary
  /**
   * Per-encounter TIMELINE event ring (Task #51). Each attributed damage/miss instant is
   * appended here (absolute ts) for the timeline view; capped at TIMELINE_CAP (drop-
   * oldest) so a marathon charm-grind fight can't grow unbounded. Only retained for
   * encounters in the recent-history window (see TIMELINE_HISTORY_CAP) — older finalized
   * encounters have their ring dropped at finalize to keep the RSS delta small. */
  events: TimelineRaw[]
  /** TRUE count of every instant ever pushed into `events`, including ones the drop-oldest
   *  cap has since evicted. ONE integer per encounter (never per-event bookkeeping) — it is
   *  the only way a consumer can tell "the ring holds 8,000" from "the fight had 8,000":
   *  once TIMELINE_CAP engages, `events.length` saturates and would silently understate the
   *  fight. `eventsTotal > events.length` IS the truncation signal (TimelineView.truncated).
   *  Nothing else reads it — no aggregate, total or attribution depends on it. */
  eventsTotal: number
  /** Stance/invocation spans that overlapped this encounter (Task #51 pinned rows).
   *  Recorded as they change while the encounter is open (absolute ts). */
  stanceSpans: StanceRaw[]
  /** Point ANNOTATIONS on this fight's clock (Task #64): stance/invocation commits, blade
   *  coats, slow landings. Never downsampled and never counted from — see TimelineMarker.
   *  Capped drop-oldest at MARKER_CAP purely as a memory bound; the densest fight in the
   *  user's whole log carries three. */
  markers: MarkerRaw[]
  /** The UTILITY blade coat that was already on when this encounter opened (Task #64), and
   *  the combat venoms alongside it. Snapshotted at ensureEncounter() from the engine's live
   *  coat state, because "was a slow even possible in this pull?" is a question about the
   *  moment of engage — re-reading today's coat later would re-label old fights. */
  coatAtEngage?: CoatSlot
  combatAtEngage: CoatSlot[]
  /** Display name of the MOST RECENT outgoing-damage target (You or pet → mob), for the
   *  LIVE encounter name (Task #54): while a fight is open its name tracks whatever you're
   *  currently swinging at. On FINALIZE the name switches to the largest target (most damage
   *  absorbed) via encounterName(). undefined until the first outgoing hit lands. */
  lastOutTarget?: string
}

/** Internal raw timeline record (absolute ts; converted to relative at snapshot). */
interface TimelineRaw {
  ts: number
  lane: string
  category: DamageCategory
  amount: number
  crit: boolean
  modifiers?: string[]
  kind: SourceKind
  /** 'miss' | 'resist' for avoided/resisted instants (Task #51 v2); absent = a landed hit. */
  outcome?: 'hit' | 'miss' | 'resist'
  /** miss subtype (dodge/parry/…) or 'resisted', for the tooltip. */
  detail?: string
  /** target/defender name, for the tooltip. */
  target?: string
}

/** Internal raw timeline MARKER (absolute ts; converted to relative at snapshot). */
interface MarkerRaw {
  ts: number
  kind: TimelineMarkerKind
  label: string
  detail?: string
}

/** Internal raw stance/invocation span (absolute ts). `end` is undefined while active. */
interface StanceRaw {
  group: 'stance' | 'invocation'
  name: string
  start: number
  end?: number
}

// Encounter closure (Task #20 — death-closed segmentation, replacing the old
// SEGMENT_GAP_MS idle rule). Two INDEPENDENT axes decide it, and conflating them was
// the multi-mob-pull split bug (Task #55):
//
//   TIMING axis (damage only) — LINGER_MS is measured against the encounter's last
//                 ATTRIBUTED DAMAGE. After every engaged hostile instance is gone,
//                 wait this long with no new damage before finalizing at the last
//                 damage ts: the linger absorbs the trailing DoT tick / cleanup swing.
//                 Nothing else may touch this clock — firstHit/lastHit/DPS/activeMs
//                 are damage-derived (AGENTS.md law 8).
//   PRESENCE axis (any evidence) — whether an engaged instance is still IN the fight,
//                 tracked per instance in Encounter.engagedSeen and refreshed by any
//                 observation of it: landed damage, misses in either direction,
//                 resists, CC, and heals it gives or receives. Presence never opens or
//                 extends an encounter; it only vetoes closing one.
//
//   PRESENCE_GONE_MS — how long a LIVE (not retired) engaged instance must go without
//                 ANY presence evidence before the death-close treats it as gone. A
//                 RETIRED instance is gone immediately (its death is the evidence; the
//                 LINGER_MS damage window still covers trailing hits), so this window
//                 only governs mobs that are still alive and simply quiet. It is
//                 deliberately 4× LINGER_MS because real fights go quiet for many
//                 seconds at a time: miss/dodge/parry streaks land nothing, mob cast
//                 phases (Stun/Root/Healing) produce no swings at all, a player stun
//                 stops YOUR damage, and the log flushes in multi-second batches while
//                 the closure is also evaluated against the WALL clock from
//                 snapshot(now). A genuinely fled mob still closes at
//                 FALLBACK_IDLE_MS — 3× sooner than it would if we waited that out.
//   FALLBACK_IDLE_MS — if there's no attributed damage AND no CC event for this long
//                 while instances remain engaged-but-not-retired (mob fled/deagroed,
//                 the log never reports a death), close anyway.
//   ACTIVE_MS   — per-hit active-time cap AND the "in combat" freshness window.
const LINGER_MS = 5_000
const PRESENCE_GONE_MS = 20_000
const FALLBACK_IDLE_MS = 60_000
// How long a single CC application/refresh keeps an instance "held" (alive for
// closure) without further evidence. A live mez is re-applied well within this, and
// resumed damage refreshes activity; this is only the backstop expiry for a CC that
// is never refreshed and never followed by damage (so a lone mez can't pin a fight
// open forever). It exceeds FALLBACK_IDLE_MS so an actively-refreshed mez holds.
const CC_HOLD_MS = 120_000
const ACTIVE_MS = 3_000
const RECENT_CAP = 300
// Zone-session history cap (Task #54): how many FINALIZED zone sessions to retain (the live one
// is separate). Each holds only frozen aggregate maps + a small summary — no per-event rings — so
// 20 sessions is a trivial footprint (see the finalize note + the task report).
const ZONE_HISTORY_CAP = 20

// Timeline (Task #51):
//   TIMELINE_CAP          — per-encounter event ring size (drop-oldest). Bumped 5k→8k for
//                           Task #51 v2: miss AND resist ticks now enter the ring (misses
//                           are ~70% of combat lines), so the densest fight's instant count
//                           roughly doubled. Full-log measurement (2026-08-02): exactly ONE
//                           marathon charm-grind fight exceeds 5k, peaking at 5259 instants;
//                           8k captures it with ZERO drop-oldest at trivial cost (only ≤60
//                           rings are ever retained — see TIMELINE_HISTORY_CAP — so the
//                           whole-session RSS delta stays well under 1MB, dominated by the
//                           68MB log string, not the ring). If a denser fight ever DOES
//                           overflow it, the loss is DECLARED, not silent: Encounter.
//                           eventsTotal keeps the true count and TimelineView.truncated
//                           tells the renderer its event-derived panels are lower bounds.
//   TIMELINE_HISTORY_CAP  — how many finalized encounters keep their event ring after
//                           finalize. Older ones drop the ring (timeline only for recent /
//                           live fights) so the whole-session RSS delta stays bounded.
//   TIMELINE_BUDGET       — max events serialized into a single TimelineView; above this
//                           the engine downsamples (uniform stride) and flags it.
const TIMELINE_CAP = 8_000
const TIMELINE_HISTORY_CAP = 60
const TIMELINE_BUDGET = 2_000

// Rogue poisons (Task #64):
//   MARKER_CAP     — per-encounter marker ring (drop-oldest). Markers are point annotations
//                    (stance/invocation commits, coats, slow landings), NOT damage: they are
//                    never downsampled, because uniform-striding a sparse series just deletes
//                    most of it. Measured on the user's whole log, the densest single fight
//                    carries 3 markers, so this cap is a pure memory bound and has never
//                    engaged. No COUNT is derived from markers (ProcAccum is), so even if it
//                    did engage no statistic would move.
//   SLOW_SAMPLE_CAP — how many recent QUALIFYING pulls (a slow-capable coat on at engage) the
//                    rolling time-to-slow ring keeps. Small on purpose: this is meant to
//                    answer "how is my poison doing right now", not to average a whole
//                    evening's worth of loadouts together.
const MARKER_CAP = 1_000
const SLOW_SAMPLE_CAP = 25

/** How a damage event `A → B` is attributed given the pet-name set. */
export type Attribution =
  | { kind: 'out-you' }
  | { kind: 'out-pet'; petKey: string; petName: string; ambiguous: boolean }
  | { kind: 'incoming' }
  | { kind: 'ignore' }

/**
 * Pure attribution decision — the whole point is same-name twin handling.
 * `petNames` is a Set of canonical (lowercased) keys for ALL of your live pets,
 * charmed AND summoned: both attribute identically (as "your pet"), so this
 * function never needs to know which kind it is.
 *
 * Rules (decided with the user):
 *   You → pet-name : ALWAYS outgoing to a hostile twin (never dropped as FF).
 *   pet-name → You : ALWAYS incoming.
 *   pet-name → same-name (A==B, pet) : pet outgoing, but AMBIGUOUS
 *     (could be your pet hitting a hostile twin, or a hostile twin hitting your
 *      pet) — attribute to the pet and flag it.
 *   pet-name → other : pet outgoing (existing rule).
 *   You → other : outgoing.  other → You : incoming.  else ignore.
 */
export function classify(ev: DamageEvent, petNames: ReadonlySet<string>): Attribution {
  const aKey = idKey(ev.attacker)
  const bKey = idKey(ev.target)
  const aYou = aKey === 'you'
  const bYou = bKey === 'you'
  const aPet = !aYou && petNames.has(aKey)
  const bPet = !bYou && petNames.has(bKey)

  if (aYou) {
    // You → anything (including a pet name = a hostile twin) is outgoing.
    return bYou ? { kind: 'ignore' } : { kind: 'out-you' }
  }
  if (aPet) {
    // Your pet is the attacker.
    if (bYou) return { kind: 'incoming' } // pet-name → You is always incoming
    const ambiguous = aKey === bKey // same-name twin: can't tell pet from twin
    return { kind: 'out-pet', petKey: aKey, petName: ev.attacker, ambiguous }
  }
  if (bYou) return { kind: 'incoming' }
  // Attacker not friendly, target not you. If target is a pet, this is a mob
  // hitting your pet — not tracked as our incoming (existing behavior: ignore).
  void bPet
  return { kind: 'ignore' }
}

export class CombatEngine {
  /** Canonical name keys of your LIVE PETS — charmed AND summoned alike. Kept in
   *  lockstep with the WorldModel's pet instances so the pure classify() (which only
   *  needs name membership) stays cheap. This is an ATTRIBUTION set, NOT a charm
   *  roster: a summoned class pet (Vebarn, Garer…) belongs here exactly as much as a
   *  charmed mob does, because both attribute as "your pet". The charmed/summoned
   *  distinction lives on WorldModel Instance.petKind — see world.charmedInstances(). */
  private petNames = new Set<string>()
  private world = new WorldModel()
  /** The player's own proper name key (e.g. "primitive"). Normally INJECTED by
   *  index.ts via setPlayerName() (it knows the character from the tail ref). As a
   *  cheap fallback (guards a mis-parsed injected name) it can also be LEARNED from
   *  heal lines: EQ writes self-heals as "You healed <PlayerName> for N", so a heal
   *  whose healer is You and whose target is neither one of your pets nor an engaged
   *  hostile reveals the player's name. An injected name always wins over a learned
   *  one. Once known, heals targeting that name count as incoming. */
  private playerKey?: string
  /** True once setPlayerName() injected the name, so heal-based learning can't
   *  overwrite it. */
  private playerKeyInjected = false
  private zone?: string
  private seq = 0
  private current: Encounter | null = null
  private history: Encounter[] = []
  private zoneAgg = new Agg()
  private zoneFinalizedMs = 0
  /** Sum of finalized encounters' activeMs this zone (for the zone active-DPS). */
  private zoneActiveMs = 0
  /** First/last attributed-damage ts in the LIVE zone session (0 = none yet). Task #54: drives
   *  the zone-session disambiguation timing (start clock + relative age + span). */
  private zoneStartTs = 0
  private zoneLastTs = 0
  /** Capped finalized-zone-session history (Task #54). Each entry keeps its FROZEN Agg + timing +
   *  a memoized SegmentView-less summary; the live zoneAgg is NOT in here. Newest last. */
  private zoneHistory: ZoneSession[] = []
  private zoneSeq = 0
  private recent: ClassifiedLine[] = []
  private recording = false
  /**
   * HYDRATION (Task #56). True from construction/reset until the historical scan hands off
   * to the live Tailer (`setLive()`, or the first live event as a belt-and-braces fallback).
   * While true, `current` is a fight from the PAST being replayed, so a snapshot's "live"
   * fields are historical — the snapshot carries this flag so the UI renders a loading state
   * instead of a churning fake-live meter.
   */
  private hydrating = true
  /** ts of the last encounter-relevant activity (attributed damage OR a CC event).
   *  Drives the FALLBACK_IDLE_MS closure independent of the damage timeline. */
  private lastActivityTs = 0
  /** Current combat-modifier pair (Task #51): the last stance/invocation the player
   *  committed to, with the ts of that change. Session-scoped (survives zones/epoch —
   *  a stance is not tied to a zone); reset() clears it. Exposed in the snapshot and
   *  used to open/close timeline stance spans on the current encounter. */
  private stance?: { name: string; ts: number }
  private invocation?: { name: string; ts: number }
  /**
   * BLADE COATS (Task #64). Two slots because the game has two: `coatUtility` is the ONE
   * active utility poison (a new utility coat replaces it), `coatCombat` holds the combat
   * venoms, which STACK. Session-scoped exactly like the stance pair — a coat survives zoning
   * (the wiki: poisons last until class swap or death) — and cleared by reset().
   */
  private coatUtility?: CoatSlot
  private coatCombat: CoatSlot[] = []
  /**
   * ROLLING TIME-TO-SLOW samples (Task #64), newest last, capped at SLOW_SAMPLE_CAP. One
   * entry per FINALIZED pull that opened with a slow-capable coat on: the ms to the first
   * slow landing, or null when the pull ended without one. The null entries are the whole
   * reason this is a list of samples and not a running mean — they are COUNTED (`noLand`) and
   * never averaged in as zero (law 5).
   */
  private slowSamples: (number | null)[] = []

  /** Enable classification logging (after the historical scan, for the live tail), and
   *  flip HYDRATION off — from here on every snapshot describes the real present. */
  setLive(): void {
    this.recording = true
    this.hydrating = false
  }

  /**
   * Display names of your GENUINELY-CHARMED live pets (mobs bound by a
   * `<mob> has been charmed.` line). SUMMONED class pets are deliberately excluded —
   * they are pets, not charms. Deliberately NOT in the snapshot: no UI needs a charm
   * roster today, and the old snapshot field lied (it was the attribution set). This is
   * the ONLY correct door for one; never reconstruct it from petNames.
   */
  charmedPetNames(): string[] {
    return this.world.charmedInstances().map((i) => i.display)
  }

  /** Display names of ALL your live pets — charmed AND summoned. This is what the DPS
   *  meter attributes to (both kinds produce `kind: 'pet'` source rows). */
  petDisplayNames(): string[] {
    return this.world.petInstances().map((i) => i.display)
  }

  /**
   * Inject the player's own character name (from index.ts's tail ref). This is the
   * authoritative source: called before the scan replay and again on a character
   * switch after reset(). Keyed canonically so it matches the idKey() the heal path
   * uses. Wins over any heal-line-learned name.
   */
  setPlayerName(name: string): void {
    this.playerKey = idKey(name)
    this.playerKeyInjected = true
  }

  reset(): void {
    this.petNames.clear()
    this.world.reset()
    this.playerKey = undefined
    this.playerKeyInjected = false
    this.zone = undefined
    this.current = null
    this.history = []
    this.zoneAgg = new Agg()
    this.zoneFinalizedMs = 0
    this.zoneActiveMs = 0
    this.zoneStartTs = 0
    this.zoneLastTs = 0
    this.zoneHistory = []
    this.zoneSeq = 0
    this.recent = []
    this.recording = false
    // A reset always precedes a fresh full-log scan (startup / character switch), so we're
    // hydrating again until that scan hands off to the tail.
    this.hydrating = true
    this.lastActivityTs = 0
    this.stance = undefined
    this.invocation = undefined
    this.coatUtility = undefined
    this.coatCombat = []
    this.slowSamples = []
  }

  private log(ts: number, cat: string, role: ClassifiedLine['role'], text: string): void {
    if (!this.recording) return
    this.recent.push({ ts, cat, role, text })
    if (this.recent.length > RECENT_CAP) this.recent.shift()
  }

  /**
   * Fold one canonical LogEvent into the state machine. The engine consumes
   * damage/charm/uncharm/death/zone directly (the old internal parse call path is
   * gone). heal/miss are parse-only for now — logged to the classification ring
   * for visibility, but not aggregated. Any other kind is ignored.
   *
   * `live` drives the classification ring (recording): historical replay events
   * mutate state silently; live events are also ring-logged.
   */
  ingestEvent(ev: LogEvent, live: boolean): void {
    if (live) {
      this.recording = true
      this.hydrating = false
    }
    switch (ev.kind) {
      case 'epoch': {
        // Character rebirth (Task #49): a same-name character was wiped/recreated. The DPS
        // meter is session-scoped (the user's live encounter history + the zone aggregate,
        // reset on every zone line already), so we deliberately KEEP it — a rebirth is not a
        // reason to lose the current session's fights. But the beta character's charmed/pet
        // world state is stale, so finalize any open fight and clear the pet sets as a cheap
        // safety (a zone line after the rebirth login would clear it anyway; this makes the
        // boundary explicit and independent of that ordering).
        this.finalizeCurrent()
        this.petNames = new Set()
        this.world.reset()
        return
      }
      case 'zone': {
        this.finalizeCurrent()
        // Freeze the just-left zone's aggregate into the capped history (Task #54) BEFORE
        // resetting, so its overall meter stays selectable. A zone session with no attributed
        // damage is dropped (nothing to show), matching the empty-encounter drop rule.
        this.finalizeZoneSession()
        this.zone = ev.zone
        this.zoneAgg = new Agg()
        this.zoneFinalizedMs = 0
        this.zoneActiveMs = 0
        this.zoneStartTs = 0
        this.zoneLastTs = 0
        // Charm cannot survive a zone transition, and hostile mobs don't follow —
        // both are retired. SUMMONED class pets DO persist across zones (real-log
        // verified), so world.zone() returns the survivors (summoned pets only) and we
        // rebuild the fast pet-name set from them — which keeps a summoned pet fully
        // attributable after zoning while dropping stale charmed/hostile names.
        const survivors = this.world.zone(ev.ts)
        this.petNames = new Set(survivors.map((i) => i.nameKey))
        this.log(ev.ts, 'zone', 'info', `▸ entered ${ev.zone}`)
        return
      }
      case 'charm': {
        const inst = this.world.charm(ev.mob, ev.ts)
        this.petNames.add(idKey(ev.mob))
        this.log(ev.ts, 'charm', 'info', `⚡ charmed ${this.world.label(inst)} [${inst.instanceId}]`)
        return
      }
      case 'petClaim': {
        // A pet addressed you as master → the named entity is your pet. Bind it as
        // a SUMMONED pet (idempotent; a charmed mob sends this tell too — the real log
        // shows both — and world.claim() leaves an already-charmed instance's petKind
        // alone, so a charmed pet is never reclassified as summoned). This is the ONLY
        // binding signal for random-named class pets. It adds the name to the
        // ATTRIBUTION set only — a summoned pet is NEVER a charmed pet.
        const inst = this.world.claim(ev.name, ev.ts)
        this.petNames.add(idKey(ev.name))
        this.log(ev.ts, 'pet', 'info', `⚡ pet claim ${this.world.label(inst)} [${inst.instanceId}]`)
        return
      }
      case 'uncharm': {
        this.world.uncharm(ev.mob, ev.ts)
        this.petNames.delete(idKey(ev.mob))
        this.log(ev.ts, 'uncharm', 'info', `✕ charm broke: ${ev.mob}`)
        return
      }
      case 'cc': {
        // Crowd control (mez/root, not charm). Evaluate any pending closure at this
        // ts first (a CC on a fresh pull shouldn't attach to a stale fight), then
        // mark the CC'd instance engaged + CC-held so the encounter stays OPEN across
        // the mez-and-wait gap. A CC'd instance counts as "alive" for closure.
        this.evalClosure(ev.ts)
        const inst = this.world.resolve(ev.mob, ev.ts)
        if (inst.instanceId === 'you') return
        const enc = this.ensureEncounter(ev.ts)
        enc.engaged.add(inst.instanceId)
        enc.engagedSeen.set(inst.instanceId, ev.ts)
        enc.ccActiveUntil.set(inst.instanceId, ev.ts + CC_HOLD_MS)
        this.lastActivityTs = ev.ts
        const tag = ev.refresh ? 'refresh' : 'applied'
        this.log(ev.ts, 'cc', 'info', `✜ CC ${tag}: ${this.world.label(inst)}${ev.spell ? ` (${ev.spell})` : ''}`)
        return
      }
      case 'death': {
        const key = idKey(ev.name)
        const killerKey = ev.bySelf ? 'you' : ev.killer ? idKey(ev.killer) : undefined
        const res = this.world.death(ev.name, ev.ts, killerKey)
        // Keep the fast pet-name set in lockstep: only drop the name from the
        // set when NO pet instance of it remains live.
        if (!this.world.petInstance(ev.name)) this.petNames.delete(key)
        // The retired instance stays in `engaged` (so an in-fight heal on the corpse
        // still counts) — closure consults world.isRetired(), not set membership.
        // Clear any CC hold on the dead instance so it can't keep the fight open.
        if (res.retired) this.current?.ccActiveUntil.delete(res.retired.instanceId)
        const petNote = res.wasPet ? ' (pet)' : ''
        const ambNote = res.ambiguous ? ' ~ambiguous' : ''
        this.log(ev.ts, 'death', 'info', `☠ ${ev.name} died${petNote}${ambNote} — ${res.reason}`)
        return
      }
      case 'damage': {
        // Caster-less other-player DoTs (attacker:null) are not our fight.
        if (ev.attacker === null) {
          this.log(ev.ts, 'other', 'dropped', ev.raw)
          return
        }
        // Close any pending encounter at this ts BEFORE routing, so attributed damage
        // after a closure starts a fresh encounter rather than reviving the old one.
        this.evalClosure(ev.ts)
        const modifiers = ev.modifiers ?? []
        const d: DamageEvent = {
          ts: ev.ts, attacker: ev.attacker, target: ev.target, amount: ev.amount,
          dtype: ev.dtype, dclass: ev.dclass, skill: ev.skill, crit: ev.crit, modifier: ev.modifier,
          // Prefer the parse-time category; derive as a fallback so pre-#51 events (or
          // any path that omits it) still aggregate under the right axis.
          category: ev.category ?? damageCategory(ev.dtype, modifiers),
          modifiers
        }
        this.route(d)
        return
      }
      case 'heal':
        this.routeHeal(ev.ts, ev.healer ?? null, ev.target, ev.amount, ev.spell, ev.rawAmount, ev.crit)
        this.log(ev.ts, 'heal', 'info', `+ ${ev.healer ?? '?'} → ${ev.target} ${ev.amount}${ev.spell ? ` (${ev.spell})` : ''}`)
        return
      case 'mitigation':
        this.routeMitigation(ev)
        this.log(
          ev.ts,
          'mitigation',
          'info',
          ev.mtype === 'rune'
            ? `⛊ rune +${ev.amount} absorption`
            : ev.mtype === 'absorbSwing'
              ? `⛊ absorbed ${ev.source ?? '?'}'s blow`
              : `⛊ absorbed ${ev.source ?? '?'}'s damage shield`
        )
        return
      case 'miss':
        this.routeMiss(ev.ts, ev.attacker, ev.target, ev.mtype)
        return
      case 'resist':
        this.routeResist(ev.ts, ev.caster, ev.target, ev.spell, ev.incoming)
        return
      case 'stanceChange':
        this.applyStance('stance', ev.stance, ev.ts)
        this.log(ev.ts, 'stance', 'info', `▸ stance: ${ev.stance}`)
        return
      case 'invocationChange':
        this.applyStance('invocation', ev.invocation, ev.ts)
        this.log(ev.ts, 'invocation', 'info', `▸ invocation: ${ev.invocation}`)
        return
      case 'poisonCoat':
        this.routeCoat(ev.ts, ev.poison, ev.group, ev.who)
        return
      case 'poisonDry':
        this.routeDry(ev.ts, ev.group)
        return
      case 'poisonProc':
        this.routeProc(ev.ts, ev.strike, ev.candidates, ev.effect === 'slow', ev.target)
        return
      case 'buffApply':
        // DISPEL LANDINGS on the mobs we are fighting (Task #64) — the "counts of spells (like
        // the dispel variants and such)" ledger. Message-driven and gated to DISPEL_FAMILY; it
        // names NO caster, and the view labels it accordingly.
        this.routeDispelLanding(ev.ts, ev.target, ev.candidates.map((c) => c.name))
        return
      default:
        return
    }
  }

  /**
   * Apply a blade coat (Task #64). ONLY your own coats move state — a third-person coat line
   * is another player's blades and is dropped after logging. A UTILITY coat replaces the one
   * utility slot; a COMBAT venom is added to the stack (re-coating the same venom just
   * refreshes its ts). An 'unknown' poison is recorded in the segment's coat list (the blades
   * demonstrably got re-coated) but never placed in a slot — we cannot claim what is on them.
   */
  private routeCoat(ts: number, poison: string, group: 'utility' | 'combat' | 'unknown', who: string): void {
    if (idKey(who) !== 'you') {
      this.log(ts, 'poison', 'info', `☠ ${who} coated their blades`)
      return
    }
    const slot: CoatSlot = { poison, sinceTs: ts }
    if (group === 'utility') this.coatUtility = slot
    else if (group === 'combat') {
      this.coatCombat = [...this.coatCombat.filter((c) => c.poison !== poison), slot]
    }
    // A coat is not combat: it never opens or extends an encounter. It attaches to an
    // in-progress fight (same freshness rule a miss uses) and always to the zone aggregate.
    const enc = this.freshEncounter(ts)
    const label = poison === 'unknown' ? 'poison' : poison
    if (enc) {
      enc.agg.procs.coats.push({ poison, ts })
      this.pushMarker(enc, { ts, kind: 'coat', label, detail: `${group} coat` })
    }
    this.zoneAgg.procs.coats.push({ poison, ts })
    this.log(ts, 'poison', 'info', `☠ coated: ${label}${group === 'unknown' ? '' : ` (${group})`}`)
  }

  /**
   * A coat wore off / was replaced. The line names no poison, only which FAMILY dried, so:
   *   utility — unambiguous, there is only ever one; clear it.
   *   combat  — the log CANNOT say which venom of a stack expired (law 6). We clear the whole
   *             stack rather than pick one: under-claiming what is coated is honest, while
   *             leaving a venom listed that the game just told us ended is not. (No combat
   *             dry line exists anywhere in the user's log; both observed dries are utility
   *             replacements, printed in the same second as the coat that replaced them.)
   */
  private routeDry(ts: number, group: 'utility' | 'combat'): void {
    if (group === 'utility') this.coatUtility = undefined
    else this.coatCombat = []
    this.log(ts, 'poison', 'info', `☠ ${group} coat dried`)
  }

  /**
   * A rogue-poison Strike landed on something (Task #64).
   *
   * ATTRIBUTION, HONESTLY: the emote names no caster, so this is never claimed as "your" proc
   * on its own. It is counted against the fight it lands in, and the SLOW timing is only
   * reported for pulls that opened with a slow-capable coat on (`ProcsView.slowExpected`) —
   * which is the closest the log lets anyone get to "my poison did that".
   *
   * A proc never OPENS an encounter (it is not damage, law 8's rule for misses applies), but
   * it IS presence evidence: a mob that just got slowed is emphatically still in the fight.
   */
  private routeProc(ts: number, strike: string, candidates: string[], isSlow: boolean, target: string): void {
    // A proc on YOU is an incoming mob effect, not our poison — never counted here. Nor is a
    // proc on anything we are not fighting: the log has a `Hakon blinks, looking confused!`
    // (another PLAYER taking a Concussive Strike from someone else's blades), and counting
    // that as a proc of ours would be a claim the line does not support. The zone aggregate
    // is gated the same way, via the encounter — a proc with no open fight is dropped.
    if (idKey(target) === 'you' || !this.isEngagedHostile(idKey(target))) return
    const ambiguous = candidates.length > 1
    const label = ambiguous ? candidates.join(' / ') : strike
    const enc = this.freshEncounter(ts)
    if (enc) {
      enc.agg.procs.addStrike(label, ambiguous, ts, isSlow)
      this.notePresence(target, ts)
      if (isSlow) {
        this.pushMarker(enc, { ts, kind: 'slow', label: SLOW_STRIKE, detail: target })
      }
    }
    this.zoneAgg.procs.addStrike(label, ambiguous, ts, isSlow)
    this.log(ts, 'poison', 'you', `☠ ${label} → ${target}`)
  }

  /**
   * Count a DISPEL landing on an engaged hostile (Task #64).
   *
   * TWO gates, both load-bearing:
   *   1. DISPEL_FAMILY — the raw landing stream is far too broad to tabulate (one lifetap
   *      message alone resolves to 36 candidate spells), so only the curated dispel family
   *      is counted. See DISPEL_FAMILY for why that is the one family worth a lane.
   *   2. ENGAGED — the ledger describes THIS fight, not every dispel in earshot.
   * `candidates` goes into the label verbatim: each tier is shared by 2–3 spells (law 3), so
   * the count is exact while the name stays honestly uncertain.
   */
  private routeDispelLanding(ts: number, target: string, candidates: string[]): void {
    if (target === 'self' || candidates.length === 0) return
    if (!candidates.every((c) => DISPEL_FAMILY.has(c))) return
    const key = idKey(target)
    if (key === 'you' || !this.isEngagedHostile(key)) return
    const enc = this.freshEncounter(ts)
    const label = candidates.join(' / ')
    if (enc) enc.agg.procs.addDispel(label)
    this.zoneAgg.procs.addDispel(label)
  }

  /** The in-progress encounter, but only while it is FRESH — the same rule routeMiss uses so a
   *  non-damage event can attach to the fight it belongs to without reviving a stale one (and
   *  without ever OPENING one: only damage/CC do that). */
  private freshEncounter(ts: number): Encounter | null {
    return this.current && ts - this.current.lastTs <= FALLBACK_IDLE_MS ? this.current : null
  }

  /** Append a point annotation to an encounter's marker ring (Task #64), drop-oldest at
   *  MARKER_CAP. Draw-only: no count, DPS or attribution ever reads this. */
  private pushMarker(enc: Encounter, m: MarkerRaw): void {
    enc.markers.push(m)
    if (enc.markers.length > MARKER_CAP) enc.markers.shift()
  }

  /**
   * Apply a stance/invocation change (Task #51). Updates the current pair and, if an
   * encounter is open, closes the prior span at this ts and opens a new one for the
   * timeline's pinned rows. A no-op change (same name) is ignored so the timeline doesn't
   * accrue zero-width spans from re-asserts.
   */
  private applyStance(group: 'stance' | 'invocation', name: string, ts: number): void {
    const cur = group === 'stance' ? this.stance : this.invocation
    if (cur?.name === name) return
    if (group === 'stance') this.stance = { name, ts }
    else this.invocation = { name, ts }
    // Reflect the change on the open encounter's span list (if any).
    const enc = this.current
    if (enc) {
      const prev = [...enc.stanceSpans].reverse().find((s) => s.group === group && s.end === undefined)
      if (prev) prev.end = ts
      enc.stanceSpans.push({ group, name, start: ts })
      // Task #64: the same commit is ALSO a point annotation (the chart draws a tick at it)
      // and a counter on the segment's proc ledger. The span drives the timeline's pinned
      // rows; the marker drives the DPS curve's ticks. Both, because they answer different
      // questions ("what was on" vs "when did it change").
      this.pushMarker(enc, { ts, kind: group, label: name })
      if (group === 'stance') enc.agg.procs.stanceSwitches++
      else enc.agg.procs.invocationSwitches++
    }
    if (group === 'stance') this.zoneAgg.procs.stanceSwitches++
    else this.zoneAgg.procs.invocationSwitches++
  }

  private route(ev: DamageEvent): void {
    if (ev.amount <= 0) return
    const at = classify(ev, this.petNames)
    if (at.kind === 'ignore') return

    // Twin evidence: You→pet-name or same-name→same-name proves a hostile twin
    // co-exists with the pet; ensure the world model has a second instance so the
    // pet and the hostile twin resolve to distinct identities.
    if (at.kind === 'out-you' && this.petNames.has(idKey(ev.target))) {
      this.world.noteTwinEvidence(ev.target, ev.ts)
    }
    if (at.kind === 'out-pet' && at.ambiguous) {
      this.world.noteTwinEvidence(ev.target, ev.ts)
    }

    const enc = this.ensureEncounter(ev.ts)
    // Active-time accrual: add the gap since the previous attributed hit, capped at
    // ACTIVE_MS (standard meter convention — a long lull between hits counts as at
    // most one "active" tick, not the whole idle stretch). First hit adds 0.
    if (enc.prevDamageTs !== undefined) {
      enc.activeMs += Math.min(Math.max(0, ev.ts - enc.prevDamageTs), ACTIVE_MS)
    }
    enc.prevDamageTs = ev.ts
    enc.lastTs = ev.ts
    this.lastActivityTs = ev.ts
    // Zone-session timing (Task #54): first/last attributed damage in this zone session, for the
    // zone-session summary's disambiguation timing (start clock + relative age + span).
    if (this.zoneStartTs === 0) this.zoneStartTs = ev.ts
    this.zoneLastTs = ev.ts

    const critMark = ev.crit ? '*' : ''
    if (at.kind === 'incoming') {
      // Attacker is a hostile (or the pet hitting you). Resolve to an instance so
      // twins are distinct in the incoming list.
      const attInst = this.world.resolve(ev.attacker, ev.ts)
      const id = attInst.instanceId
      const name = this.world.label(attInst)
      enc.agg.addInc(id, name, ev)
      this.zoneAgg.addInc(id, name, ev)
      enc.engaged.add(id)
      enc.engagedSeen.set(id, ev.ts)
      // Timeline: an incoming instant lanes under the attacker's skill (its own row).
      this.pushTimeline(enc, {
        ts: ev.ts, lane: ev.skill, category: ev.category, amount: ev.amount,
        crit: ev.crit, modifiers: ev.modifiers, kind: 'enemy'
      })
      this.log(ev.ts, ev.dtype, 'enemy', `${name} → You  ${ev.amount}${critMark}  ${ev.skill}`)
      return
    }

    // Outgoing (you or pet).
    const isYou = at.kind === 'out-you'
    let id: string
    let name: string
    const kind: SourceKind = isYou ? 'you' : 'pet'
    if (isYou) {
      id = 'you'
      name = 'You'
    } else {
      // Resolve the pet to its pet instance so twin pets are distinct.
      const petInst = this.world.petInstance(ev.attacker) ?? this.world.resolve(ev.attacker, ev.ts, true)
      id = `pet:${petInst.instanceId}`
      name = this.world.label(petInst)
      // The pet is trading blows with its target — record that engagement for the
      // death-disambiguation rule (case 2b).
      this.world.notePetEngagement(ev.attacker, idKey(ev.target))
    }
    const ambiguous = at.kind === 'out-pet' && at.ambiguous
    // POISON-TYPED DAMAGE (Task #64): the game states the damage TYPE on every typed spell
    // line ("… for 53 points of POISON damage by Asp Venom Strike."), so a poison lane is a
    // fact the log printed, not a name-matched guess. Outgoing only — a mob's poison DoT on
    // you is not a proc of ours. Additive: this is a second index over damage already counted,
    // so no total moves.
    if (ev.dclass === 'poison') {
      enc.agg.procs.addPoisonDamage(ev.skill, ev.amount)
      this.zoneAgg.procs.addPoisonDamage(ev.skill, ev.amount)
    }
    // Resolve the target to an instance. For a same-name ambiguous pet hit the
    // target is the HOSTILE twin (preferCharmed=false picks the hostile instance).
    const tgtInst = this.world.resolve(ev.target, ev.ts)
    const tgtId = tgtInst.instanceId
    const tgtName = this.world.label(tgtInst)
    enc.agg.addOut(id, name, kind, ev, ambiguous)
    enc.agg.bumpTarget(tgtId, tgtName, ev.amount)
    this.zoneAgg.addOut(id, name, kind, ev, ambiguous)
    this.zoneAgg.bumpTarget(tgtId, tgtName, ev.amount)
    enc.engaged.add(tgtId)
    enc.engagedSeen.set(tgtId, ev.ts)
    // LIVE-name tracking (Task #54): the current fight is named after whatever you're
    // presently swinging at (most recent outgoing target). Finalize switches to the
    // largest target (encounterName()); until then this drives the live label.
    enc.lastOutTarget = tgtName
    // Timeline: an outgoing instant lanes under the skill/spell name. `target` carries the
    // INSTANCE-RESOLVED defender label (same value bumpTarget aggregates under, so twins stay
    // distinct) — it drives the tooltip AND the dashboard's per-mob breakdown, which needs
    // per-event defenders to answer "what did I land on THIS mob". Miss/resist ticks already
    // carried it; damage ticks did not, which made per-mob damage underivable renderer-side.
    this.pushTimeline(enc, {
      ts: ev.ts, lane: ev.skill, category: ev.category, amount: ev.amount,
      crit: ev.crit, modifiers: ev.modifiers, kind, target: tgtName
    })
    const cat = ambiguous ? 'ambiguous' : ev.dtype
    const mark = ambiguous ? '~' : critMark
    this.log(ev.ts, cat, kind, `${name} → ${tgtName}  ${ev.amount}${mark}  ${ev.skill}`)
  }

  /**
   * Consume a miss (avoided swing) with the same attribution rules as damage.
   * We synthesize a zero-amount DamageEvent to reuse classify(); a melee skill
   * name isn't in the miss line, so avoided swings bucket under a "Melee" skill.
   */
  private routeMiss(ts: number, attacker: string, target: string, mtype: MissType): void {
    const probe: DamageEvent = {
      ts, attacker, target, amount: 0, dtype: 'melee', skill: 'Melee', crit: false,
      category: 'melee', modifiers: []
    }
    const at = classify(probe, this.petNames)
    if (at.kind === 'ignore') return
    // A miss doesn't open or extend an encounter (closure is death/CC/fallback driven),
    // but it attaches to the in-progress fight if one is fresh (so hit% is per-fight).
    // Otherwise it still counts toward the zone aggregate.
    const enc = this.current && ts - this.current.lastTs <= FALLBACK_IDLE_MS ? this.current : null
    // PRESENCE (Task #55): a swing exchanged with an already-engaged mob proves it's
    // still in the fight even though nothing landed — the mob on an incoming miss, the
    // mob we whiffed at on an outgoing one. Liveness only; no damage timing moves.
    this.notePresence(at.kind === 'incoming' ? attacker : target, ts)

    if (at.kind === 'incoming') {
      const attInst = this.world.resolve(attacker, ts)
      const id = attInst.instanceId
      const name = this.world.label(attInst)
      enc?.agg.addIncMiss(id, name, mtype, 'Melee')
      this.zoneAgg.addIncMiss(id, name, mtype, 'Melee')
      // ABSORPTION (Task #59): an incoming swing absorbed by YOUR rune is also a mitigation
      // instant. `incoming` means the defender is YOU (a swing at your pet classifies as
      // 'ignore'), so this can't pick up a pet's or a mob's own rune. It is the SECOND source
      // for the same line family the parser's 'absorbSwing' mitigation event covers: whichever
      // of MISS_RE / SKIN_ABSORB_BLOW_RE claims the line, exactly ONE event is emitted, so the
      // two paths can never double-count — and the count survives the pending MISS_RE fix.
      if (mtype === 'absorb') {
        enc?.agg.heal.addAbsorbedSwing()
        this.zoneAgg.heal.addAbsorbedSwing()
      }
      this.log(ts, 'miss', 'enemy', `${name} ✕ You (${mtype})`)
      return
    }
    const isYou = at.kind === 'out-you'
    let id: string
    let name: string
    const kind: SourceKind = isYou ? 'you' : 'pet'
    if (isYou) {
      id = 'you'
      name = 'You'
    } else {
      const petInst = this.world.petInstance(attacker) ?? this.world.resolve(attacker, ts, true)
      id = `pet:${petInst.instanceId}`
      name = this.world.label(petInst)
    }
    enc?.agg.addOutMiss(id, name, kind, mtype, 'Melee')
    this.zoneAgg.addOutMiss(id, name, kind, mtype, 'Melee')
    // Timeline: a miss tick lanes under "Melee" (hollow/red mark in the renderer). The
    // defender goes through defenderLabel() so it matches the INSTANCE label the damage
    // path writes — a raw name made every whiff at a twin pile onto a phantom bare row.
    const tgtName = enc ? this.defenderLabel(enc, target, ts) : target
    if (enc) this.pushTimeline(enc, {
      ts, lane: 'Melee', category: 'melee', amount: 0, crit: false, kind,
      outcome: 'miss', detail: mtype, target: tgtName
    })
    this.log(ts, 'miss', kind, `${name} ✕ ${tgtName} (${mtype})`)
  }

  /**
   * INSTANCE-RESOLVED defender label for a damage-free instant (miss/resist), Task #58.
   *
   * The damage path labels its defender `world.label(world.resolve(target, ts))`, so twins
   * read as "a deadly black widow (7)" / "(8)". Miss and resist ticks carried the RAW log
   * name instead, so the dashboard's per-mob panel — which groups timeline instants by
   * `target` — grew a bare-named 0-damage ghost row alongside the two real instances.
   *
   * Resolution is GATED on the name already being engaged in this encounter (the same
   * nameKey-prefix scan notePresence uses). That keeps AGENTS.md law 8 intact in both
   * directions: `engaged` membership only ever comes from LANDED damage/heals, so a whiff
   * at a mob we have never damaged still has ZERO world-model side effects (no instance is
   * spawned, no gen counter moves) and simply keeps its raw name — the honest label when no
   * instance exists. When the name IS engaged, resolve() returns the same instance the next
   * landed hit would, so the miss lands on the right twin's row.
   */
  private defenderLabel(enc: Encounter, name: string, ts: number): string {
    const key = idKey(name)
    if (key === 'you') return 'You'
    for (const id of enc.engaged) {
      const hash = id.lastIndexOf('#')
      if (hash > 0 && id.slice(0, hash) === key) return this.world.label(this.world.resolve(name, ts))
    }
    return name
  }

  /**
   * Consume a spell RESIST (Task #51 v2) — the caster-side analogue of a miss. Attribution:
   *   caster='you'  → outgoing 'you'.
   *   caster=<name> that resolves to one of our pets → outgoing pet.
   *   incoming (You resisted a mob's spell) → incoming, attributed to the mob (the caster).
   *   any other caster (a hostile mob's spell resisted by another mob) → IGNORED, mirroring
   *     classify()'s rule that non-you/pet attackers are out of scope for the meter.
   * The resisted spell is rank-normalized (spellCanonKey) ONLY for the lane display we keep;
   * we lane by the DISPLAY spell name so the resist tick lands in the same lane as landed
   * casts of that spell. Resists carry no damage → damage totals are untouched (tripwire).
   */
  private routeResist(ts: number, caster: string, target: string, spell: string, incoming: boolean): void {
    // Resisted detrimental spells are direct spells in the taxonomy (no melee/ds). A DoT
    // that's resisted is rare; we categorize all resists as 'spell' (the detrimental axis)
    // so they sort into the spell lanes — they carry no amount, so category totals are
    // unaffected. The lane is the display spell name.
    const category: DamageCategory = 'spell'
    // Attach to the in-progress fight if fresh (per-fight resist rate), else zone only —
    // mirrors routeMiss. A resist does not open/extend/close an encounter.
    const enc = this.current && ts - this.current.lastTs <= FALLBACK_IDLE_MS ? this.current : null
    // PRESENCE (Task #55): a resist names a live caster and a live resister. Refresh
    // whichever side is a HOSTILE we're already engaged with — the caster on an incoming
    // resist (the mob just cast at us), the target on our own resisted cast (the mob is
    // standing there shrugging it off). notePresence ignores anything not engaged, so the
    // you/pet side is a no-op — as is the third-party (mob-vs-mob) shape below, UNLESS
    // the resisting mob happens to be one of ours, in which case its presence is real
    // evidence even though the resist itself is dropped from the stats. Liveness only;
    // no damage timing moves.
    this.notePresence(incoming ? caster : target, ts)

    if (incoming) {
      // You resisted a mob's spell — attribute to the mob (incoming caster).
      const attInst = this.world.resolve(caster, ts)
      const id = attInst.instanceId
      const name = this.world.label(attInst)
      enc?.agg.addIncResist(id, name, spell, category)
      this.zoneAgg.addIncResist(id, name, spell, category)
      if (enc) this.pushTimeline(enc, {
        ts, lane: spell, category, amount: 0, crit: false, kind: 'enemy',
        outcome: 'resist', detail: 'resisted', target: 'You'
      })
      this.log(ts, 'resist', 'info', `You resisted ${name}'s ${spell}`)
      return
    }

    const casterKey = idKey(caster)
    const isYou = casterKey === 'you'
    const isPet = !isYou && this.petNames.has(casterKey)
    if (!isYou && !isPet) {
      // A hostile mob's spell resisted by another mob — out of scope for the meter.
      this.log(ts, 'resist', 'dropped', `${caster}'s ${spell} resisted by ${target}`)
      return
    }
    let id: string
    let name: string
    const kind: SourceKind = isYou ? 'you' : 'pet'
    if (isYou) {
      id = 'you'
      name = 'You'
    } else {
      const petInst = this.world.petInstance(caster) ?? this.world.resolve(caster, ts, true)
      id = `pet:${petInst.instanceId}`
      name = this.world.label(petInst)
    }
    enc?.agg.addOutResist(id, name, kind, spell, category)
    this.zoneAgg.addOutResist(id, name, kind, spell, category)
    // Same instance resolution as the miss/damage paths (see defenderLabel) — a resisted
    // cast at a twin must land on that twin's per-mob row, not a bare-named ghost.
    const tgtName = enc ? this.defenderLabel(enc, target, ts) : target
    if (enc) this.pushTimeline(enc, {
      ts, lane: spell, category, amount: 0, crit: false, kind,
      outcome: 'resist', detail: 'resisted', target: tgtName
    })
    this.log(ts, 'resist', kind, `${name}'s ${spell} resisted by ${tgtName}`)
  }

  /**
   * Consume a heal. Three things matter for combat stats:
   *   - target is an engaged HOSTILE instance → count as "enemy healing" (it undoes
   *     our damage; effective-DPS context per encounter + zone).
   *   - target is You or one of your pets → count as incoming healing (with top
   *     healers).
   *   - EITHER of those also folds into the meter-grade HEALING ledger (Task #59):
   *     per healer, per spell, with crit / min / max / derived overheal.
   * Other heals (party members healing each other, unrelated NPCs) are ignored for
   * aggregation — the log gives no faction for an arbitrary name.
   *
   * ZERO-EFFECTIVE heals (`… for 0 (2) hit points …`, 1,857 in the real log) are the overheal
   * evidence, so the healing ledger takes them; the pre-existing `enemyHeal`/`incHeal` maps keep
   * their original `amount <= 0` gate so their totals AND their healer lists stay byte-identical.
   */
  private routeHeal(
    ts: number,
    healer: string | null,
    target: string,
    amount: number,
    spell?: string,
    rawAmount?: number,
    crit?: boolean
  ): void {
    if (amount < 0) return
    const positive = amount > 0
    const heal = { amount, rawAmount, spell, crit }
    const tKey = idKey(target)
    const healerKey = healer ? idKey(healer) : null
    const isYouTgt = tKey === 'you'
    const isPetTgt = !isYouTgt && this.petNames.has(tKey)
    const engagedHostile = this.isEngagedHostile(tKey)

    // Learn the player's proper name as a FALLBACK only (injected name wins):
    // "You healed <Player>" where the target is not a pet and not an engaged
    // hostile → that name IS the player. (EQ never writes literal "You" as a heal
    // target; it uses the character name.)
    if (
      !this.playerKeyInjected &&
      healerKey === 'you' &&
      !isYouTgt &&
      !isPetTgt &&
      !engagedHostile &&
      this.playerKey === undefined
    ) {
      this.playerKey = tKey
    }
    const isPlayerTgt = this.playerKey !== undefined && tKey === this.playerKey

    if (isYouTgt || isPetTgt || isPlayerTgt) {
      // Incoming heal to You (or the player by name) / your pet.
      const enc = this.current && ts - this.current.lastTs <= FALLBACK_IDLE_MS ? this.current : null
      const hk = healerKey ?? 'unknown'
      const healerName = healer ?? 'Unknown'
      if (positive) {
        enc?.agg.addIncHeal(hk, healerName, amount)
        this.zoneAgg.addIncHeal(hk, healerName, amount)
      }
      // Healing ledger: rank by HEALER. Row id 'you' for self-heals keeps the healing meter's
      // primary row keyed the same way the damage meter's is.
      const kind: HealSourceKind =
        hk === 'you' ? 'you' : this.petNames.has(hk) ? 'pet' : 'other'
      const id = hk === 'you' ? 'you' : `heal:${hk}`
      enc?.agg.heal.addFriendly(id, healerName, kind, heal)
      this.zoneAgg.heal.addFriendly(id, healerName, kind, heal)
      return
    }

    // Heal on a hostile instance we're currently engaged with → enemy healing.
    const inst = this.world.resolve(target, ts)
    const enc = this.current
    if (enc && enc.engaged.has(inst.instanceId)) {
      if (positive) {
        enc.agg.addEnemyHeal(inst.instanceId, this.world.label(inst), amount)
        this.zoneAgg.addEnemyHeal(inst.instanceId, this.world.label(inst), amount)
      }
      // Counter-healing ledger, ranked by the HEALER (a mob healing itself is its own row).
      const hk = healerKey ?? 'unknown'
      const healerName = healer ?? 'Unknown'
      enc.agg.heal.addHostile(`heal:${hk}`, healerName, heal)
      this.zoneAgg.heal.addHostile(`heal:${hk}`, healerName, heal)
      // PRESENCE (Task #55): a heal on an engaged hostile proves BOTH ends are still in
      // the fight — the mob receiving it, and (when a second mob cast it) the healer. The
      // real case this came from: "Baron Telyx V`Zher healed Soldier of V`Zher for 175" —
      // the Baron had landed nothing for seconds while healing his friend, and the old
      // damage-only liveness rule had already written him off. Liveness only; no damage
      // timing moves (enemy healing is an annotation, never damage).
      this.notePresenceId(enc, inst.instanceId, ts)
      if (healer) this.notePresence(healer, ts)
    }
  }

  /**
   * Consume an ABSORPTION / MITIGATION line (Task #59) — damage prevented, not hit points
   * restored, so it never touches a DAMAGE total. It does reach the HEALING total: buildHealingView
   * folds the rune counters in as a row classified 'absorbed' (the two count-only families carry
   * no amount and so reach no total at all). Folded into the current encounter (when one is open
   * and still fresh) and the zone aggregate, exactly like an incoming heal.
   *
   * These lines NEVER open, join or extend an encounter and never move the damage timeline —
   * the same rule miss/resist follow (AGENTS.md world-model law 8). A rune ticking while you
   * stand around out of combat belongs to the zone lane and nowhere else.
   */
  private routeMitigation(ev: MitigationEvent): void {
    const enc =
      this.current && ev.ts - this.current.lastTs <= FALLBACK_IDLE_MS ? this.current : null
    const apply = (a: { heal: HealAccum }): void => {
      if (ev.mtype === 'rune') {
        // Defensive: the amount is required by the regex, but keep the ledger clean if a future
        // shape ever omits it — a rune with no amount is a count we cannot value.
        if (ev.amount != null && ev.amount > 0) a.heal.addRune(ev.amount)
      } else if (ev.mtype === 'absorbSwing') a.heal.addAbsorbedSwing()
      else a.heal.addAbsorbedDamageShield()
    }
    if (enc) apply(enc.agg)
    apply(this.zoneAgg)
  }

  /**
   * PRESENCE refresh (Task #55) — record that `name` is still in the current fight as of
   * `ts`. This is the liveness axis ONLY: it moves nothing on the damage timeline
   * (enc.lastTs / prevDamageTs / activeMs / lastActivityTs are untouched), so DPS
   * denominators and the fled-mob FALLBACK_IDLE_MS clock are unaffected (AGENTS.md law 8).
   *
   * Deliberately conservative in both directions:
   *   - it never ENGAGES anything: only instances ALREADY in enc.engaged are refreshed,
   *     so a miss/resist still cannot open or join an encounter;
   *   - it never resolves/creates a world instance (it matches the engaged instanceIds
   *     "<nameKey>#gen" by name prefix), so a whiff at a mob we've never damaged has no
   *     side effect on the world model at all.
   * Name-level matching refreshes every engaged twin sharing the name — the log cannot
   * tell twins apart on a miss line, and a retired twin is "gone" via isRetired anyway.
   */
  private notePresence(name: string, ts: number): void {
    const enc = this.current
    if (!enc) return
    const key = idKey(name)
    for (const id of enc.engaged) {
      const hash = id.lastIndexOf('#')
      if (hash > 0 && id.slice(0, hash) === key) this.notePresenceId(enc, id, ts)
    }
  }

  /** Presence refresh for an already-resolved engaged instanceId (see notePresence). */
  private notePresenceId(enc: Encounter, instanceId: string, ts: number): void {
    if (!enc.engaged.has(instanceId)) return
    const prev = enc.engagedSeen.get(instanceId)
    if (prev === undefined || ts > prev) enc.engagedSeen.set(instanceId, ts)
  }

  /** True if `nameKey` currently resolves to an engaged hostile instance. */
  private isEngagedHostile(nameKey: string): boolean {
    if (!this.current) return false
    for (const list of [this.current]) {
      for (const id of list.engaged) {
        // engaged ids are instanceIds "<nameKey>#gen"; compare the nameKey prefix.
        const hash = id.lastIndexOf('#')
        if (hash > 0 && id.slice(0, hash) === nameKey) return true
      }
    }
    return false
  }

  private ensureEncounter(ts: number): Encounter {
    // Closure is decided by evalClosure() (death-linger / CC-hold / fallback), which
    // ingestEvent runs before routing. Here we only lazily open a new encounter.
    if (!this.current) {
      const spans: StanceRaw[] = []
      // Seed the timeline's pinned rows with whatever stance/invocation is already active
      // at the moment the fight opens (so a fight inherits the standing modifiers).
      if (this.stance) spans.push({ group: 'stance', name: this.stance.name, start: ts })
      if (this.invocation) spans.push({ group: 'invocation', name: this.invocation.name, start: ts })
      this.current = {
        id: `e${++this.seq}`, zone: this.zone, startTs: ts, lastTs: ts,
        agg: new Agg(), engaged: new Set(), engagedSeen: new Map(), activeMs: 0,
        ccActiveUntil: new Map(), events: [], eventsTotal: 0, stanceSpans: spans,
        markers: [],
        // Task #64: freeze the coats as they stand AT ENGAGE. "Could this pull have been
        // slowed?" is a question about this instant — reading today's coat when the fight is
        // later rendered would silently re-label every past fight after a poison swap.
        coatAtEngage: this.coatUtility ? { ...this.coatUtility } : undefined,
        combatAtEngage: this.coatCombat.map((c) => ({ ...c }))
      }
    }
    return this.current
  }

  /** Append one instant to the current encounter's timeline ring (Task #51), capped
   *  drop-oldest at TIMELINE_CAP. Called from route()/routeMiss for attributed events.
   *  `eventsTotal` counts EVERY push, so a fight that outgrows the cap still knows its true
   *  instant count and buildTimeline can declare the loss instead of reporting the ring
   *  length as if it were the fight (law 1). The counter is display metadata only — no
   *  aggregate, DPS or attribution reads it. */
  private pushTimeline(enc: Encounter, rec: TimelineRaw): void {
    enc.events.push(rec)
    enc.eventsTotal++
    if (enc.events.length > TIMELINE_CAP) enc.events.shift()
  }

  /**
   * Evaluate deferred closure of the current encounter as of `now`. Encounters can
   * now close purely from time passing (no more events), so this is called at the
   * top of each damage/CC ingest AND from snapshot(now) — whichever comes first.
   * Finalization always stamps the encounter's lastTs (a damage timestamp), never
   * `now`, so startTs/lastTs/duration reflect the real fight, not the eval moment.
   *
   * Rules:
   *  - CC-hold: if any engaged instance is still CC-held (ccActiveUntil > now), keep
   *    OPEN regardless of gaps (the mez-and-wait case).
   *  - Death-close: once every engaged hostile instance is GONE — retired (dead/zoned),
   *    or alive but unseen for PRESENCE_GONE_MS — and LINGER_MS has passed since the last
   *    attributed DAMAGE, finalize.
   *  - Fallback: if no attributed damage AND no CC for FALLBACK_IDLE_MS (fled/deagro,
   *    no death logged), finalize.
   */
  private evalClosure(now: number): void {
    const enc = this.current
    if (!enc) return

    // CC-hold: any engaged instance still under an unexpired CC hold keeps it open.
    for (const until of enc.ccActiveUntil.values()) {
      if (until > now) return
    }

    // Is every engaged HOSTILE instance gone? Two different standards, because the
    // evidence is different (Task #55 — this split is the multi-mob-pull fix):
    //   RETIRED (dead/zoned) → gone immediately. The death line IS the evidence; the
    //     sinceDamage >= LINGER_MS check below still covers its trailing damage.
    //   LIVE → gone only after PRESENCE_GONE_MS with no presence evidence at all (see
    //     engagedSeen: damage, misses, resists, CC, heals). The old rule reused
    //     LINGER_MS here and counted only DAMAGE as evidence, so a second mob that was
    //     merely missing (or casting, or being out-damaged by its friend) looked dead
    //     after 5s — and the moment its friend actually died, the whole pull finalized
    //     and the survivor's remaining fight became a bogus second encounter.
    // A live charmed pet is never a mob we're killing, so it's excluded — otherwise the
    // pet (which never dies) would pin every charm-grind encounter open forever. CC'd
    // instances had their unexpired hold checked above.
    let hostiles = 0
    let allGone = true
    for (const id of enc.engaged) {
      if (this.world.isLivePet(id)) continue
      hostiles++
      const seen = enc.engagedSeen.get(id) ?? enc.lastTs
      const gone = this.world.isRetired(id) || now - seen >= PRESENCE_GONE_MS
      if (!gone) {
        allGone = false
        break
      }
    }

    const sinceDamage = now - enc.lastTs
    const sinceActivity = now - this.lastActivityTs

    // Death-close: every engaged hostile is dead/gone and the linger has elapsed.
    if (allGone && hostiles > 0 && sinceDamage >= LINGER_MS) {
      this.finalizeCurrent()
      return
    }
    // Fallback: no damage and no CC for the idle window (mob fled / deaggroed).
    if (sinceActivity >= FALLBACK_IDLE_MS) {
      this.finalizeCurrent()
    }
  }

  private finalizeCurrent(): void {
    if (!this.current) return
    const enc = this.current
    this.current = null
    // Close any open stance/invocation spans at the fight's end (Task #51).
    for (const s of enc.stanceSpans) if (s.end === undefined) s.end = enc.lastTs
    // Drop empty encounters: a CC application (or a lone miss) can open an encounter
    // that never accrues any attributed damage — e.g. a mez lands and the mob is
    // then killed by someone else. Don't pollute history/zone with a 0-damage shell.
    if (enc.agg.out.size === 0 && enc.agg.inc.size === 0) return
    // ROLLING TIME-TO-SLOW (Task #64). A pull only qualifies when a SLOW-CAPABLE utility coat
    // was already on at engage — otherwise "how long to slow" is a question nobody asked, and
    // including it would deflate the denominator with pulls that could never land one. A
    // qualifying pull that never slowed is pushed as `null`: counted as a miss, never averaged
    // in as a zero (law 5).
    if (enc.coatAtEngage && isSlowCapable(enc.coatAtEngage.poison)) {
      const first = enc.agg.procs.firstSlowTs
      this.slowSamples.push(first > 0 ? Math.max(0, first - enc.startTs) : null)
      if (this.slowSamples.length > SLOW_SAMPLE_CAP) this.slowSamples.shift()
    }
    this.zoneFinalizedMs += Math.max(0, enc.lastTs - enc.startTs)
    this.zoneActiveMs += enc.activeMs
    // Compute the immutable summary once, now that the encounter is frozen. A
    // finalized fight's summary never uses `now` (its `active` is always false),
    // so 0 is a safe sentinel. Reused on every snapshot() thereafter.
    enc.summary = this.encSummary(enc, 'fight', 0)
    this.history.push(enc)
    // Timeline memory bound (Task #51): keep the event ring only for the most recent
    // TIMELINE_HISTORY_CAP finalized encounters; drop older rings so the whole-session
    // RSS delta stays flat on a full-log replay (thousands of fights). The aggregate
    // summary/agg is untouched — only the raw per-event ring is released.
    const dropIdx = this.history.length - 1 - TIMELINE_HISTORY_CAP
    if (dropIdx >= 0) {
      const old = this.history[dropIdx]
      if (old.events.length) old.events = []
    }
  }

  /**
   * Freeze the LIVE zone aggregate into the capped history (Task #54), called on a zone change
   * (and epoch) before the aggregate is reset. Drops a zone session that saw no attributed damage
   * (nothing to select). The aggregate is immutable once pushed, so we compute + memoize its
   * summary here (mirroring finalizeCurrent's cached-summary pattern) — snapshot() never rebuilds
   * it. Also finalizes any still-open current encounter's duration into the session totals via the
   * caller ordering (finalizeCurrent runs first in the zone handler).
   */
  private finalizeZoneSession(): void {
    if (this.zoneAgg.out.size === 0 && this.zoneAgg.inc.size === 0) return
    const id = `zs${++this.zoneSeq}`
    const zone = this.zone ?? 'Session'
    const total = sumMap(this.zoneAgg.out)
    const durSec = Math.max(1, this.zoneFinalizedMs / 1000)
    const session: ZoneSession = {
      id,
      zone,
      agg: this.zoneAgg,
      startTs: this.zoneStartTs,
      lastTs: this.zoneLastTs,
      finalizedMs: this.zoneFinalizedMs,
      activeMs: this.zoneActiveMs,
      summary: {
        id,
        zone,
        startTs: this.zoneStartTs,
        endTs: this.zoneLastTs,
        total,
        dps: total / durSec,
        live: false
      }
    }
    this.zoneHistory.push(session)
    if (this.zoneHistory.length > ZONE_HISTORY_CAP) this.zoneHistory.shift()
  }

  /**
   * The zone-session list for the snapshot (Task #54): the LIVE session first (id 'zone'), then the
   * finalized history newest-first. The live entry's timing/total is computed fresh; the finalized
   * ones reuse their memoized summaries.
   */
  private zoneSessionSummaries(): ZoneSessionSummary[] {
    const liveTotal = sumMap(this.zoneAgg.out)
    const liveDur = this.zoneDurationSec()
    const live: ZoneSessionSummary = {
      id: 'zone',
      zone: this.zone ?? 'Session',
      startTs: this.zoneStartTs,
      endTs: 0,
      total: liveTotal,
      dps: liveTotal / liveDur,
      live: true
    }
    const finalized = [...this.zoneHistory].reverse().map((s) => s.summary)
    return [live, ...finalized]
  }

  snapshot(now: number, opts: SnapshotOpts = {}): CombatSnapshot {
    // Encounters can close purely from elapsed time (death-linger / fallback). A
    // snapshot may be the first observation after that threshold, so evaluate the
    // deferred closure here (stamped at the encounter's own lastTs, not `now`).
    this.evalClosure(now)
    const combinePets = opts.combinePets ?? false
    const maxSegments = opts.maxSegments ?? 100
    const inCombat = !!this.current && now - this.current.lastTs < ACTIVE_MS

    // Only the current encounter + zone summary are recomputed per call; finalized
    // fight summaries are memoized (immutable). Cap the finalized fights we
    // serialize to `maxSegments` newest-first — the zone summary and current
    // encounter are always included regardless of the cap.
    const segments: SegmentSummary[] = []
    if (this.current) segments.push(this.encSummary(this.current, 'current', now))
    const startIdx = this.history.length - 1
    const stopIdx = Math.max(0, this.history.length - maxSegments)
    for (let i = startIdx; i >= stopIdx; i--) {
      const e = this.history[i]
      segments.push(e.summary ?? this.encSummary(e, 'fight', now))
    }
    segments.push(this.zoneSummary())

    // DEFAULT selection = the FIGHT scope's head row: the open fight if there is one, else the
    // most recent finalized fight. Fight and Overall are an explicit user-chosen SCOPE now, so
    // this must never wander into the zone aggregate — a meter that swapped to zone-overall
    // between pulls is exactly what the user rejected. Overall is reached by ASKING for a zone
    // session id ('zone' / 'zs<n>'), never by default. With no fights at all the default
    // resolves to nothing (`selected: null`) and the UI shows a quiet "no fights yet" — the
    // renderer labels a finished head row honestly ("Last fight — X"), so nothing here has to
    // pretend a closed encounter is live.
    const defaultId = this.current?.id ?? this.history[this.history.length - 1]?.id ?? ''
    // Validate against ALL encounters, not just the capped segment window — a
    // selected finalized fight outside the cap is still fully resolvable via
    // buildSelected() (it searches this.history directly).
    const selectableId =
      opts.selectedId === 'zone' ||
      this.current?.id === opts.selectedId ||
      this.history.some((h) => h.id === opts.selectedId) ||
      this.zoneHistory.some((z) => z.id === opts.selectedId)
    const explicit = !!(opts.selectedId && selectableId)
    const selectedId = explicit ? opts.selectedId! : defaultId
    const selected = this.buildSelected(selectedId, now, combinePets)

    const recent = (opts.showUnparsed ? this.recent : this.recent.filter((r) => r.cat !== 'unparsed')).slice(-150)
    const stance: StanceState = {
      stance: this.stance?.name,
      stanceTs: this.stance?.ts,
      invocation: this.invocation?.name,
      invocationTs: this.invocation?.ts
    }
    const timeline = opts.timeline ? this.buildTimeline(selectedId, now) : undefined
    return {
      selectedId, selected, segments, inCombat, zone: this.zone,
      recent, stance, timeline,
      poison: { coat: this.coatState(), slow: this.slowRollup() },
      zoneSessions: this.zoneSessionSummaries(),
      hydrating: this.hydrating
    }
  }

  /** The live blade-coat pair, copied out so a consumer can't mutate engine state. */
  private coatState(): BladeCoatState {
    return {
      utility: this.coatUtility ? { ...this.coatUtility } : undefined,
      combat: this.coatCombat.map((c) => ({ ...c }))
    }
  }

  /**
   * The rolling time-to-slow rollup (Task #64). Statistics are computed over the LANDED
   * samples ONLY; the nulls are surfaced as `noLand` so the reader sees both halves. With no
   * landed samples every statistic is absent rather than 0 — "0 ms to slow" would be a lie
   * about a thing that never happened.
   */
  private slowRollup(): SlowRollup {
    const landed = this.slowSamples.filter((s): s is number => s !== null).sort((a, b) => a - b)
    const pulls = this.slowSamples.length
    const base: SlowRollup = {
      pulls,
      landed: landed.length,
      noLand: pulls - landed.length,
      window: SLOW_SAMPLE_CAP
    }
    if (landed.length === 0) return base
    const sum = landed.reduce((a, b) => a + b, 0)
    const mid = landed.length >> 1
    return {
      ...base,
      avgMs: Math.round(sum / landed.length),
      medianMs: landed.length % 2 ? landed[mid] : Math.round((landed[mid - 1] + landed[mid]) / 2),
      minMs: landed[0],
      maxMs: landed[landed.length - 1]
    }
  }

  /**
   * SEARCH THE WHOLE FIGHT HISTORY (Task #61) — "it should go back for all time and be fast
   * and somewhat fuzzy" (the user).
   *
   * "All time" needs no new storage: `history` is UNCAPPED (only the per-encounter timeline
   * RINGS are capped, at TIMELINE_HISTORY_CAP, and zone sessions at ZONE_HISTORY_CAP), and
   * every finalized encounter already carries a memoized SegmentSummary. So this walks the
   * ENTIRE history — deliberately NOT the `maxSegments` window snapshot() serializes, which
   * is a payload cap, not a retention one — plus the live fight (as `kind: 'current'`, so an
   * open pull is findable by the mob you are presently swinging at).
   *
   * Newest-first, because the pure scorer breaks score ties by recency and a stable input
   * order keeps that deterministic. The scoring itself lives in the MUI/electron-free
   * fightSearch.ts; this method is only the corpus.
   *
   * READ-ONLY: no closure evaluation, no memoization side effects, nothing mutated — typing
   * in a search box must never be able to finalize a fight or move a point of damage.
   */
  searchFights(text: string, limit?: number, now: number = Date.now()): FightSearchResult {
    const summaries: SegmentSummary[] = []
    if (this.current) summaries.push(this.encSummary(this.current, 'current', now))
    for (let i = this.history.length - 1; i >= 0; i--) {
      const e = this.history[i]
      // `summary` is always populated by finalizeCurrent(); the fallback keeps this total
      // even if a future path ever pushes an encounter without memoizing one.
      summaries.push(e.summary ?? this.encSummary(e, 'fight', now))
    }
    return searchFights(summaries, text, limit)
  }

  /**
   * Build the selected encounter's timeline view (Task #51). Returns null for the zone
   * selection (no single-fight timeline) or an encounter whose event ring was evicted
   * (older than TIMELINE_HISTORY_CAP). Converts absolute ts → ms-since-start, downsamples
   * with a uniform stride when over TIMELINE_BUDGET, and derives the Y-axis lanes (grouped
   * by category, then total desc) + the pinned stance/invocation spans.
   *
   * READ-ONLY over the encounter: it copies out of the ring and never mutates the ring, the
   * aggregate or any counter — asking for a timeline can't move a point of damage (asserted
   * by tests/combatRingTruncation.test.mts).
   */
  private buildTimeline(id: string, now: number): TimelineView | null {
    if (id === 'zone') return null
    const e = this.current?.id === id ? this.current : this.history.find((h) => h.id === id)
    if (!e) return null
    // An evicted finalized encounter carries no ring — no timeline available.
    if (e.events.length === 0 && e !== this.current) return null
    const start = e.startTs
    const isCurrent = this.current?.id === id
    const endTs = isCurrent ? Math.max(e.lastTs, now) : e.lastTs
    const durationMs = Math.max(1, endTs - start)

    const raw = e.events
    const rawCount = raw.length
    // TRUNCATION (drop-oldest already engaged): the ring holds only the most recent
    // TIMELINE_CAP instants of a longer fight. `rawCount` stays the ring occupancy — it is
    // the population the stride samples, so it is the honest sampling denominator — while
    // `totalCount` carries the fight's true instant count so the renderer can say "N of M"
    // without understating M. Deliberately NOT folded into the sampling factor: scaling by
    // totalCount/kept would extrapolate the discarded prefix from the retained tail, which
    // is exactly the silent guess law 1 forbids.
    const totalCount = Math.max(rawCount, e.eventsTotal)
    const truncated = totalCount > rawCount
    // Uniform-stride downsample when over budget (keeps the temporal shape; a dense
    // charm-grind fight is capped so the payload/render stays cheap).
    const stride = rawCount > TIMELINE_BUDGET ? Math.ceil(rawCount / TIMELINE_BUDGET) : 1
    const events: TimelineEvent[] = []
    const laneAgg = new Map<string, { category: DamageCategory; total: number; kind: SourceKind }>()
    for (let i = 0; i < rawCount; i++) {
      const r = raw[i]
      // Lane aggregation uses EVERY event (not just sampled ones) so a lane's total and
      // ordering are accurate even when the plotted instants are downsampled.
      const la = laneAgg.get(r.lane) ?? { category: r.category, total: 0, kind: r.kind }
      la.total += r.amount
      laneAgg.set(r.lane, la)
      if (i % stride !== 0) continue
      events.push({
        t: Math.max(0, r.ts - start),
        lane: r.lane,
        category: r.category,
        amount: r.amount,
        crit: r.crit,
        modifiers: r.modifiers && r.modifiers.length ? r.modifiers : undefined,
        kind: r.kind,
        ...(r.outcome && r.outcome !== 'hit' ? { outcome: r.outcome } : {}),
        ...(r.detail ? { detail: r.detail } : {}),
        ...(r.target ? { target: r.target } : {})
      })
    }
    const lanes = [...laneAgg.entries()]
      .map(([lane, v]) => ({ lane, category: v.category, total: v.total, kind: v.kind }))
      .sort((a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || b.total - a.total
      )
    const stanceSpans: StanceSpan[] = e.stanceSpans.map((s) => ({
      group: s.group,
      name: s.name,
      start: Math.max(0, s.start - start),
      end: Math.max(0, (s.end ?? endTs) - start)
    }))
    // MARKERS ARE NOT DOWNSAMPLED (Task #64) — every one is carried, deliberately, whatever
    // `stride` does to the damage instants above. They are sparse by construction and drawing
    // one in five of them would be worse than drawing none.
    const markers: TimelineMarker[] = e.markers.map((m) => ({
      t: Math.max(0, m.ts - start),
      kind: m.kind,
      label: m.label,
      ...(m.detail ? { detail: m.detail } : {})
    }))
    return {
      id: e.id,
      name: encounterName(e, isCurrent),
      durationMs,
      lanes,
      events,
      stanceSpans,
      markers,
      downsampled: stride > 1,
      rawCount,
      totalCount,
      truncated
    }
  }

  private encSummary(e: Encounter, kind: 'fight' | 'current', now: number): SegmentSummary {
    const total = sumMap(e.agg.out)
    const dur = Math.max(1, (e.lastTs - e.startTs) / 1000)
    const activeSec = Math.min(dur, e.activeMs / 1000)
    return {
      id: e.id,
      kind,
      name: encounterName(e, kind === 'current'),
      // ZONE on the summary (Task #61) — the search haystack is name + zone, so a fight has
      // to carry where it happened. `Encounter.zone` is stamped at ensureEncounter() from
      // `this.zone`, the SAME field finalizeZoneSession() names a zone session from, so the
      // two can never disagree. finalizeCurrent() memoizes this summary, which freezes the
      // zone with it. NOTE on backfill: encounters already finalized in memory before this
      // code existed keep `zone: undefined` and are deliberately NOT backfilled — the engine
      // no longer knows which zone a past fight belonged to, and guessing today's zone would
      // be an invented fact (law 1). A restart replays the whole log through this path and
      // rebuilds every summary WITH its zone, so the gap closes on its own.
      zone: e.zone,
      durationSec: dur,
      total,
      dps: total / dur,
      activeSec,
      activeDps: total / Math.max(1, activeSec),
      startTs: e.startTs,
      active: kind === 'current' && now - e.lastTs < ACTIVE_MS,
      enemyHealTotal: sumHeal(e.agg.enemyHeal)
    }
  }

  private zoneSummary(): SegmentSummary {
    const total = sumMap(this.zoneAgg.out)
    const dur = this.zoneDurationSec()
    const activeSec = Math.min(dur, this.zoneActiveSec())
    return {
      id: 'zone',
      kind: 'zone',
      name: `${this.zone ?? 'Session'} — overall`,
      zone: this.zone,
      durationSec: dur,
      total,
      dps: total / dur,
      activeSec,
      activeDps: total / Math.max(1, activeSec),
      startTs: 0,
      active: false,
      enemyHealTotal: sumHeal(this.zoneAgg.enemyHeal)
    }
  }

  private zoneActiveSec(): number {
    const cur = this.current ? this.current.activeMs : 0
    return (this.zoneActiveMs + cur) / 1000
  }

  private zoneDurationSec(): number {
    const cur = this.current ? this.current.lastTs - this.current.startTs : 0
    return Math.max(1, (this.zoneFinalizedMs + cur) / 1000)
  }

  private buildSelected(id: string, now: number, combinePets: boolean): SegmentView | null {
    if (id === 'zone') {
      const zDur = this.zoneDurationSec()
      return this.buildView('zone', 'zone', `${this.zone ?? 'Session'} — overall`, this.zone, this.zoneAgg, zDur, Math.min(zDur, this.zoneActiveSec()), false, combinePets)
    }
    // A finalized zone SESSION (Task #54): rebuild its full breakdown from the frozen aggregate.
    const zs = this.zoneHistory.find((z) => z.id === id)
    if (zs) {
      const zDur = Math.max(1, zs.finalizedMs / 1000)
      const zActive = Math.min(zDur, zs.activeMs / 1000)
      return this.buildView(zs.id, 'zone', `${zs.zone} — overall`, zs.zone, zs.agg, zDur, zActive, false, combinePets)
    }
    const e = this.current?.id === id ? this.current : this.history.find((h) => h.id === id)
    if (!e) return null
    const dur = Math.max(1, (e.lastTs - e.startTs) / 1000)
    const activeSec = Math.min(dur, e.activeMs / 1000)
    const isCurrent = this.current?.id === id
    const active = isCurrent && now - e.lastTs < ACTIVE_MS
    return this.buildView(e.id, 'fight', encounterName(e, isCurrent), e.zone, e.agg, dur, activeSec, active, combinePets, e)
  }

  /**
   * The per-segment proc ledger (Task #64), built entirely from the frozen aggregate.
   *
   * `enc` is present only for a FIGHT: coats-at-engage and the engage-relative timings are
   * questions about one pull's opening instant, and a zone session (many pulls, many coat
   * swaps) has no such instant. So a zone view reports the counts — procs, poison damage,
   * effects, stance switches — and honestly reports no `slowLandMs` and no `slowExpected`,
   * rather than measuring from an arbitrary zero.
   */
  private buildProcsView(agg: Agg, enc?: Encounter): ProcsView {
    const p = agg.procs
    const byCount = (a: ProcLane, b: ProcLane): number => b.count - a.count || a.name.localeCompare(b.name)
    const strikes: ProcLane[] = [...p.strikes.values()]
      .map((s) => ({ name: s.name, count: s.count, ...(s.ambiguous ? { ambiguous: true } : {}) }))
      .sort(byCount)
    const poisonDamage: ProcLane[] = [...p.poisonDamage.values()]
      .map((s) => ({ name: s.name, count: s.count, total: s.total }))
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0) || a.name.localeCompare(b.name))
    const dispels: ProcLane[] = [...p.dispels.values()]
      .map((s) => ({ name: s.name, count: s.count, ambiguous: true }))
      .sort(byCount)
    const coatAtEngage = enc?.coatAtEngage
    const start = enc?.startTs ?? 0
    return {
      coatAtEngage: coatAtEngage ? { ...coatAtEngage } : undefined,
      combatAtEngage: enc ? enc.combatAtEngage.map((c) => ({ ...c })) : [],
      slowExpected: !!coatAtEngage && isSlowCapable(coatAtEngage.poison),
      coats: enc ? p.coats.map((c) => ({ poison: c.poison, tMs: Math.max(0, c.ts - start) })) : [],
      strikes,
      strikeCount: strikes.reduce((s, l) => s + l.count, 0),
      slowLands: p.slowLands,
      ...(enc && p.firstSlowTs > 0 ? { slowLandMs: Math.max(0, p.firstSlowTs - start) } : {}),
      poisonDamage,
      poisonDamageTotal: poisonDamage.reduce((s, l) => s + (l.total ?? 0), 0),
      dispels,
      dispelCount: dispels.reduce((s, l) => s + l.count, 0),
      stanceSwitches: p.stanceSwitches,
      invocationSwitches: p.invocationSwitches
    }
  }

  private buildView(
    id: string,
    kind: 'fight' | 'zone',
    name: string,
    zone: string | undefined,
    agg: Agg,
    durationSec: number,
    activeSec: number,
    active: boolean,
    combinePets: boolean,
    enc?: Encounter
  ): SegmentView {
    const entities = sourceViews(agg.out, durationSec, combinePets)
    const incoming = sourceViews(agg.inc, durationSec, false)
    const outTotal = entities.reduce((s, e) => s + e.total, 0)
    const inTotal = incoming.reduce((s, e) => s + e.total, 0)
    const incomingHealers: HealerView[] = [...agg.incHeal.values()]
      .map((h) => ({ name: h.name, total: h.amount, count: h.count }))
      .sort((a, b) => b.total - a.total)
    return {
      id,
      kind,
      name,
      zone,
      durationSec,
      active,
      activeSec,
      outTotal,
      outDps: outTotal / durationSec,
      activeDps: outTotal / Math.max(1, activeSec),
      entities,
      inTotal,
      inDps: inTotal / durationSec,
      incoming,
      enemyHealTotal: sumHeal(agg.enemyHeal),
      incomingHealTotal: incomingHealers.reduce((s, h) => s + h.total, 0),
      incomingHealers,
      healing: buildHealingView(agg.heal, durationSec),
      procs: this.buildProcsView(agg, enc)
    }
  }
}

function sumHeal(m: Map<string, { amount: number }>): number {
  let t = 0
  for (const v of m.values()) t += v.amount
  return t
}

function sumMap(m: Map<string, SourceStat>): number {
  let t = 0
  for (const s of m.values()) t += s.total
  return t
}

/**
 * The name of an encounter (Task #54). Two modes:
 *   - `live=false` (FINALIZED / any non-current view): named after the LARGEST target —
 *     the mob that absorbed the most damage. The log has no HP, so "most damage absorbed"
 *     is a LABELED proxy for "the thing we were killing" (AGENTS.md world-model law 6).
 *   - `live=true` (the CURRENT open fight): named after whatever you're presently swinging
 *     at (the most-recent outgoing target), so a live pull is labeled by the mob in front of
 *     you, not retroactively by whichever twin ended up taking the most damage.
 * Both keep the '+N others' suffix counting the OTHER distinct engaged targets.
 */
function encounterName(e: Encounter, live = false): string {
  const targets = [...e.agg.targets.values()]
  if (targets.length === 0) return 'Combat'
  const others = targets.length - 1
  const suffix = others > 0 ? ` +${others}` : ''
  if (live && e.lastOutTarget) return `${e.lastOutTarget}${suffix}`
  const top = [...targets].sort((a, b) => b.amount - a.amount)[0].name
  return `${top}${suffix}`
}

function sourceViews(map: Map<string, SourceStat>, durationSec: number, combinePets: boolean): SourceView[] {
  const merged = new Map<string, SourceStat>()
  for (const [id, s] of map) {
    if (combinePets && s.kind === 'pet') {
      const you = merged.get('you') ?? newSource('You +pets', 'you')
      you.name = 'You +pets'
      you.total += s.total
      you.hits += s.hits
      you.crits += s.crits
      you.ambiguousHits += s.ambiguousHits
      you.ambiguousTotal += s.ambiguousTotal
      you.misses += s.misses
      you.resists += s.resists
      for (const k of MISS_KEYS) you.miss[k] += s.miss[k]
      for (const [k, sk] of s.bySkill) {
        const key = `${s.name}: ${k}`
        const prev = you.bySkill.get(key)
        if (prev) {
          prev.total += sk.total
          prev.hits += sk.hits
          prev.crits += sk.crits
          prev.misses += sk.misses
          prev.resists += sk.resists
          prev.max = Math.max(prev.max, sk.max)
          prev.min = mergeMin(prev.min, sk.min)
        } else {
          you.bySkill.set(key, { ...sk, name: key })
        }
      }
      // Merge category rollups too (namespacing the per-category skill by the pet name,
      // matching the top-level bySkill merge above) so drill-down still works combined.
      for (const [cat, cstat] of s.byCategory) {
        const yc = you.byCategory.get(cat) ?? newCategory(cat)
        yc.total += cstat.total
        yc.hits += cstat.hits
        yc.crits += cstat.crits
        yc.resists += cstat.resists
        yc.max = Math.max(yc.max, cstat.max)
        for (const [k, sk] of cstat.bySkill) {
          const key = `${s.name}: ${k}`
          const prev = yc.bySkill.get(key)
          if (prev) {
            prev.total += sk.total
            prev.hits += sk.hits
            prev.crits += sk.crits
            prev.resists += sk.resists
            prev.max = Math.max(prev.max, sk.max)
            prev.min = mergeMin(prev.min, sk.min)
          } else {
            yc.bySkill.set(key, { ...sk, name: key })
          }
        }
        you.byCategory.set(cat, yc)
      }
      // Merge rounds buckets (union of both sources' second-buckets — keeps the
      // per-second hit clustering coherent when pets fold into You).
      for (const [bk, cnt] of s.rounds.bucket) {
        you.rounds.bucket.set(bk, (you.rounds.bucket.get(bk) ?? 0) + cnt)
      }
      merged.set('you', you)
    } else {
      merged.set(id, s)
    }
  }
  const list = [...merged.entries()]
  const maxTotal = Math.max(1, ...list.map(([, s]) => s.total))
  return list
    .map(([id, s]) => {
      const skMax = Math.max(1, ...[...s.bySkill.values()].map((k) => k.total))
      const swings = s.hits + s.misses
      // Resist rate is over CAST attempts of detrimental spells: landed spell/dot hits +
      // resists. Melee/slay/ds hits can't be resisted, so they're excluded from the base.
      const spellHits = (s.byCategory.get('spell')?.hits ?? 0) + (s.byCategory.get('dot')?.hits ?? 0)
      const casts = spellHits + s.resists
      return {
        id,
        name: s.name,
        kind: s.kind,
        total: s.total,
        dps: s.total / durationSec,
        pct: (s.total / maxTotal) * 100,
        hits: s.hits,
        crits: s.crits,
        critPct: s.hits ? (s.crits / s.hits) * 100 : 0,
        ambiguousHits: s.ambiguousHits,
        ambiguousTotal: s.ambiguousTotal,
        misses: s.misses,
        hitPct: swings ? (s.hits / swings) * 100 : 100,
        missBreakdown: { ...s.miss },
        resists: s.resists,
        resistPct: casts ? (s.resists / casts) * 100 : 0,
        skills: [...s.bySkill.values()]
          .sort((a, b) => b.total - a.total)
          .slice(0, 12)
          .map(skillView(skMax)),
        categories: categoryViews(s.byCategory),
        rounds: roundsView(s.rounds)
      }
    })
    .sort((a, b) => b.total - a.total)
}

/**
 * Build the per-category drill-down views (Task #51 level 2 + 3) for a source. Ordered
 * by CATEGORY_ORDER (stable UI ordering: melee, slay, spell, dot, ds); each carries its
 * own per-skill breakdown capped at 12 (same cap as the top-level skills — small payload).
 */
/** Build a SkillView mapper closed over the category/source's max-total (for the bar pct).
 *  `misses` is always emitted (unchanged from pre-#51v2); `resists` and `min` are additive
 *  and only present when they mean something (a non-zero resist count / at least one landed
 *  hit), so damage-only and resist-only skill rows keep their exact prior shape. */
function skillView(skMax: number): (k: SkillStat) => SkillView {
  return (k) => ({
    name: k.name,
    total: k.total,
    pct: (k.total / skMax) * 100,
    hits: k.hits,
    crits: k.crits,
    max: k.max,
    // min is meaningful only over LANDED hits: a lane that only ever missed/resisted has no
    // smallest hit to report, and emitting 0 would read as "landed a 0-damage hit".
    ...(k.hits > 0 ? { min: k.min } : {}),
    misses: k.misses,
    ...(k.resists ? { resists: k.resists } : {})
  })
}

function categoryViews(byCat: Map<DamageCategory, CategoryStat>): CategoryView[] {
  const catMax = Math.max(1, ...[...byCat.values()].map((c) => c.total))
  return [...byCat.values()]
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
    .map((c) => {
      const skMax = Math.max(1, ...[...c.bySkill.values()].map((k) => k.total))
      const casts = c.hits + c.resists
      return {
        category: c.category,
        total: c.total,
        pct: (c.total / catMax) * 100,
        hits: c.hits,
        crits: c.crits,
        critPct: c.hits ? (c.crits / c.hits) * 100 : 0,
        max: c.max,
        resists: c.resists,
        resistPct: casts ? (c.resists / casts) * 100 : 0,
        skills: [...c.bySkill.values()]
          .sort((a, b) => b.total - a.total)
          .slice(0, 12)
          .map(skillView(skMax))
      }
    })
}

/**
 * Build the melee-rounds heuristic view (Task #51). Collapses the (skill, second)
 * buckets into a hits-per-round histogram and summary. HONEST framing: the log never
 * records double/triple attack, so this counts hits landed in the same second — a
 * cluster proxy, exposed as a distribution, not a fabricated multi-attack certainty.
 */
function roundsView(r: RoundsAccum): RoundsView | undefined {
  const hist = finalizeRounds(r)
  const totalRounds = hist.reduce((s, n) => s + n, 0)
  if (totalRounds === 0) return undefined
  const totalHits = hist.reduce((s, n, i) => s + n * (i + 1), 0)
  const maxHits = hist.length
  const multi = hist.reduce((s, n, i) => (i >= 1 ? s + n : s), 0) // rounds with 2+ hits
  return {
    totalRounds,
    avgHitsPerRound: totalHits / totalRounds,
    maxHitsInRound: maxHits,
    multiHitRounds: multi,
    // histogram[k-1] = rounds that landed exactly k hits.
    histogram: hist
  }
}

const MISS_KEYS: MissType[] = ['miss', 'dodge', 'parry', 'riposte', 'block', 'absorb']
