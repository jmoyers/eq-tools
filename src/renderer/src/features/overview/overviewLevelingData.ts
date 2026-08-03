// overviewLevelingData — the PURE view model behind the Overview tab's leveling card.
//
// No React, no MUI, no window.eq: one function of the `progression` snapshot the hook already
// holds, so `tests/overviewLeveling.test.mts` drives every rule here under plain node.
//
// IMPORT DISCIPLINE (same as overviewData.ts): VALUE imports are RELATIVE, never `@shared/*` —
// that alias exists only inside the vite build and the node test runner would not resolve it.
// Type-only imports keep the alias because tsx erases them.
//
// TWO WINDOWS, AND WHY THEY ARE THESE TWO
//
//   A — "last hour": `[lastTs - 60min, lastTs]`. Anchored on the DATA'S CLOCK, never
//       `Date.now()`. The distinction is the whole point: this app is read by someone who
//       alt-tabbed out of EverQuest, and a wall-clock window would hand them an empty hour
//       and a fabricated "0.00 lvl/hr" the moment they stopped playing. Anchored on `lastTs`
//       the card answers "how was the last hour I actually played", which is the question.
//
//   B — "this zone": `[start of the last zone interval, lastTs]`. The camp you are in right
//       now, however long you have been in it — the number you compare against window A to
//       decide whether to stay. Absent when the snapshot holds no zone line at all (a log
//       whose replay has not reached one yet), and that absence is a state, not an error:
//       the card simply omits the line rather than inventing a zone.
//
// EVERY UNKNOWN IS AN EM-DASH (rangeStatsRows rule 1, reused here rather than restated). A
// levels rate is null when the window has no active time AND when every experience line in it
// stated no percentage — the at-cap case, which this card chips as `at cap`. Printing '0.00'
// for either would be a fabricated measurement.
//
// VOCABULARY: "levels of progress", never "xp" (the log states a percentage of the CURRENT
// level's bar and nothing else). Silence is "idle", never "AFK" — see `idleRuleCaption`.

import type { ProgressionSnap } from '@shared/types'
import type { RangeStats } from '@shared/progressionStats'
import { IDLE_GAP_MS, rangeStats } from '../../../../shared/progressionStats'
import { NONE, activeIdleText, idleRuleCaption } from '../leveling/rangeStatsRows'
import { formatKillRate, formatLevelRate } from '../../lib/formatRate'
import { formatTime } from '../../lib/formatDate'

/** Window A's length: the last hour of LOG time. */
export const HEADLINE_WINDOW_MS = 60 * 60_000

/** A half-open range over the snapshot's own clock. */
export interface LevelingWindow {
  t0: number
  t1: number
}

/** Window B additionally names the zone it covers — RAW casing (law 2: display raw). */
export interface ZoneLevelingWindow extends LevelingWindow {
  zone: string
}

export interface LevelingWindows {
  /** `[lastTs - 60min, lastTs]`, or null when the snapshot has folded no event at all. */
  hour: LevelingWindow | null
  /** the last zone interval, clamped to `lastTs`; null when there is none (or it spans 0ms). */
  zone: ZoneLevelingWindow | null
}

/**
 * The two windows, from the snapshot alone. Pure and clock-free: same snapshot ⇒ same windows,
 * on any machine, at any time of day.
 */
export function levelingWindows(snap: ProgressionSnap): LevelingWindows {
  const lastTs = snap.lastTs
  if (lastTs <= 0) return { hour: null, zone: null }
  const hour: LevelingWindow = { t0: lastTs - HEADLINE_WINDOW_MS, t1: lastTs }
  const i = snap.zoneName.length - 1
  if (i < 0) return { hour, zone: null }
  const t0 = snap.zoneStart[i]
  // `zoneEnd === 0` is the still-open interval — the zone you are in. A closed final interval
  // (the log's last line was a zone change) is honoured as written rather than stretched to
  // `lastTs`: the range must never claim time in a zone the log says you left.
  const end = snap.zoneEnd[i] === 0 ? lastTs : Math.min(snap.zoneEnd[i], lastTs)
  if (end <= t0) return { hour, zone: null }
  return { hour, zone: { t0, t1: end, zone: snap.zoneName[i] } }
}

/**
 * The CURRENT level as the log last reported it — the tail of `levelValue`, never `max()`.
 * You level three classes at once and a loadout swap re-reports the level of the new (lowest)
 * class with no line of its own, so the latest value is the only honest "your level" (the same
 * rule `latestLevel` follows in the Leveling tab). Null when the snapshot holds no ding: the
 * card omits the chip rather than guessing one.
 */
export function currentLevel(snap: ProgressionSnap): number | null {
  const n = snap.levelValue.length
  return n > 0 ? snap.levelValue[n - 1] : null
}

/** True when the window gained experience but the log stated no percentage for ANY of it. */
function atCap(stats: RangeStats): boolean {
  return stats.expSamples > 0 && stats.expSamples === stats.expUnstated
}

/** A rate, or the em-dash. The ONE place a `number | null` rate becomes text here. */
function rate(n: number | null, fmt: (v: number) => string): string {
  return n == null ? NONE : fmt(n)
}

/** Everything the card prints. Strings are final — the component adds no arithmetic. */
export interface OverviewLevelingState {
  /** The snapshot has folded nothing yet: the card shows its quiet empty state. */
  empty: boolean
  /** Window A's headline: levels of progress per hour of ACTIVE time, or an em-dash. */
  rate: string
  /** Window A's kills/hr, or an em-dash. */
  killRate: string
  /** Window A split by the idle rule, e.g. '42m active · 18m idle'. */
  activity: string
  /** Window A gained experience the log stated no percentage for ⇒ the `at cap` chip. */
  atCap: boolean
  /** Window A reaches below the retention floor ⇒ the numbers are over a partial record. */
  clipped: boolean
  /** Window B, already worded: 'in <zone>: X lvl/hr · Y kills/hr since 13:04'. Null when the
   *  snapshot holds no zone interval. */
  zoneLine: string | null
  /** Latest reported level, or null (chip omitted). */
  level: number | null
  /** The idle rule, literally — a tooltip/caption on the number it explains, never a caption
   *  that describes the app's process (AGENTS.md: state, never process). */
  idleCaption: string
  /** credited kills in window A — context for the rate, so '0 kills' can't read as a bug. */
  kills: number
}

/** The empty snapshot's answer: every number an em-dash, nothing invented. */
function emptyState(): OverviewLevelingState {
  return {
    empty: true,
    rate: NONE,
    killRate: NONE,
    activity: '',
    atCap: false,
    clipped: false,
    zoneLine: null,
    level: null,
    idleCaption: idleRuleCaption(IDLE_GAP_MS),
    kills: 0
  }
}

/** Window B's one line. Same formatters as the headline, so the two are directly comparable. */
function zoneLineText(stats: RangeStats, zone: string): string {
  const levels = rate(stats.levelsPerHourActive, formatLevelRate)
  const kills = rate(stats.killsPerHourActive, formatKillRate)
  const since = formatTime(stats.t0, { hour: '2-digit', minute: '2-digit' })
  return `in ${zone}: ${levels} · ${kills} since ${since}`
}

/**
 * The whole card, from the snapshot. TWO `rangeStats` calls and nothing else — memoize this on
 * snapshot identity and the card is free to re-render as often as the module pushes.
 */
export function overviewLeveling(snap: ProgressionSnap): OverviewLevelingState {
  const { hour, zone } = levelingWindows(snap)
  if (!hour) return emptyState()
  const a = rangeStats({ snap, range: hour })
  const b = zone ? rangeStats({ snap, range: zone }) : null
  return {
    empty: false,
    rate: rate(a.levelsPerHourActive, formatLevelRate),
    killRate: rate(a.killsPerHourActive, formatKillRate),
    activity: activeIdleText(a),
    atCap: atCap(a),
    clipped: a.clipped,
    zoneLine: b && zone ? zoneLineText(b, zone.zone) : null,
    level: currentLevel(snap),
    idleCaption: idleRuleCaption(a.idleThresholdMs),
    kills: a.kills
  }
}
