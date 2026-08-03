import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Breadcrumbs,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  FormControlLabel,
  Link,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  Skeleton,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CircleIcon from '@mui/icons-material/Circle'
import { LIVE, useCombat } from './useCombat'
import { CombatTimeline } from './CombatTimeline'
import { BreakdownPreviewCard, DpsChartCard, MobDamageCard, TargetSkillBars, type Ringless } from './CombatDashboard'
import { Bar, CAT_COLOR, DashCard, KIND_COLOR, QuietNote, RESIST_COLOR, SkillBar, fmtDur } from './combatShared'
import { flattenSkills, skillsForTarget, type Drill } from './dashboardData'
import { formatDate, formatTime } from '../../lib/formatDate'
import { formatNum as fmt, formatRate } from '../../lib/formatRate'
import type { ClassifiedLine, DamageCategory, SegmentView, SourceView, TimelineView } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'

const ROLE_COLOR: Record<string, string> = {
  you: '#d9b25f',
  pet: '#6fb3d2',
  enemy: '#cf6679',
  info: '#9aa0aa',
  dropped: '#e0554f'
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
  // Fallback inline expand (the same flat, category-colored skill list) for the incoming
  // view, which has no drill-down; the outgoing view uses onDrill instead.
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
    <Box data-testid="meter-row">
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
            {flattenSkills(e).map((s) => (
              <SkillBar key={`${s.category}|${s.name}`} s={s} />
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

/**
 * The compact category legend above the flat list: swatch + label + total, carrying the
 * category-level badges (crit%, resist%) that used to live on the removed category bars.
 * Chips double as filters — click to isolate one category, click again to clear.
 */
function CategoryLegend({
  e,
  active,
  onToggle
}: {
  e: SourceView
  active: DamageCategory | null
  onToggle: (c: DamageCategory) => void
}): JSX.Element | null {
  if (e.categories.length === 0) return null
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
      {e.categories.map((c) => {
        const on = active === c.category
        return (
          <Tooltip
            key={c.category}
            title={`${CATEGORY_LABEL[c.category]}: ${fmt(c.total)} over ${c.hits} hits · max ${fmt(c.max)} — click to ${
              on ? 'show all categories' : 'show only this category'
            }`}
          >
            <Box
              onClick={() => onToggle(c.category)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                px: 0.75,
                py: '2px',
                borderRadius: 999,
                cursor: 'pointer',
                userSelect: 'none',
                border: '1px solid',
                borderColor: on ? CAT_COLOR[c.category] : 'divider',
                bgcolor: on ? `${CAT_COLOR[c.category]}22` : 'transparent',
                opacity: active && !on ? 0.45 : 1,
                '&:hover': { borderColor: CAT_COLOR[c.category] }
              }}
            >
              <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: CAT_COLOR[c.category], flexShrink: 0 }} />
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                {CATEGORY_LABEL[c.category]}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {fmt(c.total)}
              </Typography>
              {c.critPct >= 1 && (
                <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
                  {Math.round(c.critPct)}% crit
                </Typography>
              )}
              {c.resists > 0 && (
                <Typography component="span" variant="caption" sx={{ color: RESIST_COLOR }}>
                  {Math.round(c.resistPct)}% resist
                </Typography>
              )}
            </Box>
          </Tooltip>
        )
      })}
    </Stack>
  )
}

/**
 * Level-2 (one of two level-2 subjects): the category legend + ONE flat ranked list of every
 * skill/spell this entity landed. The melee-rounds heuristic footer rides along.
 */
function EntitySkillBars({ e }: { e: SourceView }): JSX.Element {
  const [filter, setFilter] = useState<DamageCategory | null>(null)
  const rounds = e.rounds
  const all = flattenSkills(e)
  const rows = filter ? all.filter((s) => s.category === filter) : all
  return (
    <Box>
      <CategoryLegend e={e} active={filter} onToggle={(c) => setFilter((f) => (f === c ? null : c))} />
      {rows.map((s) => (
        <SkillBar key={`${s.category}|${s.name}`} s={s} />
      ))}
      {rows.length === 0 && <QuietNote>No skill breakdown for this source.</QuietNote>}
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

/**
 * The dashboard's anchor panel: the source meter (level 1) and, when drilled, ONE level-2
 * subject — either an entity's flat skill list or a MOB's (everything you+pet landed on it).
 * The two drill kinds are a union, so there is always exactly one breadcrumb.
 */
function SegmentBody({
  seg,
  tl,
  mode,
  drill,
  setDrill,
  fallbackNote
}: {
  seg: SegmentView
  tl: TimelineView | null
  mode: 'out' | 'in'
  drill: Drill | null
  setDrill: (d: Drill | null) => void
  /** Set when the LIVE selection fell back to the zone session (no fight open) — says so. */
  fallbackNote?: string | null
}): JSX.Element {
  const rows = mode === 'out' ? seg.entities : seg.incoming
  const total = mode === 'out' ? seg.outTotal : seg.inTotal
  const dps = mode === 'out' ? seg.outDps : seg.inDps

  // If a stale drill points at an entity no longer present (fight changed), fall back to
  // level 1. The mob drill goes stale the same way when the ring disappears.
  const drilledEntity = drill?.kind === 'entity' ? rows.find((r) => r.id === drill.entityId) : undefined
  const targetName = drill?.kind === 'target' ? drill.target : null
  const targetDetail = useMemo(
    () => (tl && targetName ? skillsForTarget(tl, targetName) : null),
    [tl, targetName]
  )
  const crumb = drilledEntity?.name ?? (targetDetail ? targetName : null)

  return (
    // Grid-cell sizing, exactly like DashCard's `fill`: 100% of the cell, zero intrinsic
    // height (so a `minmax(0, 1fr)` row can shrink it), everything below the header scrolls
    // internally. The meter must never be what makes the dashboard taller than its box.
    <Paper
      variant="outlined"
      data-testid="dash-panel"
      sx={{
        p: 1.5,
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1, flexShrink: 0 }}>
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

      {/* LIVE with no open fight: the body is the zone session, and it says so (Task #56). */}
      {fallbackNote && (
        <Typography
          data-testid="live-fallback"
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', mt: -0.75, mb: 0.75, flexShrink: 0 }}
        >
          {fallbackNote}
        </Typography>
      )}

      {/* Drill-down breadcrumb + Back. Two levels only: source list ↔ one level-2 subject. */}
      {crumb && (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75, flexShrink: 0 }}>
          <Button
            size="small"
            startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />}
            onClick={() => setDrill(null)}
            sx={{ minWidth: 0, py: 0 }}
          >
            Back
          </Button>
          <Breadcrumbs separator="›" sx={{ fontSize: 12 }}>
            <Link component="button" underline="hover" color="inherit" onClick={() => setDrill(null)} sx={{ fontSize: 12 }}>
              All
            </Link>
            <Typography variant="caption" color="text.primary">
              {targetDetail ? `damage to ${crumb}` : crumb}
            </Typography>
          </Breadcrumbs>
        </Stack>
      )}

      <Box data-testid="meter-body" sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0 }}>
        {!crumb &&
          (rows.length ? (
            rows.map((e, i) => (
              <EntityRow
                key={e.id}
                e={e}
                rank={i + 1}
                onDrill={mode === 'out' ? () => setDrill({ kind: 'entity', entityId: e.id }) : undefined}
              />
            ))
          ) : (
            <QuietNote>
              {mode === 'out' ? 'No outgoing damage in this segment.' : 'No incoming damage in this segment.'}
            </QuietNote>
          ))}

        {/* Keyed by entity so switching sources resets the legend's category filter. */}
        {drilledEntity && <EntitySkillBars key={drilledEntity.id} e={drilledEntity} />}
        {!drilledEntity && targetDetail && targetName && (
          <TargetSkillBars target={targetName} detail={targetDetail} seg={seg} />
        )}

        {mode === 'in' && !crumb && <IncomingHeals seg={seg} />}
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
  // FIXED height, not minHeight (Task #56): this card's body is an append-only ring that grows
  // to 150 lines. As `flex: 0 0 auto` it sized to that CONTENT and — being unshrinkable —
  // squeezed the entire dashboard down to its `minHeight: 0`, so a few seconds after the live
  // tail started the Combat tab was JUST a scrolling log. The ring scrolls inside a fixed box.
  return (
    <DashCard
      title="Combat log"
      right={
        <FormControlLabel
          control={<Switch size="small" checked={showUnparsed} onChange={(e) => setShowUnparsed(e.target.checked)} />}
          label={<Typography variant="caption">show unparsed</Typography>}
          sx={{ m: 0 }}
        />
      }
      height={220}
    >
      <Box
        ref={ref}
        data-testid="combat-log"
        sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0, fontFamily: '"Consolas","Courier New",monospace', fontSize: 11 }}
      >
        {lines.length === 0 && <QuietNote>Waiting for combat…</QuietNote>}
        {lines.map((l, i) => (
          <LogLine key={`${l.ts}|${l.cat}|${i}`} l={l} />
        ))}
      </Box>
    </DashCard>
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

/**
 * Stabilise the timeline's IDENTITY across snapshot ticks. Every poll rebuilds the payload,
 * so a frozen finalized encounter would hand the dashboard a brand-new (but identical)
 * object each second and re-run every derivation. The signature below changes exactly when
 * the content can have changed — id, event count, raw count, duration — so a static
 * selection derives ONCE and a live fight still recomputes every tick.
 *
 * NO_SIG is the first-render sentinel: it only has to differ from every real signature (a
 * real one is '' for "no timeline", else 'id|…' with pipes) so the first render adopts.
 */
const NO_SIG = '<none>'

/**
 * HYDRATION state (Task #56). During the startup replay the engine is folding the whole log,
 * so every snapshot's "current fight" is an encounter from hours ago: the dashboard churned
 * through historical pulls as if they were live, then snapped to the real present. That is a
 * lie the UI shouldn't tell, so while `snap.hydrating` is true the dashboard body is this
 * quiet, dense placeholder — state ("Reading log…"), never process.
 */
function HydratingPanel(): JSX.Element {
  return (
    <Paper
      variant="outlined"
      data-testid="combat-hydrating"
      sx={{ p: 1.5, flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <CircularProgress size={13} thickness={5} />
        <Typography variant="caption" color="text.secondary">
          Reading log…
        </Typography>
      </Stack>
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} variant="rounded" height={22} sx={{ mb: '3px', opacity: 1 - i * 0.15 }} />
      ))}
    </Paper>
  )
}

function useStableTimeline(tl: TimelineView | null | undefined): TimelineView | null {
  const sig = tl ? `${tl.id}|${tl.rawCount}|${tl.events.length}|${tl.durationMs}|${tl.lanes.length}` : ''
  const sigRef = useRef<string>(NO_SIG)
  const valRef = useRef<TimelineView | null>(null)
  if (sig !== sigRef.current) {
    sigRef.current = sig
    valRef.current = tl ?? null
  }
  return valRef.current
}

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
    loadMore
  } = useCombat()
  const [mode, setMode] = useState<'out' | 'in'>('out')
  const [view, setView] = useState<'dash' | 'timeline'>('dash')
  const [drill, setDrill] = useState<Drill | null>(null)

  // Esc leaves the drill-down (there is only one level below the source list).
  useEffect(() => {
    if (view !== 'dash') return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !drill) return
      setDrill(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, drill])

  // Reset the drill when the selected fight / mode changes (a drill is per-fight).
  useEffect(() => setDrill(null), [selection, mode])

  const history = (snap?.segments ?? []).filter((s) => s.kind === 'fight')
  const zoneSessions = snap?.zoneSessions ?? []
  // The segment payload is capped at `maxSegments` finalized fights (newest-first).
  // Offer a "Load more" when the cap is likely truncating history.
  const capped = history.length >= maxSegments
  // A single `now` for the whole render so all the relative-age labels agree; it advances
  // each snapshot tick (~1s idle, sub-second live) so ages stay live-updating and coarse.
  const now = Date.now()

  // Startup replay in progress (Task #56): the engine is still folding history, so nothing in
  // this snapshot describes the present. `snap === null` (first fetch in flight) reads the same
  // way — both are "we're not ready", and both render the quiet loading state.
  const hydrating = snap?.hydrating ?? true
  const seg = snap?.selected ?? null
  // LIVE is selected but no fight is open → `selected` is the live ZONE session (the engine
  // decides this; see snapshot()'s liveFallback). Say so instead of silently relabelling.
  const fallbackNote =
    snap?.liveFallback && selection === LIVE
      ? `No active fight — showing ${snap.zone ?? 'this zone'} overall`
      : null
  const tl = useStableTimeline(snap?.timeline)
  // Why the event-derived panels have nothing to show: a zone session keeps no ring at all,
  // an older fight had its ring dropped at finalize. Both are quiet notes, never errors.
  const ringless: Ringless = tl ? null : seg?.kind === 'zone' ? 'zone' : 'evicted'
  // The scrolling window only follows `now` for the live fight (the selector's other rows
  // are all finalized encounters and zone sessions).
  const live = selection === LIVE
  // The preview follows the drill when a source is drilled, else the top row of the meter.
  const previewRows = mode === 'out' ? seg?.entities ?? [] : seg?.incoming ?? []
  const previewSource =
    (drill?.kind === 'entity' ? previewRows.find((r) => r.id === drill.entityId) : undefined) ?? previewRows[0] ?? null

  return (
    // The tab owns exactly the height it's given: the dashboard (flexGrow) takes what's left
    // after the header and the FIXED-height combat log, and nothing here may spill into the
    // app's scrolling content area. Before Task #56 the unbounded log below did exactly that —
    // it grew past the viewport and pushed the dashboard to 0px, leaving "just a combat log".
    <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Select
          size="small"
          data-testid="segment-select"
          // While hydrating, the fight list is a churning replay artifact — don't invite a
          // pick from it (the value stays LIVE and the list settles the moment the tail runs).
          disabled={hydrating}
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
          <ToggleButton value="dash">Dashboard</ToggleButton>
          <ToggleButton value="timeline">Timeline</ToggleButton>
        </ToggleButtonGroup>
        {view === 'dash' && (
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
        {snap?.inCombat && (
          <Chip
            size="small"
            icon={<CircleIcon sx={{ fontSize: 10, color: 'success.main' }} />}
            label="in combat"
            variant="outlined"
          />
        )}
      </Stack>

      {hydrating ? (
        <HydratingPanel />
      ) : view === 'timeline' ? (
        tl ? (
          <CombatTimeline tl={tl} />
        ) : (
          <Paper variant="outlined" sx={{ p: 2, flexGrow: 1 }}>
            <Typography color="text.secondary">
              No timeline for this selection — pick a recent fight (the timeline is kept only for the live and most
              recent encounters; the zone aggregate has no single-fight timeline).
            </Typography>
          </Paper>
        )
      ) : seg ? (
        // Dashboard: FOUR EQUAL panels in a 2x2 grid — source meter, DPS over time, breakdown
        // preview, damage by mob. `minmax(0, 1fr)` on both axes is the load-bearing bit: it lets
        // every track shrink below its content, so no panel can dictate the grid's size (the old
        // flex rail gave the meter a 1.5x column and squeezed the other three into a strip, and
        // an intrinsic-size track is exactly how a growing panel used to push the page taller).
        // Each cell is a `fill` panel: 100% of the cell, its own internal `overflow: auto`.
        // At md the region is `overflow: hidden` and sized by flexGrow between the header and the
        // fixed-height combat log — so the view still has NO page-level scroll (Task #56).
        // Below md it collapses to ONE column of comfortably-tall panels and the region scrolls.
        <Box
          data-testid="combat-dashboard"
          sx={{
            display: 'grid',
            gap: 1.5,
            flexGrow: 1,
            minHeight: 0,
            minWidth: 0,
            overflow: { xs: 'auto', md: 'hidden' },
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
            gridTemplateRows: { xs: 'none', md: 'repeat(2, minmax(0, 1fr))' },
            // xs rows are a DEFINITE height on purpose: `auto` would let the meter's row list
            // size the track (an append-only panel sizing its own box is the Task #56 bug), so
            // each stacked panel gets a comfortable fixed box and scrolls inside it.
            gridAutoRows: { xs: '320px', md: 'minmax(0, 1fr)' },
            '& > *': { minWidth: 0, minHeight: 0 }
          }}
        >
          <SegmentBody seg={seg} tl={tl} mode={mode} drill={drill} setDrill={setDrill} fallbackNote={fallbackNote} />
          <DpsChartCard tl={tl} live={live} ringless={ringless} />
          <BreakdownPreviewCard
            source={previewSource}
            onOpen={() => previewSource && setDrill({ kind: 'entity', entityId: previewSource.id })}
          />
          <MobDamageCard tl={tl} ringless={ringless} drill={drill} setDrill={setDrill} />
        </Box>
      ) : (
        <Paper variant="outlined" sx={{ p: 2, flexGrow: 1 }}>
          <Typography color="text.secondary">No combat yet — engage something and it&apos;ll appear here live.</Typography>
        </Paper>
      )}

      <ProcessingLog lines={snap?.recent ?? []} showUnparsed={showUnparsed} setShowUnparsed={setShowUnparsed} />
    </Stack>
  )
}
