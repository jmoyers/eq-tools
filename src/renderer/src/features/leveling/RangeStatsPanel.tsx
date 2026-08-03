// RangeStatsPanel — what a drag-selected time range says about progression.
//
// Presentation ONLY. Every number arrives already computed by the pure
// `shared/progressionStats.rangeStats`, and every string it prints is shaped by the pure
// `rangeStatsRows.ts` beside this file. Nothing is derived here, which is what keeps the
// feature's honesty rules testable instead of buried in JSX:
//
//   • a null rate is an em-dash, NEVER '0.0' (the log declining to report progress is not
//     the same fact as no progress);
//   • `levelEquiv` is "levels of progress", never "xp" — the log states a percentage of the
//     CURRENT level's bar and nothing else;
//   • a range whose experience lines stated no percentage SAYS SO, in a caption on the
//     number it explains;
//   • idle is labeled with the literal rule that produced it, and is called "idle" — never
//     "AFK", never "offline" (the log records events, not presence).
//
// Zone swatches come from `zoneBands.zoneColor`, the same function the chart strip uses, so a
// row and its band are always the same hue.

import { type JSX, useState } from 'react'
import {
  Box,
  Chip,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  Tooltip,
  Typography
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import SpeedIcon from '@mui/icons-material/Speed'
import WhatshotIcon from '@mui/icons-material/Whatshot'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import MilitaryTechIcon from '@mui/icons-material/MilitaryTech'
import type { RangeStats } from '@shared/progressionStats'
import { formatDateTime } from '../../lib/formatDate'
import { fmtDuration } from './levelChartGeometry'
import {
  AA_RESPEC_CAPTION,
  aaText,
  activeIdleText,
  comboInferred,
  comboText,
  idleGapsText,
  idleRuleCaption,
  rangeHeroes,
  unstatedCaption,
  witnessedText,
  zoneStatRows,
  type HeroStat,
  type ZoneSort,
  type ZoneStatRow
} from './rangeStatsRows'

export interface RangeStatsPanelProps {
  stats: RangeStats
  onClear: () => void
}

/** The leveling view's existing hero hues, reused rather than re-invented. */
const ACCENT: Record<HeroStat['id'], string> = {
  rate: '#5fbf72',
  kills: '#b07fd0',
  levels: '#d9b25f',
  range: '#6fb3d2'
}

const ICON: Record<HeroStat['id'], JSX.Element> = {
  rate: <SpeedIcon />,
  kills: <WhatshotIcon />,
  levels: <TrendingUpIcon />,
  range: <MilitaryTechIcon />
}

/**
 * The `HeroCard` idiom from LevelingView, at panel density (h5 rather than h4, tighter
 * padding): a colored left rule, the icon in the same hue, value / label / caption. It is a
 * local copy because `HeroCard` is private to LevelingView.tsx — see the report note; the
 * right fix is to lift that component into its own file and have both views import it.
 */
function StatCard({ stat }: { stat: HeroStat }): JSX.Element {
  const accent = ACCENT[stat.id]
  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.25, flex: 1, minWidth: 150, borderLeft: `3px solid ${accent}`, display: 'flex', gap: 1 }}
    >
      <Box sx={{ color: accent, display: 'flex', alignItems: 'center' }}>{ICON[stat.id]}</Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h5" sx={{ lineHeight: 1.1, color: accent }} noWrap>
          {stat.value}
        </Typography>
        <Typography variant="body2">{stat.label}</Typography>
        <Typography variant="caption" color="text.secondary" display="block">
          {stat.sub}
        </Typography>
      </Box>
    </Paper>
  )
}

const CHIP_SX = { height: 20 } as const

/**
 * The chip row: active/idle with the idle rule as its caption, the class combo, the witnessed
 * kills (dimmed — they are context, and they enter no rate), and the AA gained with the same
 * respec reservation the "AA gained over time" panel carries.
 */
function ChipRow({ stats }: { stats: RangeStats }): JSX.Element {
  const gaps = idleGapsText(stats)
  const witnessed = witnessedText(stats)
  const aa = aaText(stats)
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Tooltip title={gaps ?? ''} disableHoverListener={!gaps}>
          <Chip size="small" variant="outlined" label={activeIdleText(stats)} sx={CHIP_SX} />
        </Tooltip>
        <Chip size="small" variant="outlined" label={comboText(stats.combos)} sx={CHIP_SX} />
        {comboInferred(stats.combos) && <Chip size="small" variant="outlined" label="inferred" sx={CHIP_SX} />}
        {witnessed && (
          <Chip size="small" variant="outlined" label={witnessed} sx={{ ...CHIP_SX, opacity: 0.55 }} />
        )}
        {aa && (
          <Tooltip title={AA_RESPEC_CAPTION}>
            <Chip size="small" variant="outlined" label={aa} sx={CHIP_SX} />
          </Tooltip>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
        {idleRuleCaption(stats.idleThresholdMs)}
        {aa && ` · AA: ${AA_RESPEC_CAPTION}`}
      </Typography>
    </Box>
  )
}

const CELL_SX = { py: 0.35, fontSize: 12 } as const

function ZoneRow({ row }: { row: ZoneStatRow }): JSX.Element {
  return (
    <TableRow hover>
      <TableCell sx={{ ...CELL_SX, width: 18, pr: 0 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: row.color }} />
      </TableCell>
      <TableCell sx={CELL_SX}>
        <Typography variant="caption" noWrap title={row.zone}>
          {row.zone}
        </Typography>
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.time}
        <Box component="span" sx={{ opacity: 0.55 }}>
          {row.idle ? ` (${row.active} active)` : ''}
        </Box>
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.kills}
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.levels}
        {row.unstated > 0 && (
          <Box component="span" sx={{ opacity: 0.55 }} title="some experience lines here stated no percentage">
            {' *'}
          </Box>
        )}
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.levelsPerHour}
      </TableCell>
      <TableCell align="right" sx={CELL_SX}>
        {row.killsPerHour}
      </TableCell>
    </TableRow>
  )
}

const HEAD_SX = { ...CELL_SX, fontWeight: 700, whiteSpace: 'nowrap' } as const

/**
 * Per-zone rows, sorted by levels/hr (the farming-efficiency question) with a secondary
 * toggle onto time. Per the fixed-height-scroll-box law the table lives in a bounded box with
 * its OWN `overflow: auto` — a range over a long session can list every zone visited and must
 * never size to its content and squeeze the charts above it.
 */
function ZoneTable({ zones }: { zones: RangeStats['zones'] }): JSX.Element | null {
  const [sort, setSort] = useState<ZoneSort>('levels')
  const rows = zoneStatRows(zones, sort)
  if (rows.length === 0) return null
  const head = (key: ZoneSort, label: string): JSX.Element => (
    <TableSortLabel active={sort === key} direction="desc" onClick={() => { setSort(key) }}>
      {label}
    </TableSortLabel>
  )
  return (
    <Box sx={{ flexGrow: 1, minHeight: 0, maxHeight: 240, overflow: 'auto' }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell sx={{ ...HEAD_SX, width: 18, pr: 0 }} />
            <TableCell sx={HEAD_SX}>Zone</TableCell>
            <TableCell align="right" sx={HEAD_SX}>
              {head('time', 'Time')}
            </TableCell>
            <TableCell align="right" sx={HEAD_SX}>
              Kills
            </TableCell>
            <TableCell align="right" sx={HEAD_SX}>
              Levels
            </TableCell>
            <TableCell align="right" sx={HEAD_SX}>
              {head('levels', 'Levels/hr')}
            </TableCell>
            <TableCell align="right" sx={HEAD_SX}>
              Kills/hr
            </TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <ZoneRow key={r.key} row={r} />
          ))}
        </TableBody>
      </Table>
    </Box>
  )
}

function HeaderRow({ stats, onClear }: RangeStatsPanelProps): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {formatDateTime(stats.t0)} → {formatDateTime(stats.t1)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {fmtDuration(stats.durationMs)}
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
          sx={CHIP_SX}
        />
      )}
      <IconButton size="small" onClick={onClear} aria-label="Clear selection" sx={{ ml: 'auto' }}>
        <CloseIcon fontSize="small" />
      </IconButton>
    </Stack>
  )
}

export function RangeStatsPanel({ stats, onClear }: RangeStatsPanelProps): JSX.Element {
  const footnote = unstatedCaption(stats)
  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25, flexGrow: 1, minHeight: 0 }}
    >
      <HeaderRow stats={stats} onClear={onClear} />
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {rangeHeroes(stats).map((s) => (
          <StatCard key={s.id} stat={s} />
        ))}
      </Stack>
      <ChipRow stats={stats} />
      <ZoneTable zones={stats.zones} />
      {footnote && (
        <Typography variant="caption" color="text.secondary">
          {footnote}
        </Typography>
      )}
    </Paper>
  )
}
