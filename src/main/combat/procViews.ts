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
// THE LINK FEED (§2.1 `ProcLink`), which used to be the hole in this file. `ProcLaneView.linked` is now
// filled from the per-state firing split `SpellProcLane.byState` carries, against the per-state
// swing exposure `ProcAccum.swingsByState` carries — BOTH folded on ingest, because the event
// ring is capped, truncated and absent entirely for zone sessions, so a link derived from it
// would be silently wrong exactly where the sample is biggest.
//
// SPELL LANES ONLY, and the two absences are deliberate rather than pending:
//   - a POISON lane's link to its own coat is TAUTOLOGICAL — an Asp Venom Strike cannot fire
//     without asp venom on the blade, so 'exclusive' there restates the mechanic instead of
//     measuring anything. (Its firings are also folded in procRouting.ts, not on this path.)
//   - a SLAY lane's count comes from the damage taxonomy, not from a proc fold, and its
//     `directDamage` is "damage on swings that procced" rather than damage the proc ADDED — so
//     rolling it up as a state's exact contribution would overstate it by a whole swing each.
// Both keep an empty list, which is the same discipline as everything else here: a number is
// absent when the sample cannot support it, never zero-filled.

import { sumMap } from './aggregate'
import { stateKeyOf } from './stateTimeline'
import { buildAttributionReport, concentrationOf, linkStrength, procRate } from './procWindows'
import { laneCount, sidesCount } from './procDetect'
import { idKey, spellCanonKey } from '../log/parseCommon'
import { POISONS, isSlowCapable } from '../../shared/poisons'
import { PROC_BUFF_CATALOG } from '../../shared/procBuffs'
import type { Agg, SourceStat } from './aggregate'
import type { ProcSourceWindow } from './procWindows'
import type { SpellProcLane } from './procDetect'
import type { Encounter } from './encounter'
import type { EngineState } from './state'
import type { ProcLaneView, ProcLink, ProcOrigin, ProcRateView, ProcSkillTag, StateSpan } from '../../shared/procAnalytics'
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
  /** Per-state active-time exposure, folded on ingest — the source-window denominators. */
  sources: SourceWindows
}

/**
 * THE SOURCE-WINDOW INDEX (2026-08-04): every state span this segment saw, with the active
 * seconds it was open for, resolvable by the two things that GRANT a proc.
 *
 * Built once per segment because both lookups are name joins over small tables and both are
 * asked once per lane. `unknown` is not an error state — it is the answer for every item proc,
 * every illusion-granted proc (the log's `Earthquake` comes from a Boon of the Garou illusion
 * and the illusion prints no span this model tracks) and any buff that predates the window.
 */
interface SourceWindows {
  /** `<kind>:<key>` → active seconds that state was open for, inside this segment. */
  activeSecByState: Map<string, number>
  /** `<kind>:<key>` → the span's display name. */
  nameByState: Map<string, string>
}

function sourceWindows(spec: ProcsViewSpec, states: readonly StateSpan[]): SourceWindows {
  const activeSecByState = new Map<string, number>()
  for (const [key, ms] of spec.agg.procs.activeMsByState) activeSecByState.set(key, ms / 1000)
  const nameByState = new Map<string, string>()
  for (const s of states) nameByState.set(stateKeyOf(s.kind, s.key), s.name)
  return { activeSecByState, nameByState }
}

/**
 * The source window for a POISON lane: the coat spans of every poison whose roster grants one
 * of the lane's Strikes.
 *
 * SUMMING those spans is a union and not a double count, and the roster is what makes it so:
 * every poison that grants a given Strike is mutually EXCLUSIVE with the others that grant it.
 * All the multi-granting poisons are UTILITY (Weakening Strike comes from Weakening, Binding,
 * Neurotoxic and Paralytic — one utility slot, so at most one is ever on), and every combat
 * Strike is granted by exactly one venom. So no two of the spans being added can overlap.
 *
 * Unknown when NO granting coat has an observed span in this segment — which is the honest
 * state for a coat applied before the window opened with no priming session behind it.
 */
function poisonSource(label: string, w: SourceWindows): ProcSourceWindow | undefined {
  const strikes = new Set(label.split(' / ').map((n) => n.trim()))
  let sec = 0
  const names: string[] = []
  for (const p of POISONS) {
    if (!p.strikes.some((s) => strikes.has(s))) continue
    const key = stateKeyOf('coat', idKey(p.name))
    const s = w.activeSecByState.get(key)
    if (s === undefined || s <= 0) continue
    sec += s
    names.push(w.nameByState.get(key) ?? p.name)
  }
  return names.length > 0 ? { activeSec: sec, name: names.join(' + ') } : undefined
}

/** The source window for a SPELL lane: the tracked proc buff that GRANTS it, when the catalog
 *  names one and its span was observed here (`Instrument of Nife` → `Condemnation of Nife`). */
function spellSource(name: string, w: SourceWindows): ProcSourceWindow | undefined {
  const key = spellCanonKey(name)
  for (const b of PROC_BUFF_CATALOG) {
    if (b.grantsProc === undefined || spellCanonKey(b.grantsProc) !== key) continue
    const stateKey = stateKeyOf('buff', idKey(b.name))
    const sec = w.activeSecByState.get(stateKey)
    if (sec !== undefined && sec > 0) return { activeSec: sec, name: w.nameByState.get(stateKey) ?? b.name }
  }
  return undefined
}

/**
 * The source-window half of a lane's `RateInput`.
 *
 * THREE STATES, and the third is why this returns a fragment rather than a window:
 *   - KNOWN   — a coat span or a tracked proc-buff span. The rate is over it, exactly.
 *   - UNKNOWN — a spell or poison lane whose granting span this segment never saw. The segment
 *               is assumed, and `sourceAmbiguous` says so.
 *   - N/A     — a SLAY lane. Slay Undead is an innate class proc: there is no span to observe,
 *               was never one to miss, and flagging it 'ambiguous' would invite a reader to
 *               look for a window that does not exist. It divides by the segment plainly.
 */
function sourceInput(origin: ProcOrigin, label: string, w: SourceWindows): { source?: ProcSourceWindow; sourceUnknown?: boolean } {
  if (origin === 'slay') return {}
  const source = origin === 'poison' ? poisonSource(label, w) : spellSource(label, w)
  return source ? { source } : { sourceUnknown: true }
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
  const states = spec.st.stateTimeline.spansOverlapping(spec.startTs, spec.endTs)
  const b = rateBase(spec, states)
  const lanes = buildLanes(spec, states)
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
    overall: overallRate(lanes, b),
    procSkills: procSkillTags(spec, lanes),
    states,
    // TIER B IS OVERALL-SCOPE ONLY (§1). A single pull has no inactive sample, so offering a
    // per-fight counterfactual would be an invitation to read one minute of noise as an effect.
    ...(spec.kind === 'zone'
      ? { attribution: buildAttributionReport({ sessionId: spec.id, windows: agg.windows.list(), states, lanes }) }
      : {})
  }
}

function rateBase(spec: ProcsViewSpec, states: readonly StateSpan[]): RateBase {
  return {
    activeSec: spec.activeSec,
    durationSec: spec.durationSec,
    swings: spec.agg.procs.swings,
    outTotal: sumMap(spec.agg.out),
    sources: sourceWindows(spec, states)
  }
}

/** One LANE's rates: divided by its source window when the model knows one, and honestly
 *  flagged when it does not (see `sourceInput` for the three states). */
function laneRate(count: number, b: RateBase, origin: ProcOrigin, label: string): ProcRateView {
  return procRate({
    count,
    activeSec: b.activeSec,
    durationSec: b.durationSec,
    swings: b.swings,
    ...sourceInput(origin, label, b.sources)
  })
}

/** The lane list, in one pass per origin. Order: poison, then spell, then slay — the order the
 *  questions get asked, with each block sorted by count desc. */
function buildLanes(spec: ProcsViewSpec, states: readonly StateSpan[]): ProcLaneView[] {
  const b = rateBase(spec, states)
  const you = spec.agg.out.get('you')
  const poison = poisonLanes(spec, you, b)
  const covered = new Set<string>()
  for (const l of poison) {
    for (const k of candidateKeys(l.name)) covered.add(k)
  }
  return [...poison, ...spellLanes(spec, b, covered, linkCtx(spec, states)), ...slayLanes(you, b)]
}

/** The two denominators every link in this segment shares, plus the states to test. */
interface LinkCtx {
  /** One entry per distinct `<kind>:<key>`, in the order the spans first appear. */
  states: StateSpan[]
  swingsByState: ReadonlyMap<string, number>
  swings: number
}

function linkCtx(spec: ProcsViewSpec, states: readonly StateSpan[]): LinkCtx {
  const seen = new Map<string, StateSpan>()
  for (const s of states) {
    const k = stateKeyOf(s.kind, s.key)
    if (!seen.has(k)) seen.set(k, s)
  }
  return {
    states: [...seen.values()],
    swingsByState: spec.agg.procs.swingsByState,
    swings: spec.agg.procs.swings
  }
}

/**
 * One lane's co-occurrence with every state this segment saw.
 *
 * EVERY state gets a row, including the ones whose answer is 'inconclusive' — the same rule the
 * Tier-B report follows, and for the same reason: an omitted comparison reads as one that was
 * never worth making, when in fact it was made and refused.
 *
 * `withoutCount` is the lane's remaining firings, not a second counter. Since states overlap,
 * two links of the same lane can both report most of its firings; that is the truth about
 * overlapping states and not a double count — each row answers one question on its own.
 */
function linksFor(lane: SpellProcLane, ctx: LinkCtx): ProcLink[] {
  const count = laneCount(lane)
  const out: ProcLink[] = []
  for (const s of ctx.states) {
    const key = stateKeyOf(s.kind, s.key)
    const withCount = sidesCount(lane.byState.get(key))
    const withoutCount = Math.max(0, count - withCount)
    const activeSwings = ctx.swingsByState.get(key) ?? 0
    const inactiveSwings = Math.max(0, ctx.swings - activeSwings)
    out.push({
      kind: s.kind,
      key: s.key,
      name: s.name,
      withCount,
      withoutCount,
      concentration: concentrationOf(withCount, withoutCount),
      inactiveSwings,
      strength: linkStrength({ withCount, withoutCount, activeSwings, inactiveSwings })
    })
  }
  return out
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

/**
 * YOUR damage rows recorded under any of `keys` — THE one place a proc lane is matched against
 * the meter's own skill lanes. Both consumers read it (the lane's Tier-A damage, and the
 * is-a-proc join below), so "which rows is this lane" can never come to mean two things.
 *
 * Names are matched rank-normalized (law 2, at the counting boundary) and returned RAW, because
 * the raw string is what `SkillView.name` carries and therefore what the drill row is labelled
 * with.
 */
function skillsMatching(you: SourceStat | undefined, keys: readonly string[]): { name: string; total: number; hits: number }[] {
  const out: { name: string; total: number; hits: number }[] = []
  if (!you) return out
  for (const s of you.bySkill.values()) {
    if (keys.includes(spellCanonKey(s.name))) out.push({ name: s.name, total: s.total, hits: s.hits })
  }
  return out
}

/** Damage delivered under a given skill name by YOU, read back out of the same aggregate the
 *  meter's bars come from. An INDEX, never a second accumulation. */
function deliveredBy(you: SourceStat | undefined, keys: readonly string[]): number {
  return skillsMatching(you, keys).reduce((n, s) => n + s.total, 0)
}

/** YOUR resists on the rows a lane covers. Same join, same aggregate, same discipline as
 *  `deliveredBy` — a lane and the drill row beneath it read one counter, not two. */
function resistedBy(you: SourceStat | undefined, keys: readonly string[]): number {
  if (!you) return 0
  let n = 0
  for (const s of you.bySkill.values()) {
    if (keys.includes(spellCanonKey(s.name))) n += s.resists
  }
  return n
}

/**
 * EFFECT LANDINGS WITH NO DAMAGE LINE — the join defect 1 turned on (2026-08-04).
 *
 * `<mob>'s limbs move slower!` is the ONLY thing a Weakening Strike prints when it lands; its
 * RESISTS print the spell name like any other spell. So the drill built a lane for it entirely
 * out of resists and reported `0 landed · 34 resisted` for a proc that landed 562 times in the
 * same log — while the Procs tab, three inches away, counted every one of those emotes.
 *
 * This is the count that closes the gap, and the gate on it is exact rather than convenient: a
 * strike lane contributes here ONLY when no row of the meter's has LANDED A HIT under its name.
 * Where a lane DOES land damage the firings are already represented — Asp Venom Strike prints
 * an emote AND a damage line for a single proc, and adding its 424 emotes to its 96 damage hits
 * would report 520 firings for at most 424. Every shared-emote label in the roster (asp/cobra,
 * siphon/draw) belongs to a damage-carrying strike, so a lane reaching this map is always named
 * by exactly one Strike — which is why the key can be its canon name.
 *
 * `hits > 0`, NOT "a row exists": the row is exactly what a resist creates, and gating on its
 * existence would have left the reported defect in place on precisely the lanes that showed it
 * (a Weakening Strike with four resists has a row, zero hits, and 562 landings to report).
 *
 * Exported because `sourceViews` needs it to build the drill row and `procViews` needs it to
 * tag that row: ONE definition of "landings nothing else counted", read twice.
 */
export function effectLandings(agg: Agg): Map<string, { name: string; count: number }> {
  const you = agg.out.get('you')
  const out = new Map<string, { name: string; count: number }>()
  for (const s of agg.procs.strikes.values()) {
    const keys = candidateKeys(s.name)
    if (skillsMatching(you, keys).some((r) => r.hits > 0)) continue
    out.set(keys[0], { name: s.name, count: s.count })
  }
  return out
}

/**
 * THE IS-A-PROC JOIN (docs/plans/proc-visibility.md §2). One tag per (damage row, lane), so the
 * drill can say `proc · 3.1 ppm` on exactly the rows the ledger already counts — and on no
 * others.
 *
 * It runs HERE because this is where both definitions of "proc" live: `agg.procs.strikes` is the
 * poison roster matched exactly (shared/poisons.ts, via the parser's emote table) and
 * `agg.procs.spellProcs` is procDetect's cast-less inference. Deriving it again downstream would
 * be a second definition, and a second definition is a future disagreement.
 *
 * ONE ABSENCE IS DELIBERATE, and one has been OVERTURNED:
 *   - only YOUR rows are tagged. The lanes are folded from your procs, so tagging a pet's row
 *     with them would attribute your blades to the pet. (Stands.)
 *   - a lane with no damage row used to produce no tag, on the reasoning that "the drill lists
 *     damage". That reasoning cost the owner the four Strikes they actually care about:
 *     Weakening, Clumsiness, Stunning and Banishing deal nothing at all, so the drill showed
 *     them only when a RESIST created the row and then labelled them `0 landed · N resisted`.
 *     A damage-less lane with landings now gets its tag and its row (see `effectLandings`), and
 *     that row reads `0 dmg · N landed`. (2026-08-04, overturned.)
 */
function procSkillTags(spec: ProcsViewSpec, lanes: readonly ProcLaneView[]): ProcSkillTag[] {
  const you = spec.agg.out.get('you')
  const landed = effectLandings(spec.agg)
  const out: ProcSkillTag[] = []
  for (const l of lanes) {
    const skills = taggedSkills(you, l)
    // A damage-less strike is its OWN row now: the ledger's label is what the drill names it,
    // so the tag joins on that name exactly the way a damage row's tag joins on its own.
    if (skills.length === 0 && landed.has(candidateKeys(l.name)[0])) skills.push(l.name)
    for (const skill of skills) {
      out.push({ skill, lane: l.name, origin: l.origin, rate: l.rate, activeSec: spec.activeSec })
    }
  }
  return out
}

/**
 * The damage rows one lane covers.
 *
 * A SLAY lane is the exception and it is a presentation one: a Slay Undead proc rides an ordinary
 * weapon swing, so the aggregate's rows are the WEAPON names ("Melee", "Backstab") and the drill
 * merges them into a single row labelled with the lane's own name (`groupSlay` in
 * dashboardData.ts). That merged row is what carries the rate; tagging the weapon rows instead
 * would put a proc rate on lanes that are mostly ordinary swings.
 */
function taggedSkills(you: SourceStat | undefined, l: ProcLaneView): string[] {
  if (l.origin === 'slay') return [l.name]
  return skillsMatching(you, candidateKeys(l.name)).map((s) => s.name)
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
  /** Times this lane's spell was RESISTED — read out of the drill's own per-skill counters. */
  resisted: number
  /** Co-occurrence rows. Absent ⇒ empty: see the header for the two origins that have none. */
  linked?: ProcLink[]
}

function lane(s: LaneSpec, b: RateBase): ProcLaneView {
  const attempts = s.count + s.resisted
  return {
    name: s.name,
    count: s.count,
    origin: s.origin,
    rate: laneRate(s.count, b, s.origin, s.name),
    directDamage: s.damage,
    directHeal: s.heal,
    pctOfOut: b.outTotal > 0 ? (s.damage / b.outTotal) * 100 : 0,
    dpsContribution: b.activeSec > 0 ? s.damage / b.activeSec : 0,
    // THE OTHER HALF OF THE LANE'S RECORD (2026-08-04). `count` is what landed; without this the
    // ledger showed only landings while the drill showed only resists, and the same Weakening
    // Strike read `90 landings` in one panel and `0 landed · 34 resisted` in the other.
    ...(s.resisted > 0 ? { resisted: s.resisted, resistPct: (s.resisted / attempts) * 100 } : {}),
    linked: s.linked ?? []
  }
}

/** ROGUE-POISON lanes. `count` is the EMOTE count and nothing else (rule 1). */
function poisonLanes(spec: ProcsViewSpec, you: SourceStat | undefined, b: RateBase): ProcLaneView[] {
  const out: ProcLaneView[] = []
  for (const s of spec.agg.procs.strikes.values()) {
    const keys = candidateKeys(s.name)
    const l = lane(
      {
        name: s.name, origin: 'poison', count: s.count,
        damage: deliveredBy(you, keys), heal: healedBy(spec.agg, keys), resisted: resistedBy(you, keys)
      },
      b
    )
    if (s.ambiguous) l.ambiguous = true
    out.push(l)
  }
  return out.sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
}

/**
 * CAST-LESS SPELL lanes, minus any name a poison emote already counted (rule 2).
 *
 * RULE 4, and it is as load-bearing as the other three: a lane's `count` is `laneCount` — the
 * LARGER of its damage-line and heal-line firings, never their sum. One Lifetap Strike prints
 * both, and adding them reported 24 firings for w39's twelve.
 */
function spellLanes(
  spec: ProcsViewSpec,
  b: RateBase,
  covered: ReadonlySet<string>,
  ctx: LinkCtx
): ProcLaneView[] {
  const out: ProcLaneView[] = []
  const you = spec.agg.out.get('you')
  for (const [key, l] of spec.agg.procs.spellProcs) {
    if (covered.has(key)) continue
    out.push(
      lane(
        {
          name: l.name, origin: 'spell', count: laneCount(l), damage: l.damage, heal: l.heal,
          resisted: resistedBy(you, [key]), linked: linksFor(l, ctx)
        },
        b
      )
    )
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
  const l = lane({ name: 'Slay Undead', origin: 'slay', count: slay.hits, damage: slay.total, heal: 0, resisted: 0 }, b)
  l.marginalDamage = slay.total - slay.hits * meanMelee
  return [l]
}

/**
 * The "procs per minute" headline: an IDENTITY over the lanes it is built from, so it cannot
 * drift from the rows beneath it.
 *
 * OVER THE SEGMENT, deliberately, while every lane below it now divides by its own source
 * window. "How many procs did this fight see per minute" is a question about the fight, and
 * summing lanes measured over disjoint windows would produce a rate with no denominator at all.
 * So this one keeps the segment and carries no source fields — an absence that means "not
 * applicable", where a lane's absence means "unknown".
 */
function overallRate(lanes: readonly ProcLaneView[], b: RateBase): ProcRateView {
  return procRate({
    count: lanes.reduce((n, l) => n + l.count, 0),
    activeSec: b.activeSec,
    durationSec: b.durationSec,
    swings: b.swings
  })
}
