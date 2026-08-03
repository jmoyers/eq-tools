import { type JSX, useCallback, useMemo, useState } from 'react'
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
import type { MobTarget } from '../mobs/mobTarget'
import Confetti from '../../lib/Confetti'
import { tierStyle, type TierStyle } from '../../lib/tierChip'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { cachedImageUrl } from '../../lib/imageUrl'

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
        // NEVER the raw `target.image`. `bosses.json` carries real wiki.project1999.com URLs
        // (scraped data stays honest), but a portrait must be downloaded at most ONCE ever —
        // so it is served from the app's permanent cache instead. A URL the main process
        // refuses, or a portrait that 404s, falls through to the initials tile below via
        // onError, exactly as before.
        src={cachedImageUrl(target.image)}
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

// The "Recently considered" strip that used to live here MOVED to the Mobs tab in Task #64.
// It lodged here because this tab already answered the other mob question ("which named things
// have I killed") and a con strip needed a roof; Mobs is its actual module home. This tab is
// about RAID PROGRESSION again — and its cards now route to the same mob page everything else
// does, instead of opening a modal only this tab knew how to open.

// The little tier-coloured tick in the card's top-left corner: "you have this one".
function TargetKilledBadge({ tier }: { tier: TierStyle }): JSX.Element {
  return (
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
  )
}

// Portrait + the tier chip that overlays its top-right corner. An undefeated target is
// greyed out and its chip reads "not defeated" on a neutral scrim instead of a tier colour.
function TargetCardMedia({
  s,
  tier,
  height
}: {
  s: TargetStatus
  tier: TierStyle
  height: number
}): JSX.Element {
  return (
    <Box sx={{ position: 'relative' }}>
      <BossImage target={s.target} height={height} dim={!s.killed} />
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
  )
}

// The date line under a DEFEATED target's name. A single kill states one date; repeats
// spell out first and last in the tooltip. The comfortable density also shows the count.
function TargetKillDate({ s, compact }: { s: TargetStatus; compact: boolean }): JSX.Element {
  return (
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
  )
}

// Everything below the portrait: name, zone (comfortable only) and the kill/no-kill line.
function TargetCardCaption({ s, compact }: { s: TargetStatus; compact: boolean }): JSX.Element {
  return (
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
        <TargetKillDate s={s} compact={compact} />
      ) : (
        !compact && (
          <Typography variant="caption" color="text.disabled" display="block">
            not defeated
          </Typography>
        )
      )}
    </Box>
  )
}

function TargetCard({
  s,
  compact,
  flash,
  onOpen
}: {
  s: TargetStatus
  compact: boolean
  flash?: boolean
  onOpen: (s: TargetStatus) => void
}): JSX.Element {
  const imgH = compact ? 70 : 120
  const tier = tierStyle(s.bestTier)
  const tierColor = tier.bg
  return (
    <Paper
      variant="outlined"
      // A raid target IS a mob, so it opens the same mob PAGE everything else does (Task #64).
      onClick={() => onOpen(s)}
      title={`${s.target.name} — drops, quests, your kills`}
      sx={{
        overflow: 'hidden',
        position: 'relative',
        cursor: 'pointer',
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
      {s.killed && <TargetKilledBadge tier={tier} />}
      <TargetCardMedia s={s} tier={tier} height={imgH} />
      <TargetCardCaption s={s} compact={compact} />
    </Paper>
  )
}

/**
 * What a roster card hands the app-wide mob page. A roster card carries no consider (you may
 * never have conned it), so the page simply renders without the con block — never with an
 * invented one. The kill facts come from the status the roster already computed, which is
 * article-insensitive matching the log's `match` names (bossStatus.ts).
 */
function mobTargetForStatus(t: TargetStatus): MobTarget {
  return {
    mob: t.target.name,
    kill:
      t.count > 0
        ? { count: t.count, bestTier: t.bestTier, firstTs: t.firstTs, lastTs: t.lastTs }
        : undefined
  }
}

// Search / defeated-only / density, plus the running "N of M defeated" tally.
function BossToolbar({
  query,
  onQueryChange,
  defeatedOnly,
  onDefeatedOnlyChange,
  density,
  onDensityChange,
  defeated,
  total
}: {
  query: string
  onQueryChange: (q: string) => void
  defeatedOnly: boolean
  onDefeatedOnlyChange: (v: boolean) => void
  density: Density
  onDensityChange: (d: Density | null) => void
  defeated: number
  total: number
}): JSX.Element {
  return (
    <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
      <TextField
        size="small"
        label="Search target"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        sx={{ minWidth: 200 }}
      />
      <FormControlLabel
        control={<Switch checked={defeatedOnly} onChange={(e) => onDefeatedOnlyChange(e.target.checked)} />}
        label="Defeated only"
      />
      <ToggleButtonGroup
        size="small"
        exclusive
        value={density}
        onChange={(_e, v: Density | null) => onDensityChange(v)}
      >
        <ToggleButton value="compact">Compact</ToggleButton>
        <ToggleButton value="comfortable">Comfortable</ToggleButton>
      </ToggleButtonGroup>
      <Box sx={{ flexGrow: 1 }} />
      <Typography variant="body2" color="text.secondary">
        {defeated} / {total} defeated · badge = highest instance tier
      </Typography>
    </Stack>
  )
}

// One progression category (Open World, Fear, Hate, Sky) and its grid of target cards.
function CategorySection({
  category,
  list,
  compact,
  minCol,
  flashing,
  onOpenMob
}: {
  category: string
  list: TargetStatus[]
  compact: boolean
  minCol: number
  flashing: Set<string>
  onOpenMob: (t: MobTarget) => void
}): JSX.Element {
  return (
    <Box sx={{ mb: compact ? 1.5 : 2.5 }}>
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
          <TargetCard
            key={s.target.name}
            s={s}
            compact={compact}
            flash={flashing.has(s.target.name)}
            onOpen={(t) => onOpenMob(mobTargetForStatus(t))}
          />
        ))}
      </Box>
    </Box>
  )
}

/**
 * @param onOpenMob  route a roster card to the app-wide mob page (the Mobs tab). This view no
 *                   longer owns a detail surface of its own — one mob, one page, everywhere.
 */
export default function BossView({ onOpenMob }: { onOpenMob: (t: MobTarget) => void }): JSX.Element {
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
      <BossToolbar
        query={query}
        onQueryChange={setQuery}
        defeatedOnly={defeatedOnly}
        onDefeatedOnlyChange={setDefeatedOnly}
        density={density}
        onDensityChange={setDensityPersist}
        defeated={defeated}
        total={statuses.length}
      />

      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {byCategory.map(([category, list]) => (
          <CategorySection
            key={category}
            category={category}
            list={list}
            compact={compact}
            minCol={minCol}
            flashing={flashing}
            onOpenMob={onOpenMob}
          />
        ))}
      </Box>
    </Stack>
  )
}
