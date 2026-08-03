// Pure geometry + text for the combat TIMELINE (CombatTimeline.tsx). No React, no MUI: the
// chart's sizing rules and its tick tooltips are arithmetic and string-building, and keeping
// them here leaves the component as the SVG it draws.
//
// Timeline sizing (Task #54): the chart FILLS its container. Width comes from a ResizeObserver on
// the scroll box; lane height grows to use the available vertical space (min MIN_LANE_H for
// readability, up to MAX_LANE_H) and only scrolls when lanes×min exceeds the container. Fonts/ticks
// scale with lane height so the chart reads as the hero of the view at large sizes.

import type { TimelineEvent, TimelineView } from '@shared/combat'
import { formatNum as fmt } from '../../lib/formatRate'

export const MIN_LANE_H = 22
export const MAX_LANE_H = 40
export const PIN_H = 16
export const PAD = 8
export const MIN_PLOT_W = 320
export const AXIS_H = 22
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

/** The floating tooltip's anchor + text. */
export interface Hover {
  x: number
  y: number
  lines: string[]
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
  /** y-offset of the lane block: the pin block plus its gap. The SVG's one repeated translate. */
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
  const laneTop = pinBlockH + (pinBlockH ? 6 : 0)
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

function whoWord(kind: TimelineEvent['kind']): string {
  return kind === 'you' ? 'You' : kind === 'pet' ? 'Pet' : 'Enemy'
}

/** A fully-resisted spell: the lane is the spell's own, and nothing landed. */
function resistTip(e: TimelineEvent, who: string): string[] {
  const whose = who === 'You' ? 'your' : who === 'Pet' ? "pet's" : 'the'
  return [`${e.lane} — RESISTED`, `${e.target ?? '?'} resisted ${whose} spell`, fmtDur(e.t)]
}

/** An avoided swing — `detail` names which of the miss family it was. */
function missTip(e: TimelineEvent, who: string): string[] {
  return [`${e.lane} — ${(e.detail ?? 'miss').toUpperCase()}`, `${who} vs ${e.target ?? '?'}`, fmtDur(e.t)]
}

function hitTip(e: TimelineEvent, who: string): string[] {
  const mods = e.modifiers?.length ? ` · ${e.modifiers.join(' ')}` : ''
  return [
    `${e.lane}${e.crit ? ' · CRIT' : ''}`,
    `${fmt(e.amount)}${mods}${e.target ? ` → ${e.target}` : ''}`,
    `${who} · ${fmtDur(e.t)}`
  ]
}

/** Hover text for one tick: ability · amount · modifiers · target · time (or the outcome). */
export function tickTooltip(e: TimelineEvent): string[] {
  const who = whoWord(e.kind)
  if (e.outcome === 'resist') return resistTip(e, who)
  if (e.outcome === 'miss') return missTip(e, who)
  return hitTip(e, who)
}
