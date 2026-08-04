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
//
// OFFLINE TIME IS NOT IDLE TIME, AND NEITHER IS ACTIVITY
//
//   Window A is an hour of LOG time, and an hour of log time can contain a logout: play until
//   02:52, camp, come back at 13:00, and `[lastTs - 60min, lastTs]` may be mostly an empty
//   chair. Every number on this card handles that the same way — the hours the log says you
//   were logged out are taken OUT of the denominator rather than counted as bad hours:
//
//     • the headline rate was always over ACTIVE time and is unchanged;
//     • the projection divides by the window's ONLINE wall rate (`levelsPerHourWall`, whose
//       denominator is `durationMs - offlineMs`), so an overnight in the window no longer
//       drags the ETA toward infinity;
//     • the per-level history subtracts the same intervals from each completed level, so the
//       comparison is online-against-online rather than a pace that quietly beats a median
//       full of sleep;
//     • and when the window has too little online play left to project from, the estimate is
//       REFUSED with a reason (`ETA_MIN_ONLINE_MS`) instead of quoted from a five-minute
//       sample. An ETA over a window that was 90% logged out was arithmetic, not a prediction.
//
//   The honesty limit rides along unchanged: a logout is derived only from the LOGIN line that
//   ended it, so an absence in progress is invisible and its silence stays "idle". No wording
//   on this card says offline unless an interval was actually derived.
//
// THE PROJECTION (owner request: "predict next level timing at the same level of activity")
//
//   The log NEVER states where you are in the level bar. It states a percentage PER GAIN, and
//   nothing else — no total, no remainder, no bar position. So the only way to know how far
//   into the current bar you are is to add up every stated percentage SINCE THE LAST DING, and
//   that sum is trustworthy only when nothing is missing from it. Four things can make it
//   untrustworthy, and each one KILLS the estimate rather than degrading it (law 1: anything
//   inferred is labeled, and a projection built on a guessed bar position is not labelable —
//   it is just wrong):
//
//     • no ding has been observed at all ⇒ there is no anchor to sum from;
//     • an at-cap line (no percentage stated) landed since the ding ⇒ a hole in the sum;
//     • the retention floor has risen past the ding ⇒ dropped samples, a hole in the sum;
//     • the last hour states no pace at all ⇒ nothing to project with.
//
//   Those four are about the SUM. A fifth gate is about the WINDOW — see the offline section
//   below: an hour that was mostly a logout has too little play left in it to project from.
//
//   With all of them clear the estimate is `remaining fraction / the last hour's WALL rate`.
//   WALL, not active: the user asked when they will level, and they will experience that in
//   wall time, including the same proportion of medding and looting the last hour already
//   contained. (That denominator is ONLINE wall — the hours the log says you were logged out
//   are excluded, because you will not experience those either.) The ACTIVE rate gates it (that
//   is the honest "were you actually playing" signal) but the WALL rate divides. The tooltip
//   states every assumption verbatim, and the `~` is real: this is a projection of one hour
//   forward, never a countdown to a known instant.
//
// THE COMPARISON is the same discipline applied backwards: time-per-level for the last few
// dings, read off `levelTs`/`levelValue` — which are UNCAPPED, so unlike everything else here
// they cannot be clipped. It NEVER crosses a run boundary. EQ Legends gives one level to a
// three-class loadout and swapping a class in drops the level with NO log line of any kind, so
// the span across that drop covers time the log cannot account for. `progressionStats` splits
// runs on exactly that rule (a value below the previous one opens a new run) and so does this.

import type { ProgressionSnap } from '@shared/types'
import type { RangeStats, ZoneRangeRow } from '@shared/progressionStats'
import { IDLE_GAP_MS, offlineMsIn, rangeStats } from '../../../../shared/progressionStats'
import { NONE, activeIdleText, idleRuleCaption, offlineText } from '../leveling/rangeStatsRows'
import { fmtDelta, fmtDuration } from '../leveling/levelChartGeometry'
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

// ---------------------------------------------------------------------------------------
// NEXT-LEVEL PROJECTION
// ---------------------------------------------------------------------------------------

const MS_PER_HOUR = 3_600_000

/** Beyond this the estimate is stated as a horizon, not a duration — see `etaText`. */
export const ETA_ABSURD_MS = 24 * MS_PER_HOUR

/**
 * How much of window A must be ONLINE for a projection to be offered at all.
 *
 * The window is an hour of log time, and a logout can eat almost all of it: log in at 12:55
 * after an overnight and 55 of those 60 minutes are an empty chair. The pace measured over the
 * surviving five minutes is a real rate — it is just not an hour of evidence, and extrapolating
 * it to "~1h 40m to level 44" dresses a sample of five minutes as a prediction. A QUARTER of
 * the window is the floor: enough play to have a shape, and low enough that an ordinary
 * session that began mid-window still gets its estimate.
 *
 * The gate fires ONLY when an offline interval was actually derived, so a window with no
 * logout in it — which is every window this app has ever seen before today — reaches exactly
 * the same verdict it always did.
 */
export const ETA_MIN_ONLINE_MS = 15 * 60_000

/** WHY there is no estimate. Each one is a hole in the evidence, and each is shown on hover. */
export type EtaBlocked = 'no-ding' | 'unstated' | 'clipped' | 'overfull' | 'offline' | 'no-pace'

/**
 * Either a projection or the reason there isn't one. A UNION rather than a bag of nullables so
 * the renderer cannot read `ms` without having proven `blocked === null` first. `offlineMs` is
 * carried so the tooltip can state the logged-out assumption ONLY when there was one.
 */
export type LevelEta =
  | { blocked: EtaBlocked }
  | { blocked: null; ms: number; toLevel: number; progress: number; offlineMs: number }

/**
 * Σ stated level-bar percentage for the samples STRICTLY AFTER `dingTs`, plus how many samples
 * in that span stated none.
 *
 * Strictly after, on purpose: EQ timestamps are whole seconds, so the experience line that
 * pushed you over sits in the SAME second as "You have gained a level!". Counting it would
 * credit the previous bar's last gain to the new bar. The carry-over it represents is not in
 * the log either way, so the estimate is deliberately the conservative one.
 *
 * Walks backwards from the tail: the span since the last ding is small, and the columns are
 * ascending, so this stops the moment it passes the anchor.
 */
function statedSinceDing(snap: ProgressionSnap, dingTs: number): { equiv: number; unstated: number } {
  let equiv = 0
  let unstated = 0
  for (let i = snap.expTs.length - 1; i >= 0 && snap.expTs[i] > dingTs; i--) {
    if ((snap.expFlag[i] & 1) !== 0) unstated++
    else equiv += snap.expPct[i] / 100
  }
  return { equiv, unstated }
}

/**
 * True when the window has too little ONLINE play left in it to project an hour's pace from.
 * Guarded on `offlineMs > 0` so a window the log never said anything about is never gated.
 */
function tooOffline(hour: RangeStats): boolean {
  return hour.offlineMs > 0 && hour.durationMs - hour.offlineMs < ETA_MIN_ONLINE_MS
}

/**
 * The next-level estimate, or the reason there is none. `hour` is window A's stats — the same
 * object the headline rate came from, so the number on the card and the number the projection
 * used can never diverge.
 */
export function levelEta(snap: ProgressionSnap, hour: RangeStats): LevelEta {
  const n = snap.levelTs.length
  if (n === 0) return { blocked: 'no-ding' }
  const dingTs = snap.levelTs[n - 1]
  // The retention floor rose past the anchor ⇒ samples between the ding and the floor are gone
  // and the sum below would silently under-count. (`levelTs` itself is uncapped; `expTs` is not.)
  if (snap.windowStart > 0 && dingTs < snap.windowStart) return { blocked: 'clipped' }
  const { equiv, unstated } = statedSinceDing(snap, dingTs)
  if (unstated > 0) return { blocked: 'unstated' }
  // More than a full bar's worth stated with no ding to show for it: the model and the log
  // disagree, and the honest answer to "where am I in the bar" is that we do not know.
  if (equiv >= 1) return { blocked: 'overfull' }
  // Most of the hour was an empty chair: what is left is a rate, not an hour of evidence.
  if (tooOffline(hour)) return { blocked: 'offline' }
  // The ACTIVE rate is the gate (null ⇒ no active time, or at cap); the ONLINE WALL rate
  // divides — see `RangeStats.levelsPerHourWall`, whose denominator excludes the logout.
  if (hour.levelsPerHourActive == null) return { blocked: 'no-pace' }
  const pace = hour.levelsPerHourWall
  if (pace == null || pace <= 0) return { blocked: 'no-pace' }
  return {
    blocked: null,
    ms: ((1 - equiv) / pace) * MS_PER_HOUR,
    toLevel: snap.levelValue[n - 1] + 1,
    progress: equiv,
    offlineMs: hour.offlineMs
  }
}

/** '~2h 10m to level 44', or the horizon phrase past a day. Null when the estimate is blocked. */
function etaText(eta: LevelEta): string | null {
  if (eta.blocked !== null) return null
  if (eta.ms > ETA_ABSURD_MS) return `>1 day to level ${eta.toLevel} at this pace`
  return `~${fmtDuration(eta.ms)} to level ${eta.toLevel}`
}

/** The reason there is no estimate, in the log's own terms — one per `EtaBlocked`. */
const ETA_BLOCKED_TITLE: Record<EtaBlocked, string> = {
  'no-ding':
    'No level-up has been recorded yet, so how far into this level you are is unknown — the game states a percentage per gain and never your position in the bar.',
  unstated:
    'Experience lines since your last level-up stated no percentage, so progress into this level cannot be added up — unknown, not zero.',
  clipped:
    'The retained record no longer reaches back to your last level-up, so progress into this level cannot be added up.',
  overfull:
    'The percentages stated since your last level-up already exceed a full level, so your position in the bar is unknown.',
  offline:
    'Most of the last hour of the log is time you were logged out, so there is not enough play left in it to project an hour of pace from.',
  'no-pace': 'The last hour states no levels of progress, so there is no pace to project forward.'
}

/**
 * The logged-out assumption, stated ONLY when the window actually contained a derived logout.
 * Empty otherwise, so a card that has never seen one reads exactly as it always did.
 */
function etaOfflineClause(offlineMs: number): string {
  return offlineMs > 0
    ? ' The time the log says you were logged out is excluded from both the pace and the estimate, which therefore assumes you keep playing.'
    : ''
}

/** ALWAYS a sentence: the assumptions when there is an estimate, the reason when there is not. */
function etaTitleText(eta: LevelEta): string {
  if (eta.blocked !== null) return ETA_BLOCKED_TITLE[eta.blocked]
  return (
    `${Math.round(eta.progress * 100)}% of level ${eta.toLevel - 1} stated since your last level-up, ` +
    `projected forward at the last hour's pace — same mobs, same activity, and the same share of idle ` +
    'time that hour already contained. An estimate from stated percentages, never a countdown.' +
    etaOfflineClause(eta.offlineMs)
  )
}

// ---------------------------------------------------------------------------------------
// LEVEL HISTORY COMPARISON
// ---------------------------------------------------------------------------------------

/** How many recent levels the history line prints and the median is taken over. */
export const HISTORY_MAX = 5

/** How far off the median counts as "the same pace" — ±20%, symmetric in ratio. */
export const PACE_BAND = 0.2

/** One completed level: how long it took to go `fromLevel` → `toLevel`. */
export interface LevelSpan {
  fromLevel: number
  toLevel: number
  /** ONLINE ms between the two dings — the derived logouts inside the span are removed. */
  ms: number
  /** how much was removed. 0 ⇒ the log recorded no logout here and `ms` is plain wall time. */
  offlineMs: number
}

/**
 * Time-per-level for the last `max` completed levels of the CURRENT run, oldest first.
 *
 * Walks backwards and STOPS at the first pair that does not rise. A drop is a loadout swap (the
 * level of the class you swapped in, reported by nothing) and the span across it covers hours
 * the log cannot attribute; a repeat is not a level gained at all. Neither is a time-per-level,
 * and neither may be bridged to reach an older run.
 *
 * `ms` is ONLINE time: a level that took "13.9 hours" because you slept in the middle of it
 * took 13.9 hours of calendar and rather less of playing, and this is the number the last
 * hour's pace is compared against — a comparison whose one side excluded logouts and whose
 * other side counted them would find you "ahead of your recent pace" every single night. With
 * no derived logout in a span the subtraction is zero and `ms` is exactly the wall span it
 * always was.
 */
export function recentLevelSpans(snap: ProgressionSnap, max: number = HISTORY_MAX): LevelSpan[] {
  const spans: LevelSpan[] = []
  for (let i = snap.levelTs.length - 1; i > 0 && spans.length < max; i--) {
    const fromLevel = snap.levelValue[i - 1]
    const toLevel = snap.levelValue[i]
    if (toLevel <= fromLevel) break
    const offlineMs = offlineMsIn(snap, snap.levelTs[i - 1], snap.levelTs[i])
    spans.push({ fromLevel, toLevel, ms: snap.levelTs[i] - snap.levelTs[i - 1] - offlineMs, offlineMs })
  }
  return spans.reverse()
}

/** Middle value; the mean of the two middles on an even count. `values` is left untouched. */
function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** How the last hour compares to the median of the recent levels. */
export type PaceVerdict = 'ahead' | 'even' | 'behind'

const VERDICT_TEXT: Record<PaceVerdict, string> = {
  ahead: 'ahead of your recent pace',
  even: 'about your recent pace',
  behind: 'behind your recent pace'
}

/** Wall ms per level at a wall levels/hour rate, or null when there is no usable rate. */
function msPerLevel(levelsPerHourWall: number | null): number | null {
  return levelsPerHourWall != null && levelsPerHourWall > 0 ? MS_PER_HOUR / levelsPerHourWall : null
}

/**
 * The verdict, or null. Null under TWO samples on purpose: one level is a sample size of one
 * and a single unlucky camp would print a confident-looking judgement of your whole night. The
 * comparison is ONLINE wall against ONLINE wall — the recent levels include everything you did
 * while logged in, so the last hour has to as well, and neither side counts a logout.
 */
export function paceVerdict(spans: readonly LevelSpan[], levelsPerHourWall: number | null): PaceVerdict | null {
  if (spans.length < 2) return null
  const now = msPerLevel(levelsPerHourWall)
  if (now == null) return null
  const med = median(spans.map((s) => s.ms))
  if (med <= 0) return null
  if (now < med * (1 - PACE_BAND)) return 'ahead'
  if (now > med / (1 - PACE_BAND)) return 'behind'
  return 'even'
}

/** 'lvl 41→42 13.9h · 42→43 1.0h'. Null when this run holds no completed level. */
function historyText(spans: readonly LevelSpan[]): string | null {
  if (spans.length === 0) return null
  return `lvl ${spans.map((s) => `${s.fromLevel}→${s.toLevel} ${fmtDelta(s.ms)}`).join(' · ')}`
}

/** The history line's tooltip: what the verdict was measured against, and the swap rule. */
function historyTitleText(spans: readonly LevelSpan[], levelsPerHourWall: number | null): string {
  if (spans.length === 0) return ''
  const med = fmtDuration(median(spans.map((s) => s.ms)))
  const n = spans.length
  // "wall time" only while it IS wall time. Once a logout has been subtracted out of one of
  // these levels the number is online time and says so — the word follows the evidence.
  const basis = spans.some((s) => s.offlineMs > 0)
    ? 'online time, with the hours the log says you were logged out taken out of each level'
    : 'wall time'
  const base =
    `Median ${med} per level over your last ${n} level${n === 1 ? '' : 's'}, ${basis}. ` +
    'Never across a class swap — a swap re-reports your level with no log line, so the time either side of one is not comparable.'
  const now = msPerLevel(levelsPerHourWall)
  return now == null ? base : `${base} The last hour projects ${fmtDuration(now)} per level.`
}

/**
 * The zone the last hour actually paid best in. Free: `rangeStats` already broke window A down
 * per zone, so this is a scan of a list that exists. Null unless the hour genuinely spans two
 * or more NAMED zones that each state a rate — with one camp there is no comparison to draw,
 * and the deep per-zone table lives one click away in the Leveling tab.
 */
function zoneCompareText(zones: readonly ZoneRangeRow[]): string | null {
  // `rangeStats` names the pre-first-zone remainder 'unknown'; it is a placeholder, not a camp.
  const named = zones.filter(
    (z): z is ZoneRangeRow & { levelsPerHourActive: number } => z.zone !== 'unknown' && z.levelsPerHourActive != null
  )
  if (named.length < 2) return null
  const best = named.reduce((m, z) => (z.levelsPerHourActive > m.levelsPerHourActive ? z : m))
  return `best this hour: ${best.zone} at ${formatLevelRate(best.levelsPerHourActive)}`
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
  /**
   * '18m offline' when the hour contained a logout the log CLOSED with a login line, else
   * null — and null is the normal state. Never inferred from silence: an absence still in
   * progress is invisible to this app and its time is counted as idle above.
   */
  offline: string | null
  /** Window A gained experience the log stated no percentage for ⇒ the `at cap` chip. */
  atCap: boolean
  /** Window A reaches below the retention floor ⇒ the numbers are over a partial record. */
  clipped: boolean
  /** Window B, already worded: 'in <zone>: X lvl/hr · Y kills/hr since 13:04'. Null when the
   *  snapshot holds no zone interval. */
  zoneLine: string | null
  /** 'best this hour: <zone> at X lvl/hr'. Null unless window A spans 2+ rated zones. */
  zoneCompare: string | null
  /** '~2h 10m to level 44' / '>1 day to level 44 at this pace'. Null when no honest estimate
   *  exists — the card still shows an em-dash and `etaTitle` says which hole caused it. */
  eta: string | null
  /** ALWAYS a sentence: every assumption behind the estimate, or the reason there is none. */
  etaTitle: string
  /** 'lvl 41→42 13.9h · 42→43 1.0h' for the current run. Null when it holds no full level. */
  history: string | null
  /** 'ahead of your recent pace' / 'about' / 'behind'. Null under two recent levels. */
  verdict: string | null
  /** The history line's tooltip. '' when there is no history line to hang it on. */
  historyTitle: string
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
    offline: null,
    atCap: false,
    clipped: false,
    zoneLine: null,
    zoneCompare: null,
    eta: null,
    etaTitle: ETA_BLOCKED_TITLE['no-ding'],
    history: null,
    verdict: null,
    historyTitle: '',
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
 * The whole card, from the snapshot. STILL two `rangeStats` calls and nothing else — the
 * projection reuses window A's own stats object and the comparison reads the uncapped level
 * columns directly, so neither added a sweep. Memoize this on snapshot identity and the card is
 * free to re-render as often as the module pushes.
 */
export function overviewLeveling(snap: ProgressionSnap): OverviewLevelingState {
  const { hour, zone } = levelingWindows(snap)
  if (!hour) return emptyState()
  const a = rangeStats({ snap, range: hour })
  const b = zone ? rangeStats({ snap, range: zone }) : null
  const eta = levelEta(snap, a)
  const spans = recentLevelSpans(snap)
  const verdict = paceVerdict(spans, a.levelsPerHourWall)
  return {
    empty: false,
    rate: rate(a.levelsPerHourActive, formatLevelRate),
    killRate: rate(a.killsPerHourActive, formatKillRate),
    activity: activeIdleText(a),
    offline: offlineText(a),
    atCap: atCap(a),
    clipped: a.clipped,
    zoneLine: b && zone ? zoneLineText(b, zone.zone) : null,
    zoneCompare: zoneCompareText(a.zones),
    eta: etaText(eta),
    etaTitle: etaTitleText(eta),
    history: historyText(spans),
    verdict: verdict && VERDICT_TEXT[verdict],
    historyTitle: historyTitleText(spans, a.levelsPerHourWall),
    level: currentLevel(snap),
    idleCaption: idleRuleCaption(a.idleThresholdMs),
    kills: a.kills
  }
}
