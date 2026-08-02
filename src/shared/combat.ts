// Public combat model shared between the engine (main) and the UI (renderer).
// All types here are plain/serializable so snapshots can cross the IPC boundary.

export type SourceKind = 'you' | 'pet' | 'enemy'
export type DamageType = 'melee' | 'spell' | 'dot' | 'ds'

/**
 * Damage TAXONOMY category (Task #51), a superset dimension over DamageType: the
 * Slay Undead melee proc is split into its own 'slay' category per the user; every
 * other dtype maps 1:1. Computed at parse time (src/main/combat/taxonomy.ts) and
 * rolled into per-source category aggregates by the engine for the drill-down UI.
 */
export type DamageCategory = 'melee' | 'slay' | 'spell' | 'dot' | 'ds'

/** Display label + fixed ordering for each taxonomy category (UI + tests). */
export const CATEGORY_LABEL: Record<DamageCategory, string> = {
  melee: 'Melee',
  slay: 'Slay Undead',
  spell: 'Direct spells',
  dot: 'DoTs',
  ds: 'Damage shield'
}
export const CATEGORY_ORDER: DamageCategory[] = ['melee', 'slay', 'spell', 'dot', 'ds']

export interface SkillView {
  name: string
  total: number
  pct: number
  hits: number
  crits: number
  max: number
  /** Avoided swings for this skill (miss/dodge/parry/riposte/block/absorb). */
  misses?: number
  /** Spell resists for this spell/dot lane (Task #51 v2). resist rate = resists/(hits+resists). */
  resists?: number
}

/** Breakdown of avoided swings by outcome (for hit% + defensive tooltip). */
export interface MissBreakdown {
  miss: number
  dodge: number
  parry: number
  riposte: number
  block: number
  absorb: number
}

/** A taxonomy-category rollup within a source (Task #51 drill-down level 2). Carries
 *  its own per-skill/per-spell breakdown (level 3). */
export interface CategoryView {
  category: DamageCategory
  total: number
  /** pct of the source's largest category (for the level-2 bar fill). */
  pct: number
  hits: number
  crits: number
  critPct: number
  max: number
  /** Spell resists within this category (spell/dot only; Task #51 v2). 0 for melee/slay/ds. */
  resists: number
  /** resists / (hits + resists) as a percentage; 0 when nothing was cast. */
  resistPct: number
  /** per-skill/per-spell breakdown within this category (capped at 12). */
  skills: SkillView[]
}

/**
 * The melee-"rounds" heuristic (Task #51). The log does NOT record double/triple
 * attack, so a "round" is the HONEST proxy: a source's melee/slay hits sharing the same
 * whole second (and skill). This is a cluster distribution, NOT a fabricated multi-attack
 * flag; main-hand vs off-hand is also not distinguishable in the log. Present only for
 * sources that landed melee/slay hits.
 */
export interface RoundsView {
  /** number of (skill, second) buckets observed. */
  totalRounds: number
  avgHitsPerRound: number
  maxHitsInRound: number
  /** rounds that landed 2+ hits in the same second (multi-attack candidates). */
  multiHitRounds: number
  /** histogram[k-1] = count of rounds that landed exactly k hits. */
  histogram: number[]
}

export interface SourceView {
  id: string
  name: string
  kind: SourceKind
  total: number
  dps: number
  pct: number
  hits: number
  crits: number
  critPct: number
  /** Hits attributed to this pet that were name-ambiguous (charmed twin vs its
   *  same-named hostile twin). Surfaced as a "~" badge in the UI. */
  ambiguousHits: number
  /** Damage total from those ambiguous hits. */
  ambiguousTotal: number
  /** Avoided swings attributed to this source (all outcomes). */
  misses: number
  /** hits / (hits + misses) as a percentage; 100 when no swings avoided. */
  hitPct: number
  /** Avoided-swing breakdown by outcome (for tooltip / expanded row). */
  missBreakdown: MissBreakdown
  /** Total spell resists against this source's detrimental spells (Task #51 v2). */
  resists: number
  /** resists / (spell+dot hits + resists) as a percentage; 0 when no spells cast. */
  resistPct: number
  skills: SkillView[]
  /** Per-category rollup (Task #51 drill-down level 2 → 3). Ordered by CATEGORY_ORDER. */
  categories: CategoryView[]
  /** Melee-rounds heuristic (Task #51); undefined for sources with no melee/slay hits. */
  rounds?: RoundsView
}

export interface SegmentView {
  id: string
  kind: 'fight' | 'zone'
  name: string
  zone?: string
  durationSec: number
  active: boolean
  /** Sum of active combat time (gaps between consecutive attributed damage hits
   *  capped at 3s each — standard meter convention), in seconds. ≤ durationSec. */
  activeSec: number
  outTotal: number
  outDps: number
  /** Outgoing damage ÷ activeSec — DPS while actually swinging (excludes idle gaps). */
  activeDps: number
  entities: SourceView[]
  inTotal: number
  inDps: number
  incoming: SourceView[]
  /** Total healing received by engaged HOSTILE instances in this segment
   *  (self-heals + heals cast on them) — "effective DPS" context. */
  enemyHealTotal: number
  /** Total healing received by You (and your pets) in this segment. */
  incomingHealTotal: number
  /** Top healers of You/your pets, sorted desc by amount. */
  incomingHealers: HealerView[]
}

/** A source of incoming healing (to You / your pet), for the incoming section. */
export interface HealerView {
  name: string
  total: number
  count: number
}

export interface SegmentSummary {
  id: string
  kind: 'fight' | 'zone' | 'current'
  name: string
  durationSec: number
  total: number
  dps: number
  /** Active combat time (capped-gap sum) in seconds; ≤ durationSec. */
  activeSec: number
  /** total ÷ activeSec — active-time DPS. */
  activeDps: number
  startTs: number
  active: boolean
  /** Healing received by hostile instances during this segment (annotation). */
  enemyHealTotal: number
}

/** One line as the engine classified it, for the live processing log. */
export interface ClassifiedLine {
  ts: number
  /** melee | spell | dot | ds | charm | pet | uncharm | death | zone | unparsed
   *  ('charm' = a `<mob> has been charmed.` line; 'pet' = a SUMMONED pet's
   *  owner-only "… Master." claim tell — the two are never conflated). */
  cat: string
  /** who it was attributed to */
  role: 'you' | 'pet' | 'enemy' | 'info' | 'dropped'
  text: string
}

/** The player's current combat-modifier pair (Task #51). Two mutually-exclusive groups
 *  the parser tracks: a melee/general STANCE and a caster INVOCATION. Either may be
 *  undefined if never observed this session. Shown as two chips near the meter header. */
export interface StanceState {
  /** current stance name (lowercased canonical), or undefined if none seen yet. */
  stance?: string
  /** ts of the last stance change. */
  stanceTs?: number
  /** current invocation name, or undefined. */
  invocation?: string
  /** ts of the last invocation change. */
  invocationTs?: number
}

/**
 * One event on the selected-encounter TIMELINE (Task #51). A timestamped, categorized
 * instant used to render the WarcraftLogs-style timeline (skills on the Y axis, time on
 * X). Kept small + capped (the engine downsamples an encounter's ring when it exceeds a
 * budget). `t` is ms since the encounter start (so the renderer needn't know absolute ts).
 */
export interface TimelineEvent {
  /** ms since encounter start. */
  t: number
  /** row label = the skill/spell/element name (the Y-axis lane). */
  lane: string
  /** taxonomy category (drives color + which section the lane sorts into). */
  category: DamageCategory
  /** damage amount (0 for a miss/resist tick). */
  amount: number
  /** true when this instant was a crit. */
  crit: boolean
  /** parsed modifiers (Riposte/Finishing Blow/…) for the tooltip. */
  modifiers?: string[]
  /** 'you' | 'pet' | 'enemy' — who produced it (color/opacity hint). */
  kind: SourceKind
  /**
   * Event flavor (Task #51 v2). 'hit' = landed damage (default). 'miss' = an avoided
   * melee swing (dodge/parry/riposte/block/absorb/miss). 'resist' = a fully-resisted
   * spell. Miss/resist ticks render as hollow/red-tinted marks in the ability's lane.
   */
  outcome?: 'hit' | 'miss' | 'resist'
  /** the specific miss outcome (dodge/parry/…) or resist detail, for the tooltip. */
  detail?: string
  /** the target / defender name, for the tooltip. */
  target?: string
}

/** A span during which a stance/invocation was active (Task #51 timeline pinned rows). */
export interface StanceSpan {
  /** 'stance' | 'invocation' — which pinned lane. */
  group: 'stance' | 'invocation'
  /** the stance/invocation name. */
  name: string
  /** ms since encounter start when it became active (clamped to ≥0). */
  start: number
  /** ms since encounter start when it ended (the encounter end if still active). */
  end: number
}

/**
 * The selected encounter's event timeline (Task #51). Returned only when
 * SnapshotOpts.timeline is set (payload is heavier than the bar view). Capped +
 * downsampled per the engine's budget; `downsampled` flags when events were dropped.
 */
export interface TimelineView {
  /** the encounter id this timeline is for. */
  id: string
  name: string
  /** encounter duration in ms (X-axis extent). */
  durationMs: number
  /** ordered lane labels (Y axis), grouped by category then by total desc. */
  lanes: Array<{ lane: string; category: DamageCategory; total: number; kind: SourceKind }>
  /** timestamped instants (relative ms). */
  events: TimelineEvent[]
  /** pinned stance/invocation spans (rendered above the skill lanes). */
  stanceSpans: StanceSpan[]
  /** true when the raw event count exceeded the budget and was downsampled. */
  downsampled: boolean
  /** raw event count before any downsampling (for the "showing N of M" note). */
  rawCount: number
}

/**
 * One finalized-or-live ZONE SESSION (Task #54). Instead of discarding the zone aggregate on
 * every zone change, the engine FINALIZES it into a capped history so you can re-select a past
 * zone's overall meter. The live zone session is always index 0 (id 'zone'); finalized ones get
 * stable ids ('zs<n>'). Carries just the summary fields the selector needs; the full breakdown
 * is rebuilt on demand via buildSelected(id).
 */
export interface ZoneSessionSummary {
  /** 'zone' for the live session, else 'zs<n>' for a finalized one. */
  id: string
  /** zone display name (raw). */
  zone: string
  /** epoch ms of the first attributed damage in this zone session (0 if none / live-unstarted). */
  startTs: number
  /** epoch ms of the last attributed damage; 0 for the still-live session. */
  endTs: number
  /** total outgoing damage this zone session. */
  total: number
  /** wall-clock DPS over the session's combat span. */
  dps: number
  /** true for the currently-active (live) zone session. */
  live: boolean
}

export interface CombatSnapshot {
  selectedId: string
  selected: SegmentView | null
  segments: SegmentSummary[]
  inCombat: boolean
  zone?: string
  // NOTE: there is deliberately NO pet/charm roster here. The engine's pet-name set is an
  // ATTRIBUTION set (charmed AND summoned pets both attribute as "your pet"), so exposing it
  // as "charmed" mislabelled every summoned class pet. Pets are already visible where they
  // matter — as `kind: 'pet'` source rows on the meter. If a genuinely-charmed roster is ever
  // needed, derive it from the world model (Instance.petKind === 'charmed'), never from the
  // attribution set.
  /** recent classified lines, oldest→newest */
  recent: ClassifiedLine[]
  /** current stance + invocation pair (Task #51). */
  stance: StanceState
  /** the selected encounter's timeline — present only when SnapshotOpts.timeline is set. */
  timeline?: TimelineView | null
  /** zone-session list (Task #54): the live zone + capped finalized-zone history, newest-first
   *  after the live one. Drives the ZONE selector in the main view + the 'overall' overlay. */
  zoneSessions: ZoneSessionSummary[]
}

export interface SnapshotOpts {
  combinePets?: boolean
  selectedId?: string
  /** include lines the engine couldn't classify (damage-shaped but unmatched) */
  showUnparsed?: boolean
  /**
   * Cap on how many finalized-fight summaries to serialize (newest-first). The
   * current encounter and the zone summary are ALWAYS included regardless of the
   * cap. Defaults to 100. A selected finalized fight outside the cap window is
   * still fully resolvable via `selected` (built separately). Raise to load more.
   */
  maxSegments?: number
  /**
   * When true (Task #51), include the SELECTED encounter's event timeline in the
   * snapshot (`timeline`). Off by default — the timeline payload is heavier than the bar
   * view, so it's only fetched when the CombatView is in Timeline mode. Only the current
   * live encounter and finalized encounters within the engine's per-encounter event ring
   * carry a timeline; older/evicted encounters return `timeline:null`.
   */
  timeline?: boolean
}
