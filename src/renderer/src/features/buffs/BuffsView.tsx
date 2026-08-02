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
import type { ActiveBuff, BuffClass, BuffStat, BuffsDelta, BuffsSnap } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { fmtDuration, remainingFraction, isOverdue, classAccent, classLabel } from './format'

const CLASS_ORDER: BuffClass[] = ['self', 'pet', 'debuff']

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
  // Overdue (Task #30): run past the p75 window (n≥2) → show "any moment" instead of
  // a bottomed-out countdown.
  const overdue = isOverdue(elapsed, buff.p75, buff.n)
  // Provisional (Task #30): shown optimistically the instant we saw the cast begin,
  // before the land timeout confirms it. Dim the row + show a "casting…" hint.
  const provisional = buff.provisional === true

  // Debuff target is INFERRED (castBegin carries no target) — surface it honestly as a
  // "target: inferred" chip, never a silent guess (Task #32 rule 5c).
  const inferred = buff.inferredTarget === true

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        opacity: provisional ? 0.6 : 1,
        borderStyle: provisional ? 'dashed' : 'solid',
        // Class accent: red-ish left border for debuffs, green for pet, gold for self.
        borderLeft: '3px solid',
        borderLeftColor: classAccent(buff.cls)
      }}
    >
      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {buff.spell}
        </Typography>
        {inferred ? (
          <Tooltip title="Debuff target inferred from the pet's current fight target — castBegin carries no target, so this is a best guess, not a confirmed target.">
            <Chip
              size="small"
              label={buff.target ? `target: ${buff.target} (inferred)` : 'target: inferred'}
              variant="outlined"
              color="warning"
              sx={{ height: 18, fontSize: 11, maxWidth: 180, '& .MuiChip-label': { px: 0.75 } }}
            />
          </Tooltip>
        ) : buff.target === 'pet' ? (
          <Chip size="small" label="pet" variant="outlined" sx={{ height: 18, fontSize: 11 }} />
        ) : buff.target ? (
          <Chip
            size="small"
            label={buff.target}
            variant="outlined"
            sx={{ height: 18, fontSize: 11, maxWidth: 120, '& .MuiChip-label': { px: 0.75 } }}
          />
        ) : null}
        {provisional && (
          <Chip
            size="small"
            label="casting…"
            variant="outlined"
            color="info"
            sx={{ height: 18, fontSize: 11 }}
          />
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
              // Fade toward warning as the estimated window empties / runs overdue.
              '& .MuiLinearProgress-bar': {
                bgcolor: overdue || (frac as number) < 0.2 ? 'warning.main' : 'primary.main'
              }
            }}
          />
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="caption" color={overdue ? 'warning.main' : 'text.secondary'}>
              {overdue
                ? 'overdue · any moment'
                : `~${fmtDuration(remaining as number)} left`}
              {!overdue && spread != null && spread > 1000 ? ` (± ${fmtDuration(spread)})` : ''}
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
        No {classLabel(cls).toLowerCase()} durations mined yet.
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

  // Group active buffs by class so Self / Pet / Debuffs render as visually-distinct
  // sections (Task #32). Within a group, preserve the snapshot's startedTs order.
  const activeByClass = useMemo(() => {
    const g: Record<BuffClass, ActiveBuff[]> = { self: [], pet: [], debuff: [] }
    for (const b of active) g[b.cls].push(b)
    return g
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
            label={`${active.length} active · ${minedCount} mined`}
          />
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Buffs are bound to WHO they're on — self, your pet, or (for debuffs like slows) a hostile
          mob. Cast targets are learned from landing emotes ("You feel much faster." ⇒ self); ranks
          are merged so "Swift Like the Wind I" and its rank-less fade pair. Durations are mined from
          each cast→fade pair; fades that can never be observed — a charmed pet or mob left behind on a
          zone, an entity's death, or a logout gap (≥30 min clears everything) — are censored, not
          sampled, and a buff run far past its window auto-retires. Debuff targets are inferred (the
          cast line has no target) and shown as such.
        </Typography>
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Active
        </Typography>
        {active.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No active buffs tracked. A buff appears here once you cast it and it has been observed
            wearing off before (the fade is how the app knows a spell is a buff/debuff).
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {CLASS_ORDER.filter((c) => activeByClass[c].length > 0).map((c) => (
              <Box key={c}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                  <Box
                    sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: classAccent(c) }}
                  />
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    {classLabel(c)}
                  </Typography>
                </Stack>
                <Box
                  sx={{
                    display: 'grid',
                    gap: 1,
                    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))'
                  }}
                >
                  {activeByClass[c].map((b) => (
                    <ActiveRow key={b.spell} buff={b} now={now} />
                  ))}
                </Box>
              </Box>
            ))}
          </Stack>
        )}
      </Box>

      <Box>
        <Typography variant="subtitle2" gutterBottom>
          Mined durations
        </Typography>
        {statsClasses.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No buff durations mined yet. Cast a buff on yourself or your pet and let it wear off — the
            duration model learns from each land→fade pair.
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {statsClasses.map((c) => (
              <Box key={c}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
                  <Box
                    sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: classAccent(c) }}
                  />
                  <Typography variant="caption" sx={{ fontWeight: 600 }}>
                    {classLabel(c)}
                  </Typography>
                </Stack>
                <Paper
                  variant="outlined"
                  sx={{ p: 1, borderLeft: '3px solid', borderLeftColor: classAccent(c) }}
                >
                  <StatsTable stats={snap.stats} cls={c} />
                </Paper>
              </Box>
            ))}
          </Stack>
        )}
      </Box>

      <Typography variant="caption" color="text.secondary">
        Tip: you can wire a sound to any buff wearing off on the Alerts tab with an event trigger like{' '}
        <code>{`{ type: 'event', kind: 'buffFade', where: { spell: 'Clarity' } }`}</code> — handy for
        re-casting long class buffs the moment they drop.
      </Typography>
    </Stack>
  )
}
