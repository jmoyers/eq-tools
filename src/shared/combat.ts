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
  /**
   * Smallest LANDED hit amount on this lane. Tracked over damage amounts ONLY — a miss or a
   * resist carries no amount, so an all-avoided lane must never report `min 0`. Absent when
   * the lane never landed a hit (resist-only lanes), and equal to `max` for a single-hit or
   * fixed-damage lane (the UI collapses that case to just the max).
   */
  min?: number
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
  /**
   * The HEALING meter for this segment (Task #59) — the full per-healer / per-spell breakdown
   * plus the absorption lanes, built from the SAME aggregate as the damage bars so the healing
   * overlays inherit fight/zone-session selection for free.
   */
  healing: HealingView
  /**
   * ROGUE-POISON / PROC ledger for this segment (Task #64). Folded on ingest into the same
   * `Agg` the damage bars come from, so it is exact for zone sessions too (no event ring
   * involved) — the timeline MARKERS are the only ring-derived half of this feature, and they
   * are for drawing, never for counting.
   */
  procs: ProcsView
}

// ---------------------------------------------------------------------------
// ROGUE POISONS (Task #64). The catalog + the message tables live in shared/logEvents.ts;
// these are the SHAPES the engine hands the UI.
// ---------------------------------------------------------------------------

/**
 * One counted lane in the Procs tab. `total` is present only for lanes that carry damage
 * (the poison-damage lanes); a proc emote has no amount and must never be given one.
 * `ambiguous` marks a lane whose NAME the log could not pin down — two Strikes share an emote
 * ("screams as poison burns their veins!" is Asp Venom Strike OR Cobra Venom Strike), and a
 * dispel landing is shared across the whole Cancel Magic family. The count is exact either
 * way; only the label is uncertain, and the UI says so with the app's `~` treatment.
 */
export interface ProcLane {
  name: string
  count: number
  total?: number
  ambiguous?: boolean
}

/** One coated poison and when it went on. */
export interface CoatSlot {
  /** DB spell name, or 'unknown' when the line refused to name it. */
  poison: string
  /** epoch ms of the coat line. */
  sinceTs: number
}

/**
 * The player's blade coats (Task #64). TWO slots, because that is what the game has (wiki,
 * Rogue page): combat venoms STACK, utility poisons replace one another. Modeling it as one
 * "current poison" would have made four of the five procs in the user's own log impossible —
 * see the block comment in shared/logEvents.ts.
 */
export interface BladeCoatState {
  /** The ONE active utility poison, if any. */
  utility?: CoatSlot
  /** Active combat venoms, in the order they were coated. */
  combat: CoatSlot[]
}

/**
 * ROLLING TIME-TO-SLOW (Task #64) — "how long does it take to land slow when I have the right
 * poison on".
 *
 * THE DENOMINATOR IS THE WHOLE POINT (law 5). A pull only enters this rollup when a
 * SLOW-CAPABLE utility poison was already coated at the moment the pull opened; those are the
 * only pulls where "time to slow" is a question the game was even being asked. Of those,
 * `landed` are averaged and `noLand` are NOT — a fight that never slowed is reported as its
 * own number, never folded in as a zero (which would drag the mean toward a lie) and never
 * dropped (which would flatter it).
 */
export interface SlowRollup {
  /** Pulls that opened with a slow-capable coat active — the honest denominator. */
  pulls: number
  /** Of those, the ones where a slow actually landed. Only these feed the statistics. */
  landed: number
  /** `pulls - landed`: qualifying pulls that ended with no slow. Reported, never averaged. */
  noLand: number
  /** Mean ms from engage to the FIRST slow landing, over `landed` only. Absent when none. */
  avgMs?: number
  /** Median of the same samples — a single 8-minute grind shouldn't set the headline. */
  medianMs?: number
  minMs?: number
  maxMs?: number
  /** How many recent qualifying pulls the ring keeps; `pulls` saturates here. */
  window: number
}

/** Blade coats + the rolling slow measurement, for the header and the aggregate line. */
export interface PoisonState {
  coat: BladeCoatState
  slow: SlowRollup
}

/**
 * The per-segment proc ledger (Task #64). Everything here is folded on ingest from the
 * authoritative event stream — nothing reads the timeline ring — so a downsampled or
 * truncated fight still reports exact counts.
 */
export interface ProcsView {
  /** The utility coat that was already on when this segment opened. */
  coatAtEngage?: CoatSlot
  /** Combat venoms already on when this segment opened. */
  combatAtEngage: CoatSlot[]
  /** True when `coatAtEngage` grants Weakening Strike — i.e. a slow was actually possible. */
  slowExpected: boolean
  /** Coats applied DURING the segment (yours only), as ms since segment start. */
  coats: { poison: string; tMs: number }[]
  /** Rogue-poison Strike procs that landed, by Strike name. */
  strikes: ProcLane[]
  strikeCount: number
  /** Weakening-Strike landings (the slow) in this segment. */
  slowLands: number
  /**
   * ms from the segment's start to the FIRST slow landing. Absent when none landed — which,
   * combined with `slowExpected`, is the difference between "not landed yet" and "no slow
   * poison was on". The UI must not collapse those two.
   */
  slowLandMs?: number
  /** Outgoing damage lanes whose damage TYPE was poison (`dclass === 'poison'`). */
  poisonDamage: ProcLane[]
  poisonDamageTotal: number
  /**
   * DISPEL LANDINGS on the mobs engaged in this segment, one lane per message tier — the
   * "counts of spells (like the dispel variants and such)" ask. Sourced from the
   * message-driven landing stream (so a lane exists only because the game printed that
   * spell's own landing line) and gated to DISPEL_FAMILY.
   *
   * IT NAMES NO CASTER, and every lane is `ambiguous`: `<mob> feels a bit dispelled.` is the
   * Cancel Magic family's message, available to eleven classes plus NPCs. It is emphatically
   * NOT evidence of your rogue dispel — that proc prints `'s blessings wither!` and lands in
   * `strikes` instead. The UI labels this section accordingly.
   */
  dispels: ProcLane[]
  dispelCount: number
  /** Stance / invocation commits inside this segment. */
  stanceSwitches: number
  invocationSwitches: number
}

/** A source of incoming healing (to You / your pet), for the incoming section. */
export interface HealerView {
  name: string
  total: number
  count: number
}

// ---------------------------------------------------------------------------
// HEALING model (Task #59)
//
// What the log actually supports (verified sweep of eqlog_Primitive_freeport.txt, 2026-08-02):
//   - 16,680 `<healer> healed <target> for N[ (M)] hit points[ by <Spell>].` lines. 16,198 name a
//     spell; the rest are spell-less. 233 additionally carry a trailing `(Critical)`.
//   - The `(M)` form IS the overheal record: M is the RAW heal, N the EFFECTIVE one, and EQ omits
//     the parens whenever nothing was wasted (3,016 paren lines, N < M on every single one). So
//     `overheal = M − N` is DERIVED, never guessed, and it is 0 by construction on a plain line.
//     1,857 of those landed on a full health bar (N = 0) — a fully-wasted cast.
//   - HoTs are NOT distinguishable. There is no `healed over time` / `regeneration` line family
//     anywhere in the log; a regen tick (e.g. Blessing of the Squire, 706 lines of "healed
//     himself for 2") is byte-identical in shape to a direct heal. So this model does NOT split
//     direct vs HoT — it would be an invention (AGENTS.md world-model law 6).
//   - Overheal is only knowable per-line. A healer's `overheal` therefore sums only the ticks
//     whose line carried the raw amount; it is a FLOOR, never a rate over unknown ticks.
// ---------------------------------------------------------------------------

/** Who a heal came from. Deliberately its own union — a healing meter has an ALLY lane that the
 *  damage model's SourceKind ('you'|'pet'|'enemy') has no room for. */
export type HealSourceKind = 'you' | 'pet' | 'other' | 'enemy'

/**
 * What a number in the healing ledger MEANS. Both live in the same ledger, the same ranked drill
 * list and the same total, but they are never the same claim — so every LANE carries this and
 * the UI must label it:
 *   - 'restored' — hit points actually put back on a health bar. A heal line said so.
 *   - 'absorbed' — absorption GRANTED by a rune. Counted as effective sustain on the assumption
 *     that the shield gets consumed; the log records the grant, never the consumption. That
 *     assumption is why this classification exists and why it is never silently merged away.
 * Keeping it on the wire is deliberate: a future UI can split the meter apart again — and a
 * future model could split ABSORPTION ITSELF by source — without any change here.
 */
export type HealClassification = 'restored' | 'absorbed'

/**
 * One lane inside a healer's drill-down — a heal spell, or the absorption lane. They share one
 * FLAT ranked list on purpose: a grouping level (heals here, absorption there) is exactly what
 * hid the flat breakdown in the damage drill-down, so the drill is
 * `Lay on Hands VI · Lay on Hands V · Center · Rune` ranked by amount, with `classification`
 * (not position) telling the two kinds apart.
 */
export interface HealSpellView {
  /** Display spell name, 'Unspecified' when the line named no spell, or 'Rune' for absorption. */
  name: string
  /** Effective healing (what actually landed on a health bar). */
  total: number
  /** pct of the healer's largest spell lane (drives the bar fill). */
  pct: number
  /** Number of heal lines on this lane (HoT ticks included — the log cannot separate them). */
  count: number
  /** Critical heals on this lane. */
  crits: number
  /** Largest single EFFECTIVE heal. */
  max: number
  /** Smallest EFFECTIVE heal. Absent when every tick landed for the same amount. */
  min?: number
  /**
   * Wasted healing summed from the `(M)` lines only: Σ(raw − effective). A plain line contributes
   * 0 because EQ omits the parens exactly when nothing was wasted. A FLOOR, not an estimate.
   */
  overheal: number
  /** Ticks that landed entirely on a full health bar (effective 0). */
  fullOverheal: number
  /** 'restored' on every real heal lane; 'absorbed' on the rune lane. Absorption has no overheal
   *  by construction — a rune that is never consumed simply expires, and the log does not say. */
  classification: HealClassification
}

/**
 * One healer row on the meter (level 1), with its flat lane breakdown (level 2).
 *
 * A row can be MIXED (the self row carries both your heals and your rune absorption), so the row
 * has no single classification — it has a split total instead. Its other headline stats (count,
 * crits, max, min, overheal, overhealPct) describe RESTORED healing ONLY: folding rune grants
 * into "6 heals · max 428" would be an aggregate that lies (AGENTS.md law 5).
 */
export interface HealSourceView {
  /** Stable row id: 'you' | 'heal:<healerKey>'. */
  id: string
  name: string
  kind: HealSourceKind
  /** The row's ranking figure: restored healing + granted absorption. */
  total: number
  /** How much of `total` is absorption (0 on a pure healer). `total − absorbedTotal` is the
   *  restored half. Never fabricated: only rune grants have amounts. */
  absorbedTotal: number
  /** total ÷ segment duration — sustain per second. */
  hps: number
  /** pct of the largest row's total (bar fill). */
  pct: number
  /** Heal LINES only — a rune grant is not a heal and is never counted here. */
  count: number
  crits: number
  critPct: number
  /** Largest / smallest single EFFECTIVE heal. Absorption never enters these. */
  max: number
  min?: number
  overheal: number
  /** overheal ÷ (restored + overheal) as a percentage — absorption is deliberately NOT in the
   *  denominator, which would silently deflate a healer's overheal rate. */
  overhealPct: number
  fullOverheal: number
  /** ONE flat list, ranked by amount desc: heal lanes and the absorption lane together. */
  spells: HealSpellView[]
}

/**
 * The RAW absorption counters, kept intact as their own object even though the rune lane is now
 * also folded into the healing ledger as an 'absorbed' drill lane. This is the un-aggregated
 * truth — a future UI can split absorption back out with no model change — and it is the ONLY
 * home of the two count-only families, which have no amount to sum and so appear in no total.
 */
export interface MitigationView {
  /** Σ of `You gain a rune for N points of absorption.` — absorption GRANTED. The log never
   *  records how much of a rune was actually consumed, so this is not "damage prevented".
   *  Mirrored by the 'Rune' lane on the self row (same numbers, classified 'absorbed').
   *  ONE lane, not two: the gain line names no source and the enchanter-rune landing message
   *  never appears in this log — see the verified sweep in src/main/combat/healing.ts. */
  runeTotal: number
  runeCount: number
  runeMax: number
  /** Smallest rune grant; absent when none were seen. */
  runeMin?: number
  /** `… but YOUR magical skin absorbs the blow!` — swings fully absorbed. COUNT ONLY: the log
   *  carries no amount for these, so the UI must show a count and never a fabricated total. */
  absorbedSwings: number
  /** `YOUR magical skin absorbs the damage of <mob>'s thorns.` — incoming damage-shield ticks
   *  absorbed. COUNT ONLY, same rule. */
  absorbedDamageShields: number
}

/**
 * The healing meter for one segment.
 *
 * ABSORPTION IS IN THE LEDGER. Rune grants are a lane on the SELF row and count toward `total` /
 * `hps`, because a shield is sustain the same way a heal is — but it is an ASSUMPTION (the log
 * records absorption granted, never consumed), so the classification travels with the number and
 * the UI labels it. The two count-only absorption families (absorbed swings, absorbed
 * damage-shield ticks) carry no amount in the log and are therefore in NO total — they stay
 * counts under `mitigation`.
 */
export interface HealingView {
  /** Healers of You / your pets, ranked by total desc. The self row also carries absorption. */
  healers: HealSourceView[]
  /** Σ healers[].total — restored hit points AND granted absorption. */
  total: number
  /** total ÷ segment duration. */
  hps: number
  /** Σ of the 'restored' rows: hit points actually put back. */
  restoredTotal: number
  /** Σ of the 'absorbed' rows: absorption granted. `restoredTotal + absorbedTotal == total`. */
  absorbedTotal: number
  /** Σ healers[].overheal (a floor — see HealSpellView.overheal). Absorption contributes 0:
   *  a rune has no overheal and one is never fabricated for it. */
  overheal: number
  /** Healers of engaged HOSTILE instances (counter-healing that undid your damage). */
  enemyHealers: HealSourceView[]
  /** Σ enemyHealers[].total. Matches SegmentView.enemyHealTotal. */
  enemyTotal: number
  mitigation: MitigationView
}

export interface SegmentSummary {
  id: string
  kind: 'fight' | 'zone' | 'current'
  name: string
  /**
   * The zone this segment happened in (raw display name, Task #61). Stamped from the
   * engine's current zone when the encounter OPENS — the same source the zone sessions use
   * — and frozen into the memoized summary at finalize. Absent when no `You have entered X.`
   * line had been seen yet (a session that starts mid-zone), which the log genuinely cannot
   * answer. It is what makes fight search reach zone names ("freprot" → fights in Freeport).
   */
  zone?: string
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

/**
 * One ranked fight-search result (Task #61). Carries the WHOLE summary, not just an id: the
 * result list has to render (name, zone, duration, dps, when) without a second round trip,
 * and a hit may be a fight far outside the snapshot's `maxSegments` window — so the summary
 * would otherwise be unreachable from the renderer.
 */
export interface FightSearchHit {
  summary: SegmentSummary
  /** 0..1 relevance. Exact token matches outrank prefix, prefix substring, substring typo. */
  score: number
}

/** The result of one fight-history search (Task #61). */
export interface FightSearchResult {
  /** Ranked hits, best first; ties broken by recency (newer first). Capped by the request's
   *  `limit`. Empty for an empty/whitespace query — the UI shows its browse list instead. */
  hits: FightSearchHit[]
  /** How many fights were SEARCHED (the whole uncapped history + the live fight). Lets the
   *  UI say "12 of 1,428" honestly instead of implying the corpus is the result set. */
  corpus: number
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

/**
 * A point-in-time ANNOTATION on the fight's clock (Task #64) — a stance/invocation commit, a
 * blade coat, a slow landing. Markers are NOT damage: they carry no amount, they are not
 * lanes, and they live in their own array precisely so nothing that walks `events` (the DPS
 * curve, per-mob grouping, lane totals, the downsampler) has to learn about them.
 *
 * THEY ARE NEVER DOWNSAMPLED. `events` is uniform-strided when a fight outgrows the render
 * budget, which for a sparse series would mean silently dropping most of it — a chart that
 * shows 1 of 5 coats is worse than one that shows none. Markers are sparse by construction
 * (the densest fight in the user's whole log carries three), so they are all carried, with a
 * generous drop-oldest cap purely as a memory bound. No COUNT is ever derived from them:
 * every number in `ProcsView` is folded on ingest from the aggregate instead.
 */
export type TimelineMarkerKind = 'stance' | 'invocation' | 'coat' | 'slow'

export interface TimelineMarker {
  /** ms since encounter start. */
  t: number
  kind: TimelineMarkerKind
  /** the stance/invocation/poison name, or the slowed mob. */
  label: string
  /** secondary text for the tooltip (e.g. the mob a slow landed on). */
  detail?: string
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
 * SnapshotOpts.timeline is set (payload is heavier than the bar view).
 *
 * TWO independent losses can stand between a fight and this view, and BOTH are declared
 * here (law 1 — anything inferred/partial is LABELED, never silently understated):
 *
 *   downsampled — the retained ring was over the serialization budget, so only every
 *                 Nth instant is carried. A uniform stride, so scaling by
 *                 `rawCount / events.length` is an unbiased estimate OF THE RING.
 *   truncated   — the per-encounter ring itself overflowed its drop-OLDEST cap, so the
 *                 ring is only the most recent slice of the fight. This is NOT a
 *                 uniform sample: everything derived from it is a LOWER BOUND on the
 *                 whole fight and must never be extrapolated (see `totalCount`).
 *
 * Neither loss ever touches the engine's aggregates: the meter/`SegmentView` totals are
 * folded on ingest, entirely independently of this ring.
 */
export interface TimelineView {
  /** the encounter id this timeline is for. */
  id: string
  name: string
  /**
   * Epoch ms of the encounter's start — the absolute clock `t: 0` stands for. DISPLAY ONLY:
   * every other time in this view stays relative (the renderer needn't know absolute ts), and
   * nothing derives from this. It exists so a hover readout can say what time of day an instant
   * happened without threading the segment's start through three components. Not persisted.
   */
  startTs: number
  /** encounter duration in ms (X-axis extent). */
  durationMs: number
  /** ordered lane labels (Y axis), grouped by category then by total desc. */
  lanes: { lane: string; category: DamageCategory; total: number; kind: SourceKind }[]
  /** timestamped instants (relative ms). */
  events: TimelineEvent[]
  /** pinned stance/invocation spans (rendered above the skill lanes). */
  stanceSpans: StanceSpan[]
  /** point annotations (stance/invocation commits, blade coats, slow landings) — see
   *  TimelineMarker: never downsampled, never counted from. */
  markers: TimelineMarker[]
  /** true when the raw event count exceeded the budget and was downsampled. */
  downsampled: boolean
  /**
   * How many instants the RING still held when this view was built — i.e. the population
   * `events` was sampled from, and therefore the ONLY honest denominator of the sampling
   * factor (`rawCount / events.length`). Deliberately NOT the fight's true instant count:
   * using `totalCount` there would silently extrapolate the dropped-oldest prefix from the
   * retained tail. Equals `totalCount` unless `truncated`.
   */
  rawCount: number
  /**
   * The TRUE number of instants this encounter ever recorded, independent of ring
   * occupancy (one counter per encounter, no per-event bookkeeping). This is the number a
   * "showing N of M events" note must quote — quoting `rawCount` once the ring has
   * overflowed understates the fight without saying so.
   */
  totalCount: number
  /**
   * true when the ring overflowed its drop-oldest cap and the fight's OLDEST instants were
   * discarded (`totalCount > rawCount`). Every event-derived number is then a lower bound
   * over the retained window, not an estimate of the whole fight; consumers label it with
   * the same `~` + explainer treatment as `downsampled`.
   */
  truncated: boolean
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
  /** blade coats + the rolling time-to-slow measurement (Task #64). */
  poison: PoisonState
  /** the selected encounter's timeline — present only when SnapshotOpts.timeline is set. */
  timeline?: TimelineView | null
  /** zone-session list (Task #54): the live zone + capped finalized-zone history, newest-first
   *  after the live one. Drives the ZONE selector in the main view + the 'overall' overlay. */
  zoneSessions: ZoneSessionSummary[]
  /**
   * HYDRATION (Task #56): true while the engine is still folding the historical scan
   * (`live:false` replay) and false once the Tailer's live handoff happens. Every snapshot
   * taken during the replay describes a HISTORICAL moment — an encounter from hours ago is
   * `current` and looks live. The UI must render a quiet loading state instead of that
   * churning fake-live meter; this is the only honest signal for it.
   */
  hydrating: boolean
  // NOTE: there is deliberately NO `liveFallback` here any more. Fight vs Overall is an explicit
  // user-chosen SCOPE (renderer-side), not an automatic switch: the default selection resolves to
  // the open fight, else the most recent finalized fight, and NEVER to the zone aggregate. The
  // renderer tells "current" from "last" by looking for a `kind: 'current'` entry in `segments`
  // and labels the row accordingly, so no extra flag is needed.
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
