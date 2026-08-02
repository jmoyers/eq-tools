import { memo, useMemo, useState } from 'react'
import { Box, Paper, Stack, Typography } from '@mui/material'
import type { DamageCategory, TimelineView } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'

// Dense, dark, WarcraftLogs-style timeline (Task #51): X = encounter time, Y = one row
// per skill/spell (left-axis labels), ticks where events occurred. Stance/invocation
// spans are pinned above the skill lanes. SVG render (crisp at any zoom, cheap hover).

const CAT_COLOR: Record<DamageCategory, string> = {
  melee: '#d9b25f',
  slay: '#e8d48a',
  spell: '#a98fe0',
  dot: '#6fb3d2',
  ds: '#cf6679'
}
const KIND_OPACITY: Record<string, number> = { you: 1, pet: 0.75, enemy: 0.5 }

const LANE_H = 18
const LABEL_W = 132
const PIN_H = 16
const PAD = 8

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(Math.round(n))
}

interface Hover {
  x: number
  y: number
  text: string
}

function CombatTimelineInner({ tl }: { tl: TimelineView }): JSX.Element {
  const [hover, setHover] = useState<Hover | null>(null)

  // Lane index by label (Y position). Lanes are pre-sorted (category, total desc) by the
  // engine; keep that order top→bottom.
  const laneIndex = useMemo(() => {
    const m = new Map<string, number>()
    tl.lanes.forEach((l, i) => m.set(l.lane, i))
    return m
  }, [tl.lanes])

  const pinRows = useMemo(() => {
    const groups: Array<'stance' | 'invocation'> = []
    if (tl.stanceSpans.some((s) => s.group === 'stance')) groups.push('stance')
    if (tl.stanceSpans.some((s) => s.group === 'invocation')) groups.push('invocation')
    return groups
  }, [tl.stanceSpans])

  const pinBlockH = pinRows.length * (PIN_H + 2)
  const plotW = 640
  const plotH = tl.lanes.length * LANE_H
  const totalH = pinBlockH + (pinBlockH ? 6 : 0) + plotH + 22 // +axis
  const dur = Math.max(1, tl.durationMs)
  const xOf = (t: number): number => LABEL_W + (Math.min(dur, Math.max(0, t)) / dur) * plotW

  // Axis ticks: ~6 evenly spaced.
  const ticks = useMemo(() => {
    const n = 6
    return Array.from({ length: n + 1 }, (_, i) => (dur * i) / n)
  }, [dur])

  return (
    <Paper variant="outlined" sx={{ p: 1.5, flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1 }}>
        <Typography variant="subtitle1" noWrap>
          {tl.name} · timeline
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {fmtDur(tl.durationMs)} · {tl.lanes.length} lanes ·{' '}
          {tl.downsampled ? `showing ${tl.events.length} of ${tl.rawCount} events` : `${tl.rawCount} events`}
        </Typography>
      </Stack>
      <Box sx={{ overflow: 'auto', flexGrow: 1, position: 'relative' }}>
        <svg
          width={LABEL_W + plotW + PAD}
          height={totalH + PAD}
          style={{ display: 'block', fontFamily: 'inherit' }}
          onMouseLeave={() => setHover(null)}
        >
          {/* pinned stance / invocation spans */}
          {pinRows.map((group, gi) => {
            const y = gi * (PIN_H + 2)
            return (
              <g key={group}>
                <text x={4} y={y + PIN_H - 4} fontSize={10} fill="#9aa0aa">
                  {group === 'stance' ? 'Stance' : 'Invocation'}
                </text>
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
                              x: (x1 + x2) / 2,
                              y: y + PIN_H,
                              text: `${group}: ${s.name} · ${fmtDur(s.start)}–${fmtDur(s.end)}`
                            })
                          }
                        />
                        {x2 - x1 > 30 && (
                          <text x={x1 + 3} y={y + PIN_H - 4} fontSize={9} fill="#e6e6e6" style={{ pointerEvents: 'none' }}>
                            {s.name}
                          </text>
                        )}
                      </g>
                    )
                  })}
              </g>
            )
          })}

          {/* lane labels + gridlines */}
          <g transform={`translate(0, ${pinBlockH + (pinBlockH ? 6 : 0)})`}>
            {tl.lanes.map((l, i) => {
              const y = i * LANE_H
              return (
                <g key={l.lane}>
                  <rect x={LABEL_W} y={y} width={plotW} height={LANE_H} fill={i % 2 ? 'rgba(255,255,255,0.02)' : 'transparent'} />
                  <text x={LABEL_W - 6} y={y + LANE_H - 5} fontSize={10} textAnchor="end" fill="#c8c8c8">
                    <title>{`${CATEGORY_LABEL[l.category]} · ${fmt(l.total)} total`}</title>
                    {l.lane.length > 20 ? l.lane.slice(0, 19) + '…' : l.lane}
                  </text>
                  <rect x={LABEL_W - 3} y={y + 3} width={2} height={LANE_H - 6} fill={CAT_COLOR[l.category]} opacity={0.8} />
                </g>
              )
            })}

            {/* event ticks */}
            {tl.events.map((e, i) => {
              const lane = laneIndex.get(e.lane)
              if (lane === undefined) return null
              const x = xOf(e.t)
              const y = lane * LANE_H
              const h = e.crit ? LANE_H - 2 : LANE_H - 8
              return (
                <rect
                  key={i}
                  x={x}
                  y={y + (LANE_H - h) / 2}
                  width={e.crit ? 3 : 2}
                  height={h}
                  fill={CAT_COLOR[e.category]}
                  opacity={KIND_OPACITY[e.kind] ?? 0.7}
                  onMouseEnter={() =>
                    setHover({
                      x,
                      y: y + LANE_H,
                      text: `${e.lane} · ${fmt(e.amount)}${e.crit ? ' crit' : ''}${
                        e.modifiers && e.modifiers.length ? ` · ${e.modifiers.join(' ')}` : ''
                      } · ${fmtDur(e.t)}`
                    })
                  }
                />
              )
            })}
          </g>

          {/* time axis */}
          <g transform={`translate(0, ${pinBlockH + (pinBlockH ? 6 : 0) + plotH})`}>
            <line x1={LABEL_W} y1={2} x2={LABEL_W + plotW} y2={2} stroke="rgba(255,255,255,0.15)" />
            {ticks.map((t, i) => (
              <text key={i} x={xOf(t)} y={16} fontSize={9} textAnchor="middle" fill="#9aa0aa">
                {fmtDur(t)}
              </text>
            ))}
          </g>
        </svg>

        {hover && (
          <Box
            sx={{
              position: 'absolute',
              left: Math.min(hover.x + 8, LABEL_W + plotW - 160),
              top: hover.y + 4,
              bgcolor: 'rgba(20,20,24,0.96)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 0.5,
              px: 0.75,
              py: 0.25,
              pointerEvents: 'none',
              zIndex: 5,
              maxWidth: 240
            }}
          >
            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
              {hover.text}
            </Typography>
          </Box>
        )}
      </Box>
    </Paper>
  )
}

export const CombatTimeline = memo(CombatTimelineInner)
