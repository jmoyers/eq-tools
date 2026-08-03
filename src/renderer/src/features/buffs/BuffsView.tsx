import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  Collapse,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography
} from '@mui/material'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined'
import type {
  ActiveBuff,
  BuffClass,
  BuffStat,
  BuffsDelta,
  BuffsSnap,
  MessageOverlay,
  OverlayVerdict
} from '@shared/types'
import { useModule } from '../../lib/useModule'
import { ActiveRow } from './ActiveBuffRow'
import { fmtDuration, classAccent, groupKey, groupLabel } from './format'

// Stats-table sections: buffs first, then debuffs (Task #35 — a spell property).
const CLASS_ORDER: BuffClass[] = ['buff', 'debuff']
const CLASS_LABEL: Record<BuffClass, string> = { buff: 'Buffs', debuff: 'Debuffs' }

// Stable empty reference so hooks don't churn before hydration.
const EMPTY_BUFFS: BuffsSnap = { active: [], stats: {} }

// The buffs module ships its whole (small) snapshot each flush, so the delta simply
// replaces state — no incremental merge needed.
const applyBuffsDelta = (_state: BuffsSnap, delta: BuffsDelta): BuffsSnap => delta

/** The dense per-spell stats table for ONE class, sorted by sample count. */
function StatsTable({ stats, cls }: { stats: Record<string, BuffStat>; cls: BuffClass }): JSX.Element {
  const rows = useMemo(
    () =>
      Object.values(stats)
        .filter((s) => s.cls === cls)
        .sort((a, b) => b.n - a.n || a.spell.localeCompare(b.spell)),
    [stats, cls]
  )
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No {CLASS_LABEL[cls].toLowerCase()} durations yet.
      </Typography>
    )
  }
  return (
    <Table size="small" sx={{ '& td, & th': { py: 0.5 } }}>
      <TableHead>
        <TableRow>
          <TableCell>Spell</TableCell>
          <TableCell align="right">estimate</TableCell>
          <TableCell align="right">n</TableCell>
          <TableCell align="right">median</TableCell>
          <TableCell align="right">IQR (p25–p75)</TableCell>
          <TableCell align="right">min–max</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((s) => (
          <StatsRow key={s.spell} s={s} />
        ))}
      </TableBody>
    </Table>
  )
}

/**
 * The estimate the app uses (Task #34): DB duration when known ("db"), else the
 * recency-weighted max of samples ("observed"). Falls back to median for older deltas
 * without the field.
 */
function rowEstimate(s: BuffStat): { ms?: number | null; src?: string } {
  const ms = s.estimateMs ?? s.dbDurationMs ?? s.medianMs
  const src =
    s.estimatorSource ?? (s.dbDurationMs != null ? 'db' : s.medianMs != null ? 'observed' : undefined)
  return { ms, src }
}

/** The estimate cell: the figure plus a chip naming where it came from. */
function EstimateCell({ ms, src }: { ms?: number | null; src?: string }): JSX.Element {
  if (ms == null) return <>—</>
  return (
    <Tooltip
      title={
        src === 'db'
          ? 'Authoritative duration from the spell database.'
          : 'Recency-weighted max of observed casts.'
      }
    >
      <span>
        {fmtDuration(ms)}
        {src ? (
          <Chip
            size="small"
            label={src === 'db' ? 'db' : 'obs'}
            variant="outlined"
            sx={{ ml: 0.5, height: 15, fontSize: 9, '& .MuiChip-label': { px: 0.4 } }}
          />
        ) : null}
      </span>
    </Tooltip>
  )
}

/** One stats row. Everything not stated by a source renders as '—', never as a zero. */
function StatsRow({ s }: { s: BuffStat }): JSX.Element {
  const est = rowEstimate(s)
  return (
    <TableRow hover>
      <TableCell>{s.spell}</TableCell>
      <TableCell align="right">
        <EstimateCell ms={est.ms} src={est.src} />
      </TableCell>
      <TableCell align="right">
        {s.n === 0 ? (
          <Tooltip title="Seen fading but no clean cast→fade pair yet">
            <span style={{ opacity: 0.5 }}>0</span>
          </Tooltip>
        ) : (
          s.n
        )}
      </TableCell>
      <TableCell align="right">{fmtDuration(s.medianMs)}</TableCell>
      <TableCell align="right" style={{ opacity: 0.8 }}>
        {s.p25 != null && s.p75 != null ? `${fmtDuration(s.p25)} – ${fmtDuration(s.p75)}` : '—'}
      </TableCell>
      <TableCell align="right" style={{ opacity: 0.65 }}>
        {s.minMs != null && s.maxMs != null ? `${fmtDuration(s.minMs)} – ${fmtDuration(s.maxMs)}` : '—'}
      </TableCell>
    </TableRow>
  )
}

// Verdict → chip color + label for the overlay audit table (Task #36).
const VERDICT_COLOR: Record<OverlayVerdict, 'success' | 'info' | 'error' | 'default'> = {
  verified: 'success',
  shared: 'info',
  'contradicts-wiki': 'error',
  unknown: 'default'
}
const VERDICT_LABEL: Record<OverlayVerdict, string> = {
  verified: 'verified',
  shared: 'shared',
  'contradicts-wiki': 'contradicts wiki',
  unknown: 'unknown'
}

/**
 * Diagnostics table (read-only): per-message verdicts. Collapsed behind an
 * unobtrusive icon-button — no explanatory prose, just the data.
 */
function OverlayDiagnostics({ overlay }: { overlay: MessageOverlay }): JSX.Element {
  const [open, setOpen] = useState(false)
  const rows = useMemo(
    () => overlay.messages.filter((m) => m.verdict !== 'unknown').slice(0, 200),
    [overlay.messages]
  )
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Diagnostics">
          <IconButton size="small" onClick={() => setOpen((v) => !v)}>
            <ScienceOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Paper variant="outlined" sx={{ mt: 1, p: 1, maxHeight: 380, overflow: 'auto' }}>
          <Table size="small" sx={{ '& td, & th': { py: 0.4, fontSize: 12 } }}>
            <TableHead>
              <TableRow>
                <TableCell>Message</TableCell>
                <TableCell>role</TableCell>
                <TableCell>verdict</TableCell>
                <TableCell align="right">n</TableCell>
                <TableCell>spell(s) · count</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={`${m.role}:${m.text}`} hover>
                  <TableCell sx={{ fontFamily: 'monospace', maxWidth: 320 }}>{m.text}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{m.role}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={VERDICT_COLOR[m.verdict]}
                      label={VERDICT_LABEL[m.verdict]}
                      sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
                    />
                  </TableCell>
                  <TableCell align="right">{m.total}</TableCell>
                  <TableCell sx={{ color: 'text.secondary', maxWidth: 340 }}>
                    {m.verdict === 'contradicts-wiki' && m.wikiConflict ? (
                      <Tooltip title={`wiki claims: "${m.wikiConflict.wikiText}"`}>
                        <span>
                          {m.spells.map((s) => `${s.spell}:${s.count}`).join(', ')}{' '}
                          <span style={{ opacity: 0.6 }}>(wiki ≠ observed)</span>
                        </span>
                      </Tooltip>
                    ) : (
                      m.spells
                        .slice(0, 8)
                        .map((s) => `${s.spell}:${s.count}`)
                        .join(', ') + (m.spells.length > 8 ? ' …' : '')
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      </Collapse>
    </Box>
  )
}

/** One entity's live buffs: its label, a count chip, and the row grid. */
function ActiveGroup({
  label,
  buffs,
  now
}: {
  label: string
  buffs: ActiveBuff[]
  now: number
}): JSX.Element {
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          label={buffs.length}
          sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
        />
      </Stack>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {buffs.map((b) => (
          <ActiveRow key={`${b.spell}@${b.self ? 'self' : b.target ?? '?'}`} buff={b} now={now} />
        ))}
      </Box>
    </Box>
  )
}

/** One class's durations table, under its accent swatch. */
function StatsSection({
  cls,
  stats
}: {
  cls: BuffClass
  stats: Record<string, BuffStat>
}): JSX.Element {
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: classAccent(cls) }} />
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {CLASS_LABEL[cls]}
        </Typography>
      </Stack>
      <Paper variant="outlined" sx={{ p: 1, borderLeft: '3px solid', borderLeftColor: classAccent(cls) }}>
        <StatsTable stats={stats} cls={cls} />
      </Paper>
    </Box>
  )
}

export default function BuffsView(): JSX.Element {
  const snap = useModule<BuffsSnap, BuffsDelta>('buffs', applyBuffsDelta) ?? EMPTY_BUFFS
  // Tick once a second so active-buff elapsed/remaining stay live between deltas.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const active = snap.active
  const minedCount = Object.values(snap.stats).filter((s) => s.n > 0).length

  // PRIORITY layout (Task #35): "Your buffs" (self) FIRST, then one group per bound entity
  // sorted by liveliness/recency (most-recently-refreshed entity first — the current pet
  // naturally tops this). Buff vs debuff is a per-row style (classAccent), not a group.
  const activeGroups = useMemo(() => {
    const byKey = new Map<string, ActiveBuff[]>()
    for (const b of active) {
      const k = groupKey(b)
      const list = byKey.get(k)
      if (list) list.push(b)
      else byKey.set(k, [b])
    }
    const recency = (list: ActiveBuff[]): number => Math.max(...list.map((b) => b.startedTs))
    return [...byKey.entries()]
      .sort((a, b) => {
        if (a[0] === 'self') return -1 // self always first
        if (b[0] === 'self') return 1
        return recency(b[1]) - recency(a[1]) // then most-recent entity first
      })
      .map(([key, list]) => ({
        key,
        buffs: [...list].sort((x, y) => x.startedTs - y.startedTs)
      }))
  }, [active])
  // Which classes have any mined stats — to decide whether to render each table.
  const statsClasses = useMemo(() => {
    const present = new Set<BuffClass>()
    for (const s of Object.values(snap.stats)) present.add(s.cls)
    return CLASS_ORDER.filter((c) => present.has(c))
  }, [snap.stats])

  return (
    <Stack spacing={2}>
      <Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          <AutoFixHighIcon color="primary" />
          <Typography variant="h6">Buffs</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={`${active.length} active · ${minedCount} tracked`}
          />
        </Stack>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Active
        </Typography>
        {active.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No active buffs.
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {activeGroups.map((g) => (
              <ActiveGroup key={g.key} label={groupLabel(g.key)} buffs={g.buffs} now={now} />
            ))}
          </Stack>
        )}
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Durations
        </Typography>
        {statsClasses.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No buff durations yet.
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {statsClasses.map((c) => (
              <StatsSection key={c} cls={c} stats={snap.stats} />
            ))}
          </Stack>
        )}
      </Box>

      {snap.overlay && snap.overlay.messages.length > 0 ? (
        <OverlayDiagnostics overlay={snap.overlay} />
      ) : null}
    </Stack>
  )
}
