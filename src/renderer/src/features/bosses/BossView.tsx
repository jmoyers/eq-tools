import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import type { KillMap, LootEvent, RaidTarget } from '@shared/types'
import { getBossData } from '../../data'

const TIER_LABEL = ['d0 · base', 'd1 · Awakened', 'd2 · Adaptive', 'd3 · Fused', 'd4 · Refined']
const TIER_COLOR = ['#7a7a7a', '#5fbf72', '#6fb3d2', '#b07fd0', '#e0a94a']

const bosses = getBossData()

interface TargetStatus {
  target: RaidTarget
  killed: boolean
  bestTier: number
  count: number
  lastTs: number
}

function BossImage({ target }: { target: RaidTarget }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (target.image && !failed) {
    return (
      <Box
        component="img"
        src={target.image}
        alt={target.name}
        onError={() => setFailed(true)}
        sx={{ width: '100%', height: 120, objectFit: 'cover', objectPosition: 'top', display: 'block' }}
      />
    )
  }
  const initials = target.name
    .replace(/[^A-Za-z ]/g, '')
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
  return (
    <Box
      sx={{
        width: '100%',
        height: 120,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'action.hover',
        color: 'text.disabled',
        fontSize: 28,
        fontWeight: 700
      }}
    >
      {initials}
    </Box>
  )
}

export default function BossView({ lastLoot }: { lastLoot: LootEvent | null }): JSX.Element {
  const [kills, setKills] = useState<KillMap>({})
  const [query, setQuery] = useState('')
  const [defeatedOnly, setDefeatedOnly] = useState(false)

  useEffect(() => {
    void window.eq.getKills().then(setKills)
  }, [])
  // Refresh kills when new loot arrives (a kill usually precedes loot).
  useEffect(() => {
    if (lastLoot) void window.eq.getKills().then(setKills)
  }, [lastLoot])

  const killByLower = useMemo(() => {
    const m: KillMap = {}
    for (const [name, info] of Object.entries(kills)) m[name.toLowerCase()] = info
    return m
  }, [kills])

  const statuses = useMemo<TargetStatus[]>(() => {
    return bosses.targets.map((target) => {
      let bestTier = 0
      let count = 0
      let lastTs = 0
      let killed = false
      for (const name of target.match) {
        const info = killByLower[name.toLowerCase()]
        if (info) {
          killed = true
          bestTier = Math.max(bestTier, info.bestTier)
          count += info.count
          lastTs = Math.max(lastTs, info.lastTs)
        }
      }
      return { target, killed, bestTier, count, lastTs }
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
    return [...map.entries()]
  }, [filtered])

  const defeated = statuses.filter((s) => s.killed).length

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          label="Search target"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 220 }}
        />
        <FormControlLabel
          control={<Switch checked={defeatedOnly} onChange={(e) => setDefeatedOnly(e.target.checked)} />}
          label="Defeated only"
        />
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="body2" color="text.secondary">
          {defeated} / {statuses.length} targets defeated · tier = highest instance difficulty killed
        </Typography>
      </Stack>

      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {byCategory.map(([category, list]) => (
          <Box key={category} sx={{ mb: 3 }}>
            <Typography variant="subtitle1" sx={{ mb: 1, color: 'primary.main' }}>
              {category}{' '}
              <Typography component="span" variant="caption" color="text.secondary">
                ({list.filter((s) => s.killed).length}/{list.length})
              </Typography>
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 1.5
              }}
            >
              {list.map((s) => (
                <Paper
                  key={s.target.name}
                  variant="outlined"
                  sx={{ overflow: 'hidden', opacity: s.killed ? 1 : 0.55 }}
                >
                  <Box sx={{ position: 'relative' }}>
                    <BossImage target={s.target} />
                    <Chip
                      size="small"
                      label={s.killed ? TIER_LABEL[s.bestTier] : 'Not defeated'}
                      sx={{
                        position: 'absolute',
                        top: 6,
                        right: 6,
                        bgcolor: s.killed ? TIER_COLOR[s.bestTier] : 'rgba(0,0,0,0.6)',
                        color: '#fff',
                        fontWeight: 700
                      }}
                    />
                  </Box>
                  <Box sx={{ p: 1 }}>
                    <Typography variant="body2" noWrap title={s.target.name}>
                      {s.target.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {s.target.zone ?? ''}
                    </Typography>
                    {s.killed && (
                      <Typography variant="caption" color="text.secondary" display="block">
                        {s.count} kill{s.count === 1 ? '' : 's'} · last {new Date(s.lastTs).toLocaleDateString()}
                      </Typography>
                    )}
                  </Box>
                </Paper>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </Stack>
  )
}
