import { useCallback, useMemo, useState } from 'react'
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
import type { RaidTarget } from '@shared/types'
import { getBossData } from '../../data'
import { useBossKills } from './useBossKills'
import type { TargetStatus } from './bossStatus'
import Confetti from './Confetti'
import { tierStyle } from '../../lib/tierChip'
import { formatDate, formatDateTime } from '../../lib/formatDate'

// EQL raid progression order.
const CATEGORY_ORDER = ['Open World', 'Plane of Fear', 'Plane of Hate', 'Plane of Sky']

const DENSITY_KEY = 'eq.bossDensity'
type Density = 'compact' | 'comfortable'

const bosses = getBossData()

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

function TargetCard({ s, compact, flash }: { s: TargetStatus; compact: boolean; flash?: boolean }): JSX.Element {
  const imgH = compact ? 70 : 120
  const tier = tierStyle(s.bestTier)
  const tierColor = tier.bg
  return (
    <Paper
      variant="outlined"
      sx={{
        overflow: 'hidden',
        position: 'relative',
        borderWidth: 2,
        borderColor: flash ? tierColor : s.killed ? tierColor : 'divider',
        boxShadow: flash
          ? `0 0 22px ${tierColor}, 0 0 8px ${tierColor}`
          : s.killed
            ? `0 0 10px ${tierColor}55`
            : 'none',
        transform: flash ? 'scale(1.04)' : 'none',
        transition: 'transform 200ms, box-shadow 200ms, border-color 200ms',
        '&:hover': { transform: flash ? 'scale(1.04)' : 'translateY(-2px)' }
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
            bgcolor: tier.bg,
            color: tier.fg,
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
        <Tooltip title={s.killed ? tier.long : 'Not defeated'}>
          <Chip
            size="small"
            label={s.killed ? tier.label : 'not defeated'}
            sx={{
              position: 'absolute',
              top: 4,
              right: 4,
              height: 20,
              bgcolor: s.killed ? tier.bg : 'rgba(0,0,0,0.65)',
              color: s.killed ? tier.fg : '#fff',
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
          <Tooltip
            title={
              s.firstTs && s.firstTs !== s.lastTs
                ? `First ${formatDateTime(s.firstTs)} · Last ${formatDateTime(s.lastTs)}`
                : `Defeated ${formatDateTime(s.lastTs || s.firstTs)}`
            }
          >
            <Typography variant="caption" color="text.secondary" noWrap display="block">
              {formatDate(s.lastTs || s.firstTs)}
              {!compact && ` · ${s.count} kill${s.count === 1 ? '' : 's'}`}
            </Typography>
          </Tooltip>
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

export default function BossView(): JSX.Element {
  const [query, setQuery] = useState('')
  const [defeatedOnly, setDefeatedOnly] = useState(false)
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem(DENSITY_KEY) as Density) || 'compact'
  )
  // Names of bosses currently flashing, and the id of the active confetti burst.
  const [flashing, setFlashing] = useState<Set<string>>(new Set())
  const [burst, setBurst] = useState<number | null>(null)

  // ANY live roster-boss kill (incl. a repeat at the same/lower tier, Task #24):
  // fire confetti over the view and flash the boss card for ~3s. The kills module
  // (via useBossKills) already gates out the historical baseline, so this only
  // fires for kills that happen while the app is open. The bossDefeat *sound* is
  // handled separately in App (new-tier defeats only).
  const onKill = useCallback((s: TargetStatus) => {
    setBurst((n) => (n ?? 0) + 1)
    setFlashing((prev) => new Set(prev).add(s.target.name))
    window.setTimeout(() => {
      setFlashing((prev) => {
        const next = new Set(prev)
        next.delete(s.target.name)
        return next
      })
    }, 3000)
  }, [])

  const { statuses } = useBossKills(bosses.targets, { onKill })

  const setDensityPersist = (d: Density | null): void => {
    if (!d) return
    localStorage.setItem(DENSITY_KEY, d)
    setDensity(d)
  }
  const compact = density === 'compact'

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
    <Stack spacing={1.5} sx={{ height: '100%', position: 'relative' }}>
      {burst != null && <Confetti key={burst} onDone={() => setBurst(null)} />}
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
                <TargetCard key={s.target.name} s={s} compact={compact} flash={flashing.has(s.target.name)} />
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </Stack>
  )
}
