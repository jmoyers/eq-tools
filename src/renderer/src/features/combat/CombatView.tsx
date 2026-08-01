import { useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import { useCombat } from './useCombat'
import type { EntitySnap, ScopeSnap } from './engine'

const KIND_COLOR: Record<string, string> = { you: '#d9b25f', pet: '#6fb3d2', other: '#6b6b6b' }
const IN_COLOR = '#cf6679'

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(Math.round(n))
}
function fmtDps(n: number): string {
  return fmt(n) + '/s'
}
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Bar({
  color,
  pct,
  left,
  right,
  onClick,
  faded
}: {
  color: string
  pct: number
  left: ReactNode
  right: string
  onClick?: () => void
  faded?: boolean
}): JSX.Element {
  return (
    <Box
      onClick={onClick}
      sx={{
        position: 'relative',
        height: 24,
        borderRadius: 0.5,
        mb: 0.5,
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        bgcolor: 'action.hover',
        opacity: faded ? 0.7 : 1
      }}
    >
      <Box sx={{ position: 'absolute', inset: 0, width: `${pct}%`, bgcolor: color, opacity: 0.55 }} />
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        sx={{ position: 'absolute', inset: 0, px: 1 }}
      >
        <Typography variant="caption" noWrap sx={{ fontWeight: 600 }}>
          {left}
        </Typography>
        <Typography variant="caption" sx={{ whiteSpace: 'nowrap', ml: 1 }}>
          {right}
        </Typography>
      </Stack>
    </Box>
  )
}

function EntityRow({ e }: { e: EntitySnap }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Box>
      <Bar
        color={KIND_COLOR[e.kind]}
        pct={e.pct}
        faded={e.kind === 'other'}
        onClick={e.abilities.length ? () => setOpen((o) => !o) : undefined}
        left={
          <>
            {e.name}
            {e.kind === 'pet' && <Chip label="pet" size="small" sx={{ ml: 0.5, height: 14, fontSize: 9 }} />}
            {e.kind === 'other' && (
              <Chip label="unverified" size="small" variant="outlined" sx={{ ml: 0.5, height: 14, fontSize: 9 }} />
            )}
          </>
        }
        right={`${fmtDps(e.dps)} · ${fmt(e.total)}`}
      />
      <Collapse in={open}>
        <Box sx={{ pl: 1, pb: 0.5 }}>
          {e.abilities.map((a) => (
            <Stack key={a.name} direction="row" justifyContent="space-between">
              <Typography variant="caption" color="text.secondary" noWrap>
                {a.name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {fmt(a.total)}
              </Typography>
            </Stack>
          ))}
        </Box>
      </Collapse>
    </Box>
  )
}

function ScopePanel({
  title,
  subtitle,
  scope,
  mode
}: {
  title: ReactNode
  subtitle: string
  scope: ScopeSnap
  mode: 'out' | 'in'
}): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1 }}>
        <Typography variant="subtitle2">{title}</Typography>
        <Typography variant="caption" color="text.secondary">
          {subtitle}
        </Typography>
      </Stack>
      <Typography variant="h5" sx={{ color: mode === 'out' ? 'primary.main' : IN_COLOR, mb: 1 }}>
        {fmtDps(mode === 'out' ? scope.dps : scope.incomingTotal / scope.durationSec)}
        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
          {mode === 'out' ? `${fmt(scope.total)} dmg` : `${fmt(scope.incomingTotal)} taken`} · {fmtDur(scope.durationSec)}
        </Typography>
      </Typography>
      <Box sx={{ overflow: 'auto' }}>
        {mode === 'out' ? (
          scope.entities.length ? (
            scope.entities.map((e) => <EntityRow key={e.id} e={e} />)
          ) : (
            <Typography variant="caption" color="text.secondary">
              No damage yet.
            </Typography>
          )
        ) : scope.incoming.length ? (
          scope.incoming.map((s) => (
            <Bar
              key={s.name}
              color={IN_COLOR}
              pct={s.pct}
              left={s.name}
              right={`${fmtDps(s.dps)} · ${fmt(s.total)}`}
            />
          ))
        ) : (
          <Typography variant="caption" color="text.secondary">
            No incoming damage.
          </Typography>
        )}
      </Box>
    </Paper>
  )
}

export default function CombatView(): JSX.Element {
  const { snap, combinePets, setCombinePets, showOthers, setShowOthers, reset } = useCombat()
  const [mode, setMode] = useState<'out' | 'in'>('out')

  return (
    <Stack spacing={1.5} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
        <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_e, v) => v && setMode(v)}>
          <ToggleButton value="out">Outgoing</ToggleButton>
          <ToggleButton value="in">Incoming</ToggleButton>
        </ToggleButtonGroup>
        <FormControlLabel
          control={<Switch checked={combinePets} onChange={(e) => setCombinePets(e.target.checked)} />}
          label="Combine pets"
        />
        <FormControlLabel
          control={<Switch checked={showOthers} onChange={(e) => setShowOthers(e.target.checked)} />}
          label="Show others"
        />
        <Box sx={{ flexGrow: 1 }} />
        {snap?.fight.active && (
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

      {snap && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ flexGrow: 1, minHeight: 0 }}>
          <ScopePanel
            title={
              <>
                Current fight
                {snap.fight.target && (
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    vs {snap.fight.target}
                  </Typography>
                )}
              </>
            }
            subtitle={snap.fight.active ? 'live' : 'ended'}
            scope={snap.fight}
            mode={mode}
          />
          <ScopePanel title="Overall (session)" subtitle="all fights" scope={snap.overall} mode={mode} />
        </Stack>
      )}

      <Alert severity="info" sx={{ py: 0 }}>
        You and your charmed pets are tracked accurately via charm windows. Other names are shown as{' '}
        <strong>unverified</strong> (toggle above) — the log names actors without ids, so other players&apos; pets and
        charms can&apos;t be attributed. Combat history + timelines come next.
      </Alert>
    </Stack>
  )
}
