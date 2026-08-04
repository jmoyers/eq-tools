// progressionStats.ts — the PURE range query over ProgressionSnap (see
// docs/plans/leveling-analytics.md §4). No React, no Electron, no I/O: one function over one
// columnar snapshot, so the whole feature's arithmetic is unit-testable without a window.
//
// It lives in src/shared (not src/main) because BOTH tsconfigs must see it: main folds the
// snapshot, the renderer queries it, and the node tests import it directly.
//
// WHAT THE NUMBERS MEAN (law 1 — say what the log cannot say):
//   • `levelEquiv` is Σ of the STATED level-bar percentages / 100 — "levels of progress",
//     NEVER "experience points". The log prints a per-kill percentage of the CURRENT level's
//     bar and nothing else: no raw exp number, no to-next-level total, no bar position. 1% at
//     level 40 is far more raw experience than 1% at level 10, so these are levels, not xp.
//   • An exp line that stated NO percentage (the game prints one only while a level bar
//     exists — in the real log every such line sits inside one contiguous at-the-cap window)
//     contributes to `expUnstated` and to NOTHING else. It is never counted as 0%.
//     When a range's exp samples are ALL unstated, every levels-rate is `null`, not 0.0:
//     unknown is not zero. (This is stricter than the plan text, which nulls the rates only
//     on activeMs === 0 — a "0.0 levels/hr" over a window where the game refused to report
//     progress would be a fabricated number.)
//   • `kills` counts CREDITED kills only (your killing blow + a bound pet's). Kills you
//     merely witnessed are `killsWitnessed` and enter no rate, so a busy zone full of other
//     players cannot inflate your farming numbers.
//   • IDLE is PRESENT-BUT-UNPRODUCTIVE; OFFLINE is ABSENT. These are two different claims and
//     this file keeps them in two different fields.
//
//     Within a session the log records EVENTS, not PRESENCE — medding, banking, crafting,
//     travelling and being AFK at the keyboard are all the same silence, and `idleMs` is that
//     silence. Call it "idle": never "AFK" (the log cannot see a chair) and never "offline"
//     (see below).
//
//     What the log CAN state is a logout, and only in hindsight: the `offlineGap` derived
//     event is emitted after the login line ("Welcome to EverQuest Legends!") that ENDED the
//     absence, carrying the camp line's evidence when there was one. Those intervals are
//     `offlineMs`, they are SUBTRACTED out of `idleMs` (a logout is not medding), and they are
//     the reason a 13.7-hour overnight no longer reads as the largest idle gap of the week.
//
//     THE LIMIT, STATED (laws 1/6): the user may be logged out RIGHT NOW and this app cannot
//     know it — the only evidence would be a login line that has not been written yet. So
//     silence at the LIVE EDGE is still idle, and no surface may call it offline. When the
//     snapshot carries no offline interval at all, every number here is byte-identical to what
//     it was before offline existed.

// Imported from the transport module directly (types.ts re-exports the same names) — a shared
// file importing the barrel it is part of would be a needless cycle.
import type { ProgressionSnap } from './progressionTypes'

/**
 * No exp / credited-kill / loot event for LONGER than this ⇒ idle.
 *
 * MEASURED, not guessed: over the 9869 post-epoch activity events the inter-activity gap
 * distribution is p50 4s · p75 25s · p90 52s · p95 87s · p99 314s · max 13.7h. 5 minutes sits
 * just above p99, so under 1% of ordinary between-pull gaps get misread as idle, and the
 * sensitivity curve flattens hard right after it (5m → 10m moves only 4 points of a 146h
 * span). It is a CLASSIFIER, not a grace period: a qualifying gap contributes its WHOLE
 * length to idle time, not `gap - threshold`. Surface it (`RangeStats.idleThresholdMs`)
 * wherever an idle number is shown — the threshold is a choice, not a fact.
 */
export const IDLE_GAP_MS = 5 * 60_000

/** The row that covers range time before the first known zone line. */
const UNKNOWN_ZONE = 'unknown'

const MS_PER_HOUR = 3_600_000

export interface ZoneRangeRow {
  /** RAW display name, first-seen casing (law 2: canonicalize at boundaries, display raw). */
  zone: string
  /** ms of the selection spent in this zone (Σ over every visit inside the range). */
  spanMs: number
  /** spanMs minus idleMs minus offlineMs. */
  activeMs: number
  /** present-but-unproductive silence. EXCLUDES `offlineMs` — a logout is not medding. */
  idleMs: number
  /**
   * ms of this zone's span the log says you were LOGGED OUT.
   *
   * A logout lands INSIDE the zone interval you logged out in — the login writes a fresh zone
   * line, so the old interval stays open until then — which is why this is the zone row's own
   * column rather than a share of its idle. The overnight belongs to the camp you left, and
   * the camp's `activeMs` / rates must not be judged by it.
   */
  offlineMs: number
  visits: number
  kills: number
  killsSelf: number
  killsPet: number
  /** Σ stated level-bar percent, /100. Excludes unstated samples. */
  levelEquiv: number
  /** exp lines whose percentage the log did not state (at cap). */
  expUnstated: number
  expSamples: number
  /** null when activeMs is 0, or when every exp sample here was unstated. */
  levelsPerHourActive: number | null
  /** per hour of ONLINE wall (`spanMs - offlineMs`) — see `RangeStats.levelsPerHourWall`. */
  levelsPerHourWall: number | null
  killsPerHourActive: number | null
}

export interface ComboInterval {
  startTs: number
  endTs: number
  /** e.g. ['PAL','MNK','ENC'] — display order as stated. */
  classes: string[]
  /** the combo agent's own confidence flag; chipped `inferred` when true. */
  inferred: boolean
}

/**
 * Implemented by the class-combo module (a separate plan). STRUCTURAL — this file declares
 * the shape it needs and never imports the combo implementation, so this feature compiles and
 * ships before that work lands. `rangeStats` calls `intervalsIn` EXACTLY ONCE and stores the
 * result verbatim: zero inference, zero merging, zero gap-filling. Absent ⇒ `combos: []`,
 * which is a first-class state, not an error (the self `/who` row is the only line that ever
 * states a loadout and there are 11 in 1.1M lines, so "unknown" is the COMMON case).
 */
export interface ComboSource {
  /** the loadout active at `ts`, or null when nothing is known at that instant. */
  comboAt(ts: number): ComboInterval | null
  /** every combo interval overlapping [t0,t1), clipped to it, ascending. */
  intervalsIn(t0: number, t1: number): ComboInterval[]
}

export interface RangeStats {
  t0: number
  t1: number
  durationMs: number
  /**
   * THE Σ IDENTITY, pinned by the tests: `activeMs + idleMs + offlineMs === durationMs`.
   * Every instant of the selection is exactly one of playing, present-but-silent, and gone.
   */
  activeMs: number
  /**
   * Present-but-unproductive silence, with any derived offline interval CARVED OUT of it. So
   * an overnight logout adds to `offlineMs`, not here — while the four minutes you spent
   * finding your corpse after logging back in are still idle, because they are.
   */
  idleMs: number
  /**
   * Number of idle spans in the range. Counted AFTER offline is carved out, so one overnight
   * silence can leave a short present-but-idle remainder at either end of it and those
   * remainders are counted (they are real time you were logged in and quiet). With no offline
   * interval in range this is exactly what it always was: the gaps over IDLE_GAP_MS.
   */
  idleGaps: number
  idleThresholdMs: number

  /**
   * ms of the range the log says you were LOGGED OUT — Σ of the derived `offlineGap` intervals
   * clipped to the selection. 0 when the log stated no logout, which is not the same fact as
   * "you were online" (see the file header's live-edge limit) and must never be worded as one.
   */
  offlineMs: number
  /** how many derived offline intervals intersect the range. 0 ⇒ say nothing about offline. */
  offlineGaps: number

  kills: number
  killsSelf: number
  killsPet: number
  killsWitnessed: number

  expSamples: number
  expParty: number
  expUnstated: number
  /** Σ stated percent / 100 — "levels of progress", NOT experience points. */
  levelEquiv: number
  levelsPerHourActive: number | null
  /**
   * Levels of progress per hour of ONLINE WALL time — `durationMs - offlineMs`, NOT the
   * selection's raw wall clock.
   *
   * The name is kept for its callers; the honest reading is "per online hour". A rate whose
   * denominator counted a logout would be arithmetic about an empty chair: an overnight in the
   * window drove this toward zero and made every ETA built on it meaningless, which is the
   * whole reason offline exists. WALL still means "including the idle time you actually spent
   * in the game" — medding and looting stay in the denominator, deliberately, because you will
   * experience the projection in that same wall time. Null when the online wall is 0 (a range
   * that is entirely offline), or when every exp sample in range was unstated.
   *
   * With no offline interval in range this is EXACTLY the old wall rate — same denominator,
   * same number, byte for byte.
   */
  levelsPerHourWall: number | null
  killsPerHourActive: number | null

  /** dings inside the range, in order. */
  levelUps: { ts: number; level: number }[]
  /**
   * Disjoint level runs — a loadout swap opens a NEW run, never a negative span. EQ Legends
   * gives a character ONE level shared by a three-class loadout, and swapping a class in
   * drops that level with NO log line of any kind; the same rule as `buildLevelSegments`
   * (renderer levelSeries.ts): a value below the previous one starts a new run.
   */
  levelRuns: { fromLevel: number; toLevel: number; startTs: number; endTs: number }[]

  /** Σ of the gain LINES in range. NOT the AA identity — a respec re-logs purchases and
   *  refunds nothing, so this over-reports re-earned points. Label it at every surface,
   *  exactly like the existing "AA gained over time" caption. (law 5) */
  aaGained: number
  aaGainEvents: number

  zones: ZoneRangeRow[]
  combos: ComboInterval[]

  /** true when t0 < snapshot.windowStart — the panel must say the range is clipped. */
  clipped: boolean
}

export interface RangeStatsArgs {
  snap: ProgressionSnap
  range: { t0: number; t1: number }
  /** OPTIONAL seam. Absent ⇒ `combos: []`. */
  combo?: ComboSource
}

/** One clipped zone visit inside the range. Contiguous and gapless by construction. */
interface ZoneSeg {
  key: string
  name: string
  start: number
  end: number
}

interface Span {
  start: number
  end: number
}

/**
 * Case-insensitive zone key. Mirrors main/log/parseCommon.ts `idKey` for zone names (trim +
 * lowercase); src/shared cannot import from src/main, and idKey's extra 'you'/'yourself'
 * folding is about entity names and can never apply to a zone.
 */
function zoneIdKey(name: string): string {
  return name.trim().toLowerCase()
}

/** First index i with arr[i] >= v (arr ascending). */
function lowerBound(arr: readonly number[], v: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First index i with arr[i] > v (arr ascending). */
function upperBound(arr: readonly number[], v: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The last value strictly before `t`, or null. */
function prevBefore(arr: readonly number[], t: number): number | null {
  const i = lowerBound(arr, t)
  return i > 0 ? arr[i - 1] : null
}

/** The first value at or after `t`, or null. */
function nextFrom(arr: readonly number[], t: number): number | null {
  const i = lowerBound(arr, t)
  return i < arr.length ? arr[i] : null
}

/**
 * The zone visits covering [t0,t1), clipped, in order. The pre-first-zone remainder gets its
 * own `unknown` segment and the still-open final interval runs to the end of the SELECTION
 * (you never left it) — together those two rules are what make `Σ zones[].spanMs ==
 * durationMs` an identity rather than an approximation.
 */
function zoneSegments(snap: ProgressionSnap, t0: number, t1: number): ZoneSeg[] {
  const segs: ZoneSeg[] = []
  const n = snap.zoneName.length
  const headEnd = Math.min(n > 0 ? snap.zoneStart[0] : t1, t1)
  if (headEnd > t0) segs.push({ key: UNKNOWN_ZONE, name: UNKNOWN_ZONE, start: t0, end: headEnd })
  // The last interval starting at/before t0 is the one we are inside when the range opens.
  for (let i = Math.max(0, upperBound(snap.zoneStart, t0) - 1); i < n && snap.zoneStart[i] < t1; i++) {
    const start = Math.max(snap.zoneStart[i], t0)
    const end = Math.min(snap.zoneEnd[i] === 0 ? t1 : snap.zoneEnd[i], t1)
    if (end > start) segs.push({ key: zoneIdKey(snap.zoneName[i]), name: snap.zoneName[i], start, end })
  }
  return segs
}

/**
 * Index of the segment containing `ts`, or -1 when the range has no segments. A `ts` past the
 * last segment clamps to it, so every in-range sample is attributed exactly once and the
 * `Σ zones[].kills == kills` identity holds by construction.
 */
function segAt(segs: readonly ZoneSeg[], ts: number): number {
  let lo = 0
  let hi = segs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (segs[mid].end <= ts) lo = mid + 1
    else hi = mid
  }
  return lo < segs.length ? lo : segs.length - 1
}

/**
 * The idle spans inside [t0,t1]. The stream is exp ∪ credited kill ∪ loot; the samples
 * BRACKETING the range are pulled in unconditionally (not merely padded by the threshold) so
 * a gap that STRADDLES a selection edge is measured instead of the edge manufacturing
 * activity. When no bracketing sample exists the edge itself anchors the walk — silence with
 * nothing before it is still silence.
 */
function idleSpans(snap: ProgressionSnap, t0: number, t1: number): Span[] {
  const cols = [snap.expTs, snap.killTs, snap.lootTs]
  const stream: number[] = []
  for (const col of cols) for (let i = lowerBound(col, t0); i < lowerBound(col, t1); i++) stream.push(col[i])
  stream.sort((a, b) => a - b)
  const prev = cols.map((c) => prevBefore(c, t0)).filter((v): v is number => v !== null)
  const next = cols.map((c) => nextFrom(c, t1)).filter((v): v is number => v !== null)
  const walk = [prev.length ? Math.max(...prev) : t0, ...stream, next.length ? Math.min(...next) : t1]
  const spans: Span[] = []
  for (let i = 1; i < walk.length; i++) {
    if (walk[i] - walk[i - 1] <= IDLE_GAP_MS) continue
    const start = Math.max(walk[i - 1], t0)
    const end = Math.min(walk[i], t1)
    if (end > start) spans.push({ start, end })
  }
  return spans
}

/**
 * The offline intervals overlapping [t0,t1), clipped to it. Ascending and disjoint by
 * construction (each row is one `offlineGap`, and a gap ends where the session that ended it
 * begins), so no merging is needed — and none is invented: an interval is quoted exactly as
 * the log's two lines stated it.
 */
function offlineSpansIn(snap: ProgressionSnap, t0: number, t1: number): Span[] {
  const out: Span[] = []
  const n = snap.offlineStart.length
  for (let i = Math.max(0, upperBound(snap.offlineStart, t0) - 1); i < n && snap.offlineStart[i] < t1; i++) {
    const start = Math.max(snap.offlineStart[i], t0)
    const end = Math.min(snap.offlineEnd[i], t1)
    if (end > start) out.push({ start, end })
  }
  return out
}

/**
 * How much of [t0,t1) the log says you were logged out. Exported because the Overview card's
 * per-level history needs the same subtraction over spans this file never sees (a level took
 * 13.9 hours only if you were there for them).
 */
export function offlineMsIn(snap: ProgressionSnap, t0: number, t1: number): number {
  return offlineSpansIn(snap, t0, t1).reduce((n, s) => n + (s.end - s.start), 0)
}

/**
 * `spans` minus `cuts` — both ascending and disjoint. This is what makes idle and offline
 * DISJOINT rather than double-counted: an offline interval always sits inside a silence (you
 * killed nothing while logged out), so without the subtraction the same hours would be both,
 * and `active + idle + offline == duration` could not hold.
 *
 * A cut through the middle of a silence SPLITS it, which is honest: the minutes before you
 * camped and the minutes after you logged back in are separate stretches of being present and
 * quiet, and neither is the logout.
 */
function subtractSpans(spans: readonly Span[], cuts: readonly Span[]): Span[] {
  if (cuts.length === 0) return [...spans]
  const out: Span[] = []
  for (const s of spans) {
    let start = s.start
    for (const c of cuts) {
      if (c.end <= start || c.start >= s.end) continue
      if (c.start > start) out.push({ start, end: c.start })
      start = c.end
    }
    if (start < s.end) out.push({ start, end: s.end })
  }
  return out
}

/** How much of `spans` falls inside [start,end). Spans are disjoint, so this is a plain Σ. */
function overlapMs(spans: readonly Span[], start: number, end: number): number {
  let total = 0
  for (const s of spans) {
    const overlap = Math.min(s.end, end) - Math.max(s.start, start)
    if (overlap > 0) total += overlap
  }
  return total
}

function newRow(zone: string): ZoneRangeRow {
  return {
    zone,
    spanMs: 0,
    activeMs: 0,
    idleMs: 0,
    offlineMs: 0,
    visits: 0,
    kills: 0,
    killsSelf: 0,
    killsPet: 0,
    levelEquiv: 0,
    expUnstated: 0,
    expSamples: 0,
    levelsPerHourActive: null,
    levelsPerHourWall: null,
    killsPerHourActive: null
  }
}

/**
 * A rate per hour, or null when the window is zero-length. `perHour` is deliberately NOT
 * called for the levels rates when the range's exp samples were all unstated — see
 * `levelsUnknown`.
 */
function perHour(amount: number, windowMs: number): number | null {
  return windowMs > 0 ? amount / (windowMs / MS_PER_HOUR) : null
}

/** True when the log gained experience here but never stated how much (law 1: unknown ≠ 0). */
function levelsUnknown(expSamples: number, expUnstated: number): boolean {
  return expSamples > 0 && expSamples === expUnstated
}

/** Rows in segment order, one per distinct zone key, with spanMs/visits/idle/offline folded in. */
function buildRows(
  segs: readonly ZoneSeg[],
  idle: readonly Span[],
  offline: readonly Span[]
): { rows: ZoneRangeRow[]; of: number[] } {
  const index = new Map<string, number>()
  const rows: ZoneRangeRow[] = []
  const of: number[] = []
  for (const seg of segs) {
    let at = index.get(seg.key)
    if (at === undefined) {
      at = rows.length
      index.set(seg.key, at)
      rows.push(newRow(seg.name))
    }
    of.push(at)
    rows[at].spanMs += seg.end - seg.start
    rows[at].visits += 1
    // Split every idle AND offline span at the zone boundaries it crosses, so per-zone idle
    // and offline each sum to the range's own total EXACTLY (the attribution is exact — a zone
    // line is a real event — even though WHY you were idle there is not in the log at all).
    // In practice an offline span never crosses one: the login writes a fresh zone line, so
    // the whole absence belongs to the camp you left.
    rows[at].idleMs += overlapMs(idle, seg.start, seg.end)
    rows[at].offlineMs += overlapMs(offline, seg.start, seg.end)
  }
  return { rows, of }
}

/** The per-range scratch every fold writes through: the clipped visits, their rows, and the
 *  segment→row index. Bundled because ESLint `max-params` is 4 and each fold also needs the
 *  snapshot and the bounds. */
interface FoldCtx {
  segs: readonly ZoneSeg[]
  rows: ZoneRangeRow[]
  of: readonly number[]
  t0: number
  t1: number
}

/** The row a sample at `ts` belongs to. Total whenever the range has any span at all. */
function rowAt(ctx: FoldCtx, ts: number): ZoneRangeRow | null {
  const at = segAt(ctx.segs, ts)
  return at < 0 ? null : ctx.rows[ctx.of[at]]
}

/** Fold the credited kills of [t0,t1) into the range totals and their zone rows. */
function foldKills(snap: ProgressionSnap, ctx: FoldCtx): Pick<RangeStats, 'kills' | 'killsSelf' | 'killsPet'> {
  let kills = 0
  let killsSelf = 0
  let killsPet = 0
  for (let i = lowerBound(snap.killTs, ctx.t0); i < lowerBound(snap.killTs, ctx.t1); i++) {
    const pet = snap.killCredit[i] === 1
    kills++
    if (pet) killsPet++
    else killsSelf++
    const row = rowAt(ctx, snap.killTs[i])
    if (!row) continue
    row.kills++
    if (pet) row.killsPet++
    else row.killsSelf++
  }
  return { kills, killsSelf, killsPet }
}

/** Fold the experience samples of [t0,t1) into the range totals and their zone rows. */
function foldExp(
  snap: ProgressionSnap,
  ctx: FoldCtx
): Pick<RangeStats, 'expSamples' | 'expParty' | 'expUnstated' | 'levelEquiv'> {
  let expSamples = 0
  let expParty = 0
  let expUnstated = 0
  let levelEquiv = 0
  for (let i = lowerBound(snap.expTs, ctx.t0); i < lowerBound(snap.expTs, ctx.t1); i++) {
    const unstated = (snap.expFlag[i] & 1) !== 0
    const equiv = unstated ? 0 : snap.expPct[i] / 100
    expSamples++
    if ((snap.expFlag[i] & 2) !== 0) expParty++
    if (unstated) expUnstated++
    levelEquiv += equiv
    const row = rowAt(ctx, snap.expTs[i])
    if (!row) continue
    row.expSamples++
    row.levelEquiv += equiv
    if (unstated) row.expUnstated++
  }
  return { expSamples, expParty, expUnstated, levelEquiv }
}

/** Dings in range, plus the disjoint runs a loadout swap splits them into. */
function levelSeriesIn(snap: ProgressionSnap, t0: number, t1: number): Pick<RangeStats, 'levelUps' | 'levelRuns'> {
  const levelUps: RangeStats['levelUps'] = []
  const levelRuns: RangeStats['levelRuns'] = []
  for (let i = lowerBound(snap.levelTs, t0); i < lowerBound(snap.levelTs, t1); i++) {
    const level = snap.levelValue[i]
    const ts = snap.levelTs[i]
    levelUps.push({ ts, level })
    const run = levelRuns[levelRuns.length - 1]
    if (!run || level < run.toLevel) levelRuns.push({ fromLevel: level, toLevel: level, startTs: ts, endTs: ts })
    else {
      run.toLevel = level
      run.endTs = ts
    }
  }
  return { levelUps, levelRuns }
}

/** Fill in each row's derived activeMs + rates. Mutates in place. */
function finishRows(rows: ZoneRangeRow[]): void {
  for (const row of rows) {
    row.activeMs = Math.max(0, row.spanMs - row.idleMs - row.offlineMs)
    const unknown = levelsUnknown(row.expSamples, row.expUnstated)
    row.levelsPerHourActive = unknown ? null : perHour(row.levelEquiv, row.activeMs)
    // ONLINE wall: the hours you were logged out of this camp are not hours it paid badly in.
    row.levelsPerHourWall = unknown ? null : perHour(row.levelEquiv, row.spanMs - row.offlineMs)
    row.killsPerHourActive = perHour(row.kills, row.activeMs)
  }
}

/**
 * Everything a drag-selected time range says about progression. Pure: same snapshot + same
 * range ⇒ same answer, no clock read, no I/O. `RangeStatsArgs` is a single object because the
 * repo's ESLint `max-params` is 4 and this would otherwise be at the ceiling.
 */
export function rangeStats(args: RangeStatsArgs): RangeStats {
  const { snap, range, combo } = args
  const t0 = range.t0
  const t1 = Math.max(range.t0, range.t1)
  const durationMs = t1 - t0
  const segs = zoneSegments(snap, t0, t1)
  const offline = durationMs > 0 ? offlineSpansIn(snap, t0, t1) : []
  // Offline is carved OUT of the silence it sits in — see `subtractSpans`. Do it before the
  // rows are built so a zone row's idle and its offline can never claim the same instant.
  const spans = subtractSpans(durationMs > 0 ? idleSpans(snap, t0, t1) : [], offline)
  const { rows, of } = buildRows(segs, spans, offline)
  const idleMs = spans.reduce((n, s) => n + (s.end - s.start), 0)
  const offlineMs = offline.reduce((n, s) => n + (s.end - s.start), 0)
  const activeMs = Math.max(0, durationMs - idleMs - offlineMs)
  const ctx: FoldCtx = { segs, rows, of, t0, t1 }
  const kills = foldKills(snap, ctx)
  const exp = foldExp(snap, ctx)
  finishRows(rows)
  const unknown = levelsUnknown(exp.expSamples, exp.expUnstated)
  let aaGained = 0
  const aaLo = lowerBound(snap.aaGainTs, t0)
  const aaHi = lowerBound(snap.aaGainTs, t1)
  for (let i = aaLo; i < aaHi; i++) aaGained += snap.aaGainAmount[i]
  return {
    t0,
    t1,
    durationMs,
    activeMs,
    idleMs,
    idleGaps: spans.length,
    idleThresholdMs: IDLE_GAP_MS,
    offlineMs,
    offlineGaps: offline.length,
    ...kills,
    killsWitnessed: lowerBound(snap.witnessTs, t1) - lowerBound(snap.witnessTs, t0),
    ...exp,
    levelsPerHourActive: unknown ? null : perHour(exp.levelEquiv, activeMs),
    // ONLINE wall (duration - offline): a rate whose denominator counted a logout is a
    // statement about an empty chair. See the field's doc.
    levelsPerHourWall: unknown ? null : perHour(exp.levelEquiv, durationMs - offlineMs),
    killsPerHourActive: perHour(kills.kills, activeMs),
    ...levelSeriesIn(snap, t0, t1),
    aaGained,
    aaGainEvents: aaHi - aaLo,
    zones: rows,
    combos: combo ? combo.intervalsIn(t0, t1) : [],
    clipped: snap.windowStart > 0 && t0 < snap.windowStart
  }
}
