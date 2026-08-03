import { type JSX, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Paper,
  Stack,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import type { ItemKnowledge, LootEvent } from '@shared/types'
import { formatDate } from '../../lib/formatDate'
import { EQ_ITEM_COLORS } from '../../lib/ItemWindow'
import { ObservedItemWindow } from '../../lib/ObservedItemWindow'
import { KnowledgeSection } from './KnowledgeSection'

/**
 * "What it's for" knowledge (Task #53): fetch this item's lore/quest knowledge when the
 * dialog opens. Local-posky-first + cached in main, so a known item resolves instantly;
 * a fresh wiki lookup shows a quiet loading state. Never throws (main degrades to a
 * cached-negative / offline record). Re-runs when the item changes.
 */
interface ItemKnowledgeState {
  data: ItemKnowledge | null
  loading: boolean
}

function useItemKnowledge(item: string, open: boolean): ItemKnowledgeState {
  const [data, setData] = useState<ItemKnowledge | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    let alive = true
    setData(null)
    setLoading(true)
    void window.eq
      .lookupItem(item)
      .then((k) => {
        if (alive) setData(k)
      })
      .catch(() => {
        /* main never rejects; guard anyway */
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [item, open])
  return { data, loading }
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, flex: 1, minWidth: 120 }}>
      <Typography variant="h5" sx={{ color: 'primary.main', lineHeight: 1.1 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.disabled" display="block">
          {hint}
        </Typography>
      )}
    </Paper>
  )
}

function Bar({
  label,
  value,
  max,
  right
}: {
  label: string
  value: number
  max: number
  right: string
}): JSX.Element {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <Box sx={{ mb: 0.75 }}>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.25 }}>
        <Typography variant="caption" noWrap sx={{ maxWidth: 220 }}>
          {label}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {right}
        </Typography>
      </Stack>
      <Box sx={{ height: 8, bgcolor: 'action.hover', borderRadius: 1 }}>
        <Box sx={{ height: 8, width: `${pct}%`, bgcolor: 'secondary.main', borderRadius: 1 }} />
      </Box>
    </Box>
  )
}

interface TimelineBins {
  counts: number[]
  from: number
  to: number
}

function Timeline({ events }: { events: LootEvent[] }): JSX.Element {
  const bins = useMemo<TimelineBins>(() => {
    const ts = events.map((e) => e.ts).filter(Boolean)
    if (ts.length === 0) return { counts: [], from: 0, to: 0 }
    const from = Math.min(...ts)
    const to = Math.max(...ts)
    const N = 32
    const span = Math.max(1, to - from)
    const counts = new Array<number>(N).fill(0)
    for (const t of ts) counts[Math.min(N - 1, Math.floor(((t - from) / span) * (N - 1)))]++
    return { counts, from, to }
  }, [events])

  if (bins.counts.length === 0) return <Typography variant="caption">No dated loot events.</Typography>
  const max = Math.max(...bins.counts, 1)
  const W = 640
  const H = 60
  const bw = W / bins.counts.length
  const fmt = (ms: number): string => formatDate(ms)
  return (
    <Box>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
        {bins.counts.map((c, i) => {
          const h = (c / max) * (H - 4)
          return (
            <rect
              key={i}
              x={i * bw + 1}
              y={H - h}
              width={bw - 2}
              height={h}
              fill="var(--mui-palette-primary-main, #d9b25f)"
              opacity={c ? 0.9 : 0.15}
            />
          )
        })}
      </svg>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {fmt(bins.from)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {fmt(bins.to)}
        </Typography>
      </Stack>
    </Box>
  )
}

interface LootTally {
  name: string
  count: number
}

interface LootBreakdown {
  sources: LootTally[]
  zones: LootTally[]
}

// Who dropped it and where, most-seen first. A loot row with no `source` still counts —
// it happened — so it tallies under `unknown` rather than vanishing from the breakdown.
function aggregateLoot(events: LootEvent[]): LootBreakdown {
  const bySource = new Map<string, number>()
  const byZone = new Map<string, number>()
  for (const e of events) {
    const s = e.source ?? 'unknown'
    bySource.set(s, (bySource.get(s) ?? 0) + 1)
    if (e.zone) byZone.set(e.zone, (byZone.get(e.zone) ?? 0) + 1)
  }
  const sources = [...bySource.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  const zones = [...byZone.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  return { sources, zones }
}

/* The item as the GAME shows it: wiki base data, drawn in the item-window language.
   `stats` (posky's scraped block) is the offline fallback when the wiki lookup hasn't
   structured one yet. */
function ItemWindowColumn({
  item,
  stats,
  knowledge
}: {
  item: string
  stats?: string
  knowledge: ItemKnowledgeState
}): JSX.Element {
  return (
    <Box sx={{ width: { xs: '100%', md: 340 }, flexShrink: 0 }}>
      <ObservedItemWindow
        name={item}
        stats={knowledge.data?.stats}
        rawStats={stats ?? knowledge.data?.statsBlock}
        iconId={knowledge.data?.iconId}
        flavor={knowledge.data?.summary}
      />
      {knowledge.loading && !knowledge.data && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, color: 'text.secondary' }}>
          <CircularProgress size={14} />
          <Typography variant="caption">Looking up this item…</Typography>
        </Stack>
      )}
    </Box>
  )
}

function DroppedByColumn({ sources, max }: { sources: LootTally[]; max: number }): JSX.Element {
  return (
    <Box sx={{ flex: 1 }}>
      <Typography variant="subtitle2" gutterBottom>
        Dropped by{' '}
        <Typography component="span" variant="caption" color="text.secondary">
          (times seen)
        </Typography>
      </Typography>
      {sources.length === 0 && <Typography variant="caption">No source recorded.</Typography>}
      {sources.map((s) => (
        <Bar key={s.name} label={s.name} value={s.count} max={max} right={`${s.count}× seen`} />
      ))}
    </Box>
  )
}

function ZonesColumn({ zones, max }: { zones: LootTally[]; max: number }): JSX.Element {
  return (
    <Box sx={{ flex: 1 }}>
      <Typography variant="subtitle2" gutterBottom>
        Seen in zones
      </Typography>
      {zones.length === 0 && <Typography variant="caption">No zone recorded.</Typography>}
      {zones.map((z) => (
        <Bar key={z.name} label={z.name} value={z.count} max={max} right={`${z.count}×`} />
      ))}
    </Box>
  )
}

/* Everything BELOW/BESIDE the game block is OUR knowledge — what the live log and the local
   dataset add that the in-game window can't tell you. */
function ObservedColumn({
  events,
  agg,
  knowledge
}: {
  events: LootEvent[]
  agg: LootBreakdown
  knowledge: ItemKnowledgeState
}): JSX.Element {
  return (
    <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <StatCard label="Times looted" value={String(events.length)} />
        <StatCard label="Distinct mobs" value={String(agg.sources.length)} />
        <StatCard label="Zones seen" value={String(agg.zones.length)} />
      </Stack>

      {/* "What it's for" (Task #53) — quest knowledge. Local posky + cached wiki. */}
      <KnowledgeSection data={knowledge.data} loading={knowledge.loading} />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
        <DroppedByColumn sources={agg.sources} max={agg.sources[0]?.count ?? 1} />
        <ZonesColumn zones={agg.zones} max={agg.zones[0]?.count ?? 1} />
      </Stack>

      <Divider sx={{ my: 2 }} />
      <Typography variant="subtitle2" gutterBottom>
        Looted over time
      </Typography>
      <Timeline events={events} />
    </Box>
  )
}

export function ItemDetailDialog({
  open,
  onClose,
  item,
  events,
  stats,
  isQuestItem
}: {
  open: boolean
  onClose: () => void
  item: string
  events: LootEvent[]
  stats?: string
  isQuestItem: boolean
}): JSX.Element {
  const agg = useMemo(() => aggregateLoot(events), [events])
  const knowledge = useItemKnowledge(item, open)

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ pr: 6 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Box component="span" sx={{ color: EQ_ITEM_COLORS.name }}>
            {item}
          </Box>
          {isQuestItem && <Chip size="small" color="primary" variant="outlined" label="Plane of Sky" />}
        </Stack>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2.5} alignItems="flex-start">
          <ItemWindowColumn item={item} stats={stats} knowledge={knowledge} />
          <ObservedColumn events={events} agg={agg} knowledge={knowledge} />
        </Stack>
      </DialogContent>
    </Dialog>
  )
}
