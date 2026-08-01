import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography
} from '@mui/material'
import type { LevelEvent } from '@shared/types'

function fmtDelta(ms: number): string {
  if (ms <= 0) return '—'
  const mins = ms / 60000
  if (mins < 60) return `${Math.round(mins)}m`
  const hrs = mins / 60
  if (hrs < 48) return `${hrs.toFixed(1)}h`
  return `${(hrs / 24).toFixed(1)}d`
}

function LevelChart({ levels }: { levels: LevelEvent[] }): JSX.Element | null {
  if (levels.length < 2) return null
  const W = 720
  const H = 160
  const pad = 24
  const t0 = levels[0].ts
  const t1 = levels[levels.length - 1].ts
  const lo = levels[0].level - 1
  const hi = levels[levels.length - 1].level
  const x = (t: number): number => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad)
  const y = (lv: number): number => H - pad - ((lv - lo) / Math.max(1, hi - lo)) * (H - 2 * pad)
  const pts = levels.map((l) => `${x(l.ts).toFixed(1)},${y(l.level).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
      <polyline
        points={pts}
        fill="none"
        stroke="var(--mui-palette-primary-main, #d9b25f)"
        strokeWidth={2}
      />
      {levels.map((l) => (
        <circle key={l.ts} cx={x(l.ts)} cy={y(l.level)} r={2.5} fill="var(--mui-palette-primary-main, #d9b25f)" />
      ))}
    </svg>
  )
}

export default function LevelingView(): JSX.Element {
  const [levels, setLevels] = useState<LevelEvent[]>([])

  useEffect(() => {
    void window.eq.getLevels().then(setLevels)
    const off = window.eq.onLevel((e) => setLevels((prev) => [...prev, e]))
    return off
  }, [])

  const sorted = useMemo(() => [...levels].sort((a, b) => a.ts - b.ts), [levels])
  const current = sorted.length ? Math.max(...sorted.map((l) => l.level)) : null
  const span = sorted.length >= 2 ? sorted[sorted.length - 1].ts - sorted[0].ts : 0

  const rows = useMemo(() => {
    return sorted
      .map((l, i) => ({ ...l, delta: i > 0 ? l.ts - sorted[i - 1].ts : 0 }))
      .reverse()
  }, [sorted])

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <Paper variant="outlined" sx={{ p: 2, minWidth: 140 }}>
          <Typography variant="h3" sx={{ color: 'primary.main', lineHeight: 1 }}>
            {current ?? '—'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            current level {current ? '(highest logged)' : ''}
          </Typography>
        </Paper>
        <Paper variant="outlined" sx={{ p: 2, minWidth: 140 }}>
          <Typography variant="h3" sx={{ lineHeight: 1 }}>
            {sorted.length}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            level-ups in this log
          </Typography>
        </Paper>
        {span > 0 && (
          <Paper variant="outlined" sx={{ p: 2, minWidth: 140 }}>
            <Typography variant="h3" sx={{ lineHeight: 1 }}>
              {fmtDelta(span)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              across {sorted[0].level} → {sorted[sorted.length - 1].level}
            </Typography>
          </Paper>
        )}
      </Stack>

      <Alert severity="info" sx={{ py: 0 }}>
        Levels are read from <code>You have gained a level!</code> lines. EQ Legends doesn&apos;t log your{' '}
        class/loadout, so <strong>per-class levels can&apos;t be auto-detected</strong> — this tracks the
        character&apos;s overall level. A capped character with no recent dings will show no data here.
      </Alert>

      {sorted.length === 0 ? (
        <Typography color="text.secondary" sx={{ p: 2 }}>
          No level-ups found in this character&apos;s log.
        </Typography>
      ) : (
        <>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              Level over time
            </Typography>
            <LevelChart levels={sorted} />
          </Paper>

          <Box sx={{ flexGrow: 1, overflow: 'auto' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Level</TableCell>
                  <TableCell>Reached</TableCell>
                  <TableCell align="right">Time from previous</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={`${r.ts}-${r.level}`} hover>
                    <TableCell sx={{ color: 'primary.main', fontWeight: 600 }}>{r.level}</TableCell>
                    <TableCell sx={{ color: 'text.secondary' }}>{new Date(r.ts).toLocaleString()}</TableCell>
                    <TableCell align="right" sx={{ color: 'text.secondary' }}>
                      {fmtDelta(r.delta)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Box>
        </>
      )}
    </Stack>
  )
}
