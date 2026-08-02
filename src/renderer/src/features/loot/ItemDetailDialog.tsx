import { useEffect, useMemo, useState } from 'react'
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
import AutoStoriesIcon from '@mui/icons-material/AutoStories'
import type { ItemKnowledge, LootEvent } from '@shared/types'
import { formatDate } from '../../lib/formatDate'

/**
 * "What it's for" knowledge (Task #53): fetch this item's lore/quest knowledge when the
 * dialog opens. Local-posky-first + cached in main, so a known item resolves instantly;
 * a fresh wiki lookup shows a quiet loading state. Never throws (main degrades to a
 * cached-negative / offline record). Re-runs when the item changes.
 */
function useItemKnowledge(item: string, open: boolean): { data: ItemKnowledge | null; loading: boolean } {
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

/**
 * The "What it's for" card: lore badge, quest chips (with giver when known), a wiki
 * summary line, and source attribution. Quiet loading/offline/empty states — no
 * narration. Rendered only when there's something to say (or while loading).
 */
function KnowledgeSection({ data, loading }: { data: ItemKnowledge | null; loading: boolean }): JSX.Element | null {
  if (loading && !data) {
    return (
      <Box sx={{ mb: 2 }}>
        <Divider sx={{ mb: 1.5 }} />
        <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
          <CircularProgress size={14} />
          <Typography variant="caption">Looking up what this is for…</Typography>
        </Stack>
      </Box>
    )
  }
  if (!data) return null

  const hasSomething = data.lore || data.quest || data.questUses.length > 0 || !!data.summary
  // Nothing notable AND we successfully checked the wiki — stay silent (don't add noise
  // to ordinary vendor trash). If it was offline/notFound with no local data, also silent.
  if (!hasSomething) return null

  const wikiUrl = data.page
    ? `https://eqlwiki.com/wiki/${encodeURIComponent(data.page.replace(/ /g, '_'))}`
    : undefined

  return (
    <Box sx={{ mb: 2 }}>
      <Divider sx={{ mb: 1.5 }} />
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <AutoStoriesIcon fontSize="small" sx={{ color: 'secondary.main' }} />
        <Typography variant="subtitle2">What it&apos;s for</Typography>
        {data.lore && <Chip size="small" color="warning" variant="outlined" label="LORE" sx={{ height: 20 }} />}
        {data.offline && (
          <Typography variant="caption" color="text.disabled">
            (offline — showing what&apos;s known locally)
          </Typography>
        )}
      </Stack>

      {data.summary && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {data.summary}
        </Typography>
      )}

      {data.questUses.length > 0 ? (
        <Box>
          <Typography variant="caption" color="text.secondary">
            Used in {data.questUses.length === 1 ? 'quest' : 'quests'}:
          </Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
            {data.questUses.map((u) => (
              <Chip
                key={`${u.source}:${u.quest}`}
                size="small"
                variant="outlined"
                color={u.source === 'posky' ? 'primary' : 'default'}
                label={u.giver ? `${u.quest} · ${u.giver}` : u.quest}
                sx={{ height: 22 }}
              />
            ))}
          </Stack>
        </Box>
      ) : (
        data.quest && (
          <Typography variant="caption" color="text.secondary">
            Flagged as a quest item on the wiki (no specific quest association found).
          </Typography>
        )
      )}

      {wikiUrl && (
        <Typography variant="caption" color="text.disabled" display="block" sx={{ mt: 1 }}>
          Source: <a href={wikiUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>eqlwiki.com</a>
          {data.questUses.some((u) => u.source === 'posky') && ' + Plane of Sky dataset'}
        </Typography>
      )}
    </Box>
  )
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
  const knowledge = useItemKnowledge(item, open)

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

        {/* "What it's for" (Task #53) — lore/quest knowledge. Local posky + cached wiki. */}
        <KnowledgeSection data={knowledge.data} loading={knowledge.loading} />

        {/* Stat block: posky's scraped block when we have it, else the wiki item page's. */}
        {(stats || knowledge.data?.statsBlock) && (
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
            {stats ?? knowledge.data?.statsBlock}
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
