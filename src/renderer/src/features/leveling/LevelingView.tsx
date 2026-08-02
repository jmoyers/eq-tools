import { useMemo } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import MilitaryTechIcon from '@mui/icons-material/MilitaryTech'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import BoltIcon from '@mui/icons-material/Bolt'
import type { AASpendEvent, LevelingDelta, LevelingSnap } from '@shared/types'
import { computeAAAccounting } from '@shared/aa'
import { useModule } from '../../lib/useModule'
import { formatDate } from '../../lib/formatDate'
import {
  buildLevelSegments,
  latestLevel,
  levelFeedEntries,
  peakLevel,
  sortLevels,
  swapCount,
  type LevelSegment
} from './levelSeries'

const EMPTY_LEVELING: LevelingSnap = { levels: [], aaGains: [], aaSpends: [] }

const applyLevelingDelta = (s: LevelingSnap, d: LevelingDelta): LevelingSnap => ({
  levels: [...s.levels, ...d.levels],
  aaGains: [...s.aaGains, ...d.aaGains],
  aaSpends: [...s.aaSpends, ...d.aaSpends]
})

function fmtDelta(ms: number): string {
  if (ms <= 0) return '—'
  const mins = ms / 60000
  if (mins < 60) return `${Math.round(mins)}m`
  const hrs = mins / 60
  if (hrs < 48) return `${hrs.toFixed(1)}h`
  return `${(hrs / 24).toFixed(1)}d`
}

function HeroCard({
  icon,
  value,
  label,
  sub,
  accent
}: {
  icon: JSX.Element
  value: string
  label: string
  sub?: string
  accent: string
}): JSX.Element {
  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, flex: 1, minWidth: 160, borderLeft: `3px solid ${accent}`, display: 'flex', gap: 1.5 }}
    >
      <Box sx={{ color: accent, display: 'flex', alignItems: 'center' }}>{icon}</Box>
      <Box>
        <Typography variant="h4" sx={{ lineHeight: 1, color: accent }}>
          {value}
        </Typography>
        <Typography variant="body2">{label}</Typography>
        {sub && (
          <Typography variant="caption" color="text.secondary">
            {sub}
          </Typography>
        )}
      </Box>
    </Paper>
  )
}

/** Simple filled area chart of a cumulative series over time. */
function AreaChart({ points, color }: { points: { ts: number; y: number }[]; color: string }): JSX.Element | null {
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

const SWAP_COLOR = '#8fa3b8'

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
function LevelStepChart({ segments, color }: { segments: LevelSegment[]; color: string }): JSX.Element | null {
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

interface FeedItem {
  ts: number
  kind: 'level' | 'aa' | 'swap'
  label: string
  detail: string
}

const FEED_COLOR: Record<FeedItem['kind'], string> = {
  level: '#d9b25f',
  aa: '#6fb3d2',
  swap: SWAP_COLOR
}

export default function LevelingView(): JSX.Element {
  const state = useModule<LevelingSnap, LevelingDelta>('leveling', applyLevelingDelta) ?? EMPTY_LEVELING
  const { levels, aaGains: aas, aaSpends: spends } = state

  const sortedLevels = useMemo(() => sortLevels(levels), [levels])
  const sortedAAs = useMemo(() => [...aas].sort((a, b) => a.ts - b.ts), [aas])

  // CURRENT level is the LATEST reported one, never max(). You level three classes at once
  // and a loadout swap re-reports the level of the new (lowest) class — so the peak belongs
  // to a class that may no longer be in the loadout. It's surfaced separately as "peak".
  const levelSegments = useMemo(() => buildLevelSegments(sortedLevels), [sortedLevels])
  const currentLevel = latestLevel(sortedLevels)
  const peak = peakLevel(sortedLevels)
  const swaps = swapCount(levelSegments)

  // Refund-proof AA accounting (Task #48). The headline is NOT Σ gains — a respec
  // refunds points with no log line, they re-enter as fresh gain lines, so Σ gains
  // double-counts every refunded point. Instead:
  //   allocated = latest-epoch cost per (ability,rank), cost-0 auto-grants excluded
  //   unspent   = last authoritative "you now have" − spends after it
  //   earned    = allocated + unspent   (the identity the user validated)
  // See src/shared/aa.ts for the full derivation.
  const acct = useMemo(() => computeAAAccounting(aas, spends), [aas, spends])
  const aaEarned = acct.earned
  const aaSpent = acct.allocated
  const aaUnspent = aas.length ? acct.unspent : null
  const boughtCount = acct.boughtCount

  // Purchases list: newest first, with respec re-buys deduped. The same
  // ability+rank bought more than once (a respec then re-buy) collapses to its
  // most-recent purchase, tagged with a ×N count. Auto-grants (cost 0) are kept
  // but badged rather than counted as purchases.
  const purchases = useMemo(() => {
    const byKey = new Map<string, { ev: AASpendEvent; count: number }>()
    for (const s of spends) {
      const key = s.ability
      const prev = byKey.get(key)
      if (!prev) byKey.set(key, { ev: s, count: 1 })
      else byKey.set(key, { ev: s.ts >= prev.ev.ts ? s : prev.ev, count: prev.count + 1 })
    }
    return [...byKey.values()].sort((a, b) => b.ev.ts - a.ev.ts)
  }, [spends])

  const aaCumulative = useMemo(() => {
    let sum = 0
    return sortedAAs.map((a) => ({ ts: a.ts, y: (sum += a.amount) }))
  }, [sortedAAs])

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = []
    for (const e of levelFeedEntries(sortedLevels)) {
      // A post-swap ding is the first level of a NEW loadout: the elapsed time back to the
      // previous ding spans the (unlogged) swap, so it is not a "time to level" — showing
      // `+38.9h` there would be fabricated. Label the swap instead.
      items.push({
        ts: e.ts,
        kind: e.afterSwap ? 'swap' : 'level',
        label: e.afterSwap ? `Level ${e.level} (class swap)` : `Level ${e.level}`,
        detail: e.afterSwap ? 'new loadout — level re-reported' : e.sinceMs != null ? `+${fmtDelta(e.sinceMs)}` : ''
      })
    }
    for (const a of sortedAAs) {
      items.push({ ts: a.ts, kind: 'aa', label: `+${a.amount} AA`, detail: `${a.nowHave} unspent` })
    }
    return items.sort((a, b) => b.ts - a.ts).slice(0, 60)
  }, [sortedLevels, sortedAAs])

  const nothing = sortedLevels.length === 0 && sortedAAs.length === 0

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <HeroCard
          icon={<MilitaryTechIcon fontSize="large" />}
          value={currentLevel != null ? String(currentLevel) : '—'}
          label="Character level"
          sub={
            sortedLevels.length
              ? `${sortedLevels.length} level-ups logged` +
                (swaps > 0 ? ` · peak ${peak} · ${swaps} class swap${swaps === 1 ? '' : 's'}` : '')
              : 'no level-ups in log'
          }
          accent="#d9b25f"
        />
        <HeroCard
          icon={<AutoAwesomeIcon fontSize="large" />}
          value={aaEarned ? aaEarned.toLocaleString() : '—'}
          label="AA points earned"
          sub="spent + unspent"
          accent="#6fb3d2"
        />
        <HeroCard
          icon={<AutoAwesomeIcon fontSize="large" />}
          value={aaSpent ? aaSpent.toLocaleString() : '—'}
          label="AA points spent"
          sub={`${boughtCount} abilities allocated`}
          accent="#b07fd0"
        />
        <HeroCard
          icon={<BoltIcon fontSize="large" />}
          value={aaUnspent != null ? aaUnspent.toLocaleString() : '—'}
          label="AA unspent"
          sub="last reported balance"
          accent="#5fbf72"
        />
      </Stack>

      {nothing ? (
        <Typography color="text.secondary" sx={{ p: 2 }}>
          No level-ups or AA gains found in this character&apos;s log yet. They&apos;ll appear here live as you play.
        </Typography>
      ) : (
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} sx={{ flexGrow: 1, minHeight: 0 }}>
          <Stack spacing={2} sx={{ flex: 2, minWidth: 320 }}>
            {aaCumulative.length >= 2 && (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle2">AA gained over time</Typography>
                <Typography variant="caption" color="text.secondary" gutterBottom display="block">
                  cumulative gain lines — includes points re-gained after a respec, so the final
                  value runs ahead of the {aaEarned.toLocaleString()} earned headline
                </Typography>
                <AreaChart points={aaCumulative} color="#6fb3d2" />
              </Paper>
            )}
            {sortedLevels.length >= 2 && (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle2">Level over time</Typography>
                <Typography variant="caption" color="text.secondary" gutterBottom display="block">
                  {swaps > 0 ? (
                    <>
                      steps hold until the next ding; a{' '}
                      <Box component="span" sx={{ color: SWAP_COLOR }}>
                        dashed break
                      </Box>{' '}
                      is a class swap — the level is re-reported for the new loadout, not lost
                    </>
                  ) : (
                    'steps hold until the next ding'
                  )}
                </Typography>
                <LevelStepChart segments={levelSegments} color="#d9b25f" />
              </Paper>
            )}
          </Stack>

          <Stack spacing={2} sx={{ flex: 1, minWidth: 260, minHeight: 0 }}>
            {purchases.length > 0 && (
              <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', maxHeight: '45%' }}>
                <Typography variant="subtitle2" gutterBottom>
                  AAs purchased{' '}
                  <Typography component="span" variant="caption" color="text.secondary">
                    ({boughtCount})
                  </Typography>
                </Typography>
                <Box sx={{ overflow: 'auto' }}>
                  {purchases.map(({ ev: p, count }, i) => {
                    const auto = p.cost === 0
                    return (
                      <Stack key={`${p.ts}-${i}`} direction="row" spacing={1} alignItems="center" sx={{ py: 0.3 }}>
                        <AutoAwesomeIcon sx={{ fontSize: 12, color: auto ? '#7a7a7a' : '#b07fd0' }} />
                        <Typography
                          variant="caption"
                          sx={{ flexGrow: 1, color: auto ? 'text.secondary' : 'text.primary' }}
                          noWrap
                          title={p.ability}
                        >
                          {p.ability}
                          {count > 1 && (
                            <Typography component="span" variant="caption" color="text.disabled">
                              {' '}
                              ×{count}
                            </Typography>
                          )}
                        </Typography>
                        {auto ? (
                          <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
                            auto-granted
                          </Typography>
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            {p.cost} pt{p.cost === 1 ? '' : 's'}
                          </Typography>
                        )}
                      </Stack>
                    )
                  })}
                </Box>
              </Paper>
            )}
            <Paper variant="outlined" sx={{ p: 2, flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <Typography variant="subtitle2" gutterBottom>
                Recent progress
              </Typography>
              <Box sx={{ overflow: 'auto' }}>
                {feed.map((f, i) => (
                <Stack
                  key={`${f.ts}-${f.kind}-${i}`}
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  sx={{ py: 0.4 }}
                >
                  <Chip
                    size="small"
                    label={f.label}
                    sx={{
                      height: 20,
                      bgcolor: `${FEED_COLOR[f.kind]}22`,
                      color: FEED_COLOR[f.kind],
                      fontWeight: 700,
                      minWidth: 68
                    }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }} noWrap>
                    {f.detail}
                  </Typography>
                  <Typography variant="caption" color="text.disabled" noWrap>
                    {formatDate(f.ts)}
                  </Typography>
                </Stack>
              ))}
              </Box>
            </Paper>
          </Stack>
        </Stack>
      )}
    </Stack>
  )
}
