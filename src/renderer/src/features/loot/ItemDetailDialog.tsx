import { useMemo } from 'react'
import {
  Box,
  Chip,
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
import type { LootEvent } from '@shared/types'
import { formatDate } from '../../lib/formatDate'

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

function Timeline({ events }: { events: LootEvent[] }): JSX.Element {
  const bins = useMemo(() => {
    const ts = events.map((e) => e.ts).filter(Boolean)
    if (ts.length === 0) return { counts: [] as number[], from: 0, to: 0 }
    const from = Math.min(...ts)
    const to = Math.max(...ts)
    const N = 32
    const span = Math.max(1, to - from)
    const counts = new Array(N).fill(0)
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
  const agg = useMemo(() => {
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
  }, [events])

  const total = events.length
  const maxSource = agg.sources[0]?.count ?? 1
  const maxZone = agg.zones[0]?.count ?? 1

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ pr: 6 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <span>{item}</span>
          {isQuestItem && <Chip size="small" color="primary" variant="outlined" label="Plane of Sky" />}
        </Stack>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          <StatCard label="Times looted" value={String(total)} />
          <StatCard label="Distinct mobs" value={String(agg.sources.length)} />
          <StatCard label="Zones seen" value={String(agg.zones.length)} />
        </Stack>

        {stats && (
          <Paper
            variant="outlined"
            sx={{
              p: 1.5,
              mb: 2,
              fontFamily: '"Consolas","Courier New",monospace',
              fontSize: 12,
              whiteSpace: 'pre-line',
              color: '#e9e2c9',
              bgcolor: '#12131c'
            }}
          >
            {stats}
          </Paper>
        )}

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="subtitle2" gutterBottom>
              Dropped by <Typography component="span" variant="caption" color="text.secondary">(times seen)</Typography>
            </Typography>
            {agg.sources.length === 0 && <Typography variant="caption">No source recorded.</Typography>}
            {agg.sources.map((s) => (
              <Bar key={s.name} label={s.name} value={s.count} max={maxSource} right={`${s.count}× seen`} />
            ))}
          </Box>
          <Box sx={{ flex: 1 }}>
            <Typography variant="subtitle2" gutterBottom>
              Seen in zones
            </Typography>
            {agg.zones.length === 0 && <Typography variant="caption">No zone recorded.</Typography>}
            {agg.zones.map((z) => (
              <Bar key={z.name} label={z.name} value={z.count} max={maxZone} right={`${z.count}×`} />
            ))}
          </Box>
        </Stack>

        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle2" gutterBottom>
          Looted over time
        </Typography>
        <Timeline events={events} />
      </DialogContent>
    </Dialog>
  )
}
