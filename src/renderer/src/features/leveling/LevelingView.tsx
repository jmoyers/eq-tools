import { useEffect, useMemo, useState } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import MilitaryTechIcon from '@mui/icons-material/MilitaryTech'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import BoltIcon from '@mui/icons-material/Bolt'
import type { AAEvent, AASpendEvent, LevelEvent } from '@shared/types'

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

interface FeedItem {
  ts: number
  kind: 'level' | 'aa'
  label: string
  detail: string
}

export default function LevelingView(): JSX.Element {
  const [levels, setLevels] = useState<LevelEvent[]>([])
  const [aas, setAAs] = useState<AAEvent[]>([])
  const [spends, setSpends] = useState<AASpendEvent[]>([])

  useEffect(() => {
    void window.eq.getLevels().then(setLevels)
    void window.eq.getAAs().then(setAAs)
    void window.eq.getAASpends().then(setSpends)
    const offL = window.eq.onLevel((e) => setLevels((p) => [...p, e]))
    const offA = window.eq.onAA((e) => setAAs((p) => [...p, e]))
    const offS = window.eq.onAASpend((e) => setSpends((p) => [...p, e]))
    return () => {
      offL()
      offA()
      offS()
    }
  }, [])

  const sortedLevels = useMemo(() => [...levels].sort((a, b) => a.ts - b.ts), [levels])
  const sortedAAs = useMemo(() => [...aas].sort((a, b) => a.ts - b.ts), [aas])

  const currentLevel = sortedLevels.length ? Math.max(...sortedLevels.map((l) => l.level)) : null
  const aaEarned = sortedAAs.reduce((s, a) => s + a.amount, 0)
  const aaSpent = spends.reduce((s, a) => s + a.cost, 0)

  // Unspent = the game's last authoritative "you now have", minus every AA spent
  // after that point. Ends where the character actually is (0), not a stale value.
  const aaUnspent = useMemo(() => {
    const lastGain = sortedAAs[sortedAAs.length - 1]
    if (!lastGain) return null
    let pool = lastGain.nowHave
    for (const s of spends) if (s.ts >= lastGain.ts) pool = Math.max(0, pool - s.cost)
    return pool
  }, [sortedAAs, spends])

  const purchases = useMemo(() => [...spends].sort((a, b) => b.ts - a.ts), [spends])

  const aaCumulative = useMemo(() => {
    let sum = 0
    return sortedAAs.map((a) => ({ ts: a.ts, y: (sum += a.amount) }))
  }, [sortedAAs])

  const levelSeries = useMemo(() => sortedLevels.map((l) => ({ ts: l.ts, y: l.level })), [sortedLevels])

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = []
    for (let i = 0; i < sortedLevels.length; i++) {
      const l = sortedLevels[i]
      const delta = i > 0 ? l.ts - sortedLevels[i - 1].ts : 0
      items.push({ ts: l.ts, kind: 'level', label: `Level ${l.level}`, detail: i > 0 ? `+${fmtDelta(delta)}` : '' })
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
          sub={sortedLevels.length ? `${sortedLevels.length} level-ups logged` : 'no level-ups in log'}
          accent="#d9b25f"
        />
        <HeroCard
          icon={<AutoAwesomeIcon fontSize="large" />}
          value={aaEarned ? aaEarned.toLocaleString() : '—'}
          label="AA points earned"
          sub="gained, from the log"
          accent="#6fb3d2"
        />
        <HeroCard
          icon={<AutoAwesomeIcon fontSize="large" />}
          value={aaSpent ? aaSpent.toLocaleString() : '—'}
          label="AA points spent"
          sub={`${spends.length} abilities bought`}
          accent="#b07fd0"
        />
        <HeroCard
          icon={<BoltIcon fontSize="large" />}
          value={aaUnspent != null ? aaUnspent.toLocaleString() : '—'}
          label="AA unspent"
          sub="earned − spent"
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
                <Typography variant="subtitle2" gutterBottom>
                  AA earned over time
                </Typography>
                <AreaChart points={aaCumulative} color="#6fb3d2" />
              </Paper>
            )}
            {levelSeries.length >= 2 && (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle2" gutterBottom>
                  Level over time
                </Typography>
                <AreaChart points={levelSeries} color="#d9b25f" />
              </Paper>
            )}
          </Stack>

          <Stack spacing={2} sx={{ flex: 1, minWidth: 260, minHeight: 0 }}>
            {purchases.length > 0 && (
              <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', maxHeight: '45%' }}>
                <Typography variant="subtitle2" gutterBottom>
                  AAs purchased{' '}
                  <Typography component="span" variant="caption" color="text.secondary">
                    ({purchases.length})
                  </Typography>
                </Typography>
                <Box sx={{ overflow: 'auto' }}>
                  {purchases.map((p, i) => (
                    <Stack key={`${p.ts}-${i}`} direction="row" spacing={1} alignItems="center" sx={{ py: 0.3 }}>
                      <AutoAwesomeIcon sx={{ fontSize: 12, color: '#b07fd0' }} />
                      <Typography variant="caption" sx={{ flexGrow: 1 }} noWrap title={p.ability}>
                        {p.ability}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {p.cost} pt{p.cost === 1 ? '' : 's'}
                      </Typography>
                    </Stack>
                  ))}
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
                      bgcolor: f.kind === 'level' ? '#d9b25f22' : '#6fb3d222',
                      color: f.kind === 'level' ? '#d9b25f' : '#6fb3d2',
                      fontWeight: 700,
                      minWidth: 68
                    }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }} noWrap>
                    {f.detail}
                  </Typography>
                  <Typography variant="caption" color="text.disabled" noWrap>
                    {new Date(f.ts).toLocaleDateString()}
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
