// Public combat model shared between the engine (main) and the UI (renderer).
// All types here are plain/serializable so snapshots can cross the IPC boundary.

export type SourceKind = 'you' | 'pet' | 'enemy'
export type DamageType = 'melee' | 'spell' | 'dot' | 'ds'

export interface SkillView {
  name: string
  total: number
  pct: number
  hits: number
  crits: number
  max: number
  /** Avoided swings for this skill (miss/dodge/parry/riposte/block/absorb). */
  misses?: number
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
  skills: SkillView[]
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
  /** melee | spell | dot | ds | charm | uncharm | death | zone | unparsed */
  cat: string
  /** who it was attributed to */
  role: 'you' | 'pet' | 'enemy' | 'info' | 'dropped'
  text: string
}

export interface CombatSnapshot {
  selectedId: string
  selected: SegmentView | null
  segments: SegmentSummary[]
  inCombat: boolean
  zone?: string
  /** currently-charmed pet names (for visibility) */
  charmed: string[]
  /** recent classified lines, oldest→newest */
  recent: ClassifiedLine[]
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
}
