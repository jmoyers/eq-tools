import { useEffect, useMemo, useState } from 'react'
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
import type { LootEvent, PoskyData } from '@shared/types'
import poskyRaw from '../../data/posky.json'

const posky = poskyRaw as unknown as PoskyData

// Names of every item required by a Plane of Sky quest (for highlighting).
const questItemNames = new Set<string>(
  posky.quests.flatMap((q) => q.items.map((i) => i.name.toLowerCase()))
)

const MAX_ROWS = 500

function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function LootView({ lastLoot }: { lastLoot: LootEvent | null }): JSX.Element {
  const [history, setHistory] = useState<LootEvent[]>([])
  const [query, setQuery] = useState('')
  const [groupByItem, setGroupByItem] = useState(false)
  const [questOnly, setQuestOnly] = useState(false)

  useEffect(() => {
    void window.eq.getLootHistory().then(setHistory)
  }, [])
  useEffect(() => {
    if (lastLoot) setHistory((h) => [...h, lastLoot])
  }, [lastLoot])

  const q = query.trim().toLowerCase()

  const events = useMemo(() => {
    let list = history
    if (questOnly) list = list.filter((e) => questItemNames.has(e.item.toLowerCase()))
    if (q) list = list.filter((e) => e.item.toLowerCase().includes(q))
    return [...list].reverse() // most recent first
  }, [history, q, questOnly])

  const grouped = useMemo(() => {
    const map = new Map<string, { item: string; count: number; last: number }>()
    for (const e of events) {
      const key = e.item.toLowerCase()
      const cur = map.get(key)
      if (cur) {
        cur.count += 1
        cur.last = Math.max(cur.last, e.ts)
      } else {
        map.set(key, { item: e.item, count: 1, last: e.ts })
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || b.last - a.last)
  }, [events])

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
          {history.length.toLocaleString()} loot events · {grouped.length.toLocaleString()} unique items
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
                <TableCell>Item</TableCell>
                <TableCell align="right">Times looted</TableCell>
                <TableCell>Last looted</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {grouped.slice(0, MAX_ROWS).map((g) => (
                <TableRow key={g.item} hover>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <span>{g.item}</span>
                      {isQuestItem(g.item) && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">{g.count}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{fmtTime(g.last)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 160 }}>Time</TableCell>
                <TableCell>Item</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.slice(0, MAX_ROWS).map((e, i) => (
                <TableRow key={`${e.ts}-${e.item}-${i}`} hover>
                  <TableCell sx={{ color: 'text.secondary' }}>{fmtTime(e.ts)}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <span>{e.item}</span>
                      {isQuestItem(e.item) && <Chip size="small" color="primary" variant="outlined" label="PoSky" />}
                    </Stack>
                  </TableCell>
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
    </Stack>
  )
}
