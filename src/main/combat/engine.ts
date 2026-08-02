// The combat engine: a formal state machine over the log stream.
//
// State it maintains:
//   charmed:  Set<mobName>        — your active charmed pets (name-keyed)
//   zone:     string              — current zone (resets the overall aggregate)
//   current:  Encounter | null    — the in-progress/most-recent fight
//   history:  Encounter[]         — finalized fights
//   zoneAgg:  Agg                 — damage aggregated for the whole zone
//
// Transitions (one per ingested line):
//   zone   → finalize current, reset zoneAgg
//   charm  → charmed.add(mob)     (message only the charmer sees ⇒ it's yours)
//   uncharm/death(charm spell/mob death) → charmed.delete(mob)
//   cc     → mark the mob's instance engaged + CC-held (mez/root keep-alive)
//   damage → route to current encounter + zoneAgg (see route())
//
// Attribution rule (damage `A → B` for N):
//   A = You            → your outgoing
//   A ∈ charmed        → your pet's outgoing (unless B is friendly)
//   B = You            → incoming
//   otherwise          → not your fight (ignored)
//
// Encounter segmentation (Task #20 — death-closed, replacing the old idle-gap
// rule). A fight CLOSES when either:
//   - every engaged hostile instance is retired (dead/zoned) AND LINGER_MS passes
//     with no new attributed damage → crisp pull boundaries from the death timeline;
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
import type { LogEvent, MissType } from '../../shared/logEvents'
import type { DamageCategory, DamageType } from '../../shared/combat'
import { CATEGORY_ORDER } from '../../shared/combat'
import type {
  CategoryView,
  ClassifiedLine,
  CombatSnapshot,
  HealerView,
  MissBreakdown,
  RoundsView,
  SegmentSummary,
  SegmentView,
  SnapshotOpts,
  SourceKind,
  SourceView,
  StanceSpan,
  StanceState,
  TimelineEvent,
  TimelineView
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
  misses: number
}

/** Per-category rollup within a source (Task #51 drill-down level 2). Holds the
 *  category total + its own per-skill/per-spell breakdown (level 3). */
interface CategoryStat {
  category: DamageCategory
  total: number
  hits: number
  crits: number
  max: number
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
  bySkill: Map<string, SkillStat>
  /** Per-category rollup (Task #51 drill-down level 2 + 3). */
  byCategory: Map<DamageCategory, CategoryStat>
  /** Melee-rounds heuristic accumulator (Task #51). */
  rounds: RoundsAccum
}

function newSkill(name: string): SkillStat {
  return { name, total: 0, hits: 0, crits: 0, max: 0, misses: 0 }
}

function newCategory(category: DamageCategory): CategoryStat {
  return { category, total: 0, hits: 0, crits: 0, max: 0, bySkill: new Map() }
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

function newSource(name: string, kind: SourceKind): SourceStat {
  return {
    name, kind, total: 0, hits: 0, crits: 0, ambiguousHits: 0, ambiguousTotal: 0,
    misses: 0, miss: newMissBreakdown(), bySkill: new Map(), byCategory: new Map(), rounds: newRounds()
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

interface Encounter {
  id: string
  zone?: string
  startTs: number
  lastTs: number
  agg: Agg
  engaged: Set<string>
  /** instanceId → ts it was last involved in attributed damage (as our target or as
   *  an incoming attacker). Drives the "gone" staleness in death-close: a hostile
   *  that stopped being fought and never got a death line is treated as gone once it
   *  has been idle for LINGER_MS, so a pull that ends with a mob fleeing still closes
   *  crisply instead of waiting out the 60s fallback. */
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
  /** Stance/invocation spans that overlapped this encounter (Task #51 pinned rows).
   *  Recorded as they change while the encounter is open (absolute ts). */
  stanceSpans: StanceRaw[]
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
}

/** Internal raw stance/invocation span (absolute ts). `end` is undefined while active. */
interface StanceRaw {
  group: 'stance' | 'invocation'
  name: string
  start: number
  end?: number
}

// Encounter closure (Task #20 — death-closed segmentation, replacing the old
// SEGMENT_GAP_MS idle rule):
//   LINGER_MS   — after every engaged hostile instance is retired (dead/zoned),
//                 wait this long with no new attributed damage before finalizing at
//                 the last damage ts. Crisp pull boundaries come from the death
//                 timeline; the linger absorbs the trailing DoT tick / cleanup swing.
//   FALLBACK_IDLE_MS — if there's no attributed damage AND no CC event for this long
//                 while instances remain engaged-but-not-retired (mob fled/deagroed,
//                 the log never reports a death), close anyway.
//   ACTIVE_MS   — per-hit active-time cap AND the "in combat" freshness window.
const LINGER_MS = 5_000
const FALLBACK_IDLE_MS = 60_000
// How long a single CC application/refresh keeps an instance "held" (alive for
// closure) without further evidence. A live mez is re-applied well within this, and
// resumed damage refreshes activity; this is only the backstop expiry for a CC that
// is never refreshed and never followed by damage (so a lone mez can't pin a fight
// open forever). It exceeds FALLBACK_IDLE_MS so an actively-refreshed mez holds.
const CC_HOLD_MS = 120_000
const ACTIVE_MS = 3_000
const RECENT_CAP = 300

// Timeline (Task #51):
//   TIMELINE_CAP          — per-encounter event ring size (drop-oldest). 5k covers a very
//                           long fight; measured RSS impact on a full-log replay is small
//                           (see AGENTS.md perf numbers) because only recent encounters
//                           retain their ring.
//   TIMELINE_HISTORY_CAP  — how many finalized encounters keep their event ring after
//                           finalize. Older ones drop the ring (timeline only for recent /
//                           live fights) so the whole-session RSS delta stays bounded.
//   TIMELINE_BUDGET       — max events serialized into a single TimelineView; above this
//                           the engine downsamples (uniform stride) and flags it.
const TIMELINE_CAP = 5_000
const TIMELINE_HISTORY_CAP = 60
const TIMELINE_BUDGET = 2_000

/** How a damage event `A → B` is attributed given the charmed set. */
export type Attribution =
  | { kind: 'out-you' }
  | { kind: 'out-pet'; petKey: string; petName: string; ambiguous: boolean }
  | { kind: 'incoming' }
  | { kind: 'ignore' }

/**
 * Pure attribution decision — the whole point is same-name twin handling.
 * `charmed` is a Set of canonical (lowercased) keys.
 *
 * Rules (decided with the user):
 *   You → charmed-name : ALWAYS outgoing to a hostile twin (never dropped as FF).
 *   charmed-name → You : ALWAYS incoming.
 *   charmed-name → same-name (A==B, charmed) : pet outgoing, but AMBIGUOUS
 *     (could be your pet hitting a hostile twin, or a hostile twin hitting your
 *      pet) — attribute to the pet and flag it.
 *   charmed-name → other : pet outgoing (existing rule).
 *   You → other : outgoing.  other → You : incoming.  else ignore.
 */
export function classify(ev: DamageEvent, charmed: ReadonlySet<string>): Attribution {
  const aKey = idKey(ev.attacker)
  const bKey = idKey(ev.target)
  const aYou = aKey === 'you'
  const bYou = bKey === 'you'
  const aPet = !aYou && charmed.has(aKey)
  const bPet = !bYou && charmed.has(bKey)

  if (aYou) {
    // You → anything (including a charmed name = a hostile twin) is outgoing.
    return bYou ? { kind: 'ignore' } : { kind: 'out-you' }
  }
  if (aPet) {
    // Charmed pet is the attacker.
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
  /** Canonical charmed name keys — kept in lockstep with the WorldModel's charmed
   *  instances so the pure classify() (which only needs name membership) is
   *  unchanged. The world model owns instance identity; this is a fast lookup. */
  private charmed = new Set<string>()
  private world = new WorldModel()
  /** The player's own proper name key (e.g. "primitive"). Normally INJECTED by
   *  index.ts via setPlayerName() (it knows the character from the tail ref). As a
   *  cheap fallback (guards a mis-parsed injected name) it can also be LEARNED from
   *  heal lines: EQ writes self-heals as "You healed <PlayerName> for N", so a heal
   *  whose healer is You and whose target is neither a charmed pet nor an engaged
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
  private recent: ClassifiedLine[] = []
  private recording = false
  /** ts of the last encounter-relevant activity (attributed damage OR a CC event).
   *  Drives the FALLBACK_IDLE_MS closure independent of the damage timeline. */
  private lastActivityTs = 0
  /** Current combat-modifier pair (Task #51): the last stance/invocation the player
   *  committed to, with the ts of that change. Session-scoped (survives zones/epoch —
   *  a stance is not tied to a zone); reset() clears it. Exposed in the snapshot and
   *  used to open/close timeline stance spans on the current encounter. */
  private stance?: { name: string; ts: number }
  private invocation?: { name: string; ts: number }

  /** Enable classification logging (after the historical scan, for the live tail). */
  setLive(): void {
    this.recording = true
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
    this.charmed.clear()
    this.world.reset()
    this.playerKey = undefined
    this.playerKeyInjected = false
    this.zone = undefined
    this.current = null
    this.history = []
    this.zoneAgg = new Agg()
    this.zoneFinalizedMs = 0
    this.zoneActiveMs = 0
    this.recent = []
    this.recording = false
    this.lastActivityTs = 0
    this.stance = undefined
    this.invocation = undefined
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
    if (live) this.recording = true
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
        this.charmed = new Set()
        this.world.reset()
        return
      }
      case 'zone': {
        this.finalizeCurrent()
        this.zone = ev.zone
        this.zoneAgg = new Agg()
        this.zoneFinalizedMs = 0
        this.zoneActiveMs = 0
        // Charm cannot survive a zone transition, and hostile mobs don't follow —
        // both are retired. SUMMONED class pets DO persist across zones (real-log
        // verified), so world.zone() returns the survivors and we rebuild the fast
        // charmed name-set from them (dropping stale charmed/hostile names).
        const survivors = this.world.zone(ev.ts)
        this.charmed = new Set(survivors.map((i) => i.nameKey))
        this.log(ev.ts, 'zone', 'info', `▸ entered ${ev.zone}`)
        return
      }
      case 'charm': {
        const inst = this.world.charm(ev.mob, ev.ts)
        this.charmed.add(idKey(ev.mob))
        this.log(ev.ts, 'charm', 'info', `⚡ charmed ${this.world.label(inst)} [${inst.instanceId}]`)
        return
      }
      case 'petClaim': {
        // A pet addressed you as master → the named entity is your pet. Bind it as
        // a summoned pet (idempotent; charmed pets that also tell you this stay
        // charmed). This is the ONLY binding signal for random-named class pets.
        const inst = this.world.claim(ev.name, ev.ts)
        this.charmed.add(idKey(ev.name))
        this.log(ev.ts, 'charm', 'info', `⚡ pet claim ${this.world.label(inst)} [${inst.instanceId}]`)
        return
      }
      case 'uncharm': {
        this.world.uncharm(ev.mob, ev.ts)
        this.charmed.delete(idKey(ev.mob))
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
        // Keep the fast charmed-name set in lockstep: only drop the name from the
        // set when NO charmed instance of it remains live.
        if (!this.world.petInstance(ev.name)) this.charmed.delete(key)
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
        this.routeHeal(ev.ts, ev.healer ?? null, ev.target, ev.amount, ev.spell)
        this.log(ev.ts, 'heal', 'info', `+ ${ev.healer ?? '?'} → ${ev.target} ${ev.amount}${ev.spell ? ` (${ev.spell})` : ''}`)
        return
      case 'miss':
        this.routeMiss(ev.ts, ev.attacker, ev.target, ev.mtype)
        return
      case 'stanceChange':
        this.applyStance('stance', ev.stance, ev.ts)
        this.log(ev.ts, 'stance', 'info', `▸ stance: ${ev.stance}`)
        return
      case 'invocationChange':
        this.applyStance('invocation', ev.invocation, ev.ts)
        this.log(ev.ts, 'invocation', 'info', `▸ invocation: ${ev.invocation}`)
        return
      default:
        return
    }
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
    }
  }

  private route(ev: DamageEvent): void {
    if (ev.amount <= 0) return
    const at = classify(ev, this.charmed)
    if (at.kind === 'ignore') return

    // Twin evidence: You→charmed-name or same-name→same-name proves a hostile twin
    // co-exists with the pet; ensure the world model has a second instance so the
    // pet and the hostile twin resolve to distinct identities.
    if (at.kind === 'out-you' && this.charmed.has(idKey(ev.target))) {
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
      // Resolve the pet to its charmed instance so twin pets are distinct.
      const petInst = this.world.petInstance(ev.attacker) ?? this.world.resolve(ev.attacker, ev.ts, true)
      id = `pet:${petInst.instanceId}`
      name = this.world.label(petInst)
      // The pet is trading blows with its target — record that engagement for the
      // death-disambiguation rule (case 2b).
      this.world.notePetEngagement(ev.attacker, idKey(ev.target))
    }
    const ambiguous = at.kind === 'out-pet' && at.ambiguous
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
    // Timeline: an outgoing instant lanes under the skill/spell name.
    this.pushTimeline(enc, {
      ts: ev.ts, lane: ev.skill, category: ev.category, amount: ev.amount,
      crit: ev.crit, modifiers: ev.modifiers, kind
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
    const at = classify(probe, this.charmed)
    if (at.kind === 'ignore') return
    // A miss doesn't extend or close an encounter (closure is death/CC/fallback
    // driven), but it attaches to the in-progress fight if one is fresh (so hit% is
    // per-fight). Otherwise it still counts toward the zone aggregate.
    const enc = this.current && ts - this.current.lastTs <= FALLBACK_IDLE_MS ? this.current : null

    if (at.kind === 'incoming') {
      const attInst = this.world.resolve(attacker, ts)
      const id = attInst.instanceId
      const name = this.world.label(attInst)
      enc?.agg.addIncMiss(id, name, mtype, 'Melee')
      this.zoneAgg.addIncMiss(id, name, mtype, 'Melee')
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
    this.log(ts, 'miss', kind, `${name} ✕ ${target} (${mtype})`)
  }

  /**
   * Consume a heal. Two things matter for combat stats:
   *   - target is an engaged HOSTILE instance → count as "enemy healing" (it undoes
   *     our damage; effective-DPS context per encounter + zone).
   *   - target is You or one of your pets → count as incoming healing (with top
   *     healers).
   * Other heals (party members, unrelated NPCs) are ignored for aggregation.
   */
  private routeHeal(ts: number, healer: string | null, target: string, amount: number, _spell?: string): void {
    if (amount <= 0) return
    const tKey = idKey(target)
    const healerKey = healer ? idKey(healer) : null
    const isYouTgt = tKey === 'you'
    const isPetTgt = !isYouTgt && this.charmed.has(tKey)
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
      enc?.agg.addIncHeal(hk, healerName, amount)
      this.zoneAgg.addIncHeal(hk, healerName, amount)
      return
    }

    // Heal on a hostile instance we're currently engaged with → enemy healing.
    const inst = this.world.resolve(target, ts)
    const enc = this.current
    if (enc && enc.engaged.has(inst.instanceId)) {
      enc.agg.addEnemyHeal(inst.instanceId, this.world.label(inst), amount)
      this.zoneAgg.addEnemyHeal(inst.instanceId, this.world.label(inst), amount)
    }
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
        ccActiveUntil: new Map(), events: [], stanceSpans: spans
      }
    }
    return this.current
  }

  /** Append one instant to the current encounter's timeline ring (Task #51), capped
   *  drop-oldest at TIMELINE_CAP. Called from route()/routeMiss for attributed events. */
  private pushTimeline(enc: Encounter, rec: TimelineRaw): void {
    enc.events.push(rec)
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
   *  - Death-close: once every engaged hostile instance is retired (dead/zoned) and
   *    LINGER_MS has passed since the last damage, finalize.
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

    // Is every engaged HOSTILE instance gone? A hostile is "gone" if it's retired
    // (dead/zoned) OR it has been idle (no attributed damage involving it) for at
    // least LINGER_MS — a mob the pet stopped fighting that never got a death line
    // (fled/deaggroed) shouldn't pin the pull open past the linger. A live charmed
    // pet is never a mob we're killing, so it's excluded — otherwise the pet (which
    // never dies) would pin every charm-grind encounter open forever. CC'd instances
    // had their unexpired hold checked above.
    let hostiles = 0
    let allGone = true
    for (const id of enc.engaged) {
      if (this.world.isLivePet(id)) continue
      hostiles++
      const seen = enc.engagedSeen.get(id) ?? enc.lastTs
      const gone = this.world.isRetired(id) || now - seen >= LINGER_MS
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

    const defaultId = this.current?.id ?? this.history[this.history.length - 1]?.id ?? 'zone'
    // Validate against ALL encounters, not just the capped segment window — a
    // selected finalized fight outside the cap is still fully resolvable via
    // buildSelected() (it searches this.history directly).
    const selectableId =
      opts.selectedId === 'zone' ||
      this.current?.id === opts.selectedId ||
      this.history.some((h) => h.id === opts.selectedId)
    const selectedId = opts.selectedId && selectableId ? opts.selectedId : defaultId
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
      charmed: [...this.charmed], recent, stance, timeline
    }
  }

  /**
   * Build the selected encounter's timeline view (Task #51). Returns null for the zone
   * selection (no single-fight timeline) or an encounter whose event ring was evicted
   * (older than TIMELINE_HISTORY_CAP). Converts absolute ts → ms-since-start, downsamples
   * with a uniform stride when over TIMELINE_BUDGET, and derives the Y-axis lanes (grouped
   * by category, then total desc) + the pinned stance/invocation spans.
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
        kind: r.kind
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
    return {
      id: e.id,
      name: encounterName(e),
      durationMs,
      lanes,
      events,
      stanceSpans,
      downsampled: stride > 1,
      rawCount
    }
  }

  private encSummary(e: Encounter, kind: 'fight' | 'current', now: number): SegmentSummary {
    const total = sumMap(e.agg.out)
    const dur = Math.max(1, (e.lastTs - e.startTs) / 1000)
    const activeSec = Math.min(dur, e.activeMs / 1000)
    return {
      id: e.id,
      kind,
      name: encounterName(e),
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
    const e = this.current?.id === id ? this.current : this.history.find((h) => h.id === id)
    if (!e) return null
    const dur = Math.max(1, (e.lastTs - e.startTs) / 1000)
    const activeSec = Math.min(dur, e.activeMs / 1000)
    const active = this.current?.id === id && now - e.lastTs < ACTIVE_MS
    return this.buildView(e.id, 'fight', encounterName(e), e.zone, e.agg, dur, activeSec, active, combinePets)
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
    combinePets: boolean
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
      incomingHealers
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

function encounterName(e: Encounter): string {
  const sorted = [...e.agg.targets.values()].sort((a, b) => b.amount - a.amount)
  if (sorted.length === 0) return 'Combat'
  const top = sorted[0].name
  return sorted.length > 1 ? `${top} +${sorted.length - 1}` : top
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
      for (const k of MISS_KEYS) you.miss[k] += s.miss[k]
      for (const [k, sk] of s.bySkill) {
        const key = `${s.name}: ${k}`
        const prev = you.bySkill.get(key)
        if (prev) {
          prev.total += sk.total
          prev.hits += sk.hits
          prev.crits += sk.crits
          prev.misses += sk.misses
          prev.max = Math.max(prev.max, sk.max)
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
        yc.max = Math.max(yc.max, cstat.max)
        for (const [k, sk] of cstat.bySkill) {
          const key = `${s.name}: ${k}`
          const prev = yc.bySkill.get(key)
          if (prev) {
            prev.total += sk.total
            prev.hits += sk.hits
            prev.crits += sk.crits
            prev.max = Math.max(prev.max, sk.max)
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
        skills: [...s.bySkill.values()]
          .sort((a, b) => b.total - a.total)
          .slice(0, 12)
          .map((k) => ({ name: k.name, total: k.total, pct: (k.total / skMax) * 100, hits: k.hits, crits: k.crits, max: k.max, misses: k.misses })),
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
function categoryViews(byCat: Map<DamageCategory, CategoryStat>): CategoryView[] {
  const catMax = Math.max(1, ...[...byCat.values()].map((c) => c.total))
  return [...byCat.values()]
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category))
    .map((c) => {
      const skMax = Math.max(1, ...[...c.bySkill.values()].map((k) => k.total))
      return {
        category: c.category,
        total: c.total,
        pct: (c.total / catMax) * 100,
        hits: c.hits,
        crits: c.crits,
        critPct: c.hits ? (c.crits / c.hits) * 100 : 0,
        max: c.max,
        skills: [...c.bySkill.values()]
          .sort((a, b) => b.total - a.total)
          .slice(0, 12)
          .map((k) => ({ name: k.name, total: k.total, pct: (k.total / skMax) * 100, hits: k.hits, crits: k.crits, max: k.max, misses: k.misses }))
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
