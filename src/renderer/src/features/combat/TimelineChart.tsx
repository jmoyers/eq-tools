// The timeline's SVG parts (CombatTimeline.tsx draws them into one <svg>). Every component
// here returns a FRAGMENT of sibling elements — the wrapping <g> groups, their clip paths and
// their transforms stay in the parent, so the emitted SVG tree is exactly what it was when this
// was one function.

import { Box, Typography } from '@mui/material'
import type { TimelineEvent, TimelineView } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'
import { formatNum as fmt } from '../../lib/formatRate'
import { CAT_COLOR, RESIST_COLOR } from './combatShared'
import {
  PIN_H,
  fmtClock,
  fmtDur,
  tickTooltip,
  type Hover,
  type PinGroup,
  type TimelineMetrics
} from './timelineGeometry'

// Category colors + the miss/resist tint come from combatShared — ONE source, so the timeline
// lane stripe, the drill-down bar and the overlay can never disagree about what 'slay' looks
// like (it used to keep a private copy, which is how slay stayed melee-gold here).
const KIND_OPACITY: Record<string, number> = { you: 1, pet: 0.75, enemy: 0.5 }

type SetHover = (h: Hover | null) => void

/** The pinned stance / invocation spans, one row per group that the fight actually had. */
export function PinSpans({
  tl,
  m,
  xOf,
  setHover
}: {
  tl: TimelineView
  m: TimelineMetrics
  xOf: (t: number) => number
  setHover: SetHover
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
                      stroke={group === 'stance' ? '#d9b25f' : '#a98fe0'}
                      strokeWidth={0.5}
                      onMouseEnter={() =>
                        setHover({
                          x: Math.max(m.labelW, (x1 + x2) / 2),
                          y: y + PIN_H,
                          lines: [`${group}: ${s.name}`, `${fmtDur(s.start)}–${fmtDur(s.end)}`]
                        })
                      }
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
function EventTick({
  e,
  x,
  y,
  m,
  onEnter
}: {
  e: TimelineEvent
  x: number
  y: number
  m: TimelineMetrics
  onEnter: () => void
}): React.JSX.Element {
  if (e.outcome === 'resist') {
    return (
      <circle cx={x} cy={y + m.laneH / 2} r={3} fill="none" stroke={RESIST_COLOR} strokeWidth={1.2} onMouseEnter={onEnter} />
    )
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
        onMouseEnter={onEnter}
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
      onMouseEnter={onEnter}
    />
  )
}

/** The event ticks, windowed to the visible time range by the caller. */
export function EventTicks({
  events,
  laneIndex,
  m,
  xOf,
  setHover
}: {
  events: TimelineEvent[]
  laneIndex: Map<string, number>
  m: TimelineMetrics
  xOf: (t: number) => number
  setHover: SetHover
}): React.JSX.Element {
  return (
    <>
      {events.map((e, i) => {
        const lane = laneIndex.get(e.lane)
        if (lane === undefined) return null
        const x = xOf(e.t)
        const y = lane * m.laneH
        return (
          <EventTick
            key={i}
            e={e}
            x={x}
            y={y}
            m={m}
            onEnter={() => setHover({ x: Math.max(m.labelW, x), y: y + m.laneH, lines: tickTooltip(e) })}
          />
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

/** The floating hover card, positioned in the scroll box (outside the SVG). */
export function HoverCard({ hover, m }: { hover: Hover; m: TimelineMetrics }): React.JSX.Element {
  return (
    <Box
      sx={{
        position: 'absolute',
        left: Math.min(hover.x + 8, m.labelW + m.plotW - 170),
        top: hover.y + 4,
        bgcolor: 'rgba(20,20,24,0.96)',
        border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: 0.5,
        px: 0.75,
        py: 0.25,
        pointerEvents: 'none',
        zIndex: 5,
        maxWidth: 260
      }}
    >
      {hover.lines.map((ln, i) => (
        <Typography
          key={i}
          variant="caption"
          sx={{ whiteSpace: 'nowrap', display: 'block', color: i === 0 ? 'text.primary' : 'text.secondary', fontWeight: i === 0 ? 600 : 400 }}
        >
          {ln}
        </Typography>
      ))}
    </Box>
  )
}
