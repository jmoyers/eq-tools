// progressionTypes.ts — the TRANSPORT half of the leveling-analytics surface: the columnar
// snapshot the `progression` module folds (src/main/modules/progression.ts) and the delta it
// pushes over the generic module channel.
//
// Split out of types.ts for the same reason alertTypes.ts was: that file sits right at the
// MEASURED 400-code-line factoring ceiling and this section pushed it over (429). The section
// text is UNCHANGED and every name here is still exported from `shared/types`, which re-exports
// it explicitly — so no importer moved and no import path changed. The QUERY over these shapes
// lives in shared/progressionStats.ts.

// ----- Leveling analytics: the `progression` module (docs/plans/leveling-analytics.md) -----
//
// A range-queryable time series of everything that moves the level bar: experience samples,
// CREDITED kills (yours + a bound pet — third-party kills are kept separately and never enter
// a rate), loot as an activity signal, and the zone timeline the whole thing is attributed to.
// Deliberately NOT part of LevelingSnap: that snapshot's contract is "everything, forever"
// (the AA identity needs the whole history), while this one is CAPPED drop-oldest — mixing a
// ring into an uncapped snapshot is a semantic trap. `src/main/modules/progression.ts` owns it;
// `src/shared/progressionStats.ts` is the pure query over it.

/**
 * ONE credited kill, named. The columnar series above deliberately carries no names (a name
 * column would be ~40k strings against a numeric budget), so this is a small bounded RING —
 * the last `RECENT_KILL_CAP` credited kills, drop-oldest — that rides alongside it purely so a
 * glance surface can say WHAT you killed and what it paid.
 *
 * It is a DUPLICATE VIEW of `killTs`/`killCredit`, never a second source of truth: no statistic
 * is derived from it, its drops never enter `dropped`/`windowStart` (those describe the capped
 * COLUMNS' retention floor, and a 50-row ring drops constantly), and losing it entirely would
 * change no number anywhere.
 */
export interface ProgressionKill {
  /** timestamp of the kill line. */
  ts: number
  /** RAW display name of the thing that died, exactly as the line spelled it (law 2). */
  name: string
  /** 0 = your killing blow, 1 = credited to a bound pet (INFERRED — same semantics as
   *  `killCredit`; the log never names the pet on the kill line, so no name is retained). */
  credit: number
  /** RAW zone name the kill landed in; '' before the first zone line (never a fabricated one). */
  zone: string
  /**
   * The bitfield of the experience line JOINED to this kill — SAME bits as `expFlag`
   * (1 = no percentage stated, 2 = party experience).
   *
   * ABSENT means something different from every flag value: no experience line accompanied
   * this kill at all (a grey kill, or a corpse that paid nothing). `expFlag & 1` means the
   * game DID pay experience and stated no size for it — the at-the-cap shape. Law 1: those two
   * unknowns are not the same unknown and the UI must not render either as 0%.
   */
  expFlag?: number
  /** stated level-bar percent of the joined line; present iff the line stated one. */
  expPct?: number
}

/**
 * Parallel-array time series. COLUMNAR on purpose: structured-clone of N number arrays
 * is dramatically cheaper than N row objects, and the range query is a binary search on
 * a sorted `ts` column. Every array of a group has identical length; all `*Ts` columns
 * are ascending (log order is time order — the feeder is a single seq stream).
 */
export interface ProgressionSnap {
  // --- experience samples ---
  expTs: number[]
  /** stated level-bar percent, or -1 when the line printed none (see expFlag bit 1). */
  expPct: number[]
  /** bitfield: 1 = no percentage stated, 2 = party experience. */
  expFlag: number[]

  // --- credited kills (yours + bound pet); third-party kills are NOT here ---
  killTs: number[]
  /**
   * Index into `zoneName` for the interval the kill landed in, or -1 before the first zone
   * line (or once that zone aged out of ZONE_CAP). ADVISORY: `rangeStats` attributes every
   * sample — kills, exp and loot alike — by TIMESTAMP against the zone intervals, because
   * the exp/loot columns carry no zone index at all. So a skew here can never corrupt a
   * statistic; it exists for cheap O(1) lookups by a consumer that already trusts the index.
   */
  killZone: number[]
  /** 0 = your killing blow, 1 = credited to a bound pet (INFERRED — pet binding is
   *  learned from `<Name> told you, '… Master.'` / charm lines, not stated per kill). */
  killCredit: number[]

  /** third-party kills seen in the world, timestamps only (for the dimmed context number). */
  witnessTs: number[]

  /**
   * The last `RECENT_KILL_CAP` credited kills, oldest→newest, WITH names and the experience
   * line joined to each. Bounded by count (50 rows of six small fields is negligible against
   * the columnar budget) and purely a display feed — see `ProgressionKill`.
   */
  recentKills: ProgressionKill[]

  // --- loot events, timestamps only: an activity signal for the idle heuristic ---
  lootTs: number[]

  // --- zone intervals, ascending, contiguous, half-open [start, end) ---
  zoneStart: number[]
  /** 0 for the still-open final interval; consumers clamp to `lastTs` (or the selection end). */
  zoneEnd: number[]
  /** RAW display name (law 2: canonicalize at boundaries, display raw). */
  zoneName: string[]

  // --- tiny uncapped series, mirrored so rangeStats has one input ---
  levelTs: number[]
  levelValue: number[]
  aaGainTs: number[]
  aaGainAmount: number[]

  /** last event ts folded (clamps the open zone interval and an open selection). */
  lastTs: number
  /**
   * RETENTION FLOOR: the oldest instant at which EVERY capped column is still complete.
   * 0 while nothing has aged out — so `clipped` means "your range reaches into dropped
   * territory", never merely "your range predates the log". Once a cap bites it is the MAX
   * of the surviving columns' first timestamps: before that instant the record is partial,
   * and a rate computed over it would silently under-count.
   */
  windowStart: number
  /** how many samples the caps have dropped, across all capped columns (0 until one bites). */
  dropped: number
}

/**
 * How many leading entries the consumer must splice off each CAPPED column before
 * concatenating this delta's appended slices. Absent/0 = nothing aged out this flush.
 * `zone` also invalidates any `killZone` index the consumer already holds (see the field
 * doc above — indices are advisory for exactly this reason).
 */
export interface ProgressionDropFront {
  exp: number
  kill: number
  witness: number
  loot: number
  zone: number
}

/**
 * Delta = the appended slices of every column, plus the scalars (REPLACE, never concat)
 * and the front-drop bookkeeping. `zoneCloseEnd` is the one in-place edit: when a new zone
 * line arrives the previously-open interval closes, so the consumer sets the end of the last
 * interval it already holds to this value BEFORE appending.
 */
export interface ProgressionDelta {
  expTs: number[]
  expPct: number[]
  expFlag: number[]
  killTs: number[]
  killZone: number[]
  killCredit: number[]
  witnessTs: number[]
  /** rows appended to the recent-kills ring this flush (oldest→newest). */
  recentKills: ProgressionKill[]
  /**
   * How many leading rows to splice off the ring AFTER appending — the ring's own
   * `dropFront`, deliberately OUTSIDE `ProgressionDropFront`: that struct feeds `dropped` and
   * `windowStart`, which describe the capped COLUMNS' retention floor, and a 50-row display
   * ring drops on almost every kill. Folding it in would make the honest "your range reaches
   * into dropped territory" warning fire permanently.
   */
  recentKillsDrop: number
  lootTs: number[]
  zoneStart: number[]
  zoneEnd: number[]
  zoneName: string[]
  /** new end for the previously-open zone interval, when one closed this flush. */
  zoneCloseEnd?: number
  levelTs: number[]
  levelValue: number[]
  aaGainTs: number[]
  aaGainAmount: number[]
  lastTs: number
  windowStart: number
  dropped: number
  dropFront: ProgressionDropFront
}
