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
