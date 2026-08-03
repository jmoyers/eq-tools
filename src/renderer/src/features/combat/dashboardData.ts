// Pure, renderer-side derivations for the combat DASHBOARD panels. No JSX, no MUI —
// everything here is a single-pass grouping over the selected encounter's TimelineView
// (≤2k serialized events) or over the authoritative SourceView aggregates.
//
// HONESTY (world-model law 5 — aggregates lie; law 1 — anything inferred is LABELED):
//   - The engine downsamples an encounter's event ring with a UNIFORM STRIDE once it
//     exceeds its serialization budget. Every number derived from a downsampled event
//     list is therefore an ESTIMATE. We scale sums/counts by the sampling factor (the
//     unbiased estimator for uniform-stride sampling) and hand the caller `estimated`
//     so every affected number renders with the `~` prefix. Observed maxima are NOT
//     scaled — a sampled max is a lower bound, never inflated.
//   - Finalized ZONE sessions keep no event ring at all (the snapshot's `timeline` is
//     null). Callers degrade to a quiet note; these functions are simply not called.
// The authoritative totals always remain the engine's SourceView bars.

import type {
  DamageCategory,
  SegmentSummary,
  SkillView,
  SourceView,
  TimelineView,
  ZoneSessionSummary
} from '@shared/combat'

/** A skill row tagged with the category it was rolled up under (the color key). */
export type FlatSkill = SkillView & { category: DamageCategory }

/**
 * A row of the flat level-2 list. Identical to a FlatSkill except that a GROUP row also carries
 * the per-skill rows it stands for (`children`) — today only the Slay Undead aggregate does.
 * Consumers that just render a bar can ignore `children` entirely; the ones that expand a row
 * use it as the inline breakdown.
 */
export type SkillRow = FlatSkill & { children?: FlatSkill[] }

/**
 * Label for the aggregated slay row. Mirrors `CATEGORY_LABEL.slay` in @shared/combat, spelled
 * literally because this module is imported by node tests (tests/combatPerMobGhosts.test.mts),
 * which run without the renderer's `@shared` alias — a VALUE import here would break them.
 */
const SLAY_LABEL = 'Slay Undead'

/**
 * Collapse every `slay`-category row into ONE "Slay Undead" aggregate.
 *
 * WHY: a Slay Undead proc is a normal weapon swing that carries the proc, so the flatten names
 * it after the weapon verb — "Melee", "Backstab", "Bash", "Kick" — and the flat list grew a run
 * of near-duplicate ivory rows that are all the same THING (the paladin proc) seen through
 * different weapons. The user reads them as one ability, so the list shows one row; the weapon
 * split is one click down, inside the row's own expansion (no new nav level).
 *
 * Aggregation is a plain sum over counts/damage with `max` = the largest single proc across all
 * weapons and `min` = the smallest LANDED one (0/absent minima are skipped — a resist/miss-only
 * lane carries no amount and must never pull the group minimum to 0). Rows are re-sorted and
 * every bar pct re-based on the new global max, since the merged row is usually the biggest one.
 *
 * A single slay skill is left EXACTLY as it is: a group of one is a wrapper around nothing, and
 * the per-weapon row ("Backstab · Slay Undead") is strictly more informative than a "Slay Undead"
 * row whose only child repeats it.
 */
export function groupSlay(rows: SkillRow[]): SkillRow[] {
  const slay = rows.filter((r) => r.category === 'slay')
  if (slay.length < 2) return rows
  const children = [...slay].sort((a, b) => b.total - a.total || b.hits - a.hits || a.name.localeCompare(b.name))
  const sum = (pick: (s: FlatSkill) => number): number => children.reduce((n, s) => n + pick(s), 0)
  const minima = children.map((s) => s.min ?? 0).filter((m) => m > 0)
  const childMax = Math.max(1, ...children.map((s) => s.total))
  const group: SkillRow = {
    name: SLAY_LABEL,
    category: 'slay',
    total: sum((s) => s.total),
    pct: 0,
    hits: sum((s) => s.hits),
    crits: sum((s) => s.crits),
    max: Math.max(0, ...children.map((s) => s.max)),
    min: minima.length > 0 ? Math.min(...minima) : undefined,
    misses: sum((s) => s.misses ?? 0),
    resists: sum((s) => s.resists ?? 0),
    // Children bar widths are relative to the LARGEST slay skill, so the nested list reads as
    // its own ranking rather than as slivers of the parent's width.
    children: children.map((s) => ({ ...s, pct: (s.total / childMax) * 100 }))
  }
  const out: SkillRow[] = [...rows.filter((r) => r.category !== 'slay'), group]
  out.sort((a, b) => b.total - a.total || b.hits - a.hits || a.name.localeCompare(b.name))
  const max = Math.max(1, ...out.map((r) => r.total))
  return out.map((r) => ({ ...r, pct: (r.total / max) * 100 }))
}

/**
 * Drill-down selection (union). `entity` = the level-2 flat skill list for one source
 * (the existing meter drill). `target` = the level-2 flat skill list for everything you
 * and your pet landed on ONE mob (driven by the Damage-by-mob panel). They are mutually
 * exclusive by construction: picking either replaces the other, so the main panel always
 * has exactly one level-2 subject and one breadcrumb.
 */
export type Drill = { kind: 'entity'; entityId: string } | { kind: 'target'; target: string }

/**
 * Flatten a source's per-category skill lists into ONE list ranked by damage desc, and
 * re-base each row's bar pct on the global max (the engine's `pct` is relative to the
 * skill's own category max, which would make small categories render full-width here).
 * The slay rows then collapse into a single grouped row (`groupSlay`) — the ONE place the
 * flat list departs from "one row per engine skill", so every surface that renders this
 * list (meter drill, overlay drill, breakdown preview) groups identically.
 */
export function flattenSkills(e: SourceView): SkillRow[] {
  const rows: FlatSkill[] = e.categories.flatMap((c) => c.skills.map((s) => ({ ...s, category: c.category })))
  rows.sort((a, b) => b.total - a.total || b.hits - a.hits || a.name.localeCompare(b.name))
  const max = Math.max(1, ...rows.map((r) => r.total))
  return groupSlay(rows.map((r) => ({ ...r, pct: (r.total / max) * 100 })))
}

/** Sampling factor for a (possibly downsampled) timeline: 1 when every event is present. */
export function sampleScale(tl: TimelineView): number {
  if (!tl.downsampled || tl.events.length === 0) return 1
  return Math.max(1, tl.rawCount / tl.events.length)
}

// ── DPS over time ──────────────────────────────────────────────────────────────────

/** Widest bucket count we ever plot — the SVG is render-bound, so keep the polyline short. */
const MAX_BUCKETS = 360
/** Rolling-window width for the smoothed rate (reads as a curve, not a comb). */
const SMOOTH_MS = 5_000

export interface DpsSeries {
  /** bucket width in ms (≥1s; grows for long fights so the polyline stays ≤MAX_BUCKETS). */
  bucketMs: number
  /** effective smoothing window in ms (a whole number of buckets, ≥ bucketMs). */
  smoothMs: number
  /** bucket count. */
  n: number
  /** smoothed rate (damage per second) per bucket. */
  you: Float64Array
  pet: Float64Array
  inc: Float64Array
  /** peak smoothed OUTGOING (you+pet) rate across the whole fight. */
  peakOut: number
  hasPet: boolean
  hasInc: boolean
  /** true when any damage at all landed in the window. */
  hasAny: boolean
  durationMs: number
  /** true when the source events were downsampled → every rate here is an estimate. */
  estimated: boolean
}

/**
 * Bucket the encounter's events per `bucketMs` and smooth with a TRAILING rolling mean —
 * the same reading a live DPS meter gives ("your damage over the last 5 seconds"), so the
 * curve's height at time t is a rate you could actually have seen on screen at time t.
 * Leading buckets divide by the (shorter) elapsed window rather than the full one, so the
 * curve starts at the real opening rate instead of ramping from a fake zero.
 */
export function buildDpsSeries(tl: TimelineView): DpsSeries {
  const durationMs = Math.max(1000, tl.durationMs)
  const bucketMs = Math.max(1000, Math.ceil(durationMs / MAX_BUCKETS / 1000) * 1000)
  const n = Math.max(1, Math.ceil(durationMs / bucketMs))
  const rawYou = new Float64Array(n)
  const rawPet = new Float64Array(n)
  const rawInc = new Float64Array(n)
  let hasPet = false
  let hasInc = false
  let hasAny = false
  const scale = sampleScale(tl)
  for (const e of tl.events) {
    if (e.amount <= 0) continue
    const i = Math.min(n - 1, Math.max(0, Math.floor(e.t / bucketMs)))
    hasAny = true
    if (e.kind === 'you') rawYou[i] += e.amount
    else if (e.kind === 'pet') {
      rawPet[i] += e.amount
      hasPet = true
    } else {
      rawInc[i] += e.amount
      hasInc = true
    }
  }
  const w = Math.max(1, Math.round(SMOOTH_MS / bucketMs))
  const smooth = (src: Float64Array): Float64Array => {
    const out = new Float64Array(n)
    let run = 0
    for (let i = 0; i < n; i++) {
      run += src[i]
      if (i >= w) run -= src[i - w]
      const spanSec = (Math.min(i + 1, w) * bucketMs) / 1000
      out[i] = (run * scale) / spanSec
    }
    return out
  }
  const you = smooth(rawYou)
  const pet = smooth(rawPet)
  const inc = smooth(rawInc)
  let peakOut = 0
  for (let i = 0; i < n; i++) peakOut = Math.max(peakOut, you[i] + pet[i])
  return {
    bucketMs,
    smoothMs: w * bucketMs,
    n,
    you,
    pet,
    inc,
    peakOut,
    hasPet,
    hasInc,
    hasAny,
    durationMs,
    estimated: scale > 1
  }
}

// ── Damage by mob ──────────────────────────────────────────────────────────────────

export interface MobRow {
  /** raw defender name as the world model labelled it (twins already disambiguated). */
  target: string
  total: number
  hits: number
  crits: number
  /** avoided swings against this mob. */
  misses: number
  /** your spells this mob resisted. */
  resists: number
  /** pct of the LARGEST mob's total (bar fill). */
  pct: number
  /** pct of all event-derived outgoing damage (the ranked share). */
  share: number
}

export interface MobBreakdown {
  rows: MobRow[]
  /** event-derived outgoing total across all mobs. */
  total: number
  estimated: boolean
}

/** Unnamed defender fallback — kept visible rather than silently dropped. */
const UNKNOWN_TARGET = 'unknown target'

/**
 * Group OUTGOING instants (you + pet) by defender. One pass; misses/resists fold into the
 * same row as damage-free counters (law 8 — they're first-class but carry no amount).
 */
export function groupByTarget(tl: TimelineView): MobBreakdown {
  const scale = sampleScale(tl)
  const byTarget = new Map<string, MobRow>()
  let total = 0
  for (const e of tl.events) {
    if (e.kind === 'enemy') continue
    const key = e.target ?? UNKNOWN_TARGET
    let row = byTarget.get(key)
    if (!row) {
      row = { target: key, total: 0, hits: 0, crits: 0, misses: 0, resists: 0, pct: 0, share: 0 }
      byTarget.set(key, row)
    }
    if (e.outcome === 'miss') row.misses += 1
    else if (e.outcome === 'resist') row.resists += 1
    else {
      row.total += e.amount
      row.hits += 1
      if (e.crit) row.crits += 1
      total += e.amount
    }
  }
  const rows = [...byTarget.values()]
  for (const r of rows) {
    r.total *= scale
    r.hits = Math.round(r.hits * scale)
    r.crits = Math.round(r.crits * scale)
    r.misses = Math.round(r.misses * scale)
    r.resists = Math.round(r.resists * scale)
  }
  total *= scale
  rows.sort((a, b) => b.total - a.total || b.hits - a.hits || a.target.localeCompare(b.target))
  const max = Math.max(1, ...rows.map((r) => r.total))
  for (const r of rows) {
    r.pct = (r.total / max) * 100
    r.share = total > 0 ? (r.total / total) * 100 : 0
  }
  return { rows, total, estimated: scale > 1 }
}

export interface TargetDetail {
  /** flat, ranked skill/spell rows for the damage landed on this one mob (slay grouped). */
  rows: SkillRow[]
  total: number
  hits: number
  crits: number
  misses: number
  resists: number
  estimated: boolean
}

/**
 * The level-2 flat skill list for ONE mob: every lane you and your pet landed on it,
 * grouped by (lane, category). You + pet are COMBINED here — the ring's per-event `kind`
 * could split them, but the panel exists to answer "what killed this mob", and a combined
 * list keeps the row set short; the header labels the combination.
 * `max`/`min` are the largest/smallest single observed hits and are deliberately NOT scaled by
 * the sampling factor (a sampled max is a lower bound and a sampled min an upper bound;
 * scaling either would invent a hit that never landed).
 */
export function skillsForTarget(tl: TimelineView, target: string): TargetDetail {
  const scale = sampleScale(tl)
  const byLane = new Map<string, FlatSkill>()
  let total = 0
  let hits = 0
  let crits = 0
  let misses = 0
  let resists = 0
  for (const e of tl.events) {
    if (e.kind === 'enemy') continue
    if ((e.target ?? UNKNOWN_TARGET) !== target) continue
    const key = `${e.category}|${e.lane}`
    let row = byLane.get(key)
    if (!row) {
      row = { name: e.lane, category: e.category, total: 0, pct: 0, hits: 0, crits: 0, max: 0, min: 0, misses: 0, resists: 0 }
      byLane.set(key, row)
    }
    if (e.outcome === 'miss') {
      row.misses = (row.misses ?? 0) + 1
      misses += 1
    } else if (e.outcome === 'resist') {
      row.resists = (row.resists ?? 0) + 1
      resists += 1
    } else {
      row.total += e.amount
      row.hits += 1
      hits += 1
      if (e.crit) crits += 1
      if (e.crit) row.crits += 1
      if (e.amount > row.max) row.max = e.amount
      // min over LANDED amounts only (0 = nothing landed yet — a miss/resist tick carries no
      // amount and must never pull the minimum to 0). Like `max` it is left UNSCALED.
      if (!row.min || e.amount < row.min) row.min = e.amount
      total += e.amount
    }
  }
  const rows = [...byLane.values()]
  for (const r of rows) {
    r.total *= scale
    r.hits = Math.round(r.hits * scale)
    r.crits = Math.round(r.crits * scale)
    r.misses = Math.round((r.misses ?? 0) * scale)
    r.resists = Math.round((r.resists ?? 0) * scale)
  }
  rows.sort((a, b) => b.total - a.total || b.hits - a.hits || a.name.localeCompare(b.name))
  const max = Math.max(1, ...rows.map((r) => r.total))
  for (const r of rows) r.pct = (r.total / max) * 100
  return {
    // Same slay grouping as the source drill — the per-mob list is the same flat list, filtered
    // to one defender, so it must not regrow the per-weapon slay duplicates. Grouping runs AFTER
    // the sample scaling above, so a downsampled ring's group sums the same estimates its
    // children show (all of them wear the panel's `~`).
    rows: groupSlay(rows),
    total: total * scale,
    hits: Math.round(hits * scale),
    crits: Math.round(crits * scale),
    misses: Math.round(misses * scale),
    resists: Math.round(resists * scale),
    estimated: scale > 1
  }
}

// ── Composition strip (authoritative — SourceView, not events) ──────────────────────

export interface CompositionSlice {
  category: DamageCategory
  total: number
  /** pct of the source's whole outgoing total. */
  pct: number
}

// ── Selector SCOPE (Fight vs Overall) ───────────────────────────────────────────────
//
// Fight and Overall are an explicit, user-chosen SCOPE — never an automatic switch. The
// dashboard used to fall back to the live ZONE aggregate whenever no fight was open, so the
// meter silently swapped between pulls; that is the behaviour this replaces. A scope decides
// BOTH what the body shows and what the selector may list:
//
//   fight   → the current fight while one is open, otherwise the LAST fight (labeled as such —
//             a finished fight is never dressed up as live), plus the finalized-fight history.
//             Zone sessions are not listed at all.
//   overall → the live zone session, plus the finalized zone-session history. Fights are not
//             listed at all.
//
// This lives here (a pure, MUI-free module) because every selector surface must filter
// identically: the Combat tab, the 'fight'/'overall' damage overlays and the heal overlays.

export type CombatScope = 'fight' | 'overall'

/**
 * Sentinel selection meaning "whatever the fight scope's head row currently is". It is sent to
 * the engine as *no* `selectedId`, so the engine re-resolves it every tick (open fight → that
 * fight; none open → the most recent finalized fight). Pinning the last fight's real id instead
 * would freeze the meter on it when the next pull started.
 */
export const LIVE_SELECTION = '__live__'

/** One row of a scope-filtered selector. */
export interface ScopeOption {
  /** the value to hand `setSelection` (the LIVE sentinel for the fight scope's head row). */
  value: string
  /** the row's display name — already carries the honest live/last wording for a head row. */
  label: string
  /** raw name without the head-row wording (used for headers/titles). */
  name: string
  dps: number
  /** epoch ms of the segment's start; 0 when unknown. */
  startTs: number
  /** wall-clock length in seconds; 0 when it isn't knowable yet (the running zone session). */
  durationSec: number
  /** genuinely live right now — an OPEN fight, or the current zone session. */
  live: boolean
}

export interface ScopeOptions {
  /** The pinned first row. Null only when the scope has no data at all yet (fresh session). */
  head: ScopeOption | null
  /** Every other row, newest-first. Never contains `head`. */
  rest: ScopeOption[]
}

/** Fight scope: the current-or-last fight, then the finalized-fight history. NO zone sessions. */
export function fightScopeOptions(segments: SegmentSummary[]): ScopeOptions {
  const open = segments.find((s) => s.kind === 'current') ?? null
  const finalized = segments.filter((s) => s.kind === 'fight')
  const headSeg = open ?? finalized[0] ?? null
  if (!headSeg) return { head: null, rest: [] }
  const head: ScopeOption = {
    value: LIVE_SELECTION,
    // State, not process: while a fight is open this row IS the current fight; between pulls it
    // is plainly the last one. It must never read "live" for a finished encounter.
    label: open ? 'Current fight (live)' : `Last fight — ${headSeg.name}`,
    name: headSeg.name,
    dps: headSeg.dps,
    startTs: headSeg.startTs,
    durationSec: headSeg.durationSec,
    live: !!open
  }
  const rest = (open ? finalized : finalized.slice(1)).map((s) => ({
    value: s.id,
    label: s.name,
    name: s.name,
    dps: s.dps,
    startTs: s.startTs,
    durationSec: s.durationSec,
    live: false
  }))
  return { head, rest }
}

/** Overall scope: the live zone session, then the finalized zone-session history. NO fights. */
export function overallScopeOptions(zoneSessions: ZoneSessionSummary[]): ScopeOptions {
  const toRow = (z: ZoneSessionSummary): ScopeOption => ({
    value: z.id,
    label: `${z.zone} — overall`,
    name: `${z.zone} — overall`,
    dps: z.dps,
    startTs: z.startTs,
    durationSec: z.live ? 0 : Math.max(1, (z.endTs - z.startTs) / 1000),
    live: z.live
  })
  const liveZone = zoneSessions.find((z) => z.live) ?? null
  const rest = zoneSessions.filter((z) => z !== liveZone).map(toRow)
  return { head: liveZone ? toRow(liveZone) : (rest.shift() ?? null), rest }
}

/** The scope-filtered selector rows. The ONE place a scope decides what may be listed. */
export function scopeOptions(
  scope: CombatScope,
  segments: SegmentSummary[],
  zoneSessions: ZoneSessionSummary[]
): ScopeOptions {
  return scope === 'fight' ? fightScopeOptions(segments) : overallScopeOptions(zoneSessions)
}

/** The selection a scope starts on (and returns to when the user switches scopes). */
export function defaultSelection(scope: CombatScope): string {
  return scope === 'fight' ? LIVE_SELECTION : 'zone'
}

/** 100%-stacked category composition for one source. Uses the engine's authoritative
 *  category rollups, so it stays exact for ring-less zone sessions too. */
export function composition(e: SourceView): CompositionSlice[] {
  const total = e.categories.reduce((n, c) => n + c.total, 0)
  if (total <= 0) return []
  return e.categories
    .filter((c) => c.total > 0)
    .map((c) => ({ category: c.category, total: c.total, pct: (c.total / total) * 100 }))
}
