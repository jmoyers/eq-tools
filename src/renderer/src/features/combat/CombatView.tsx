import { useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  FormControlLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import { LIVE, useCombat } from './useCombat'
import type { SegmentView, SourceView } from './engine'

const KIND_COLOR: Record<string, string> = { you: '#d9b25f', pet: '#6fb3d2', enemy: '#cf6679' }

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(Math.round(n))
}
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A Details-style scaled horizontal bar. */
function Bar({
  color,
  pct,
  rank,
  name,
  right,
  onClick,
  faded
}: {
  color: string
  pct: number
  rank?: number
  name: ReactNode
  right: string
  onClick?: () => void
  faded?: boolean
}): JSX.Element {
  return (
    <Box
      onClick={onClick}
      sx={{
        position: 'relative',
        height: 22,
        borderRadius: 0.5,
        mb: '3px',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        bgcolor: 'rgba(255,255,255,0.04)',
        opacity: faded ? 0.7 : 1
      }}
    >
      <Box sx={{ position: 'absolute', inset: 0, width: `${Math.max(2, pct)}%`, bgcolor: color, opacity: 0.5 }} />
      <Stack direction="row" alignItems="center" sx={{ position: 'absolute', inset: 0, px: 0.75 }} spacing={0.75}>
        {rank != null && (
          <Typography variant="caption" sx={{ color: 'text.secondary', width: 16, textAlign: 'right' }}>
            {rank}
          </Typography>
        )}
        <Typography variant="caption" noWrap sx={{ fontWeight: 600, flexGrow: 1 }}>
          {name}
        </Typography>
        <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}>
          {right}
        </Typography>
      </Stack>
    </Box>
  )
}

function EntityRow({ e, rank }: { e: SourceView; rank: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const crit = e.critPct >= 1 ? ` · ${Math.round(e.critPct)}% crit` : ''
  return (
    <Box>
      <Bar
        color={KIND_COLOR[e.kind] ?? '#888'}
        pct={e.pct}
        rank={rank}
        faded={e.kind === 'enemy'}
        onClick={e.skills.length ? () => setOpen((o) => !o) : undefined}
        name={
          <>
            {e.name}
            {e.kind === 'pet' && <Chip label="pet" size="small" sx={{ ml: 0.5, height: 14, fontSize: 9 }} />}
          </>
        }
        right={`${fmt(e.total)} · ${fmt(e.dps)}/s${crit}`}
      />
      <Collapse in={open}>
        <Box sx={{ pl: 3, pr: 0.5, py: 0.5 }}>
          {e.skills.map((s) => (
            <Bar
              key={s.name}
              color={KIND_COLOR[e.kind] ?? '#888'}
              pct={s.pct}
              name={s.name}
              right={`${fmt(s.total)} · ${s.hits} hits${s.crits ? ` · ${s.crits} crit` : ''} · max ${fmt(s.max)}`}
            />
          ))}
        </Box>
      </Collapse>
    </Box>
  )
}

function SegmentBody({ seg, mode }: { seg: SegmentView; mode: 'out' | 'in' }): JSX.Element {
  const rows = mode === 'out' ? seg.entities : seg.incoming
  const total = mode === 'out' ? seg.outTotal : seg.inTotal
  const dps = mode === 'out' ? seg.outDps : seg.inDps
  return (
    <Paper variant="outlined" sx={{ p: 1.5, flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1 }}>
        <Typography variant="subtitle1" noWrap>
          {seg.name}
          {seg.active && (
            <CircleIcon sx={{ fontSize: 10, color: 'success.main', ml: 1, verticalAlign: 'middle' }} />
          )}
        </Typography>
        <Typography variant="body2" sx={{ color: mode === 'out' ? 'primary.main' : KIND_COLOR.enemy }}>
          {fmt(dps)}/s <Typography component="span" variant="caption" color="text.secondary">· {fmt(total)} · {fmtDur(seg.durationSec)}</Typography>
        </Typography>
      </Stack>
      <Box sx={{ overflow: 'auto', flexGrow: 1 }}>
        {rows.length ? (
          rows.map((e, i) => <EntityRow key={e.id} e={e} rank={i + 1} />)
        ) : (
          <Typography variant="caption" color="text.secondary">
            {mode === 'out' ? 'No outgoing damage in this segment.' : 'No incoming damage in this segment.'}
          </Typography>
        )}
      </Box>
    </Paper>
  )
}

export default function CombatView(): JSX.Element {
  const { snap, combinePets, setCombinePets, selection, setSelection, reset } = useCombat()
  const [mode, setMode] = useState<'out' | 'in'>('out')

  const history = (snap?.segments ?? []).filter((s) => s.kind === 'fight')
  const zone = (snap?.segments ?? []).find((s) => s.kind === 'zone')

  return (
    <Stack spacing={1.5} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Select size="small" value={selection} onChange={(e) => setSelection(e.target.value)} sx={{ minWidth: 260 }}>
          <MenuItem value={LIVE}>▶ Current fight (live)</MenuItem>
          {zone && <MenuItem value="zone">◆ {zone.name} · {fmtDur(zone.durationSec)}</MenuItem>}
          {history.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.name} · {fmtDur(s.durationSec)} · {fmt(s.dps)}/s
            </MenuItem>
          ))}
        </Select>
        <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_e, v) => v && setMode(v)}>
          <ToggleButton value="out">Outgoing</ToggleButton>
          <ToggleButton value="in">Incoming</ToggleButton>
        </ToggleButtonGroup>
        <FormControlLabel
          control={<Switch size="small" checked={combinePets} onChange={(e) => setCombinePets(e.target.checked)} />}
          label="Combine pets"
        />
        <Box sx={{ flexGrow: 1 }} />
        {snap?.inCombat && (
          <Chip
            size="small"
            icon={<CircleIcon sx={{ fontSize: 10, color: 'success.main' }} />}
            label="in combat"
            variant="outlined"
          />
        )}
        <Button size="small" startIcon={<RestartAltIcon />} onClick={reset}>
          Reset
        </Button>
      </Stack>

      {snap?.selected ? (
        <SegmentBody seg={snap.selected} mode={mode} />
      ) : (
        <Typography color="text.secondary" sx={{ p: 2 }}>
          No combat yet — engage something and it&apos;ll appear here live.
        </Typography>
      )}

      <Alert severity="info" sx={{ py: 0 }}>
        Encounters start when you or your pets deal/take damage and end after ~10s idle (staggered adds join the same
        fight). DPS = damage ÷ (last − first hit), so it freezes when a fight ends. Overall resets when you zone. Click a
        row to see its skill breakdown. Combat history + timelines expand from here.
      </Alert>
    </Stack>
  )
}
