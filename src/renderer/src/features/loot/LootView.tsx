import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Chip,
  FormControlLabel,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography
} from '@mui/material'
import type { LootDelta, LootEvent, LootSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { getPoskyData } from '../../data'
import { useFavorites } from '../favorites/useFavorites'
import { FavoriteStar } from '../favorites/FavoriteStar'
import { ItemDetailDialog } from './ItemDetailDialog'

const posky = getPoskyData()

// Names of every item required by a Plane of Sky quest (for highlighting).
const questItemNames = new Set<string>(posky.quests.flatMap((q) => q.items.map((i) => i.name.toLowerCase())))

// EQ stat block per item name (quest items + rewards), for the drill-down.
const itemStats: Record<string, string> = {}
for (const qz of posky.quests) {
  for (const it of qz.items) if (it.stats) itemStats[it.name.toLowerCase()] = it.stats
  if (qz.reward && qz.rewardStats) itemStats[qz.reward.toLowerCase()] = qz.rewardStats
}

const MAX_ROWS = 500

// Stable empty reference so useMemo deps don't churn before hydration.
const EMPTY_LOOT: LootEvent[] = []

function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const applyLootDelta = (state: LootSnap, delta: LootDelta): LootSnap => [...state, ...delta.appended]

// A subtle disposition chip (Task #40): 'currency' = routed to the currency tab (kept),
// 'sold' = auto-vendored (gone). Dense, low-emphasis — no chip for ordinary kept loot.
function DispositionChip({ disposition }: { disposition?: 'currency' | 'sold' }): JSX.Element | null {
  if (disposition === 'currency') {
    return <Chip size="small" variant="outlined" color="info" label="currency" sx={{ height: 18, fontSize: 11 }} />
  }
  if (disposition === 'sold') {
    return <Chip size="small" variant="outlined" color="default" label="sold" sx={{ height: 18, fontSize: 11, opacity: 0.7 }} />
  }
  return null
}

export default function LootView(): JSX.Element {
  const { isFavorite, toggle: toggleFavorite } = useFavorites()
  const history = useModule<LootSnap, LootDelta>('loot', applyLootDelta) ?? EMPTY_LOOT
  const [query, setQuery] = useState('')
  const [groupByItem, setGroupByItem] = useState(true)
  const [questOnly, setQuestOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const q = query.trim().toLowerCase()

  const events = useMemo(() => {
    let list = history
    if (questOnly) list = list.filter((e) => questItemNames.has(e.item.toLowerCase()))
    if (q) list = list.filter((e) => e.item.toLowerCase().includes(q))
    return [...list].reverse() // most recent first
  }, [history, q, questOnly])

  const grouped = useMemo(() => {
    interface Group {
      item: string
      count: number
      last: number
      sources: Map<string, number>
      zones: Set<string>
      currency: number
      sold: number
    }
    const map = new Map<string, Group>()
    for (const e of events) {
      const key = e.item.toLowerCase()
      let cur = map.get(key)
      if (!cur) {
        cur = { item: e.item, count: 0, last: 0, sources: new Map(), zones: new Set(), currency: 0, sold: 0 }
        map.set(key, cur)
      }
      cur.count += 1
      cur.last = Math.max(cur.last, e.ts)
      if (e.source) cur.sources.set(e.source, (cur.sources.get(e.source) ?? 0) + 1)
      if (e.zone) cur.zones.add(e.zone)
      if (e.disposition === 'currency') cur.currency += 1
      else if (e.disposition === 'sold') cur.sold += 1
    }
    const list = [...map.values()].map((g) => {
      const topSource = [...g.sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      // The group's dominant disposition — shown only when ALL of its rows share one, so a
      // mixed item (some kept, some sold) stays unlabeled rather than mislabeled.
      const disposition =
        g.currency === g.count ? ('currency' as const) : g.sold === g.count ? ('sold' as const) : undefined
      return { item: g.item, count: g.count, last: g.last, topSource, zoneCount: g.zones.size, disposition }
    })
    list.sort((a, b) => b.count - a.count || b.last - a.last)
    // Pin favorites to the top (stable).
    return list.sort((a, b) => Number(isFavorite(b.item)) - Number(isFavorite(a.item)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, isFavorite])

  const isQuestItem = (name: string): boolean => questItemNames.has(name.toLowerCase())

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          label="Search looted item"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          sx={{ minWidth: 260 }}
        />
        <FormControlLabel
          control={<Switch checked={groupByItem} onChange={(e) => setGroupByItem(e.target.checked)} />}
          label="Group by item"
        />
        <FormControlLabel
          control={<Switch checked={questOnly} onChange={(e) => setQuestOnly(e.target.checked)} />}
          label="Only Plane of Sky items"
        />
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="body2" color="text.secondary">
          {history.length.toLocaleString()} loot events · {grouped.length.toLocaleString()} unique items · click a
          row for mob/zone/drop-rate breakdown
        </Typography>
      </Stack>

      {history.length === 0 && (
        <Alert severity="info">
          No loot parsed yet. Loot something in-game (or check your log path) — every{' '}
          <code>--You have looted …--</code> line shows up here in real time, and the full history is read
          from your log on launch.
        </Alert>
      )}

      <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
        {groupByItem ? (
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell>Item</TableCell>
                <TableCell align="right">Times looted</TableCell>
                <TableCell>Top source</TableCell>
                <TableCell align="right">Zones</TableCell>
                <TableCell>Last looted</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {grouped.slice(0, MAX_ROWS).map((g) => (
                <TableRow
                  key={g.item}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => setSelected(g.item)}
                >
                  <TableCell padding="checkbox">
                    <FavoriteStar name={g.item} favorited={isFavorite(g.item)} onToggle={toggleFavorite} />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <span>{g.item}</span>
                      {isQuestItem(g.item) && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
                      <DispositionChip disposition={g.disposition} />
                    </Stack>
                  </TableCell>
                  <TableCell align="right">{g.count}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{g.topSource ?? '—'}</TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>
                    {g.zoneCount || '—'}
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{fmtTime(g.last)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" />
                <TableCell sx={{ width: 150 }}>Time</TableCell>
                <TableCell>Item</TableCell>
                <TableCell>From</TableCell>
                <TableCell>Zone</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.slice(0, MAX_ROWS).map((e, i) => (
                <TableRow
                  key={`${e.ts}-${e.item}-${i}`}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => setSelected(e.item)}
                >
                  <TableCell padding="checkbox">
                    <FavoriteStar name={e.item} favorited={isFavorite(e.item)} onToggle={toggleFavorite} />
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{fmtTime(e.ts)}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <span>{e.item}</span>
                      {isQuestItem(e.item) && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
                      <DispositionChip disposition={e.disposition} />
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{e.source ?? '—'}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{e.zone ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {(groupByItem ? grouped.length : events.length) > MAX_ROWS && (
          <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
            Showing first {MAX_ROWS} of {(groupByItem ? grouped.length : events.length).toLocaleString()} — refine
            with search.
          </Typography>
        )}
      </Box>

      {selected && (
        <ItemDetailDialog
          open
          onClose={() => setSelected(null)}
          item={selected}
          events={history.filter((e) => e.item.toLowerCase() === selected.toLowerCase())}
          stats={itemStats[selected.toLowerCase()]}
          isQuestItem={questItemNames.has(selected.toLowerCase())}
        />
      )}
    </Stack>
  )
}
