import { type JSX, useMemo } from 'react'
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
import { AreaChart, LevelStepChart, SWAP_COLOR } from './levelCharts'
import { fmtDelta, type AaPoint } from './levelChartGeometry'

const EMPTY_LEVELING: LevelingSnap = { levels: [], aaGains: [], aaSpends: [] }

const applyLevelingDelta = (s: LevelingSnap, d: LevelingDelta): LevelingSnap => ({
  levels: [...s.levels, ...d.levels],
  aaGains: [...s.aaGains, ...d.aaGains],
  aaSpends: [...s.aaSpends, ...d.aaSpends]
})

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

/**
 * The four headline numbers. CURRENT level is the LATEST reported one, never max() —
 * see LevelingView for why — so the peak and the class-swap count ride along in the
 * caption whenever a swap has actually happened.
 */
function LevelingHeroes({
  currentLevel,
  levelCount,
  peak,
  swaps,
  aaEarned,
  aaSpent,
  aaUnspent,
  boughtCount
}: {
  currentLevel: number | null
  levelCount: number
  peak: number | null
  swaps: number
  aaEarned: number
  aaSpent: number
  aaUnspent: number | null
  boughtCount: number
}): JSX.Element {
  return (
    <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
      <HeroCard
        icon={<MilitaryTechIcon fontSize="large" />}
        value={currentLevel != null ? String(currentLevel) : '—'}
        label="Character level"
        sub={
          levelCount
            ? `${levelCount} level-ups logged` +
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
  )
}

/**
 * Cumulative AA gained. Deliberately NOT the earned headline: this is Σ of the gain
 * lines, so points re-gained after a respec are counted again and the curve runs
 * ahead of `earned` — the caption says so rather than quietly reconciling them.
 * Nothing is drawn until there are two points to draw a line between.
 */
function AaOverTimePanel({
  points,
  aaEarned
}: {
  points: AaPoint[]
  aaEarned: number
}): JSX.Element | null {
  if (points.length < 2) return null
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2">AA gained over time</Typography>
      <Typography variant="caption" color="text.secondary" gutterBottom display="block">
        cumulative gain lines — includes points re-gained after a respec, so the final
        value runs ahead of the {aaEarned.toLocaleString()} earned headline
      </Typography>
      <AreaChart points={points} color="#6fb3d2" />
    </Paper>
  )
}

/** Level over time, with the caption that explains the dashed class-swap breaks. */
function LevelOverTimePanel({
  segments,
  levelCount,
  swaps,
  aaPoints
}: {
  segments: LevelSegment[]
  levelCount: number
  swaps: number
  /** Context for the hover readout only ("AA gained by then") — nothing is drawn from it. */
  aaPoints: AaPoint[]
}): JSX.Element | null {
  if (levelCount < 2) return null
  return (
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
      <LevelStepChart segments={segments} color="#d9b25f" aaPoints={aaPoints} />
    </Paper>
  )
}

/**
 * Purchases list: newest first, respec re-buys deduped by the caller and tagged with a
 * ×N count. Auto-grants (cost 0) are shown but badged rather than priced — they were
 * never bought, so counting them as purchases would inflate the spend.
 */
function AaPurchasesPanel({
  purchases,
  boughtCount
}: {
  purchases: { ev: AASpendEvent; count: number }[]
  boughtCount: number
}): JSX.Element | null {
  if (purchases.length === 0) return null
  return (
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
  )
}

/** Interleaved level/AA/swap feed, newest first. */
function ProgressFeedPanel({ feed }: { feed: FeedItem[] }): JSX.Element {
  return (
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
  )
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

  // `nowHave` rides along so the hover readout can state the unspent balance the gain line
  // itself reported, instead of re-deriving a balance the log already gave us.
  const aaCumulative = useMemo<AaPoint[]>(() => {
    let sum = 0
    return sortedAAs.map((a) => ({ ts: a.ts, y: (sum += a.amount), nowHave: a.nowHave }))
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
      <LevelingHeroes
        currentLevel={currentLevel}
        levelCount={sortedLevels.length}
        peak={peak}
        swaps={swaps}
        aaEarned={aaEarned}
        aaSpent={aaSpent}
        aaUnspent={aaUnspent}
        boughtCount={boughtCount}
      />

      {nothing ? (
        <Typography color="text.secondary" sx={{ p: 2 }}>
          No level-ups or AA gains found in this character&apos;s log yet. They&apos;ll appear here live as you play.
        </Typography>
      ) : (
        <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} sx={{ flexGrow: 1, minHeight: 0 }}>
          <Stack spacing={2} sx={{ flex: 2, minWidth: 320 }}>
            <AaOverTimePanel points={aaCumulative} aaEarned={aaEarned} />
            <LevelOverTimePanel
              segments={levelSegments}
              levelCount={sortedLevels.length}
              swaps={swaps}
              aaPoints={aaCumulative}
            />
          </Stack>

          <Stack spacing={2} sx={{ flex: 1, minWidth: 260, minHeight: 0 }}>
            <AaPurchasesPanel purchases={purchases} boughtCount={boughtCount} />
            <ProgressFeedPanel feed={feed} />
          </Stack>
        </Stack>
      )}
    </Stack>
  )
}
