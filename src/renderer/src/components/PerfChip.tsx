// PerfChip — the title-bar performance HUD (docs/plans/perf-profiling.md P3).
//
//   CPU 12% · 480 MB
//
// Compact, honest, and HIDDEN ENTIRELY when the HUD is off — no greyed placeholder, no empty
// slot reserving space for a feature you did not turn on. It lives in TitleBar.tsx beside the
// overlay menu; its own file because that bar is already at the repo's factoring ceiling.
//
// COLOURED BY LAG, NEVER BY CPU. An app that is busy because you asked it to replay a 1.1M-line
// log is not misbehaving, and a chip that goes red for that would train you to ignore it exactly
// when it finally means something. The colour comes from `lagSeverity` — how late the main
// process's event loop is running — so amber/red means BLOCKED, which is the thing you can feel.
//
// Clicking it opens the whole measurement: per-process-type CPU and memory, the lag figures the
// colour came from, how many long tasks the renderer's own thread suffered, and a two-minute
// sparkline. Sixty numbers do not need a chart library — the polyline is `sparklinePoints`,
// which is a pure function with tests rather than a dependency.

import { type JSX, useRef, useState } from 'react'
import { Box, Divider, Popover, Stack, Typography } from '@mui/material'
import SpeedIcon from '@mui/icons-material/Speed'
import Tooltip from '@mui/material/Tooltip'
import {
  formatChip,
  formatCpu,
  formatMemory,
  formatMs,
  lagSeverity,
  sparklinePoints,
  type PerfHudSample,
  type PerfSeverity
} from '@shared/perf'
import { usePerfHud } from '../lib/perfHud'

/** Chip colour per severity. 'normal' stays the bar's own quiet grey — a HUD you can leave on
 *  must be ignorable while everything is fine. */
const SEVERITY_COLOR: Record<PerfSeverity, string> = {
  normal: 'text.secondary',
  warn: 'warning.main',
  alert: 'error.main'
}

const SEVERITY_TITLE: Record<PerfSeverity, string> = {
  normal: 'Performance — the event loop is keeping up',
  warn: 'Performance — the event loop is running late (click for detail)',
  alert: 'Performance — the event loop stalled (click for detail)'
}

const SPARK_W = 240
const SPARK_H = 36

/** The two-minute CPU sparkline. One polyline, no library, no axes: it answers "is this spike
 *  new or has it been like that" and nothing else. */
function Sparkline({ values, color }: { values: number[]; color: string }): JSX.Element {
  const points = sparklinePoints(values, SPARK_W, SPARK_H)
  return (
    <Box
      component="svg"
      data-testid="perf-sparkline"
      viewBox={`0 0 ${String(SPARK_W)} ${String(SPARK_H)}`}
      preserveAspectRatio="none"
      sx={{ width: '100%', height: SPARK_H, display: 'block' }}
    >
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </Box>
  )
}

/** One `label · value` row — the popover is a list of facts, not a form. */
function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
    </Stack>
  )
}

/** Per-process-type CPU + memory. Types with no live process are omitted rather than shown as
 *  zeros — "GPU 0% 0 MB" invites the question of whether the GPU process died. */
function TypeTable({ sample }: { sample: PerfHudSample }): JSX.Element {
  return (
    <Stack spacing={0.25} data-testid="perf-popover-table">
      {sample.byType
        .filter((row) => row.count > 0)
        .map((row) => (
          <Fact
            key={row.type}
            label={row.count > 1 ? `${row.type} ×${String(row.count)}` : row.type}
            value={`${formatCpu(row.cpuPercent)} · ${formatMemory(row.memoryMb)}`}
          />
        ))}
    </Stack>
  )
}

/** The lag block: the numbers the chip's colour came from, stated rather than implied. */
function LagFacts({ sample, longtasks }: { sample: PerfHudSample; longtasks: number }): JSX.Element {
  const measured = sample.lag.samples > 0
  return (
    <Stack spacing={0.25}>
      <Fact
        label="event loop, p95"
        value={measured ? formatMs(sample.lag.p95Ms) : 'not measured yet'}
      />
      <Fact label="event loop, worst" value={measured ? formatMs(sample.lag.maxMs) : '—'} />
      <Fact label="long tasks (2 min)" value={String(longtasks)} />
    </Stack>
  )
}

/** Everything behind the chip. Split out so `PerfChip` itself stays a mount + a popover. */
function PerfDetail({ ring, latest }: { ring: PerfHudSample[]; latest: PerfHudSample }): JSX.Element {
  const severity = lagSeverity(latest.lag)
  const longtasks = ring.reduce((n, s) => n + s.longtasks, 0)
  return (
    <Stack spacing={1} sx={{ p: 1.5, minWidth: 280 }} data-testid="perf-popover">
      <Typography variant="subtitle2">{formatChip(latest)}</Typography>
      <Sparkline values={ring.map((s) => s.cpuPercent)} color="currentColor" />
      <Typography variant="caption" color="text.secondary">
        CPU, last {String(ring.length)} samples (2 s apart)
      </Typography>
      <Divider />
      <TypeTable sample={latest} />
      <Divider />
      <LagFacts sample={latest} longtasks={longtasks} />
      <Typography variant="caption" sx={{ color: SEVERITY_COLOR[severity] }}>
        {severity === 'normal'
          ? 'The app is keeping up. High CPU here with a low event-loop figure is work, not lag.'
          : 'The event loop is being held up. If this app’s CPU is low, something else on the machine is holding it.'}
      </Typography>
    </Stack>
  )
}

/**
 * The chip itself. Renders NOTHING at all until the HUD is on and a sample has landed — a chip
 * that shows up empty for two seconds on every launch would be its own small performance
 * complaint.
 */
export default function PerfChip(): JSX.Element | null {
  const { enabled, ring, latest } = usePerfHud()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  if (!enabled || !latest) return null
  const severity = lagSeverity(latest.lag)
  const color = SEVERITY_COLOR[severity]

  return (
    <Box data-no-drag sx={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center' }}>
      <Tooltip title={SEVERITY_TITLE[severity]}>
        <Box
          component="button"
          type="button"
          ref={btnRef}
          data-testid="perf-chip"
          aria-label="Performance"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          sx={{
            WebkitAppRegion: 'no-drag',
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            height: 26,
            px: 1,
            borderRadius: 1,
            border: '1px solid',
            borderColor: severity === 'normal' ? 'divider' : color,
            bgcolor: 'transparent',
            color,
            cursor: 'pointer',
            outline: 'none',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            transition: 'background-color 120ms, color 120ms, border-color 120ms',
            '& svg': { fontSize: 14 },
            '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' }
          }}
        >
          <SpeedIcon />
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            {formatChip(latest)}
          </Typography>
        </Box>
      </Tooltip>
      <Popover
        anchorEl={btnRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <PerfDetail ring={ring} latest={latest} />
      </Popover>
    </Box>
  )
}
