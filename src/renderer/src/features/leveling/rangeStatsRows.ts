// rangeStatsRows.ts — the PURE shaping behind RangeStatsPanel: a `RangeStats` (the answer
// `shared/progressionStats.rangeStats` computed) turned into the exact strings the panel
// prints. No React, no DOM, no MUI, and only TYPE imports from `@shared`, so
// tests/rangeStatsRows.test.mts can import it straight under tsx (there is no `@shared/*`
// alias in the node test runner — the same constraint zoneBands.ts / levelChartGeometry.ts
// document).
//
// WHY IT IS A SEPARATE FILE. Every honesty rule this feature has is a FORMATTING decision:
// whether a rate prints or an em-dash prints, whether a number is called "levels" or "xp",
// whether a zone row admits the log stated no percentage. Those are the things that rot
// silently inside JSX. Here they are functions with return values, and the test file pins
// them.
//
// THE THREE RULES THIS FILE EXISTS TO ENFORCE (plan §4, §6.4):
//   1. A NULL rate renders as an em-dash — NEVER '0.0'. `levelsPerHourActive` is null when
//      the window has no active time, and also when every experience line in it stated no
//      percentage. Printing 0.0 there would be a fabricated measurement of a quantity the
//      log declined to report.
//   2. `levelEquiv` is LEVELS OF PROGRESS, never "xp". The log prints a percentage of the
//      CURRENT level's bar and nothing else — no raw total, no to-next-level requirement,
//      no bar position — and 1% at level 40 is far more raw experience than 1% at level 10.
//      No surface in this file may say xp, exp points, or experience points.
//   3. A row with unstated samples SAYS SO. `expUnstated > 0` is a real state of the world
//      (the game prints a percentage only while a level bar exists), not a rounding artifact.

import type { ComboInterval, RangeStats, ZoneRangeRow } from '@shared/progressionStats'
import { formatKillRate, formatLevelRate } from '../../lib/formatRate'
import { fmtDuration } from './levelChartGeometry'
import { zoneColor } from './zoneBands'

/** Every unknown prints as this. Rule 1: an em-dash, never a zero. */
export const NONE = '—'

/** Which column the per-zone table is ordered by. */
export type ZoneSort = 'levels' | 'time'

export interface ZoneStatRow {
  /** React key + stable identity: the row's raw zone name, which `rangeStats` already made
   *  unique (it groups by a case-folded key and keeps the first-seen spelling). */
  key: string
  /** RAW display name (law 2: canonicalize at boundaries, display raw). */
  zone: string
  /** From `zoneBands.zoneColor`, so a row's swatch is the SAME hue as its chart band. */
  color: string
  spanMs: number
  activeMs: number
  idleMs: number
  visits: number
  kills: number
  /** wall time in the zone, e.g. '2h 41m'. */
  time: string
  /** the active half of that time, e.g. '2h 03m' — always <= `time`. */
  active: string
  /** the idle half, or null when the zone had no qualifying silence at all. */
  idle: string | null
  /** Σ levels of progress, or an em-dash when every sample here was unstated. */
  levels: string
  levelsPerHour: string
  killsPerHour: string
  /** how many experience lines in this zone stated no percentage (0 = none). */
  unstated: number
}

/** One hero card's text. The icon and accent stay in the component; these are the words. */
export interface HeroStat {
  id: 'rate' | 'kills' | 'levels' | 'range'
  value: string
  label: string
  sub: string
}

const MS_PER_MIN = 60_000

/** A rate, or the em-dash. The ONLY place a `number | null` rate becomes text. */
function rate(n: number | null, fmt: (v: number) => string): string {
  return n == null ? NONE : fmt(n)
}

/**
 * Levels of progress as text. An em-dash when the range gained experience but the log stated
 * no percentage for ANY of it — unknown is not zero. A genuine zero (no experience lines at
 * all) is a stated fact and prints as 0.00.
 */
function levelsText(levelEquiv: number, expSamples: number, expUnstated: number): string {
  return expSamples > 0 && expSamples === expUnstated ? NONE : levelEquiv.toFixed(2)
}

/** Order: the farming-efficiency question first (levels/hr desc), nulls last. */
function byLevels(a: ZoneRangeRow, b: ZoneRangeRow): number {
  const av = a.levelsPerHourActive
  const bv = b.levelsPerHourActive
  if (av == null && bv == null) return b.spanMs - a.spanMs
  if (av == null) return 1
  if (bv == null) return -1
  return bv - av || b.spanMs - a.spanMs
}

/** Order: where the time actually went (span desc), the secondary toggle. */
function byTime(a: ZoneRangeRow, b: ZoneRangeRow): number {
  return b.spanMs - a.spanMs || byLevels(a, b)
}

function shapeZone(z: ZoneRangeRow): ZoneStatRow {
  return {
    key: z.zone,
    zone: z.zone,
    color: zoneColor(z.zone),
    spanMs: z.spanMs,
    activeMs: z.activeMs,
    idleMs: z.idleMs,
    visits: z.visits,
    kills: z.kills,
    time: fmtDuration(z.spanMs),
    active: fmtDuration(z.activeMs),
    idle: z.idleMs > 0 ? fmtDuration(z.idleMs) : null,
    levels: levelsText(z.levelEquiv, z.expSamples, z.expUnstated),
    levelsPerHour: rate(z.levelsPerHourActive, formatLevelRate),
    killsPerHour: rate(z.killsPerHourActive, formatKillRate),
    unstated: z.expUnstated
  }
}

/**
 * The per-zone table rows, sorted. `zones` is left untouched (the array is the snapshot
 * query's, not ours to reorder in place).
 */
export function zoneStatRows(zones: readonly ZoneRangeRow[], sort: ZoneSort = 'levels'): ZoneStatRow[] {
  return [...zones].sort(sort === 'time' ? byTime : byLevels).map(shapeZone)
}

/** The kills card's caption. The pet half is INFERRED — pet binding is learned from the
 *  `<Name> told you, '… Master.'` tell and charm lines, never stated per kill. */
function killsSub(stats: RangeStats): string {
  if (stats.kills === 0) return 'no credited kills in this range'
  const mine = `${stats.killsSelf} your killing blow${stats.killsSelf === 1 ? '' : 's'}`
  return stats.killsPet > 0 ? `${mine} · ${stats.killsPet} pet (inferred)` : mine
}

/** The levels-per-hour card's caption — including WHY it is an em-dash when it is. */
function rateSub(stats: RangeStats): string {
  if (stats.levelsPerHourActive != null) return `over ${fmtDuration(stats.activeMs)} active`
  if (stats.expSamples > 0) return 'the log stated no percentage in this range'
  return 'no active time in this range'
}

/** Dings in range as level runs. A loadout swap opens a NEW run: the level legitimately goes
 *  DOWN and the drop is never logged, so the two runs are never joined into one span. */
function levelRangeText(runs: RangeStats['levelRuns']): string {
  if (runs.length === 0) return NONE
  return runs.map((r) => (r.fromLevel === r.toLevel ? `${r.toLevel}` : `${r.fromLevel} → ${r.toLevel}`)).join(' · ')
}

function levelRangeSub(stats: RangeStats): string {
  const n = stats.levelUps.length
  if (n === 0) return 'no level-ups in this range'
  const dings = `${n} ding${n === 1 ? '' : 's'}`
  return stats.levelRuns.length > 1 ? `${dings} · ${stats.levelRuns.length - 1} class swap` : dings
}

/**
 * The four headline cards (plan §6.4): levels/hr active · mobs killed · levels gained ·
 * level range covered. Every value that can be unknown is an em-dash with a caption that
 * says which kind of unknown it is.
 */
export function rangeHeroes(stats: RangeStats): HeroStat[] {
  return [
    {
      id: 'rate',
      value: rate(stats.levelsPerHourActive, formatLevelRate),
      label: 'Levels per hour',
      sub: rateSub(stats)
    },
    { id: 'kills', value: stats.kills.toLocaleString(), label: 'Mobs killed', sub: killsSub(stats) },
    {
      id: 'levels',
      value: levelsText(stats.levelEquiv, stats.expSamples, stats.expUnstated),
      label: 'Levels of progress',
      sub: `${stats.expSamples} experience gain${stats.expSamples === 1 ? '' : 's'}`
    },
    {
      id: 'range',
      value: levelRangeText(stats.levelRuns),
      label: 'Level range covered',
      sub: levelRangeSub(stats)
    }
  ]
}

/** '2h 41m active · 38m idle', or just the active half when nothing qualified as idle. */
export function activeIdleText(stats: RangeStats): string {
  const active = `${fmtDuration(stats.activeMs)} active`
  return stats.idleMs > 0 ? `${active} · ${fmtDuration(stats.idleMs)} idle` : active
}

/**
 * The idle rule, literally, as a caption on the number it explains. The threshold is a
 * CHOICE, not a fact, so it is always shown beside the value it produced — and it is read
 * from the stats object (`IDLE_GAP_MS`), never typed in as a number here.
 *
 * The wording is deliberate: "idle", never "AFK" and never "offline". The log records EVENTS,
 * not PRESENCE — there is no login/logout/camp line in this family — so medding, banking,
 * crafting, travelling, being away and having the game closed are all the same silence.
 */
export function idleRuleCaption(idleThresholdMs: number): string {
  const mins = idleThresholdMs / MS_PER_MIN
  return `idle = no experience, kill, or loot event for over ${mins} minutes`
}

/** How many separate silences produced that idle total — a title-attribute detail. */
export function idleGapsText(stats: RangeStats): string | null {
  if (stats.idleGaps === 0) return null
  return `${stats.idleGaps} gap${stats.idleGaps === 1 ? '' : 's'} over ${fmtDuration(stats.idleThresholdMs)}`
}

/**
 * The class loadout, as the combo model stated it. ZERO inference here: an empty list is a
 * first-class state, not an error — the self `/who` row is the only line that ever states a
 * loadout and there are 11 of them in 1.1M lines, so "unknown" is the COMMON case and has to
 * look deliberate rather than broken.
 */
export function comboText(combos: readonly ComboInterval[]): string {
  if (combos.length === 0) return 'class combo: not stated in this range'
  const seen = new Set<string>()
  for (const c of combos) seen.add(c.classes.join('/'))
  return `class combo: ${[...seen].join(' → ')}`
}

/** True when any stated combo carried the combo model's own `inferred` flag. */
export function comboInferred(combos: readonly ComboInterval[]): boolean {
  return combos.some((c) => c.inferred)
}

/** Kills you only WITNESSED — other players', other mobs'. Deliberately outside every rate,
 *  so a busy zone cannot inflate your farming numbers; null when there were none. */
export function witnessedText(stats: RangeStats): string | null {
  return stats.killsWitnessed > 0 ? `${stats.killsWitnessed.toLocaleString()} kills by others seen` : null
}

/** AA gained in range, or null when none. */
export function aaText(stats: RangeStats): string | null {
  return stats.aaGainEvents > 0 ? `+${stats.aaGained.toLocaleString()} AA` : null
}

/**
 * The AA caption — the SAME reservation the "AA gained over time" panel carries (law 5): this
 * is Σ of the gain LINES, and a respec re-logs purchases while refunding nothing, so points
 * re-earned after one are counted again. It is not the AA identity.
 */
export const AA_RESPEC_CAPTION = 'gain lines — includes points re-gained after a respec'

/**
 * The footnote for rows whose experience lines stated no percentage. Null when every sample
 * in the range stated one, so the panel carries no caption it does not need.
 */
export function unstatedCaption(stats: RangeStats): string | null {
  if (stats.expUnstated === 0) return null
  const n = stats.expUnstated
  return `* ${n} experience line${n === 1 ? '' : 's'} stated no percentage — the game prints one only while a level bar exists, so that progress is counted nowhere above`
}
