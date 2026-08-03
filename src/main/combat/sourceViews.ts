// SERIALIZATION of a frozen aggregate into the snapshot's source/category/skill/rounds
// views — extracted verbatim from engine.ts. Pure functions over `Agg` maps: no engine
// state, no world model, no clock. The combine-pets fold lives here too, since it is a
// presentation-only regrouping of the same numbers (AGENTS.md law 4).

import {
  MISS_KEYS,
  finalizeRounds,
  mergeMin,
  newCategory,
  newSource,
  type CategoryStat,
  type RoundsAccum,
  type SkillStat,
  type SourceStat
} from './aggregate'
import { CATEGORY_ORDER } from '../../shared/combat'
import type { CategoryView, DamageCategory, RoundsView, SkillView, SourceView } from '../../shared/combat'

/**
 * Fold one source's per-skill lanes into another's, namespacing each lane by the source it
 * came from ("<pet>: Slash") so a combined row still says which entity landed what. Used for
 * both the top-level bySkill map and each category's own bySkill map.
 */
function mergeSkills(into: Map<string, SkillStat>, from: Map<string, SkillStat>, sourceName: string): void {
  for (const [k, sk] of from) {
    const key = `${sourceName}: ${k}`
    const prev = into.get(key)
    if (prev) {
      prev.total += sk.total
      prev.hits += sk.hits
      prev.crits += sk.crits
      prev.misses += sk.misses
      prev.resists += sk.resists
      prev.max = Math.max(prev.max, sk.max)
      prev.min = mergeMin(prev.min, sk.min)
    } else {
      into.set(key, { ...sk, name: key })
    }
  }
}

/** Fold a pet source into the synthetic "You +pets" row (combinePets). */
function mergePetInto(you: SourceStat, s: SourceStat): void {
  you.total += s.total
  you.hits += s.hits
  you.crits += s.crits
  you.ambiguousHits += s.ambiguousHits
  you.ambiguousTotal += s.ambiguousTotal
  you.misses += s.misses
  you.resists += s.resists
  for (const k of MISS_KEYS) you.miss[k] += s.miss[k]
  mergeSkills(you.bySkill, s.bySkill, s.name)
  // Merge category rollups too (namespacing the per-category skill by the pet name,
  // matching the top-level bySkill merge above) so drill-down still works combined.
  for (const [cat, cstat] of s.byCategory) {
    const yc = you.byCategory.get(cat) ?? newCategory(cat)
    yc.total += cstat.total
    yc.hits += cstat.hits
    yc.crits += cstat.crits
    yc.resists += cstat.resists
    yc.max = Math.max(yc.max, cstat.max)
    mergeSkills(yc.bySkill, cstat.bySkill, s.name)
    you.byCategory.set(cat, yc)
  }
  // Merge rounds buckets (union of both sources' second-buckets — keeps the
  // per-second hit clustering coherent when pets fold into You).
  for (const [bk, cnt] of s.rounds.bucket) {
    you.rounds.bucket.set(bk, (you.rounds.bucket.get(bk) ?? 0) + cnt)
  }
}

export function sourceViews(map: Map<string, SourceStat>, durationSec: number, combinePets: boolean): SourceView[] {
  const merged = new Map<string, SourceStat>()
  for (const [id, s] of map) {
    if (combinePets && s.kind === 'pet') {
      const you = merged.get('you') ?? newSource('You +pets', 'you')
      you.name = 'You +pets'
      mergePetInto(you, s)
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
