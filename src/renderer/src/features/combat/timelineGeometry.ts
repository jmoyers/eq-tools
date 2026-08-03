// Pure geometry + text for the combat TIMELINE (CombatTimeline.tsx). No React, no MUI: the
// chart's sizing rules and its tooltip models are arithmetic and string-building, and keeping
// them here leaves the component as the SVG it draws. The only value imports are MUI-free and
// carry no `@shared/*` value import of their own, so this module stays loadable outside the
// renderer bundle.
//
// Timeline sizing (Task #54): the chart FILLS its container. Width comes from a ResizeObserver on
// the scroll box; lane height grows to use the available vertical space (min MIN_LANE_H for
// readability, up to MAX_LANE_H) and only scrolls when lanes×min exceeds the container. Fonts/ticks
// scale with lane height so the chart reads as the hero of the view at large sizes.

import type { StanceSpan, TimelineEvent, TimelineMarker, TimelineView } from '@shared/combat'
import type { ChartTooltipModel, TooltipRow } from '../../lib/ChartTooltip'
import { formatTime } from '../../lib/formatDate'
import { formatNum as fmt } from '../../lib/formatRate'
import { MARKER_COLOR, MARKER_VERB, MARKER_WORD } from './markerStyle'

export const MIN_LANE_H = 22
export const MAX_LANE_H = 40
export const PIN_H = 16
export const PAD = 8
export const MIN_PLOT_W = 320
export const AXIS_H = 22
/** the marker rail's height — 0 for a fight that had no markers at all. */
export const MARKER_RAIL_H = 12
/** deepest zoom: half a second across the plot */
export const MIN_SPAN_MS = 500
/** per wheel notch / button click */
export const ZOOM_STEP = 1.35

/** Left-axis label gutter width, scaled up a touch at larger lane heights. */
function labelGutter(laneH: number): number {
  return laneH >= 32 ? 168 : laneH >= 26 ? 148 : 132
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function fmtClock(ms: number): string {
  // finer-grained axis label at deep zoom (m:ss.d)
  const s = Math.max(0, ms / 1000)
  const m = Math.floor(s / 60)
  const rem = s - m * 60
  return `${m}:${rem.toFixed(rem < 10 ? 1 : 0).padStart(rem < 10 ? 4 : 2, '0')}`
}

/** The visible time window into the encounter, in ms. */
export interface ViewWin {
  start: number
  end: number
}

/** The measured scroll container. */
export interface WrapSize {
  w: number
  h: number
}

export type PinGroup = 'stance' | 'invocation'

/** Every derived size the SVG needs, in one pass over the measured container. */
export interface TimelineMetrics {
  /** which pinned rows exist at all (a fight with no invocation gets no invocation row). */
  pinRows: PinGroup[]
  pinBlockH: number
  /** y-offset of the marker rail (the pin block plus its gap). */
  markerTop: number
  /** the marker rail's height, 0 when this fight carries no markers. */
  railH: number
  /** y-offset of the lane block: the pin block, its gap and the marker rail. The SVG's one
   *  repeated translate. */
  laneTop: number
  laneH: number
  labelW: number
  plotW: number
  plotH: number
  totalH: number
  labelFont: number
  axisFont: number
  /** max lane-label chars before ellipsis, scaled to the (wider) gutter at larger sizes. */
  labelMax: number
  /** damage-tick base width, so ticks stay visible when the chart is big. */
  tickW: number
}

export function timelineMetrics(tl: TimelineView, wrap: WrapSize): TimelineMetrics {
  const pinRows: PinGroup[] = []
  if (tl.stanceSpans.some((s) => s.group === 'stance')) pinRows.push('stance')
  if (tl.stanceSpans.some((s) => s.group === 'invocation')) pinRows.push('invocation')

  const pinBlockH = pinRows.length * (PIN_H + 2)
  const markerTop = pinBlockH + (pinBlockH ? 6 : 0)
  // The rail costs nothing on a fight that never changed a stance / coated a blade / landed a
  // slow — the same conditional the pin rows already use, so lane geometry is untouched there.
  const railH = tl.markers.length > 0 ? MARKER_RAIL_H : 0
  const laneTop = markerTop + railH
  const laneCount = Math.max(1, tl.lanes.length)
  // Grow lane height to fill the vertical space left after pins + axis; clamp to [MIN,MAX].
  // Below MIN (many lanes) the chart exceeds the container and the wrapper scrolls.
  const availLaneH = wrap.h - laneTop - AXIS_H
  const laneH = Math.max(MIN_LANE_H, Math.min(MAX_LANE_H, Math.floor(availLaneH / laneCount)))
  const labelW = labelGutter(laneH)
  const plotW = Math.max(MIN_PLOT_W, wrap.w - labelW - PAD * 2)
  const plotH = laneCount * laneH
  return {
    pinRows,
    pinBlockH,
    markerTop,
    railH,
    laneTop,
    laneH,
    labelW,
    plotW,
    plotH,
    totalH: laneTop + plotH + AXIS_H,
    // Font sizes scale with lane height so ticks + labels read well when the chart is the hero.
    labelFont: laneH >= 32 ? 13 : laneH >= 26 ? 12 : 10,
    axisFont: laneH >= 32 ? 12 : 10,
    labelMax: labelW >= 168 ? 26 : labelW >= 148 ? 23 : 20,
    tickW: laneH >= 32 ? 3 : 2
  }
}

// ── Tooltip models ─────────────────────────────────────────────────────────────────
//
// The hover layer positions; these say WHAT is under the cursor. Structured rather than
// `string[]` so a value can carry its category tint and the honesty footer can be styled as one
// (the old flat lines could only be "first line bold, rest dim").

/** The content half of a ChartTooltip — everything except where the cursor is. Derived from the
 *  tooltip's own model, so the two can't drift. */
export type TipContent = Omit<ChartTooltipModel, 'x' | 'y' | 'bounds'>

/** The two data hues a tick tooltip tints with. Passed IN rather than imported: `CAT_COLOR` /
 *  `RESIST_COLOR` live in the MUI-importing combatShared, and this module stays MUI-free. */
export interface TipPalette {
  /** the event's category color (CAT_COLOR[e.category]). */
  cat: string
  /** RESIST_COLOR — the miss/resist tint. */
  resist: string
}

function whoWord(kind: TimelineEvent['kind']): string {
  return kind === 'you' ? 'You' : kind === 'pet' ? 'Pet' : 'Enemy'
}

/** A fully-resisted spell: the lane is the spell's own, and nothing landed. */
function resistTip(e: TimelineEvent, who: string, p: TipPalette): TipContent {
  const whose = who === 'You' ? 'your' : who === 'Pet' ? "pet's" : 'the'
  return {
    title: `${e.lane} — RESISTED`,
    subtitle: `${who} · ${fmtClock(e.t)}`,
    // NO amount, ever (world-model law 8: a resist is damage-free) — and it says so in words,
    // because a bare `0` here would read as "hit for zero".
    rows: [
      { value: `${e.target ?? '?'} resisted ${whose} spell` },
      { value: 'no damage — a fully-resisted cast', color: p.resist }
    ]
  }
}

/** An avoided swing — `detail` names which of the miss family it was. */
function missTip(e: TimelineEvent, who: string, p: TipPalette): TipContent {
  return {
    title: `${e.lane} — ${(e.detail ?? 'miss').toUpperCase()}`,
    subtitle: `${who} · ${fmtClock(e.t)}`,
    rows: [
      { value: `${who} vs ${e.target ?? '?'}` },
      { value: 'no damage — an avoided swing', color: p.resist }
    ]
  }
}

function hitTip(e: TimelineEvent, who: string, p: TipPalette): TipContent {
  const rows: TooltipRow[] = [{ value: fmt(e.amount), color: p.cat }]
  if (e.target) rows.push({ value: `→ ${e.target}` })
  if (e.modifiers?.length) rows.push({ value: e.modifiers.join(' ') })
  return {
    // An observed amount is never `~`-prefixed: one tick is an observation, not a scaled estimate.
    title: `${e.lane}${e.crit ? ' · CRIT' : ''}`,
    subtitle: `${who} · ${fmtClock(e.t)}`,
    rows
  }
}

/** Hover model for one tick: ability · amount · modifiers · target · time (or the outcome). */
export function tickTooltip(e: TimelineEvent, p: TipPalette): TipContent {
  const who = whoWord(e.kind)
  if (e.outcome === 'resist') return resistTip(e, who, p)
  if (e.outcome === 'miss') return missTip(e, who, p)
  return hitTip(e, who, p)
}

/** Hover model for one marker: what changed, and when it changed. */
export function markerTooltip(m: TimelineMarker): TipContent {
  const rows: TooltipRow[] = [
    { value: `${MARKER_VERB[m.kind]} ${fmtClock(m.t)}`, color: MARKER_COLOR[m.kind] }
  ]
  if (m.detail) rows.push({ value: m.detail })
  return { title: `${m.label} — ${MARKER_WORD[m.kind]}`, rows }
}

/** Hover model for a pinned stance / invocation SPAN. */
export function spanTooltip(s: StanceSpan): TipContent {
  return {
    title: `${s.group}: ${s.name}`,
    rows: [{ value: `${fmtDur(s.start)} – ${fmtDur(s.end)}` }, { value: `${fmtDur(s.end - s.start)} active` }]
  }
}

/**
 * Hover model for empty plot space: just where the cursor is in the fight. The wall clock comes
 * from the view's own `startTs` (display only) through lib/formatDate, and the extremes are
 * named rather than left as a bare 0:00.
 */
export function timeTooltip(t: number, startTs: number, durationMs: number): TipContent {
  const edge = t <= 0 ? 'fight start' : t >= durationMs ? 'fight end' : ''
  const clock = formatTime(startTs ? startTs + t : 0)
  const subtitle = [edge, clock].filter((s) => s !== '').join(' · ')
  return { title: fmtClock(Math.max(0, Math.min(durationMs, t))), ...(subtitle ? { subtitle } : {}), rows: [] }
}
