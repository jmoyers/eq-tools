import { memo, useDeferredValue, useMemo, useRef, useState } from 'react'
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
import { useWindowedRows } from '../../lib/useWindowedRows'
import { normalizeQuery } from '../../lib/search'
import { itemCountKey } from '../../lib/itemName'
import { getPoskyData } from '../../data'
import { useFavorites } from '../favorites/useFavorites'
import { FavoriteStar } from '../favorites/FavoriteStar'
import { ItemDetailDialog } from './ItemDetailDialog'

const posky = getPoskyData()

// Names of every item required by a Plane of Sky quest (for highlighting). Keyed by the
// normalized counting key (Task #42) so an upgraded `Sphinx Claw +1` row is still flagged
// as a Sky quest item — the row keeps showing its `+N`; only the RECOGNITION is normalized.
const questItemNames = new Set<string>(posky.quests.flatMap((q) => q.items.map((i) => itemCountKey(i.name))))

// EQ stat block per item name (quest items + rewards), for the drill-down.
const itemStats: Record<string, string> = {}
for (const qz of posky.quests) {
  // Keyed by the normalized counting key so a `+N` variant drill-down resolves the base
  // item's stat block (Task #42).
  for (const it of qz.items) if (it.stats) itemStats[itemCountKey(it.name)] = it.stats
  if (qz.reward && qz.rewardStats) itemStats[itemCountKey(qz.reward)] = qz.rewardStats
}

// Fixed dense-row height (px) for the windowed tables (MUI Table size="small").
const ROW_HEIGHT = 37

// Stable empty reference so useMemo deps don't churn before hydration.
const EMPTY_LOOT: LootEvent[] = []

// A loot event with a precomputed lowercase item key — computed ONCE per history
// change so the per-keystroke filter is a plain substring test (never re-lowercasing
// thousands of rows on every character typed).
type KeyedLoot = LootEvent & { itemKey: string }

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

function isQuestItem(name: string): boolean {
  return questItemNames.has(itemCountKey(name))
}

interface GroupRow {
  item: string
  count: number
  last: number
  topSource?: string
  zoneCount: number
  disposition?: 'currency' | 'sold'
}

// Memoized rows (React.memo + stable props) so a re-render that doesn't touch a
// given row's data skips it entirely (precedent: #17's combat work).
const GroupedRow = memo(function GroupedRow({
  g,
  favorited,
  onToggleFavorite,
  onSelect
}: {
  g: GroupRow
  favorited: boolean
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}): JSX.Element {
  return (
    <TableRow
      hover
      sx={{ cursor: 'pointer', height: ROW_HEIGHT, '& td': { py: 0 } }}
      onClick={() => onSelect(g.item)}
    >
      <TableCell padding="checkbox">
        <FavoriteStar name={g.item} favorited={favorited} onToggle={onToggleFavorite} />
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
  )
})

const FlatRow = memo(function FlatRow({
  e,
  favorited,
  onToggleFavorite,
  onSelect
}: {
  e: LootEvent
  favorited: boolean
  onToggleFavorite: (name: string) => void
  onSelect: (item: string) => void
}): JSX.Element {
  return (
    <TableRow
      hover
      sx={{ cursor: 'pointer', height: ROW_HEIGHT, '& td': { py: 0 } }}
      onClick={() => onSelect(e.item)}
    >
      <TableCell padding="checkbox">
        <FavoriteStar name={e.item} favorited={favorited} onToggle={onToggleFavorite} />
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
  )
})

export default function LootView(): JSX.Element {
  const { isFavorite, toggle: toggleFavorite } = useFavorites()
  const history = useModule<LootSnap, LootDelta>('loot', applyLootDelta) ?? EMPTY_LOOT
  const [query, setQuery] = useState('')
  const [groupByItem, setGroupByItem] = useState(true)
  const [questOnly, setQuestOnly] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  // Typing echoes IMMEDIATELY (local `query` state); the filter consumes a DEFERRED
  // copy so a keystroke never blocks on the filter + re-render (Task #41).
  const deferredQuery = useDeferredValue(query)
  const q = normalizeQuery(deferredQuery)

  // Precompute a lowercase item key ONCE per history change (not per keystroke).
  const keyed = useMemo<KeyedLoot[]>(
    () => history.map((e) => ({ ...e, itemKey: e.item.toLowerCase() })),
    [history]
  )

  const events = useMemo(() => {
    let list: KeyedLoot[] = keyed
    if (questOnly) list = list.filter((e) => questItemNames.has(e.itemKey))
    if (q) list = list.filter((e) => e.itemKey.includes(q))
    return [...list].reverse() // most recent first
  }, [keyed, q, questOnly])

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
      const key = e.itemKey
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

  const scrollRef = useRef<HTMLDivElement>(null)
  // Window whichever list is active — only the rows intersecting the viewport are
  // mounted, so a filter keystroke never mounts hundreds of MUI rows synchronously.
  const rowCount = groupByItem ? grouped.length : events.length
  const win = useWindowedRows({ count: rowCount, rowHeight: ROW_HEIGHT, scrollRef })

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

      {/* The scroll container owns the ref the windowing hook reads. Spacer rows
          (top/bottom) reserve the full scroll height so only the visible slice of
          MUI rows is mounted — see useWindowedRows. */}
      <Box ref={scrollRef} sx={{ flexGrow: 1, overflow: 'auto' }}>
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
              {win.topPad > 0 && (
                <TableRow style={{ height: win.topPad }}>
                  <TableCell colSpan={6} sx={{ p: 0, border: 0 }} />
                </TableRow>
              )}
              {grouped.slice(win.start, win.end).map((g) => (
                <GroupedRow
                  key={g.item}
                  g={g}
                  favorited={isFavorite(g.item)}
                  onToggleFavorite={toggleFavorite}
                  onSelect={setSelected}
                />
              ))}
              {win.bottomPad > 0 && (
                <TableRow style={{ height: win.bottomPad }}>
                  <TableCell colSpan={6} sx={{ p: 0, border: 0 }} />
                </TableRow>
              )}
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
              {win.topPad > 0 && (
                <TableRow style={{ height: win.topPad }}>
                  <TableCell colSpan={5} sx={{ p: 0, border: 0 }} />
                </TableRow>
              )}
              {events.slice(win.start, win.end).map((e, i) => (
                <FlatRow
                  key={`${e.ts}-${e.item}-${win.start + i}`}
                  e={e}
                  favorited={isFavorite(e.item)}
                  onToggleFavorite={toggleFavorite}
                  onSelect={setSelected}
                />
              ))}
              {win.bottomPad > 0 && (
                <TableRow style={{ height: win.bottomPad }}>
                  <TableCell colSpan={5} sx={{ p: 0, border: 0 }} />
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Box>

      {selected && (
        <ItemDetailDialog
          open
          onClose={() => setSelected(null)}
          item={selected}
          events={history.filter((e) => e.item.toLowerCase() === selected.toLowerCase())}
          stats={itemStats[itemCountKey(selected)]}
          isQuestItem={questItemNames.has(itemCountKey(selected))}
        />
      )}
    </Stack>
  )
}
