import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import type { KillMap, LootEvent, RaidTarget } from '@shared/types'
import { getBossData } from '../../data'

const TIER_SHORT = ['D0', 'D1', 'D2', 'D3', 'D4']
const TIER_LONG = ['D0 · base', 'D1 · Awakened', 'D2 · Adaptive', 'D3 · Fused', 'D4 · Refined']
const TIER_COLOR = ['#7a7a7a', '#5fbf72', '#6fb3d2', '#b07fd0', '#e0a94a']

// EQL raid progression order.
const CATEGORY_ORDER = ['Open World', 'Plane of Fear', 'Plane of Hate', 'Plane of Sky']

const DENSITY_KEY = 'eq.bossDensity'
type Density = 'compact' | 'comfortable'

const bosses = getBossData()

interface TargetStatus {
  target: RaidTarget
  killed: boolean
  bestTier: number
  count: number
  firstTs: number
  lastTs: number
}

function BossImage({
  target,
  height,
  dim
}: {
  target: RaidTarget
  height: number
  dim?: boolean
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (target.image && !failed) {
    return (
      <Box
        component="img"
        src={target.image}
        alt={target.name}
        onError={() => setFailed(true)}
        sx={{
          width: '100%',
          height,
          objectFit: 'cover',
          objectPosition: 'top',
          display: 'block',
          filter: dim ? 'grayscale(1) brightness(0.5)' : 'none'
        }}
      />
    )
  }
  const initials = target.name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
  return (
    <Box
      sx={{
        width: '100%',
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'action.hover',
        color: 'text.disabled',
        fontSize: height > 90 ? 26 : 18,
        fontWeight: 700
      }}
    >
      {initials}
    </Box>
  )
}

function TargetCard({ s, compact }: { s: TargetStatus; compact: boolean }): JSX.Element {
  const imgH = compact ? 70 : 120
  const tierColor = TIER_COLOR[s.bestTier]
  return (
    <Paper
      variant="outlined"
      sx={{
        overflow: 'hidden',
        position: 'relative',
        borderWidth: 2,
        borderColor: s.killed ? tierColor : 'divider',
        boxShadow: s.killed ? `0 0 10px ${tierColor}55` : 'none',
        transition: 'transform 120ms',
        '&:hover': { transform: 'translateY(-2px)' }
      }}
    >
      {s.killed && (
        <Box
          sx={{
            position: 'absolute',
            top: 4,
            left: 4,
            zIndex: 1,
            width: 20,
            height: 20,
            borderRadius: '50%',
            bgcolor: tierColor,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 1
          }}
        >
          <CheckIcon sx={{ fontSize: 14 }} />
        </Box>
      )}
      <Box sx={{ position: 'relative' }}>
        <BossImage target={s.target} height={imgH} dim={!s.killed} />
        <Tooltip title={s.killed ? TIER_LONG[s.bestTier] : 'Not defeated'}>
          <Chip
            size="small"
            label={s.killed ? TIER_SHORT[s.bestTier] : 'not defeated'}
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              height: 20,
              bgcolor: s.killed ? tierColor : 'rgba(0,0,0,0.65)',
              color: '#fff',
              fontWeight: 700,
              fontSize: 11,
              '& .MuiChip-label': { px: 0.75 }
            }}
          />
        </Tooltip>
      </Box>
      <Box sx={{ p: compact ? 0.75 : 1 }}>
        <Typography
          variant={compact ? 'caption' : 'body2'}
          noWrap
          title={s.target.name}
          sx={{ fontWeight: 600, color: s.killed ? 'text.primary' : 'text.secondary' }}
        >
          {s.target.name}
        </Typography>
        {!compact && (
          <Typography variant="caption" color="text.secondary" noWrap display="block">
            {s.target.zone ?? ''}
          </Typography>
        )}
        {s.killed ? (
          <Typography variant="caption" color="text.secondary" noWrap display="block">
            {new Date(s.firstTs).toLocaleDateString()}
            {!compact && ` · ${s.count} kill${s.count === 1 ? '' : 's'}`}
          </Typography>
        ) : (
          !compact && (
            <Typography variant="caption" color="text.disabled" display="block">
              not defeated
            </Typography>
          )
        )}
      </Box>
    </Paper>
  )
}

export default function BossView({ lastLoot }: { lastLoot: LootEvent | null }): JSX.Element {
  const [kills, setKills] = useState<KillMap>({})
  const [query, setQuery] = useState('')
  const [defeatedOnly, setDefeatedOnly] = useState(false)
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem(DENSITY_KEY) as Density) || 'compact'
  )

  // Live: refresh kill data on load, on new loot, and on a short poll so a boss
  // defeated in-game lights up the dashboard in real time.
  useEffect(() => {
    void window.eq.getKills().then(setKills)
    const iv = setInterval(() => void window.eq.getKills().then(setKills), 3000)
    return () => clearInterval(iv)
  }, [])
  useEffect(() => {
    if (lastLoot) void window.eq.getKills().then(setKills)
  }, [lastLoot])

  const setDensityPersist = (d: Density | null): void => {
    if (!d) return
    localStorage.setItem(DENSITY_KEY, d)
    setDensity(d)
  }
  const compact = density === 'compact'

  const killByLower = useMemo(() => {
    const m: KillMap = {}
    for (const [name, info] of Object.entries(kills)) m[name.toLowerCase()] = info
    return m
  }, [kills])

  const statuses = useMemo<TargetStatus[]>(() => {
    return bosses.targets.map((target) => {
      let bestTier = 0
      let count = 0
      let firstTs = 0
      let lastTs = 0
      let killed = false
      for (const name of target.match) {
        const info = killByLower[name.toLowerCase()]
        if (info) {
          killed = true
          bestTier = Math.max(bestTier, info.bestTier)
          count += info.count
          firstTs = firstTs ? Math.min(firstTs, info.firstTs) : info.firstTs
          lastTs = Math.max(lastTs, info.lastTs)
        }
      }
      return { target, killed, bestTier, count, firstTs, lastTs }
    })
  }, [killByLower])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = statuses
    if (defeatedOnly) list = list.filter((s) => s.killed)
    if (q) list = list.filter((s) => s.target.name.toLowerCase().includes(q))
    return list
  }, [statuses, query, defeatedOnly])

  const byCategory = useMemo(() => {
    const map = new Map<string, TargetStatus[]>()
    for (const s of filtered) {
      const arr = map.get(s.target.category) ?? []
      arr.push(s)
      map.set(s.target.category, arr)
    }
    return [...map.entries()].sort(
      (a, b) => (CATEGORY_ORDER.indexOf(a[0]) + 1 || 99) - (CATEGORY_ORDER.indexOf(b[0]) + 1 || 99)
    )
  }, [filtered])

  const defeated = statuses.filter((s) => s.killed).length
  const minCol = compact ? 116 : 180

  return (
    <Stack spacing={1.5} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          label="Search target"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 200 }}
        />
        <FormControlLabel
          control={<Switch checked={defeatedOnly} onChange={(e) => setDefeatedOnly(e.target.checked)} />}
          label="Defeated only"
        />
        <ToggleButtonGroup
          size="small"
          exclusive
          value={density}
          onChange={(_e, v) => setDensityPersist(v)}
        >
          <ToggleButton value="compact">Compact</ToggleButton>
          <ToggleButton value="comfortable">Comfortable</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="body2" color="text.secondary">
          {defeated} / {statuses.length} defeated · badge = highest instance tier
        </Typography>
      </Stack>

      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {byCategory.map(([category, list]) => (
          <Box key={category} sx={{ mb: compact ? 1.5 : 2.5 }}>
            <Typography variant="subtitle2" sx={{ mb: 0.75, color: 'primary.main' }}>
              {category}{' '}
              <Typography component="span" variant="caption" color="text.secondary">
                ({list.filter((s) => s.killed).length}/{list.length})
              </Typography>
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: `repeat(auto-fill, minmax(${minCol}px, 1fr))`,
                gap: compact ? 1 : 1.5
              }}
            >
              {list.map((s) => (
                <TargetCard key={s.target.name} s={s} compact={compact} />
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </Stack>
  )
}
