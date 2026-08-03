// The leveling view's two inline SVG chart primitives. They take already-derived
// series (see ./levelSeries.ts for the world model behind the level one) and draw
// them — no data shaping, no MUI, no chart library. Split out of LevelingView.tsx
// for file mass; the drawing rules themselves are unchanged.

import type { JSX } from 'react'
import type { LevelSegment } from './levelSeries'

/** Simple filled area chart of a cumulative series over time. */
export function AreaChart({
  points,
  color
}: {
  points: { ts: number; y: number }[]
  color: string
}): JSX.Element | null {
  if (points.length < 2) return null
  const W = 720
  const H = 150
  const pad = 8
  const t0 = points[0].ts
  const t1 = points[points.length - 1].ts
  const yMax = points[points.length - 1].y || 1
  const x = (t: number): number => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad)
  const y = (v: number): number => H - pad - (v / yMax) * (H - 2 * pad)
  const line = points.map((p) => `${x(p.ts).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')
  const area = `${pad},${H - pad} ${line} ${(W - pad).toFixed(1)},${H - pad}`
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
      <polygon points={area} fill={color} opacity={0.18} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={2} />
    </svg>
  )
}

export const SWAP_COLOR = '#8fa3b8'

/**
 * Level over time, drawn HONESTLY (see ./levelSeries.ts for the world model).
 *
 * A level is a step function: it holds until the next ding, so the line is step-AFTER —
 * never a diagonal that implies you were level 43.6 on Thursday afternoon. A loadout swap
 * drops the reported level with NO log line, so the segments are drawn DISJOINT: the
 * pre-swap segment runs flat to the swap boundary, a dashed rule marks the boundary, and
 * the new segment starts at its first observed ding. Nothing is drawn descending, because
 * nothing descending was ever observed — you did not lose levels, you changed classes.
 * Cheap inline SVG (these surfaces are render-bound; no chart libs).
 */
export function LevelStepChart({
  segments,
  color
}: {
  segments: LevelSegment[]
  color: string
}): JSX.Element | null {
  const all = segments.flatMap((s) => s.points)
  if (all.length < 2) return null
  const W = 720
  const H = 150
  const padX = 8
  const padTop = 14
  const padBottom = 8
  const t0 = all[0].ts
  const tLast = all[all.length - 1].ts
  const span = Math.max(1, tLast - t0)
  // Trailing flat run so the CURRENT level reads as a plateau, not a bare endpoint.
  const t1 = tLast + span * 0.04
  const hi = all.reduce((m, p) => Math.max(m, p.level), all[0].level)
  const lo = all.reduce((m, p) => Math.min(m, p.level), all[0].level)
  // Baseline one level under the lowest observed ding: the fill follows the steps rather
  // than reaching an arbitrary zero, so a low post-swap segment doesn't look like a crater.
  const base = lo - 1
  const x = (t: number): number => padX + ((t - t0) / (t1 - t0)) * (W - 2 * padX)
  const y = (v: number): number => H - padBottom - ((v - base) / Math.max(1, hi - base)) * (H - padTop - padBottom)
  const floor = H - padBottom

  const drawn = segments.map((seg, i) => {
    const end = i + 1 < segments.length ? segments[i + 1].points[0].ts : t1
    const pts: string[] = []
    let py = y(seg.points[0].level)
    for (const p of seg.points) {
      const px = x(p.ts)
      if (pts.length) pts.push(`${px.toFixed(1)},${py.toFixed(1)}`) // hold the old level…
      py = y(p.level)
      pts.push(`${px.toFixed(1)},${py.toFixed(1)}`) // …then step up at the ding
    }
    pts.push(`${x(end).toFixed(1)},${py.toFixed(1)}`)
    const x0 = x(seg.points[0].ts)
    return {
      line: pts.join(' '),
      area: `${x0.toFixed(1)},${floor} ${pts.join(' ')} ${x(end).toFixed(1)},${floor}`,
      startX: x0,
      startY: y(seg.points[0].level),
      afterSwap: seg.afterSwap
    }
  })

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
      {drawn.map((d, i) => (
        <g key={i}>
          <polygon points={d.area} fill={color} opacity={0.12} />
          <polyline points={d.line} fill="none" stroke={color} strokeWidth={2} />
        </g>
      ))}
      {drawn.map((d, i) =>
        d.afterSwap ? (
          <g key={`s${i}`}>
            <line
              x1={d.startX}
              y1={padTop - 6}
              x2={d.startX}
              y2={floor}
              stroke={SWAP_COLOR}
              strokeWidth={1}
              strokeDasharray="3 4"
              opacity={0.9}
            />
            <circle cx={d.startX} cy={d.startY} r={3.5} fill="none" stroke={SWAP_COLOR} strokeWidth={1.5} />
          </g>
        ) : null
      )}
      <text x={padX} y={padTop} fill={color} fontSize={10} opacity={0.7}>
        {hi}
      </text>
      <text x={padX} y={floor - 2} fill={color} fontSize={10} opacity={0.7}>
        {lo}
      </text>
    </svg>
  )
}
