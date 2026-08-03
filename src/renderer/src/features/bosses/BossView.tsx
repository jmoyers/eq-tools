// BossView — the raid-progression roster: search, filters, and the sectioning toggle. The cards
// and the two section kinds live in BossSections.tsx; this file owns the state above them.
//
// The "Recently considered" strip that used to live here MOVED to the Mobs tab in Task #64.
// It lodged here because this tab already answered the other mob question ("which named things
// have I killed") and a con strip needed a roof; Mobs is its actual module home. This tab is
// about RAID PROGRESSION again — and its cards now route to the same mob page everything else
// does, instead of opening a modal only this tab knew how to open.

import { type JSX, useCallback, useMemo, useState } from 'react'
import {
  Box,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import { getBossData } from '../../data'
import { useBossKills } from './useBossKills'
import type { TargetStatus } from './bossStatus'
import { CategorySection, LoadoutSections } from './BossSections'
import type { MobTarget } from '../mobs/mobTarget'
import Confetti from '../../lib/Confetti'

// EQL raid progression order.
const CATEGORY_ORDER = ['Open World', 'Plane of Fear', 'Plane of Hate', 'Plane of Sky']

const DENSITY_KEY = 'eq.bossDensity'
type Density = 'compact' | 'comfortable'

const bosses = getBossData()

// Search / defeated-only / grouping / density, plus the running "N of M defeated" tally.
function BossToolbar({
  query,
  onQueryChange,
  filters,
  density,
  onDensityChange,
  defeated,
  total
}: {
  query: string
  onQueryChange: (q: string) => void
  /** The two switches, bundled so the toolbar keeps a readable parameter list. */
  filters: {
    defeatedOnly: boolean
    onDefeatedOnlyChange: (v: boolean) => void
    byLoadout: boolean
    onByLoadoutChange: (v: boolean) => void
  }
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
        control={
          <Switch
            checked={filters.defeatedOnly}
            onChange={(e) => filters.onDefeatedOnlyChange(e.target.checked)}
          />
        }
        label="Defeated only"
      />
      <FormControlLabel
        control={
          <Switch
            checked={filters.byLoadout}
            onChange={(e) => filters.onByLoadoutChange(e.target.checked)}
          />
        }
        label="By class loadout"
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

/**
 * @param onOpenMob  route a roster card to the app-wide mob page (the Mobs tab). This view no
 *                   longer owns a detail surface of its own — one mob, one page, everywhere.
 */
export default function BossView({ onOpenMob }: { onOpenMob: (t: MobTarget) => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [defeatedOnly, setDefeatedOnly] = useState(false)
  // Sectioning: progression category (the default — it is what the roster is for) or the class
  // loadout you were running. A DISPLAY choice; nothing about the kills themselves changes.
  const [byLoadout, setByLoadout] = useState(false)
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
  const section = { compact, minCol: compact ? 116 : 180, flashing, onOpenMob }

  return (
    <Stack spacing={1.5} sx={{ height: '100%', position: 'relative' }}>
      {burst != null && <Confetti key={burst} onDone={() => setBurst(null)} />}
      <BossToolbar
        query={query}
        onQueryChange={setQuery}
        filters={{
          defeatedOnly,
          onDefeatedOnlyChange: setDefeatedOnly,
          byLoadout,
          onByLoadoutChange: setByLoadout
        }}
        density={density}
        onDensityChange={setDensityPersist}
        defeated={defeated}
        total={statuses.length}
      />

      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {byLoadout ? (
          <LoadoutSections {...section} list={filtered} />
        ) : (
          byCategory.map(([category, list]) => (
            <CategorySection key={category} {...section} category={category} list={list} />
          ))
        )}
      </Box>
    </Stack>
  )
}
