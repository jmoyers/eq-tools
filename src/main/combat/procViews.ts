// THE PROC-LEDGER SERIALIZATION (docs/plans/proc-analytics.md §6) — one segment's `Agg` plus
// the session state timeline, turned into the `ProcsView` the renderer draws.
//
// `buildProcsView` MOVED here verbatim from segmentViews.ts, per plan §6: it was already the
// biggest single function in that file, and the new lane / rate / state / attribution assembly
// would have pushed segmentViews.ts past the 400-code-line ceiling with an EMPTY ratchet.
//
// ADDITIVE ONLY (law 8). Everything added here is a COUNT or an INDEX over damage the meter
// already counted — `directDamage` is read back out of the same `Agg` the bars come from, never
// accumulated a second time. Not one damage total moves; the golden windows pin that exactly.
//
// THE THREE COUNTING RULES, because collapsing any of them is how a proc meter starts lying:
//
//   1. A POISON lane counts EMOTES, and reports tick damage separately. `Blood Siphon Strike`
//      in w41 is four emotes, fourteen dot ticks for 658, and thirteen heal lines for 611 —
//      three numbers, each correct for its own question, and none of them is the sum of the
//      others. `count` is the emote count (the proc fired four times); `directDamage` is what
//      the ticks delivered; `directHeal` is what the taps returned.
//   2. A poison lane SUPPRESSES the spell-proc lane of the same name. `Asp Venom Strike` prints
//      both an emote and a `poison damage by Asp Venom Strike` line for ONE proc; emitting both
//      lanes would count that proc twice in the ppm headline.
//   3. A SLAY lane's `directDamage` is "damage on swings that PROCCED slay", NOT "damage slay
//      added" — the swing was going to land anyway. The excess over an ordinary swing rides in
//      `marginalDamage` with its assumption stated in the type.
//
// WHAT IS NOT HERE, and why: `ProcLaneView.linked` ships EMPTY. A link needs each lane's firings
// split by which state was active at the time, and that split has to be folded on INGEST (the
// event ring is capped, truncated, and absent entirely for zone sessions — the exact law the
// Task #64 ledger obeys). Wave 1's `SpellProcLane` carries no such split and `aggregate.ts` /
// `ingest.ts` are outside this wave's ownership, so the honest serialization is an empty list
// rather than a number derived from a ring. The link CLASSIFIER itself (linkStrength) is
// shipped, gated and tested against the goldens — only the per-lane feed is missing.

import { sumMap } from './aggregate'
import { buildAttributionReport, procRate } from './procWindows'
import { spellCanonKey } from '../log/parseCommon'
import { isSlowCapable } from '../../shared/poisons'
import type { Agg, SourceStat } from './aggregate'
import type { Encounter } from './encounter'
import type { EngineState } from './state'
import type { ProcLaneView, ProcOrigin, ProcRateView } from '../../shared/procAnalytics'
import type { ProcLane, ProcsView } from '../../shared/combat'

/** Everything one `ProcsView` needs. An args object: a fight, the live zone aggregate and a
 *  frozen zone session differ only in these fields, and eight positional parameters would blow
 *  `max-params` four times over. */
export interface ProcsViewSpec {
  st: EngineState
  agg: Agg
  id: string
  kind: 'fight' | 'zone'
  durationSec: number
  activeSec: number
  /** Segment span in absolute ms — the window the state spans are clipped to. */
  startTs: number
  endTs: number
  /** Present only for a FIGHT. */
  enc?: Encounter
}

/** The denominators every lane in a segment shares. Resolved once. */
interface RateBase {
  activeSec: number
  durationSec: number
  swings: number
  outTotal: number
}

const byCount = (a: ProcLane, b: ProcLane): number => b.count - a.count || a.name.localeCompare(b.name)

/**
 * The per-segment proc ledger (Task #64) plus the proc-analytics superset, built entirely from
 * the frozen aggregate and the session state timeline.
 *
 * `enc` is present only for a FIGHT: coats-at-engage and the engage-relative timings are
 * questions about one pull's opening instant, and a zone session (many pulls, many coat swaps)
 * has no such instant. So a zone view reports the counts — procs, poison damage, effects, stance
 * switches — and honestly reports no `slowLandMs` and no `slowExpected`, rather than measuring
 * from an arbitrary zero.
 */
export function buildProcsView(spec: ProcsViewSpec): ProcsView {
  const { agg, enc } = spec
  const p = agg.procs
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
  const lanes = buildLanes(spec)
  const states = spec.st.stateTimeline.spansOverlapping(spec.startTs, spec.endTs)
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
    invocationSwitches: p.invocationSwitches,
    lanes,
    overall: overallRate(lanes, rateBase(spec)),
    states,
    // TIER B IS OVERALL-SCOPE ONLY (§1). A single pull has no inactive sample, so offering a
    // per-fight counterfactual would be an invitation to read one minute of noise as an effect.
    ...(spec.kind === 'zone'
      ? { attribution: buildAttributionReport({ sessionId: spec.id, windows: agg.windows.list(), states }) }
      : {})
  }
}

function rateBase(spec: ProcsViewSpec): RateBase {
  return {
    activeSec: spec.activeSec,
    durationSec: spec.durationSec,
    swings: spec.agg.procs.swings,
    outTotal: sumMap(spec.agg.out)
  }
}

function rateOf(count: number, b: RateBase): ProcRateView {
  return procRate({ count, activeSec: b.activeSec, durationSec: b.durationSec, swings: b.swings })
}

/** The lane list, in one pass per origin. Order: poison, then spell, then slay — the order the
 *  questions get asked, with each block sorted by count desc. */
function buildLanes(spec: ProcsViewSpec): ProcLaneView[] {
  const b = rateBase(spec)
  const you = spec.agg.out.get('you')
  const poison = poisonLanes(spec, you, b)
  const covered = new Set<string>()
  for (const l of poison) {
    for (const k of candidateKeys(l.name)) covered.add(k)
  }
  return [...poison, ...spellLanes(spec, b, covered), ...slayLanes(you, b)]
}

/**
 * An emote label may name SEVERAL Strikes — `screams as poison burns their veins!` is Asp Venom
 * Strike OR Cobra Venom Strike, and the shipped ledger keeps both in one ` / `-joined label
 * (law 3: shared messages are the norm; the count is exact, only the name is uncertain). Both
 * candidates are joined against the damage lanes and both suppress their spell-proc twin.
 */
function candidateKeys(label: string): string[] {
  return label.split(' / ').map((n) => spellCanonKey(n.trim()))
}

/** Damage delivered under a given skill name by YOU, read back out of the same aggregate the
 *  meter's bars come from. An INDEX, never a second accumulation. */
function deliveredBy(you: SourceStat | undefined, keys: readonly string[]): number {
  let total = 0
  if (!you) return total
  for (const s of you.bySkill.values()) {
    if (keys.includes(spellCanonKey(s.name))) total += s.total
  }
  return total
}

/** Healing recorded under a given skill name by the cast-less detector (`Lifetap Strike`,
 *  `Blood Siphon Strike`). Kept SEPARATE from damage: in w39 the tap returns MORE than it deals
 *  (474 healed against 458 dealt), so one can never be derived from the other. */
function healedBy(agg: Agg, keys: readonly string[]): number {
  let n = 0
  for (const [key, lane] of agg.procs.spellProcs) {
    if (keys.includes(key)) n += lane.heal
  }
  return n
}

/** One lane, with its rates and its Tier-A numbers. `damage` and `heal` are kept apart all the
 *  way down: in w39 the tap RETURNS MORE THAN IT TAKES (474 healed against 458 dealt), so one
 *  can never be derived from the other. */
interface LaneSpec {
  name: string
  origin: ProcOrigin
  count: number
  damage: number
  heal: number
}

function lane(s: LaneSpec, b: RateBase): ProcLaneView {
  return {
    name: s.name,
    count: s.count,
    origin: s.origin,
    rate: rateOf(s.count, b),
    directDamage: s.damage,
    directHeal: s.heal,
    pctOfOut: b.outTotal > 0 ? (s.damage / b.outTotal) * 100 : 0,
    dpsContribution: b.activeSec > 0 ? s.damage / b.activeSec : 0,
    linked: []
  }
}

/** ROGUE-POISON lanes. `count` is the EMOTE count and nothing else (rule 1). */
function poisonLanes(spec: ProcsViewSpec, you: SourceStat | undefined, b: RateBase): ProcLaneView[] {
  const out: ProcLaneView[] = []
  for (const s of spec.agg.procs.strikes.values()) {
    const keys = candidateKeys(s.name)
    const l = lane(
      { name: s.name, origin: 'poison', count: s.count, damage: deliveredBy(you, keys), heal: healedBy(spec.agg, keys) },
      b
    )
    if (s.ambiguous) l.ambiguous = true
    out.push(l)
  }
  return out.sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
}

/** CAST-LESS SPELL lanes, minus any name a poison emote already counted (rule 2). */
function spellLanes(spec: ProcsViewSpec, b: RateBase, covered: ReadonlySet<string>): ProcLaneView[] {
  const out: ProcLaneView[] = []
  for (const [key, l] of spec.agg.procs.spellProcs) {
    if (covered.has(key)) continue
    out.push(lane({ name: l.name, origin: 'spell', count: l.count, damage: l.damage, heal: l.heal }, b))
  }
  return out.sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
}

/**
 * THE SLAY LANE (rule 3, §5.6). One lane, from the taxonomy's own `slay` category — a Slay
 * Undead proc rides an ordinary swing and prints no spell line of its own.
 *
 * Emitted only when it fired: a permanent 0-count row on every non-undead pull is noise, and the
 * absence is already visible in the melee category. `marginalDamage` subtracts the swing that
 * would have landed anyway, at THIS segment's mean melee hit, and the type carries the
 * assumption so the number can never travel without it.
 */
function slayLanes(you: SourceStat | undefined, b: RateBase): ProcLaneView[] {
  const slay = you?.byCategory.get('slay')
  if (!slay || slay.hits === 0) return []
  const melee = you?.byCategory.get('melee')
  const meanMelee = melee && melee.hits > 0 ? melee.total / melee.hits : 0
  const l = lane({ name: 'Slay Undead', origin: 'slay', count: slay.hits, damage: slay.total, heal: 0 }, b)
  l.marginalDamage = slay.total - slay.hits * meanMelee
  return [l]
}

/** The "procs per minute" headline: an IDENTITY over the lanes it is built from, so it cannot
 *  drift from the rows beneath it. */
function overallRate(lanes: readonly ProcLaneView[], b: RateBase): ProcRateView {
  return rateOf(
    lanes.reduce((n, l) => n + l.count, 0),
    b
  )
}
