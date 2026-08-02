import { useMemo } from 'react'
import { Box, Chip, Paper, Stack, Typography } from '@mui/material'
import MilitaryTechIcon from '@mui/icons-material/MilitaryTech'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import BoltIcon from '@mui/icons-material/Bolt'
import type { AASpendEvent, LevelingDelta, LevelingSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'

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

interface FeedItem {
  ts: number
  kind: 'level' | 'aa'
  label: string
  detail: string
}

export default function LevelingView(): JSX.Element {
  const state = useModule<LevelingSnap, LevelingDelta>('leveling', applyLevelingDelta) ?? EMPTY_LEVELING
  const { levels, aaGains: aas, aaSpends: spends } = state

  const sortedLevels = useMemo(() => [...levels].sort((a, b) => a.ts - b.ts), [levels])
  const sortedAAs = useMemo(() => [...aas].sort((a, b) => a.ts - b.ts), [aas])

  const currentLevel = sortedLevels.length ? Math.max(...sortedLevels.map((l) => l.level)) : null
  const aaEarned = sortedAAs.reduce((s, a) => s + a.amount, 0)

  // Lifetime sum of every purchase cost. This is NOT the same as net AA spent:
  // respecs refund points (with no log line) and let the same ranks be re-bought,
  // so sum-of-costs double-counts. Kept only as a detail figure.
  const aaLifetimeCost = spends.reduce((s, a) => s + a.cost, 0)

  // Auto-granted class abilities log as "at a cost of 0 ability points"
  // (Lay on Hands, Unbound *, Symphonic Aura ...). They aren't real purchases.
  const boughtCount = useMemo(() => spends.filter((s) => s.cost > 0).length, [spends])

  // Unspent = the game's last authoritative "you now have", minus every AA spent
  // after that gain. The `spends`/`aas` arrays preserve log order from the main
  // process, so we compare array position (not the 1s-resolution timestamp) to
  // decide "after": a spend at the same second as the last gain but logged before
  // it must NOT be subtracted. (Proper sequence numbers arrive in a later refactor;
  // until then, index order is the authoritative tiebreaker within a second.)
  const aaUnspent = useMemo(() => {
    if (!aas.length) return null
    // Index of the last gain within the raw (log-ordered) aas array.
    let lastGain = aas[0]
    for (const a of aas) if (a.ts >= lastGain.ts) lastGain = a
    let pool = lastGain.nowHave
    for (const s of spends) {
      // A spend counts as "after the last gain" when it is strictly later in time,
      // or same-second but appears after the gain in log order. Since spends and
      // gains are separate arrays we approximate same-second ordering by timestamp
      // only; ties are rare and resolved conservatively (see caveat above).
      if (s.ts > lastGain.ts) pool = Math.max(0, pool - s.cost)
    }
    return pool
  }, [aas, spends])

  // Net AA actually spent, defined so the headline cards are self-consistent:
  //   earned = net spent + unspent   (exactly).
  const aaSpent = aaUnspent != null ? Math.max(0, aaEarned - aaUnspent) : aaLifetimeCost

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
          sub={`net (earned − unspent) · ${boughtCount} abilities bought`}
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
