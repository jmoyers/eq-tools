import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Box,
  Breadcrumbs,
  Button,
  Chip,
  Collapse,
  FormControlLabel,
  Link,
  ListSubheader,
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
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CircleIcon from '@mui/icons-material/Circle'
import PetsIcon from '@mui/icons-material/Pets'
import { LIVE, useCombat } from './useCombat'
import { CombatTimeline } from './CombatTimeline'
import { formatDate, formatTime } from '../../lib/formatDate'
import { formatNum as fmt, formatRate } from '../../lib/formatRate'
import type { CategoryView, ClassifiedLine, DamageCategory, SegmentView, SourceView } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'

const KIND_COLOR: Record<string, string> = { you: '#d9b25f', pet: '#6fb3d2', enemy: '#cf6679' }
const ROLE_COLOR: Record<string, string> = {
  you: '#d9b25f',
  pet: '#6fb3d2',
  enemy: '#cf6679',
  info: '#9aa0aa',
  dropped: '#e0554f'
}

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function fmtClock(ts: number): string {
  return formatTime(ts)
}

/**
 * Coarse, live-updating relative age for the fight/zone selector rows (Task #54
 * disambiguation timing): 'just now' / '2m ago' / '3h ago' / '2d ago'. Kept intentionally
 * coarse so five same-named giant pulls are tellable apart by start clock + age + duration.
 */
function relativeAge(ts: number, now: number): string {
  if (!ts) return ''
  const secs = Math.max(0, (now - ts) / 1000)
  if (secs < 45) return 'just now'
  const mins = secs / 60
  if (mins < 60) return `${Math.round(mins)}m ago`
  const hrs = mins / 60
  if (hrs < 36) return `${Math.round(hrs)}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** The disambiguation timing suffix for a selector row: 'start clock · age · duration'. */
function timingLabel(startTs: number, durationSec: number, now: number): string {
  const bits: string[] = []
  if (startTs) bits.push(`${formatDate(startTs)} ${formatTime(startTs)}`)
  const age = relativeAge(startTs, now)
  if (age) bits.push(age)
  bits.push(fmtDur(durationSec))
  return bits.join(' · ')
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

const EntityRow = memo(function EntityRow({
  e,
  rank,
  onDrill
}: {
  e: SourceView
  rank: number
  onDrill?: () => void
}): JSX.Element {
  // Fallback inline expand (level-3 skills) for the incoming view, which has no
  // drill-down; the outgoing view uses onDrill (category breakdown) instead.
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
  // Spell-resist rate badge (Task #51 v2) — resists / (spell+dot casts + resists).
  const resistBadge =
    e.resists > 0 ? (
      <Tooltip title={`${e.resists} of your detrimental spells were resisted — ${Math.round(e.resistPct)}% resist rate (resists ÷ spell casts).`}>
        <Typography component="span" variant="caption" sx={{ ml: 0.5, color: RESIST_COLOR }}>
          {Math.round(e.resistPct)}% resist
        </Typography>
      </Tooltip>
    ) : null
  const onClick = onDrill ?? (e.skills.length ? () => setOpen((o) => !o) : undefined)
  return (
    <Box>
      <Bar
        color={KIND_COLOR[e.kind] ?? '#888'}
        pct={e.pct}
        rank={rank}
        onClick={onClick}
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
            {resistBadge}
          </>
        }
        right={`${fmt(e.total)} · ${formatRate(e.dps)}${crit}`}
      />
      {!onDrill && (
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
      )}
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
  prev: { e: SourceView; rank: number; onDrill?: () => void },
  next: { e: SourceView; rank: number; onDrill?: () => void }
): boolean {
  return prev.rank === next.rank && !!prev.onDrill === !!next.onDrill && JSON.stringify(prev.e) === JSON.stringify(next.e)
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

// Category bar colors for the drill-down level-2/level-3 views.
const CAT_COLOR: Record<DamageCategory, string> = {
  melee: '#d9b25f',
  slay: '#e8d48a',
  spell: '#a98fe0',
  dot: '#6fb3d2',
  ds: '#cf6679'
}
// Red-tint for resist/miss rate badges (matches the timeline's hollow marks).
const RESIST_COLOR = '#e05663'

// Drill-down selection: undefined = level 1 (entities); {entityId} = level 2
// (category breakdown); {entityId, category} = level 3 (per-skill/spell). Selection is
// renderer-side; data comes from the snapshot's SourceView.categories (extended in the
// engine). Esc / Back / breadcrumb ascend a level.
interface Drill {
  entityId: string
  category?: DamageCategory
}

/** Level-3: per-skill/spell bars within a chosen category (hits/crits/max/resist). */
function CategorySkillBars({ cat }: { cat: CategoryView }): JSX.Element {
  const color = CAT_COLOR[cat.category]
  return (
    <Box>
      {cat.skills.map((s) => {
        const resists = s.resists ?? 0
        const casts = s.hits + resists
        // A spell/dot lane can carry resists (Task #51 v2). Show a resist-rate badge and,
        // for a lane that only ever resisted (0 hits), a resist-only right-hand summary.
        return (
          <Bar
            key={s.name}
            color={color}
            pct={s.pct}
            name={
              <>
                {s.name}
                {resists > 0 && (
                  <Tooltip title={`${resists} resisted of ${casts} cast${casts === 1 ? '' : 's'} — ${Math.round((s.hits / casts) * 100)}% landed`}>
                    <Typography component="span" variant="caption" sx={{ ml: 0.5, color: RESIST_COLOR }}>
                      {Math.round((resists / casts) * 100)}% resist
                    </Typography>
                  </Tooltip>
                )}
              </>
            }
            right={
              s.hits > 0
                ? `${fmt(s.total)} · ${s.hits} hits${s.crits ? ` · ${s.crits} crit` : ''} · max ${fmt(s.max)}`
                : `${resists} resisted · 0 landed`
            }
          />
        )
      })}
    </Box>
  )
}

/** Level-2: category breakdown bars for one entity; clicking a bar drills to level 3. */
function EntityCategoryBars({
  e,
  onPick
}: {
  e: SourceView
  onPick: (cat: DamageCategory) => void
}): JSX.Element {
  const rounds = e.rounds
  return (
    <Box>
      {e.categories.map((c) => (
        <Bar
          key={c.category}
          color={CAT_COLOR[c.category]}
          pct={c.pct}
          onClick={() => onPick(c.category)}
          name={
            <>
              {CATEGORY_LABEL[c.category]}
              {c.critPct >= 1 && (
                <Typography component="span" variant="caption" sx={{ ml: 0.5, color: 'text.secondary' }}>
                  {Math.round(c.critPct)}% crit
                </Typography>
              )}
              {c.resists > 0 && (
                <Tooltip title={`${c.resists} resisted of ${c.hits + c.resists} casts — ${Math.round(c.resistPct)}% resisted`}>
                  <Typography component="span" variant="caption" sx={{ ml: 0.5, color: RESIST_COLOR }}>
                    {Math.round(c.resistPct)}% resist
                  </Typography>
                </Tooltip>
              )}
            </>
          }
          right={`${fmt(c.total)} · ${c.hits} hits · max ${fmt(c.max)}`}
        />
      ))}
      {rounds && (rounds.multiHitRounds > 0 || rounds.maxHitsInRound > 1) && (
        <Tooltip
          title={`Heuristic: EQ never logs double/triple attack, so a "round" here is same-second, same-skill melee/slay hits — a cluster proxy, not a certainty. Main-hand vs off-hand is not distinguishable. Distribution (hits→rounds): ${rounds.histogram
            .map((n, i) => `${i + 1}:${n}`)
            .join('  ')}`}
        >
          <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary">
              Melee rounds: {rounds.totalRounds} · avg {rounds.avgHitsPerRound.toFixed(2)} hits/round · {rounds.multiHitRounds} multi-hit · up to{' '}
              {rounds.maxHitsInRound}/round
            </Typography>
          </Box>
        </Tooltip>
      )}
    </Box>
  )
}

function SegmentBody({
  seg,
  mode,
  drill,
  setDrill
}: {
  seg: SegmentView
  mode: 'out' | 'in'
  drill: Drill | null
  setDrill: (d: Drill | null) => void
}): JSX.Element {
  const rows = mode === 'out' ? seg.entities : seg.incoming
  const total = mode === 'out' ? seg.outTotal : seg.inTotal
  const dps = mode === 'out' ? seg.outDps : seg.inDps

  const drilledEntity = drill ? rows.find((r) => r.id === drill.entityId) : undefined
  const drilledCat =
    drilledEntity && drill?.category ? drilledEntity.categories.find((c) => c.category === drill.category) : undefined
  // If a stale drill points at an entity/category no longer present (fight changed),
  // fall back to level 1 by treating the drill as null for rendering.
  const effectiveDrill = drilledEntity ? drill : null

  return (
    <Paper variant="outlined" sx={{ p: 1.5, flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1 }}>
        <Typography variant="subtitle1" noWrap>
          {seg.name}
          {seg.active && <CircleIcon sx={{ fontSize: 10, color: 'success.main', ml: 1, verticalAlign: 'middle' }} />}
        </Typography>
        <Typography variant="body2" sx={{ color: mode === 'out' ? 'primary.main' : KIND_COLOR.enemy }}>
          {formatRate(dps)}{' '}
          {mode === 'out' && seg.activeSec > 0 && seg.activeSec < seg.durationSec && (
            <Tooltip
              title={`Active-time DPS: damage ÷ ${fmtDur(
                seg.activeSec
              )} of actual combat time (gaps between hits capped at 3s each). Wall-clock DPS (${formatRate(
                seg.outDps
              )}) divides by the full ${fmtDur(seg.durationSec)} fight length.`}
            >
              <Typography component="span" variant="caption" sx={{ color: 'text.secondary', mr: 0.25 }}>
                (act {formatRate(seg.activeDps)})
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

      {/* Drill-down breadcrumb + Back (levels 2/3). Level 1 shows no breadcrumb. */}
      {effectiveDrill && drilledEntity && (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
          <Button
            size="small"
            startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />}
            onClick={() =>
              setDrill(effectiveDrill.category ? { entityId: effectiveDrill.entityId } : null)
            }
            sx={{ minWidth: 0, py: 0 }}
          >
            Back
          </Button>
          <Breadcrumbs separator="›" sx={{ fontSize: 12 }}>
            <Link component="button" underline="hover" color="inherit" onClick={() => setDrill(null)} sx={{ fontSize: 12 }}>
              All
            </Link>
            <Link
              component="button"
              underline="hover"
              color={effectiveDrill.category ? 'inherit' : 'text.primary'}
              onClick={() => setDrill({ entityId: effectiveDrill.entityId })}
              sx={{ fontSize: 12 }}
            >
              {drilledEntity.name}
            </Link>
            {effectiveDrill.category && (
              <Typography variant="caption" color="text.primary">
                {CATEGORY_LABEL[effectiveDrill.category]}
              </Typography>
            )}
          </Breadcrumbs>
        </Stack>
      )}

      <Box sx={{ overflow: 'auto', flexGrow: 1 }}>
        {!effectiveDrill &&
          (rows.length ? (
            rows.map((e, i) => (
              <EntityRow
                key={e.id}
                e={e}
                rank={i + 1}
                onDrill={mode === 'out' ? () => setDrill({ entityId: e.id }) : undefined}
              />
            ))
          ) : (
            <Typography variant="caption" color="text.secondary">
              {mode === 'out' ? 'No outgoing damage in this segment.' : 'No incoming damage in this segment.'}
            </Typography>
          ))}

        {effectiveDrill && drilledEntity && !effectiveDrill.category && (
          <EntityCategoryBars e={drilledEntity} onPick={(cat) => setDrill({ entityId: drilledEntity.id, category: cat })} />
        )}
        {effectiveDrill && drilledCat && <CategorySkillBars cat={drilledCat} />}

        {mode === 'in' && !effectiveDrill && <IncomingHeals seg={seg} />}
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

/**
 * A dense selector row (Task #54): fight/zone name + rate on the top line, disambiguation
 * timing (start clock · relative age · duration) on a small second line — so five same-named
 * giant pulls are tellable apart at a glance.
 */
function SelectorRow({ name, rate, timing }: { name: string; rate: string; timing: string }): JSX.Element {
  return (
    <Box sx={{ minWidth: 0, py: 0.25 }}>
      <Stack direction="row" spacing={0.75} alignItems="baseline">
        <Typography variant="body2" noWrap sx={{ fontWeight: 600, flexGrow: 1, minWidth: 0 }}>
          {name}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
          {rate}
        </Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', opacity: 0.85 }}>
        {timing}
      </Typography>
    </Box>
  )
}

/** Two chips near the header showing the current stance + invocation (Task #51). */
function StanceChips({ stance }: { stance: NonNullable<CombatSnapshotStance> }): JSX.Element | null {
  if (!stance.stance && !stance.invocation) return null
  return (
    <>
      {stance.stance && (
        <Tooltip title="Current combat stance (melee/general modifier)">
          <Chip
            size="small"
            label={`stance: ${stance.stance}`}
            variant="outlined"
            sx={{ color: '#d9b25f', borderColor: 'rgba(217,178,95,0.5)', textTransform: 'capitalize' }}
          />
        </Tooltip>
      )}
      {stance.invocation && (
        <Tooltip title="Current invocation (caster modifier)">
          <Chip
            size="small"
            label={`inv: ${stance.invocation}`}
            variant="outlined"
            sx={{ color: '#a98fe0', borderColor: 'rgba(169,143,224,0.5)', textTransform: 'capitalize' }}
          />
        </Tooltip>
      )}
    </>
  )
}
type CombatSnapshotStance = NonNullable<ReturnType<typeof useCombat>['snap']>['stance']

export default function CombatView(): JSX.Element {
  const {
    snap,
    combinePets,
    setCombinePets,
    showUnparsed,
    setShowUnparsed,
    selection,
    setSelection,
    maxSegments,
    loadMore,
    wantTimeline,
    setWantTimeline
  } = useCombat()
  const [mode, setMode] = useState<'out' | 'in'>('out')
  const [view, setView] = useState<'bars' | 'timeline'>('bars')
  const [drill, setDrill] = useState<Drill | null>(null)

  // Esc ascends one drill level (level3→level2→level1), matching Back/breadcrumb.
  useEffect(() => {
    if (view !== 'bars') return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !drill) return
      setDrill(drill.category ? { entityId: drill.entityId } : null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, drill])

  // Reset the drill when the selected fight / mode changes (a drill is per-fight).
  useEffect(() => setDrill(null), [selection, mode])
  // Fetch the timeline payload only while the Timeline view is active.
  useEffect(() => setWantTimeline(view === 'timeline'), [view, setWantTimeline])

  const history = (snap?.segments ?? []).filter((s) => s.kind === 'fight')
  const zoneSessions = snap?.zoneSessions ?? []
  // The segment payload is capped at `maxSegments` finalized fights (newest-first).
  // Offer a "Load more" when the cap is likely truncating history.
  const capped = history.length >= maxSegments
  // A single `now` for the whole render so all the relative-age labels agree; it advances
  // each snapshot tick (~1s idle, sub-second live) so ages stay live-updating and coarse.
  const now = Date.now()

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
          sx={{ minWidth: 320 }}
          MenuProps={{ PaperProps: { sx: { maxHeight: 480 } } }}
        >
          <MenuItem value={LIVE}>▶ Current fight (live)</MenuItem>
          <ListSubheader sx={{ lineHeight: '28px' }}>Fights</ListSubheader>
          {history.length === 0 && (
            <MenuItem value="__none__" disabled>
              No finalized fights yet
            </MenuItem>
          )}
          {history.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              <SelectorRow
                name={s.name}
                rate={formatRate(s.dps)}
                timing={timingLabel(s.startTs, s.durationSec, now)}
              />
            </MenuItem>
          ))}
          {capped && (
            <MenuItem value="__loadmore__" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
              Load more fights…
            </MenuItem>
          )}
          <ListSubheader sx={{ lineHeight: '28px' }}>Zone sessions</ListSubheader>
          {zoneSessions.map((z) => (
            <MenuItem key={z.id} value={z.id}>
              <SelectorRow
                name={`${z.live ? '◆ ' : ''}${z.zone} — overall`}
                rate={formatRate(z.dps)}
                timing={
                  z.live
                    ? 'live'
                    : timingLabel(z.startTs, Math.max(1, (z.endTs - z.startTs) / 1000), now)
                }
              />
            </MenuItem>
          ))}
        </Select>
        <ToggleButtonGroup size="small" exclusive value={view} onChange={(_e, v) => v && setView(v)}>
          <ToggleButton value="bars">Bars</ToggleButton>
          <ToggleButton value="timeline">Timeline</ToggleButton>
        </ToggleButtonGroup>
        {view === 'bars' && (
          <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_e, v) => v && setMode(v)}>
            <ToggleButton value="out">Outgoing</ToggleButton>
            <ToggleButton value="in">Incoming</ToggleButton>
          </ToggleButtonGroup>
        )}
        <FormControlLabel
          control={<Switch size="small" checked={combinePets} onChange={(e) => setCombinePets(e.target.checked)} />}
          label="Combine pets"
        />
        <Box sx={{ flexGrow: 1 }} />
        {snap?.stance && <StanceChips stance={snap.stance} />}
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

      {view === 'timeline' ? (
        snap?.timeline ? (
          <CombatTimeline tl={snap.timeline} />
        ) : (
          <Paper variant="outlined" sx={{ p: 2, flexGrow: 1 }}>
            <Typography color="text.secondary">
              No timeline for this selection — pick a recent fight (the timeline is kept only for the live and most
              recent encounters; the zone aggregate has no single-fight timeline).
            </Typography>
          </Paper>
        )
      ) : snap?.selected ? (
        <SegmentBody seg={snap.selected} mode={mode} drill={drill} setDrill={setDrill} />
      ) : (
        <Paper variant="outlined" sx={{ p: 2, flexGrow: 1 }}>
          <Typography color="text.secondary">No combat yet — engage something and it&apos;ll appear here live.</Typography>
        </Paper>
      )}

      <ProcessingLog lines={snap?.recent ?? []} showUnparsed={showUnparsed} setShowUnparsed={setShowUnparsed} />
    </Stack>
  )
}
