// INTERVAL CONSTRUCTION for the class-combo model (docs/plans/class-combo-inference.md § 4.5).
//
// PURE: observations + `/who` rows + level dings + user corrections in, ComboInterval[] out.
//
// A LOADOUT SWAP PRINTS NOTHING. `grep -ci loadout` over 1.1M lines returns 37 hits and every
// one is another player's chat. So every boundary here is INFERENCE, it is always a RANGE
// [startLo, startHi] rather than an instant, and the detectors are ranked by how much the log
// actually said:
//
//   who            two consecutive /who rows disagree. The game NAMED both loadouts; the swap
//                  is somewhere between the rows. Hard, and nothing overrides it.
//   levelDrop      a `Welcome to level N!` with N <= the previous ding. Displayed level is the
//                  MINIMUM of the loadout's class levels, so a non-increasing ding is a swap —
//                  note `<=`, not `<`: the real log has a genuine 11 → 11 REPEAT 0.9 h apart
//                  that a strict-descent predicate misses. (levelSeries.ts keeps `<` on
//                  purpose and is pinned by its own golden window — do not "fix" it.)
//   evidenceShift  a class with sustained exclusive evidence goes silent and a different one
//                  starts. This is what NARROWS a boundary: the Aug 2 swap is bracketed 33.9 h
//                  apart by level dings, and to ~60 min (last MNK Feign Death 00:57:55 → first
//                  ROG Backstab 01:57:42) by the shift. Both fire for the same swap; the
//                  narrower window wins and the other is recorded in `startAlso`.
//
// The one thing a `/who` row NEVER loses to is a narrower inferred window — hence the explicit
// precedence in `mergeBoundaries`.

import type {
  ClassAbbr,
  ClassObservation,
  ComboBoundaryReason,
  ComboCorrection,
  ComboInterval,
  ComboSlot
} from '../../shared/classCombo'
import { scoreSlots, statedSlots } from './comboScore'

/** A `/who` row, reduced to what interval construction needs. */
export interface WhoRow {
  ts: number
  seq: number
  classes: ClassAbbr[]
  /** the bracketed level — min over the loadout, so it is the interval's level too. */
  level: number
}

/** A `You have gained a level!` ding. */
export interface LevelPoint {
  ts: number
  level: number
}

export interface IntervalInput {
  observations: readonly ClassObservation[]
  whoRows: readonly WhoRow[]
  levels: readonly LevelPoint[]
  corrections: readonly ComboCorrection[]
}

/** One detected swap: it happened somewhere in [lo, hi]; `at` is where we cut. */
export interface Boundary {
  lo: number
  hi: number
  /** best estimate — always `hi`: the new loadout is only PROVEN at the arriving evidence. */
  at: number
  reason: ComboBoundaryReason
  /** other detectors that fired for the same swap. */
  also?: ComboBoundaryReason[]
}

/** The tertiary slot unlocks at level 10 — a PRIOR, overridden by a /who row's own arity. */
const TERTIARY_UNLOCK_LEVEL = 10

/** § 4.5 R8: never bisect below this, or an ambiguous span thrashes into confetti. */
const WINDOW_FLOOR_MS = 15 * 60_000

/** Bound on shift bisection. The real log needs one cut; this is the runaway guard. */
const MAX_SHIFT_CUTS = 16

// --------------------------------------------------------------------- detectors

/**
 * Consecutive `/who` rows that disagree, MINUS the swaps something sharper already dated.
 *
 * A `/who` pair only bounds the swap by "somewhere between these two rows", which in this log
 * runs to three hours and to 33 hours elsewhere. So the rule is: the disagreement is PROOF that
 * a swap happened, but if any already-detected boundary falls inside `(prev, row]` then that
 * boundary IS this swap, dated better, and adding a second one here would split the same event
 * twice. Only an undated disagreement opens its own (wide, honest) boundary.
 *
 * The FIRST row never opens one: with no earlier statement there is nothing to disagree with,
 * and splitting there would manufacture an empty interval in front of every anchored span.
 */
export function whoBoundaries(
  rows: readonly WhoRow[],
  dated: readonly Boundary[] = []
): Boundary[] {
  const out: Boundary[] = []
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1]
    const row = rows[i]
    if (prev.classes.join('/') === row.classes.join('/')) continue
    if (dated.some((b) => b.at > prev.ts && b.at <= row.ts)) continue
    out.push({ lo: prev.ts, hi: row.ts, at: row.ts, reason: 'who' })
  }
  return out
}

/**
 * A non-increasing level ding. The window is honestly WIDE — the Aug 2 swap's is 33.9 h — and
 * the UI is expected to draw it as a range. Exported so a test can assert that the evidence
 * shift genuinely NARROWS this rather than replacing a window nobody looked at.
 */
export function levelDropBoundaries(levels: readonly LevelPoint[]): Boundary[] {
  const out: Boundary[] = []
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1]
    const ding = levels[i]
    if (ding.level > prev.level) continue
    out.push({ lo: prev.ts, hi: ding.ts, at: ding.ts, reason: 'levelDrop' })
  }
  return out
}

/** A class's exclusive-evidence span, for classes the window actually stands behind. */
interface Span {
  cls: ClassAbbr
  first: number
  last: number
}

/**
 * Classes carrying SUSTAINED EXCLUSIVE evidence — ≥2 distinct hourly buckets of observations
 * that name that class and nothing else.
 *
 * A STRICTER bar than admission on purpose. Admission's `sustain` counts every bucket holding
 * any evidence for the class, twelve-class invocations included; that is the right question for
 * "is this class in the loadout", and the WRONG one for "when was this class present", where a
 * shared invocation would smear a class across the whole log and manufacture boundaries. Here
 * only the class's own unambiguous evidence draws the span.
 */
function exclusiveSpans(observations: readonly ClassObservation[]): Span[] {
  const spans = new Map<ClassAbbr, Span & { buckets: Set<number> }>()
  for (const o of observations) {
    if (o.candidates.length !== 1) continue
    const cls = o.candidates[0]
    const span = spans.get(cls)
    if (span) {
      span.first = Math.min(span.first, o.ts)
      span.last = Math.max(span.last, o.ts)
      span.buckets.add(Math.floor(o.ts / 3_600_000))
    } else {
      spans.set(cls, { cls, first: o.ts, last: o.ts, buckets: new Set([Math.floor(o.ts / 3_600_000)]) })
    }
  }
  return [...spans.values()]
    .filter((s) => s.buckets.size >= 2)
    .map(({ cls, first, last }) => ({ cls, first, last }))
}

/**
 * ONE cut inside a window, or null.
 *
 * The window is over-determined when more classes carry sustained exclusive evidence than a
 * loadout can hold. The swap is then bounded below by the EARLIEST departure (the first class
 * to fall silent — `Feign Death` at 00:57:55) and above by the EARLIEST arrival after it (the
 * first class to appear — `Backstab` at 01:57:42). Earliest on both ends is what makes the
 * window narrow AND honest: anything before the departure is still the old loadout, anything
 * from the first arrival on is provably the new one.
 */
function cutOnce(observations: readonly ClassObservation[], expectedSlots: number): Boundary | null {
  const spans = exclusiveSpans(observations)
  if (spans.length <= expectedSlots) return null
  const departing = spans.reduce((a, b) => (b.last < a.last ? b : a))
  const arrivals = spans.filter((s) => s.first > departing.last)
  if (arrivals.length === 0) return null
  const arriving = arrivals.reduce((a, b) => (b.first < a.first ? b : a))
  if (arriving.first - departing.last < 0) return null
  return { lo: departing.last, hi: arriving.first, at: arriving.first, reason: 'evidenceShift' }
}

/**
 * Evidence-shift boundaries inside one hard segment, found by bisecting until every sub-window
 * holds at most `expectedSlots` sustained classes. On hitting the 15-minute floor while still
 * over-determined we DO NOT split — an honest "we can't tell" beats a fabricated boundary
 * (§ 4.5); the interval keeps its candidates wide and `startAlso` records `overDetermined`.
 */
export function evidenceShiftBoundaries(
  observations: readonly ClassObservation[],
  expectedSlots: number
): Boundary[] {
  const out: Boundary[] = []
  const queue: (readonly ClassObservation[])[] = [observations]
  while (queue.length > 0 && out.length < MAX_SHIFT_CUTS) {
    const window = queue.shift()
    if (!window || window.length === 0) continue
    const span = window[window.length - 1].ts - window[0].ts
    if (span < WINDOW_FLOOR_MS) continue
    const cut = cutOnce(window, expectedSlots)
    if (!cut) continue
    out.push(cut)
    queue.push(
      window.filter((o) => o.ts <= cut.lo),
      window.filter((o) => o.ts >= cut.hi)
    )
  }
  return out.sort((a, b) => a.at - b.at)
}

// --------------------------------------------------------------------- assembly

/**
 * Windows that OVERLAP describe the same swap, and the NARROWEST of them is the answer. This
 * is the wave-2 correction made structural: the Aug 2 level ding says "somewhere in these 33.9
 * hours" and the evidence shift says "somewhere in these 60 minutes", about the same event —
 * so the shift wins the window and the ding is recorded in `also` rather than thrown away.
 *
 * The CUT itself is the EARLIEST `at` any detector in the group offers (clamped into the
 * winning window). `at` is where the new interval opens, so taking the earliest keeps a `/who`
 * row on the far side of a narrower inferred boundary inside the interval it describes.
 */
function pickBoundary(group: Boundary[]): Boundary {
  const best = group.reduce((a, b) => (b.hi - b.lo < a.hi - a.lo ? b : a))
  const at = Math.min(Math.max(Math.min(...group.map((b) => b.at)), best.lo), best.hi)
  const also = group.filter((b) => b !== best).map((b) => b.reason)
  const merged: Boundary = { ...best, at }
  if (also.length > 0) merged.also = [...new Set(also)]
  return merged
}

/** Collapse overlapping candidates into one boundary each, in time order. Windows that merely
 *  TOUCH (one ends exactly where the next begins) are separate swaps, not one. */
export function mergeBoundaries(candidates: readonly Boundary[]): Boundary[] {
  const sorted = [...candidates].sort((a, b) => a.lo - b.lo || a.hi - b.hi)
  const out: Boundary[] = []
  let group: Boundary[] = []
  let groupHi = -Infinity
  for (const b of sorted) {
    if (group.length > 0 && b.lo >= groupHi) {
      out.push(pickBoundary(group))
      group = []
    }
    group.push(b)
    groupHi = Math.max(groupHi, b.hi)
  }
  if (group.length > 0) out.push(pickBoundary(group))
  return out.sort((a, b) => a.at - b.at)
}

/** Split observations at hard cut points so shift detection never reasons across a swap the
 *  log already announced. */
function hardSegments(
  observations: readonly ClassObservation[],
  hard: readonly Boundary[]
): (readonly ClassObservation[])[] {
  if (hard.length === 0) return [observations]
  const cuts = hard.map((b) => b.at).sort((a, b) => a - b)
  const segments: ClassObservation[][] = Array.from({ length: cuts.length + 1 }, () => [])
  for (const o of observations) {
    let i = 0
    while (i < cuts.length && o.ts >= cuts[i]) i++
    segments[i].push(o)
  }
  return segments
}

/** Every raw slice of the timeline, before scoring: [start, end) plus the boundary that made it. */
interface Slice {
  start: Boundary
  end: number | null
  observations: ClassObservation[]
}

function sliceTimeline(
  observations: readonly ClassObservation[],
  boundaries: readonly Boundary[],
  firstTs: number
): Slice[] {
  const opens: Boundary[] = [
    { lo: firstTs, hi: firstTs, at: firstTs, reason: 'logStart' },
    ...boundaries
  ]
  return opens.map((start, i) => {
    const end = i + 1 < opens.length ? opens[i + 1].at : null
    return {
      start,
      end,
      observations: observations.filter((o) => o.ts >= start.at && (end === null || o.ts < end))
    }
  })
}

/** The level in force at `ts` — the last /who row or ding at or before it. */
function levelAt(input: IntervalInput, ts: number): number | null {
  let level: number | null = null
  for (const p of input.levels) if (p.ts <= ts) level = p.level
  for (const r of input.whoRows) if (r.ts <= ts) level = r.level
  return level
}

/** The correction covering `ts`, latest `setAt` first (a later edit supersedes an earlier one). */
function correctionAt(corrections: readonly ComboCorrection[], ts: number): ComboCorrection | null {
  const hits = corrections.filter((c) => ts >= c.startTs && (c.endTs === null || ts <= c.endTs))
  if (hits.length === 0) return null
  return hits.reduce((a, b) => (b.setAt >= a.setAt ? b : a))
}

/**
 * Slots for one slice, in authority order (§ 4.4):
 *   1. the LAST `/who` row inside it — the game named the loadout for this very span, so it
 *      wins even over a user correction (a correction on an anchored span is the user being
 *      wrong, and it is the game that just spoke),
 *   2. a user correction covering it,
 *   3. inference.
 * A `/who` row also sets `expectedSlots` from its own arity, which is ground truth about
 * cardinality, not just membership.
 */
function slotsFor(
  slice: Slice,
  input: IntervalInput,
  prior: 2 | 3
): { slots: ComboSlot[]; expectedSlots: 2 | 3; provenanceLock: boolean } {
  const rows = input.whoRows.filter(
    (r) => r.ts >= slice.start.at && (slice.end === null || r.ts < slice.end)
  )
  const row = rows.length > 0 ? rows[rows.length - 1] : null
  if (row) {
    const expected = row.classes.length === 2 ? 2 : 3
    return { slots: statedSlots(row.classes, 'who'), expectedSlots: expected, provenanceLock: false }
  }
  const correction = correctionAt(input.corrections, slice.start.at)
  if (correction) {
    const expected = correction.classes.length === 2 ? 2 : 3
    return {
      slots: statedSlots(correction.classes, 'user'),
      expectedSlots: expected,
      provenanceLock: true
    }
  }
  return { slots: scoreSlots(slice.observations, prior), expectedSlots: prior, provenanceLock: false }
}

/** Levels observed inside a slice, for the interval's honest level range. */
function levelRange(input: IntervalInput, slice: Slice): [number | null, number | null] {
  const inside = [
    ...input.levels.filter((p) => p.ts >= slice.start.at && (slice.end === null || p.ts < slice.end)),
    ...input.whoRows.filter((r) => r.ts >= slice.start.at && (slice.end === null || r.ts < slice.end))
  ].map((p) => p.level)
  const at = levelAt(input, slice.start.at)
  if (at !== null) inside.push(at)
  if (inside.length === 0) return [null, null]
  return [Math.min(...inside), Math.max(...inside)]
}

function toInterval(slice: Slice, input: IntervalInput, index: number): ComboInterval {
  const [levelLo, levelHi] = levelRange(input, slice)
  const prior: 2 | 3 = levelLo !== null && levelLo < TERTIARY_UNLOCK_LEVEL ? 2 : 3
  const { slots, expectedSlots, provenanceLock } = slotsFor(slice, input, prior)
  const last = slice.observations[slice.observations.length - 1]
  const interval: ComboInterval = {
    id: `ci${index + 1}`,
    startTs: slice.start.at,
    endTs: slice.end,
    startLo: slice.start.lo,
    startHi: slice.start.hi,
    // An OPEN interval has not ended, so `endHi` stays null — but `endLo` is honest and useful:
    // it is the last moment we HAVE evidence for, i.e. "it was still this loadout at least
    // until here". A closed interval's end is simply the next boundary's cut.
    endLo: slice.end ?? last?.ts ?? null,
    endHi: slice.end,
    startReason: slice.start.reason,
    expectedSlots,
    slots,
    levelLo,
    levelHi,
    evidenceCount: slice.observations.length,
    userLocked: provenanceLock
  }
  const also = [...(slice.start.also ?? [])]
  // The window could not be split further and still names more classes than a loadout holds:
  // say so rather than silently dropping the surplus (§ 4.5's floor rule).
  if (exclusiveSpans(slice.observations).length > expectedSlots) also.push('overDetermined')
  if (also.length > 0) interval.startAlso = [...new Set(also)]
  return interval
}

/** Two intervals that resolve to the SAME classes across a SOFT boundary were never two. */
function mergeable(a: ComboInterval, b: ComboInterval): boolean {
  if (b.startReason === 'who' || b.startReason === 'levelDrop' || b.startReason === 'user') {
    return false
  }
  if (a.userLocked || b.userLocked) return false
  const key = (i: ComboInterval): string =>
    i.slots.map((s) => s.candidates.join('|')).sort().join('/')
  return key(a) === key(b)
}

/**
 * The whole pass. Observations MUST arrive in seq order (the module keeps them that way).
 *
 * Note this recomputes from scratch every time — that is deliberate (§ 4.5): a `/who` typed an
 * hour from now, or a user correction, retroactively re-labels the past, and patching intervals
 * in place would leave a stale id pointing at a span that no longer exists. Ids are therefore
 * snapshot-scoped and the delta carries `removed`.
 */
export function buildIntervals(input: IntervalInput): ComboInterval[] {
  const observations = [...input.observations].sort((a, b) => a.seq - b.seq)
  if (observations.length === 0) return []
  // Level dings first (the log SAYS a swap happened), then the evidence shift inside each
  // segment they cut — a shift is only meaningful within one announced era. `/who`
  // disagreements come LAST because they only fire where nothing sharper already cut.
  const drops = levelDropBoundaries(input.levels)
  const shifts = hardSegments(observations, mergeBoundaries(drops)).flatMap((segment) =>
    // The prior is enough here: a 2-slot era simply cannot be over-determined at 3.
    evidenceShiftBoundaries(segment, 3)
  )
  const dated = mergeBoundaries([...drops, ...shifts])
  const boundaries = mergeBoundaries([
    ...dated,
    ...whoBoundaries(input.whoRows, dated)
  ]).filter((b) => b.at > observations[0].ts)
  const slices = sliceTimeline(observations, boundaries, observations[0].ts)
  const built = slices.map((slice, i) => toInterval(slice, input, i))
  return collapse(built)
}

/** Post-pass for the merge rule (§ 4.5): a soft boundary between identical slot sets was noise. */
function collapse(intervals: ComboInterval[]): ComboInterval[] {
  const out: ComboInterval[] = []
  for (const interval of intervals) {
    const prev = out[out.length - 1]
    if (prev && mergeable(prev, interval)) {
      prev.endTs = interval.endTs
      prev.endLo = interval.endLo
      prev.endHi = interval.endHi
      prev.evidenceCount += interval.evidenceCount
      prev.levelHi = Math.max(prev.levelHi ?? -Infinity, interval.levelHi ?? -Infinity)
      if (prev.levelHi === -Infinity) prev.levelHi = null
      continue
    }
    out.push({ ...interval, id: `ci${out.length + 1}` })
  }
  return out
}
