// RangeStatsPanel — what a drag-selected time range says about progression.
//
// WAVE 2 SHIP STATE: this is the STUB. It renders the header row only (the range, its
// duration, the clipped warning and the Clear control) so `LevelingView`'s import never
// points at a missing file while the interaction wave lands (AGENTS.md: keep the tree
// buildable). Wave 3 fills the body — hero row, chip row, per-zone table — off the SAME
// `RangeStats` object this already receives, so no prop changes when it does.
//
// The numbers all come from `shared/progressionStats.rangeStats`, a pure function over the
// progression snapshot. Nothing here derives anything; this file is presentation only.

import type { JSX } from 'react'
import { Chip, IconButton, Paper, Stack, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import type { RangeStats } from '@shared/progressionStats'
import { formatDateTime } from '../../lib/formatDate'
import { fmtDelta } from './levelChartGeometry'

export interface RangeStatsPanelProps {
  stats: RangeStats
  onClear: () => void
}

export function RangeStatsPanel({ stats, onClear }: RangeStatsPanelProps): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, flexShrink: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {formatDateTime(stats.t0)} → {formatDateTime(stats.t1)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {fmtDelta(stats.durationMs)}
        </Typography>
        {stats.clipped && (
          // State, not process (UI conventions): the analytics store is capped drop-oldest,
          // so a range reaching below `windowStart` is measured over a PARTIAL record and
          // every count under it would silently under-report. Say so rather than round down.
          <Chip
            size="small"
            variant="outlined"
            color="warning"
            label="range starts before the analytics window"
            sx={{ height: 20 }}
          />
        )}
        <IconButton size="small" onClick={onClear} aria-label="Clear selection" sx={{ ml: 'auto' }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Paper>
  )
}
