// The timeline's SVG parts (CombatTimeline.tsx draws them into one <svg>). Every component
// here returns a FRAGMENT of sibling elements — the wrapping <g> groups, their clip paths and
// their transforms stay in the parent, so the emitted SVG tree is exactly what it was when this
// was one function.

import type { TimelineEvent, TimelineView } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'
import { formatNum as fmt } from '../../lib/formatRate'
import { CAT_COLOR, RESIST_COLOR } from './combatShared'
import { MARKER_COLOR } from './markerStyle'
import { MARKER_RAIL_H, PIN_H, fmtClock, fmtDur, type PinGroup, type TimelineMetrics } from './timelineGeometry'

// Category colors + the miss/resist tint come from combatShared — ONE source, so the timeline
// lane stripe, the drill-down bar and the overlay can never disagree about what 'slay' looks
// like (it used to keep a private copy, which is how slay stayed melee-gold here).
const KIND_OPACITY: Record<string, number> = { you: 1, pet: 0.75, enemy: 0.5 }

// NOTHING here binds a pointer handler. Hover is one capture surface on the wrapper plus a
// nearest-in-time hit test (TimelineHoverLayer): a per-element `onMouseEnter` meant up to ~2k
// fresh closures per render, and a 2px tick is a sub-pixel mouse target.

/** The pinned stance / invocation spans, one row per group that the fight actually had. */
export function PinSpans({
  tl,
  m,
  xOf
}: {
  tl: TimelineView
  m: TimelineMetrics
  xOf: (t: number) => number
}): React.JSX.Element {
  return (
    <>
      {m.pinRows.map((group, gi) => {
        const y = gi * (PIN_H + 2)
        return (
          <g key={group}>
            {tl.stanceSpans
              .filter((s) => s.group === group)
              .map((s, i) => {
                const x1 = xOf(s.start)
                const x2 = Math.max(x1 + 2, xOf(s.end))
                return (
                  <g key={i}>
                    <rect
                      x={x1}
                      y={y + 1}
                      width={x2 - x1}
                      height={PIN_H - 2}
                      rx={2}
                      fill={group === 'stance' ? 'rgba(217,178,95,0.35)' : 'rgba(169,143,224,0.35)'}
                      stroke={group === 'stance' ? MARKER_COLOR.stance : MARKER_COLOR.invocation}
                      strokeWidth={0.5}
                    />
                    {x2 - x1 > 30 && (
                      <text x={Math.max(m.labelW + 3, x1 + 3)} y={y + PIN_H - 4} fontSize={9} fill="#e6e6e6" style={{ pointerEvents: 'none' }}>
                        {s.name}
                      </text>
                    )}
                  </g>
                )
              })}
          </g>
        )
      })}
    </>
  )
}

/** The pin-row labels, which live OUTSIDE the plot clip (they sit in the gutter). */
export function PinLabels({ pinRows }: { pinRows: PinGroup[] }): React.JSX.Element {
  return (
    <>
      {pinRows.map((group, gi) => (
        <text key={group} x={4} y={gi * (PIN_H + 2) + PIN_H - 4} fontSize={10} fill="#9aa0aa">
          {group === 'stance' ? 'Stance' : 'Invocation'}
        </text>
      ))}
    </>
  )
}

/** Lane labels + zebra gridlines. Lanes are pre-sorted by the engine; keep that order. */
export function LaneRows({ tl, m }: { tl: TimelineView; m: TimelineMetrics }): React.JSX.Element {
  return (
    <>
      {tl.lanes.map((l, i) => {
        const y = i * m.laneH
        return (
          <g key={l.lane}>
            <rect x={m.labelW} y={y} width={m.plotW} height={m.laneH} fill={i % 2 ? 'rgba(255,255,255,0.02)' : 'transparent'} />
            <text x={m.labelW - 6} y={y + m.laneH / 2 + m.labelFont / 2 - 2} fontSize={m.labelFont} textAnchor="end" fill="#c8c8c8">
              <title>{`${CATEGORY_LABEL[l.category]} · ${fmt(l.total)} total`}</title>
              {l.lane.length > m.labelMax ? l.lane.slice(0, m.labelMax - 1) + '…' : l.lane}
            </text>
            <rect x={m.labelW - 3} y={y + 3} width={2} height={m.laneH - 6} fill={CAT_COLOR[l.category]} opacity={0.8} />
          </g>
        )
      })}
    </>
  )
}

/**
 * ONE event tick. A miss/resist is a HOLLOW, red-tinted mark — an open circle for a resist, a
 * thin hollow bar for a miss — visually distinct from the solid damage ticks (world-model law 8).
 */
function EventTick({ e, x, y, m }: { e: TimelineEvent; x: number; y: number; m: TimelineMetrics }): React.JSX.Element {
  if (e.outcome === 'resist') {
    return <circle cx={x} cy={y + m.laneH / 2} r={3} fill="none" stroke={RESIST_COLOR} strokeWidth={1.2} />
  }
  if (e.outcome === 'miss') {
    return (
      <rect
        x={x - 1}
        y={y + 3}
        width={2}
        height={m.laneH - 6}
        fill="none"
        stroke={RESIST_COLOR}
        strokeWidth={0.9}
        opacity={0.85}
      />
    )
  }
  const h = e.crit ? m.laneH - 2 : m.laneH - 8
  return (
    <rect
      x={x}
      y={y + (m.laneH - h) / 2}
      width={e.crit ? m.tickW + 1 : m.tickW}
      height={h}
      fill={CAT_COLOR[e.category]}
      opacity={KIND_OPACITY[e.kind] ?? 0.7}
    />
  )
}

/** The event ticks, windowed to the visible time range by the caller. */
export function EventTicks({
  events,
  laneIndex,
  m,
  xOf
}: {
  events: TimelineEvent[]
  laneIndex: Map<string, number>
  m: TimelineMetrics
  xOf: (t: number) => number
}): React.JSX.Element {
  return (
    <>
      {events.map((e, i) => {
        const lane = laneIndex.get(e.lane)
        if (lane === undefined) return null
        return <EventTick key={i} e={e} x={xOf(e.t)} y={lane * m.laneH} m={m} />
      })}
    </>
  )
}

/**
 * The MARKER RAIL (Task #64 follow-up): the instants the fight CHANGED — a stance/invocation
 * commit, a blade coat, a slow landing — drawn as a head glyph in their own thin rail plus a
 * full-plot-height guide, so a tick can be read against the setting that was in force when it
 * landed. The same hues and the same slow pennant the DPS curve flies (markerStyle.ts).
 *
 * The guide is deliberately faint: it is a reference line behind the data, not another series.
 */
export function MarkerRail({
  tl,
  m,
  xOf
}: {
  tl: TimelineView
  m: TimelineMetrics
  xOf: (t: number) => number
}): React.JSX.Element {
  return (
    <>
      {tl.markers.map((mk, i) => {
        const x = xOf(mk.t)
        const color = MARKER_COLOR[mk.kind]
        const slow = mk.kind === 'slow'
        return (
          <g key={`${mk.kind}|${mk.t}|${i}`}>
            <line
              x1={x}
              x2={x}
              y1={m.markerTop}
              y2={m.laneTop + m.plotH}
              stroke={color}
              strokeWidth={1}
              opacity={slow ? 0.45 : 0.22}
              strokeDasharray={slow ? undefined : '2 3'}
            />
            {slow ? (
              <polygon
                points={`${x.toFixed(1)},${m.markerTop} ${(x + 7).toFixed(1)},${m.markerTop + 3.5} ${x.toFixed(1)},${m.markerTop + 7}`}
                fill={color}
              />
            ) : (
              <rect x={x - 2} y={m.markerTop + 1} width={4} height={MARKER_RAIL_H - 5} rx={1} fill={color} opacity={0.9} />
            )}
          </g>
        )
      })}
    </>
  )
}

/** The time axis: a hairline plus ~6 evenly spaced labels across the VISIBLE window. */
export function TimeAxis({
  ticks,
  m,
  xOf,
  zoomedIn
}: {
  ticks: number[]
  m: TimelineMetrics
  xOf: (t: number) => number
  zoomedIn: boolean
}): React.JSX.Element {
  return (
    <>
      <line x1={m.labelW} y1={2} x2={m.labelW + m.plotW} y2={2} stroke="rgba(255,255,255,0.15)" />
      {ticks.map((t, i) => (
        <text key={i} x={xOf(t)} y={16} fontSize={m.axisFont} textAnchor="middle" fill="#9aa0aa">
          {zoomedIn ? fmtClock(t) : fmtDur(t)}
        </text>
      ))}
    </>
  )
}
