import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
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
  Tooltip,
  Typography
} from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import PetsIcon from '@mui/icons-material/Pets'
import { LIVE, useCombat } from './useCombat'
import { formatTime } from '../../lib/formatDate'
import type { ClassifiedLine, SegmentView, SourceView } from '@shared/combat'

const KIND_COLOR: Record<string, string> = { you: '#d9b25f', pet: '#6fb3d2', enemy: '#cf6679' }
const ROLE_COLOR: Record<string, string> = {
  you: '#d9b25f',
  pet: '#6fb3d2',
  enemy: '#cf6679',
  info: '#9aa0aa',
  dropped: '#e0554f'
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(Math.round(n))
}
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function fmtClock(ts: number): string {
  return formatTime(ts)
}

function Bar({
  color,
  pct,
  rank,
  name,
  right,
  onClick
}: {
  color: string
  pct: number
  rank?: number
  name: ReactNode
  right: string
  onClick?: () => void
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
        bgcolor: 'rgba(255,255,255,0.04)'
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

function missSummary(m: SourceView['missBreakdown']): string {
  const parts: string[] = []
  if (m.miss) parts.push(`${m.miss} miss`)
  if (m.dodge) parts.push(`${m.dodge} dodge`)
  if (m.parry) parts.push(`${m.parry} parry`)
  if (m.riposte) parts.push(`${m.riposte} riposte`)
  if (m.block) parts.push(`${m.block} block`)
  if (m.absorb) parts.push(`${m.absorb} absorb`)
  return parts.join(' · ') || 'none'
}

const EntityRow = memo(function EntityRow({ e, rank }: { e: SourceView; rank: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const crit = e.critPct >= 1 ? ` · ${Math.round(e.critPct)}% crit` : ''
  // hit% only meaningful when swings were avoided (melee sources); hide at 100%.
  const swings = e.hits + e.misses
  const hitBadge =
    e.misses > 0 ? (
      <Tooltip title={`${e.hits} landed / ${swings} swings — avoided: ${missSummary(e.missBreakdown)}`}>
        <Typography component="span" variant="caption" sx={{ ml: 0.5, color: 'text.secondary' }}>
          {Math.round(e.hitPct)}% hit
        </Typography>
      </Tooltip>
    ) : null
  return (
    <Box>
      <Bar
        color={KIND_COLOR[e.kind] ?? '#888'}
        pct={e.pct}
        rank={rank}
        onClick={e.skills.length ? () => setOpen((o) => !o) : undefined}
        name={
          <>
            {e.name}
            {e.kind === 'pet' && <Chip label="pet" size="small" sx={{ ml: 0.5, height: 14, fontSize: 9 }} />}
            {e.kind === 'pet' && e.ambiguousHits > 0 && (
              <Tooltip
                title={`${e.ambiguousHits} hit${e.ambiguousHits === 1 ? '' : 's'} (${fmt(
                  e.ambiguousTotal
                )} dmg) are name-ambiguous: a same-named hostile twin exists, so this damage could belong to the twin rather than your pet.`}
              >
                <Chip
                  label="~"
                  size="small"
                  sx={{ ml: 0.5, height: 14, fontSize: 10, fontWeight: 700, bgcolor: 'rgba(207,102,121,0.25)' }}
                />
              </Tooltip>
            )}
            {hitBadge}
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
              right={`${fmt(s.total)} · ${s.hits} hits${
                s.misses ? ` · ${Math.round((s.hits / (s.hits + s.misses)) * 100)}% hit` : ''
              }${s.crits ? ` · ${s.crits} crit` : ''} · max ${fmt(s.max)}`}
            />
          ))}
        </Box>
      </Collapse>
    </Box>
  )
},
// Value-equality gate: a fresh snapshot rebuilds every SourceView object each
// tick (new references) even when the underlying data is unchanged — which is
// ALWAYS the case for a selected finalized fight (its aggregate is frozen). A
// reference-only memo would never skip; comparing the rendered fields by value
// lets those rows skip re-render, so only the genuinely-changing live/current
// rows re-render per tick. The SourceView is small, so this compare is cheap.
sourceViewEqual)

function sourceViewEqual(
  prev: { e: SourceView; rank: number },
  next: { e: SourceView; rank: number }
): boolean {
  return prev.rank === next.rank && JSON.stringify(prev.e) === JSON.stringify(next.e)
}

function IncomingHeals({ seg }: { seg: SegmentView }): JSX.Element | null {
  if (seg.incomingHealTotal <= 0) return null
  const top = seg.incomingHealers.slice(0, 4)
  return (
    <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
      <Typography variant="caption" sx={{ color: '#5fbf7f', fontWeight: 600 }}>
        Heals received: {fmt(seg.incomingHealTotal)}
      </Typography>
      {top.map((h) => (
        <Typography key={h.name} variant="caption" sx={{ display: 'block', color: 'text.secondary', pl: 1 }}>
          {h.name} · {fmt(h.total)} ({h.count})
        </Typography>
      ))}
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
          {seg.active && <CircleIcon sx={{ fontSize: 10, color: 'success.main', ml: 1, verticalAlign: 'middle' }} />}
        </Typography>
        <Typography variant="body2" sx={{ color: mode === 'out' ? 'primary.main' : KIND_COLOR.enemy }}>
          {fmt(dps)}/s{' '}
          {mode === 'out' && seg.activeSec > 0 && seg.activeSec < seg.durationSec && (
            <Tooltip
              title={`Active-time DPS: damage ÷ ${fmtDur(
                seg.activeSec
              )} of actual combat time (gaps between hits capped at 3s each). Wall-clock DPS (${fmt(
                seg.outDps
              )}/s) divides by the full ${fmtDur(seg.durationSec)} fight length.`}
            >
              <Typography component="span" variant="caption" sx={{ color: 'text.secondary', mr: 0.25 }}>
                (act {fmt(seg.activeDps)}/s)
              </Typography>
            </Tooltip>
          )}
          <Typography component="span" variant="caption" color="text.secondary">
            · {fmt(total)} · {fmtDur(seg.durationSec)}
            {mode === 'out' && seg.enemyHealTotal > 0 && (
              <Tooltip
                title={`Enemies healed for ${fmt(
                  seg.enemyHealTotal
                )} during this fight — that much of your damage was undone (effective DPS is lower).`}
              >
                <Typography component="span" variant="caption" sx={{ color: '#5fbf7f', ml: 0.5 }}>
                  · +{fmt(seg.enemyHealTotal)} enemy heal
                </Typography>
              </Tooltip>
            )}
          </Typography>
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
        {mode === 'in' && <IncomingHeals seg={seg} />}
      </Box>
    </Paper>
  )
}

// One classification-ring line. Memoized by value so that on each tick only the
// newly-appended lines mount — the ~150 stable prior lines skip re-render.
const LogLine = memo(
  function LogLine({ l }: { l: ClassifiedLine }): JSX.Element {
    return (
      <Box sx={{ display: 'flex', gap: 1, color: ROLE_COLOR[l.role] ?? 'text.primary', lineHeight: 1.5 }}>
        <span style={{ color: 'var(--mui-palette-text-disabled)', opacity: 0.7 }}>{fmtClock(l.ts)}</span>
        <span style={{ minWidth: 62, opacity: 0.8 }}>{l.cat}</span>
        <span style={{ whiteSpace: 'pre-wrap' }}>{l.text}</span>
      </Box>
    )
  },
  (p, n) => p.l.ts === n.l.ts && p.l.cat === n.l.cat && p.l.role === n.l.role && p.l.text === n.l.text
)

function ProcessingLog({
  lines,
  showUnparsed,
  setShowUnparsed
}: {
  lines: ClassifiedLine[]
  showUnparsed: boolean
  setShowUnparsed: (v: boolean) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <Paper variant="outlined" sx={{ p: 1, height: 190, display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          Combat log
        </Typography>
        <FormControlLabel
          control={<Switch size="small" checked={showUnparsed} onChange={(e) => setShowUnparsed(e.target.checked)} />}
          label={<Typography variant="caption">show unparsed</Typography>}
          sx={{ m: 0 }}
        />
      </Stack>
      <Box
        ref={ref}
        sx={{ overflow: 'auto', flexGrow: 1, fontFamily: '"Consolas","Courier New",monospace', fontSize: 11 }}
      >
        {lines.length === 0 && (
          <Typography variant="caption" color="text.disabled">
            Waiting for combat…
          </Typography>
        )}
        {lines.map((l, i) => (
          <LogLine key={`${l.ts}|${l.cat}|${i}`} l={l} />
        ))}
      </Box>
    </Paper>
  )
}

export default function CombatView(): JSX.Element {
  const { snap, combinePets, setCombinePets, showUnparsed, setShowUnparsed, selection, setSelection, maxSegments, loadMore } =
    useCombat()
  const [mode, setMode] = useState<'out' | 'in'>('out')

  const history = (snap?.segments ?? []).filter((s) => s.kind === 'fight')
  const zone = (snap?.segments ?? []).find((s) => s.kind === 'zone')
  // The segment payload is capped at `maxSegments` finalized fights (newest-first).
  // Offer a "Load more" when the cap is likely truncating history.
  const capped = history.length >= maxSegments

  return (
    <Stack spacing={1.5} sx={{ height: '100%' }}>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Select
          size="small"
          value={selection}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__loadmore__') loadMore()
            else setSelection(v)
          }}
          sx={{ minWidth: 240 }}
        >
          <MenuItem value={LIVE}>▶ Current fight (live)</MenuItem>
          {zone && (
            <MenuItem value="zone">
              ◆ {zone.name} · {fmtDur(zone.durationSec)}
            </MenuItem>
          )}
          {history.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.name} · {fmtDur(s.durationSec)} · {fmt(s.dps)}/s
              {s.activeSec > 0 && s.activeSec < s.durationSec && (
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.5 }}>
                  (act {fmt(s.activeDps)}/s)
                </Typography>
              )}
            </MenuItem>
          ))}
          {capped && (
            <MenuItem value="__loadmore__" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
              Load more fights…
            </MenuItem>
          )}
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
        {snap && snap.charmed.length > 0 && (
          <Tooltip title={`Charmed pets: ${snap.charmed.join(', ')}`}>
            <Chip
              size="small"
              icon={<PetsIcon sx={{ fontSize: 14 }} />}
              label={`${snap.charmed.length} charmed`}
              variant="outlined"
              sx={{ color: KIND_COLOR.pet, borderColor: KIND_COLOR.pet }}
            />
          </Tooltip>
        )}
        {snap?.inCombat && (
          <Chip
            size="small"
            icon={<CircleIcon sx={{ fontSize: 10, color: 'success.main' }} />}
            label="in combat"
            variant="outlined"
          />
        )}
      </Stack>

      {snap?.selected ? (
        <SegmentBody seg={snap.selected} mode={mode} />
      ) : (
        <Paper variant="outlined" sx={{ p: 2, flexGrow: 1 }}>
          <Typography color="text.secondary">No combat yet — engage something and it&apos;ll appear here live.</Typography>
        </Paper>
      )}

      <ProcessingLog lines={snap?.recent ?? []} showUnparsed={showUnparsed} setShowUnparsed={setShowUnparsed} />

      <Alert severity="info" sx={{ py: 0 }}>
        <strong>act</strong> is active-time DPS — damage per second of actual combat time, excluding idle gaps.
      </Alert>
    </Stack>
  )
}
