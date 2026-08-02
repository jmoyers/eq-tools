// Level-series derivation for the leveling view (Task: honest "Level over time").
//
// WORLD MODEL (verified against the real log, Aug 2 2026):
//   • The ONLY level line family is `You have gained a level! Welcome to level N!`
//     (src/main/log/parser.ts LEVEL_RE). There is NO loadout-swap / class-change line —
//     every "loadout"/"swap" string in the log is another player's chat.
//   • EQ Legends gives a character ONE level shared by a THREE-class loadout, not three
//     concurrent levels: the self `/who` line reads `[50 PAL/MNK/ENC] Primitive (Dark Elf)`
//     — one number, three classes. Swapping a class into the loadout drops that single
//     level back to the new class's (level 10).
//   • Those `/who` lines are user-typed and sparse (11 in 985k lines, none anywhere near
//     the observed swap), so the ACTIVE CLASS TRIO IS NOT DERIVABLE at a level-up. We
//     therefore model one honest series and label the discontinuities, rather than
//     inventing per-class lines the log cannot support (world-model law #1/#6).
//
// The consequence for display: the series legitimately goes DOWN, and the drop itself is
// NEVER logged — we only ever see the first ding of the new loadout (…50, then 11). So:
//   • "current level" is the LATEST reported level, never max() (max is the pre-swap peak).
//   • the chart is drawn as disjoint step segments; nothing is interpolated across a swap.
//   • the elapsed time between the last pre-swap ding and the first post-swap ding is NOT
//     "how long that level took" — it spans the unobserved swap — so it is suppressed.

import type { LevelEvent } from '@shared/types'

export interface LevelPoint {
  ts: number
  level: number
}

/** One loadout's run of dings — monotonically non-decreasing by construction. */
export interface LevelSegment {
  points: LevelPoint[]
  /**
   * True when this segment opens after a class swap, i.e. its first level is BELOW the
   * previous segment's last. The drop has no log line, so the segment simply starts lower;
   * the chart marks the boundary instead of drawing a cliff through it.
   */
  afterSwap: boolean
}

export interface LevelFeedEntry {
  ts: number
  level: number
  afterSwap: boolean
  /** ms since the previous ding — null for the first ding and for post-swap dings. */
  sinceMs: number | null
}

/** Sort a level list by time (ascending). Input order is log order, but be explicit. */
export function sortLevels(levels: readonly LevelEvent[]): LevelPoint[] {
  return [...levels].sort((a, b) => a.ts - b.ts).map((l) => ({ ts: l.ts, level: l.level }))
}

/**
 * The character's CURRENT level = the most recently reported one. NOT max(): after a
 * loadout swap the peak belongs to a class that is no longer in the loadout.
 */
export function latestLevel(sorted: readonly LevelPoint[]): number | null {
  return sorted.length ? sorted[sorted.length - 1].level : null
}

/** The highest level ever reported (a real, separate fact — labeled as "peak", not current). */
export function peakLevel(sorted: readonly LevelPoint[]): number | null {
  return sorted.length ? sorted.reduce((m, p) => (p.level > m ? p.level : m), sorted[0].level) : null
}

/** Split the series at every downward transition; each break is one class swap. */
export function buildLevelSegments(sorted: readonly LevelPoint[]): LevelSegment[] {
  const segs: LevelSegment[] = []
  for (const p of sorted) {
    const cur = segs[segs.length - 1]
    if (!cur || p.level < cur.points[cur.points.length - 1].level) {
      segs.push({ points: [p], afterSwap: segs.length > 0 })
    } else {
      cur.points.push(p)
    }
  }
  return segs
}

/** Number of observed loadout swaps (segment breaks). */
export function swapCount(segments: readonly LevelSegment[]): number {
  return segments.reduce((n, s) => n + (s.afterSwap ? 1 : 0), 0)
}

/**
 * Feed entries for the progress list. A post-swap ding carries NO elapsed-time delta: the
 * gap to the previous ding spans an unlogged loadout swap, so `+38.9h` there would be a
 * fabricated "time to level".
 */
export function levelFeedEntries(sorted: readonly LevelPoint[]): LevelFeedEntry[] {
  return sorted.map((p, i) => {
    const prev = i > 0 ? sorted[i - 1] : null
    const afterSwap = prev != null && p.level < prev.level
    return {
      ts: p.ts,
      level: p.level,
      afterSwap,
      sinceMs: prev && !afterSwap ? p.ts - prev.ts : null
    }
  })
}
