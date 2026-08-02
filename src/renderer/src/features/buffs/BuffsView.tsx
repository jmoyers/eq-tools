import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  LinearProgress,
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
import type { ActiveBuff, BuffStat, BuffsDelta, BuffsSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { fmtDuration, remainingFraction } from './format'

// Stable empty reference so hooks don't churn before hydration.
const EMPTY_BUFFS: BuffsSnap = { active: [], stats: {} }

// The buffs module ships its whole (small) snapshot each flush, so the delta simply
// replaces state — no incremental merge needed.
const applyBuffsDelta = (_state: BuffsSnap, delta: BuffsDelta): BuffsSnap => delta

/** One active-buff row: name, elapsed, estimated remaining bar, ± spread, n. */
function ActiveRow({ buff, now }: { buff: ActiveBuff; now: number }): JSX.Element {
  const elapsed = Math.max(0, now - buff.startedTs)
  const hasEst = buff.estimatedMs != null && buff.estimatedMs > 0
  const remaining = hasEst ? Math.max(0, (buff.estimatedMs as number) - elapsed) : null
  const frac = hasEst ? remainingFraction(elapsed, buff.estimatedMs as number) : null
  // ± spread from the p25/p75 IQR around the estimate.
  const spread =
    buff.p25 != null && buff.p75 != null ? (buff.p75 - buff.p25) / 2 : null

  return (
    <Paper variant="outlined" sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {buff.spell}
        </Typography>
        {buff.target === 'pet' && (
          <Chip size="small" label="pet" variant="outlined" sx={{ height: 18, fontSize: 11 }} />
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {fmtDuration(elapsed)} elapsed
        </Typography>
      </Stack>

      {hasEst ? (
        <>
          <LinearProgress
            variant="determinate"
            value={(frac as number) * 100}
            sx={{
              height: 8,
              borderRadius: 1,
              // Fade toward warning as the estimated window empties.
              '& .MuiLinearProgress-bar': {
                bgcolor: (frac as number) < 0.2 ? 'warning.main' : 'primary.main'
              }
            }}
          />
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="caption" color="text.secondary">
              ~{fmtDuration(remaining as number)} left
              {spread != null && spread > 1000 ? ` (± ${fmtDuration(spread)})` : ''}
            </Typography>
            <Typography variant="caption" color="text.disabled">
              n={buff.n}
            </Typography>
          </Stack>
        </>
      ) : (
        <>
          <LinearProgress
            variant="indeterminate"
            sx={{ height: 8, borderRadius: 1, opacity: 0.5 }}
          />
          <Typography variant="caption" color="text.disabled">
            unknown duration (no samples yet)
          </Typography>
        </>
      )}
    </Paper>
  )
}

/** The dense per-spell stats table, sorted by sample count. */
function StatsTable({ stats }: { stats: Record<string, BuffStat> }): JSX.Element {
  const rows = useMemo(
    () =>
      Object.values(stats).sort((a, b) => b.n - a.n || a.spell.localeCompare(b.spell)),
    [stats]
  )
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No buff durations mined yet. Cast a buff on yourself or your pet and let it wear off — the
        duration model learns from each land→fade pair.
      </Typography>
    )
  }
  return (
    <Table size="small" sx={{ '& td, & th': { py: 0.5 } }}>
      <TableHead>
        <TableRow>
          <TableCell>Spell</TableCell>
          <TableCell align="right">n</TableCell>
          <TableCell align="right">median</TableCell>
          <TableCell align="right">IQR (p25–p75)</TableCell>
          <TableCell align="right">min–max</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((s) => (
          <TableRow key={s.spell} hover>
            <TableCell>{s.spell}</TableCell>
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
        ))}
      </TableBody>
    </Table>
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

  return (
    <Stack spacing={2}>
      <Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          <AutoFixHighIcon color="primary" />
          <Typography variant="h6">Buffs</Typography>
          <Chip
            size="small"
            variant="outlined"
            label={`${active.length} active · ${minedCount} mined`}
          />
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Durations are mined from your own cast→fade history (self and pet buffs). Remaining time is
          an estimate from the median observed duration; the ± is the p25–p75 spread and n is how many
          samples back it.
        </Typography>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Active buffs
        </Typography>
        {active.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No active buffs tracked. A buff appears here once you cast it and it has been observed
            wearing off before (the fade is how the app knows a spell is a buff).
          </Typography>
        ) : (
          <Box
            sx={{
              display: 'grid',
              gap: 1,
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))'
            }}
          >
            {active.map((b) => (
              <ActiveRow key={b.spell} buff={b} now={now} />
            ))}
          </Box>
        )}
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Mined durations
        </Typography>
        <Paper variant="outlined" sx={{ p: 1 }}>
          <StatsTable stats={snap.stats} />
        </Paper>
      </Box>

      <Typography variant="caption" color="text.secondary">
        Tip: you can wire a sound to any buff wearing off on the Alerts tab with an event trigger like{' '}
        <code>{`{ type: 'event', kind: 'buffFade', where: { spell: 'Clarity' } }`}</code> — handy for
        re-casting long class buffs the moment they drop.
      </Typography>
    </Stack>
  )
}
