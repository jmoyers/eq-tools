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
  skills: SkillView[]
}

export interface SegmentView {
  id: string
  kind: 'fight' | 'zone'
  name: string
  zone?: string
  durationSec: number
  active: boolean
  outTotal: number
  outDps: number
  entities: SourceView[]
  inTotal: number
  inDps: number
  incoming: SourceView[]
}

export interface SegmentSummary {
  id: string
  kind: 'fight' | 'zone' | 'current'
  name: string
  durationSec: number
  total: number
  dps: number
  startTs: number
  active: boolean
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
}
