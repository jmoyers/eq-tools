import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Breadcrumbs,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  FormControlLabel,
  Link,
  Paper,
  Skeleton,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  type SxProps,
  type Theme
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CircleIcon from '@mui/icons-material/Circle'
import { useCombat } from './useCombat'
import { CombatTimeline } from './CombatTimeline'
import { BreakdownPreviewCard, DpsChartCard, MobDamageCard, TargetSkillBars, type Ringless } from './CombatDashboard'
import { Bar, CAT_COLOR, CopyButton, DashCard, KIND_COLOR, QuietNote, RESIST_COLOR, SkillBar, fmtDur } from './combatShared'
import { FightPicker } from './FightPicker'
import { flattenSkills, scopeOptions, skillsForTarget, type Drill } from './dashboardData'
import { formatEntityText, formatSegmentText, formatTargetText } from './copyText'
import { formatTime } from '../../lib/formatDate'
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
  setDrill
}: {
  seg: SegmentView
  tl: TimelineView | null
  mode: 'out' | 'in'
  drill: Drill | null
  setDrill: (d: Drill | null) => void
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

  // "Copy this view" means THIS view: the same three-way choice the body below makes, so the
  // clipboard can never hold a level the user isn't looking at. Built on click, never on render.
  const copyView = (): string =>
    drilledEntity
      ? formatEntityText(seg, drilledEntity)
      : targetDetail && targetName
        ? formatTargetText(seg, targetName, targetDetail)
        : formatSegmentText(seg, mode)

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
        {/* The panel's stat run, and hard right of it the copy affordance — it belongs to THIS
            panel (not to the tab's top bar), because what it copies is whatever level this
            panel is currently showing. */}
        <Stack direction="row" spacing={0.5} alignItems="baseline" sx={{ minWidth: 0 }}>
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
          <CopyButton getText={copyView} />
        </Stack>
      </Stack>

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
 * One of the two mutually-exclusive combat modifiers, as passive state (Task #51).
 *
 * NAMING: the log's two groups are a melee/general STANCE and a caster INVOCATION, and the
 * model keeps exactly those names (`StanceState.stance` / `.invocation`, the timeline's pinned
 * lanes, the parser). The DISPLAY drops the jargon — the categories read as strange next to a
 * value like "Berserker" — and simply numbers the two slots: `1: Berserker`, `2: Inversion`.
 * The slot number is a dim prefix; the VALUE carries the weight. The tooltip still names the
 * underlying group, so nothing is hidden.
 */
function ModifierSlot({ slot, value, color }: { slot: 1 | 2; value: string; color: string }): JSX.Element {
  return (
    <Tooltip title={`Modifier ${slot} — ${slot === 1 ? 'combat stance' : 'invocation'}: ${value}`}>
      {/* A subtle pill, so the two slots read as one passive readout at the end of the lens line
          rather than as two more bits of loose text competing with the controls. The TEXT is
          unchanged ('1: Berserker') — it is asserted verbatim by the headless e2e harness. */}
      <Stack
        direction="row"
        spacing={0.25}
        alignItems="baseline"
        data-testid={`stance-slot-${slot}`}
        sx={{
          minWidth: 0,
          px: 0.6,
          py: '1px',
          borderRadius: 999,
          bgcolor: 'rgba(255,255,255,0.04)'
        }}
      >
        <Typography variant="caption" sx={{ fontSize: 10, color: 'text.disabled' }}>
          {slot}:
        </Typography>
        <Typography variant="caption" noWrap sx={{ color, fontWeight: 600, textTransform: 'capitalize' }}>
          {value}
        </Typography>
      </Stack>
    </Tooltip>
  )
}

/** The current stance + invocation pair, as two terse right-aligned slots. */
function StanceReadout({ stance }: { stance: NonNullable<CombatSnapshotStance> }): JSX.Element | null {
  if (!stance.stance && !stance.invocation) return null
  return (
    <>
      {stance.stance && <ModifierSlot slot={1} value={stance.stance} color="#d9b25f" />}
      {stance.invocation && <ModifierSlot slot={2} value={stance.invocation} color="#a98fe0" />}
    </>
  )
}
type CombatSnapshotStance = NonNullable<ReturnType<typeof useCombat>['snap']>['stance']

/**
 * Chrome for the header's segmented controls. All three used to be identical `small`
 * ToggleButtonGroups sitting in a row, which is what made the bar read as a toolbar dump:
 * three outlined boxes of equal weight, none of them obviously the important one. They are
 * now one SHAPE (a low borderless pill track) at three different WEIGHTS, so the eye ranks
 * them instead of scanning them:
 *   - `primary` — the view switch (Dashboard/Timeline). It is the NAVIGATION of this tab, so
 *                 it is the only control wearing the accent: an accent-tinted track behind the
 *                 selection and accent text on it.
 *   - `quiet`   — the scope (Fight/Overall), which lives INSIDE the subject unit: a plain
 *                 light wash, so it reads as part of that control rather than a peer of it.
 *   - `text`    — the direction filter (Outgoing/Incoming): no track at all, just text that
 *                 brightens when active. It filters what one panel lists; it is not a mode.
 *
 * UNSELECTED IS NOT DISABLED. The direction pair used to render its inactive half in
 * `text.disabled`, which is the same colour the app uses for things you cannot click — so the
 * one word you are meant to click ("Incoming") read as dead text. Every unselected option here
 * is `text.secondary` and lifts on hover; `text.disabled` is now reserved for the genuinely
 * disabled case (Timeline with no event ring), which is what it should have meant all along.
 */
function segmented(weight: 'primary' | 'quiet' | 'text'): SxProps<Theme> {
  const selected =
    weight === 'primary'
      ? { bgcolor: 'rgba(217,178,95,0.20)', color: 'primary.main' }
      : weight === 'quiet'
        ? { bgcolor: 'rgba(255,255,255,0.10)', color: 'text.primary' }
        : // no track behind the pair, so the ACTIVE one carries a faint wash of its own —
        // colour + weight alone are too weak a signal at 11px.
          { bgcolor: 'rgba(255,255,255,0.09)', color: 'text.primary' }
  return {
    flexShrink: 0,
    ...(weight === 'text' ? null : { bgcolor: 'rgba(255,255,255,0.04)', borderRadius: 1, p: '2px' }),
    '& .MuiToggleButtonGroup-grouped': {
      border: 0,
      borderRadius: '5px !important',
      px: weight === 'text' ? 0.5 : 1,
      py: '1px',
      minHeight: 0,
      fontSize: 11,
      fontWeight: 600,
      lineHeight: 1.7,
      letterSpacing: 0,
      textTransform: 'none',
      color: 'text.secondary',
      '&:hover': { bgcolor: 'rgba(255,255,255,0.06)', color: 'text.primary' },
      '&.Mui-selected': { ...selected, fontWeight: 700 },
      '&.Mui-selected:hover': selected,
      // The ONE thing in this bar that is allowed to look dead, and only when it truly is.
      '&.Mui-disabled': { color: 'text.disabled', '&:hover': { bgcolor: 'transparent' } }
    }
  }
}

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
    scope,
    setScope,
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
      // Esc belongs to the innermost open thing. The fight picker owns it while its popover is
      // up (that is how you dismiss the search), so leaving the drill alone here is what keeps
      // one keypress from doing two things at once. The popover is portalled to <body>, so a
      // React-level stopPropagation in the picker could never reach this window listener.
      if (document.querySelector('[data-testid="fight-picker"]')) return
      setDrill(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, drill])

  // Reset the drill when the selected fight / mode changes (a drill is per-fight).
  useEffect(() => setDrill(null), [selection, mode])

  // SCOPE decides what the selector may list — fights only, or zone sessions only. There is no
  // automatic switch between the two any more: between pulls the Fight scope keeps showing the
  // LAST fight (labeled as the last one), it never swaps itself to the zone aggregate.
  const opts = scopeOptions(scope, snap?.segments ?? [], snap?.zoneSessions ?? [])
  // The segment payload is capped at `maxSegments` finalized fights (newest-first).
  // Offer a "Load more" when the cap is likely truncating history.
  const capped = scope === 'fight' && (snap?.segments ?? []).filter((s) => s.kind === 'fight').length >= maxSegments
  // A single `now` for the whole render so all the relative-age labels agree; it advances
  // each snapshot tick (~1s idle, sub-second live) so ages stay live-updating and coarse.
  const now = Date.now()

  // Startup replay in progress (Task #56): the engine is still folding history, so nothing in
  // this snapshot describes the present. `snap === null` (first fetch in flight) reads the same
  // way — both are "we're not ready", and both render the quiet loading state.
  const hydrating = snap?.hydrating ?? true
  const seg = snap?.selected ?? null
  const tl = useStableTimeline(snap?.timeline)
  // Why the event-derived panels have nothing to show: a zone session keeps no ring at all,
  // an older fight had its ring dropped at finalize. Both are quiet notes, never errors.
  const ringless: Ringless = tl ? null : seg?.kind === 'zone' ? 'zone' : 'evicted'
  // The scrolling window only follows `now` for a GENUINELY live selection — the open fight, or
  // the running zone session. The head row between pulls is a finished fight, so it must not
  // scroll as if time were still passing in it.
  const live = !!opts.head && selection === opts.head.value && opts.head.live
  // The preview follows the drill when a source is drilled, else the top row of the meter.
  const previewRows = mode === 'out' ? seg?.entities ?? [] : seg?.incoming ?? []
  const previewSource =
    (drill?.kind === 'entity' ? previewRows.find((r) => r.id === drill.entityId) : undefined) ?? previewRows[0] ?? null

  // TIMELINE AVAILABILITY. The timeline is drawn from an encounter's event ring, and a ring only
  // exists for the live + most recent fights (older ones drop theirs at finalize; a zone
  // aggregate never had one). Offering Timeline for those selections led straight to an empty
  // pane, which reads as a broken view rather than as "this selection has no such data" — so the
  // option DISABLES instead (with a tooltip saying why), and any selection change that would
  // strand you on an empty timeline falls back to the dashboard. `hydrating` is excluded because
  // during the startup replay `tl` is legitimately absent for a moment; disabling then would make
  // the switch flicker.
  const noTimeline = !hydrating && !tl
  useEffect(() => {
    if (view === 'timeline' && noTimeline) setView('dash')
  }, [view, noTimeline])

  const hasStatus = !!(snap?.stance?.stance || snap?.stance?.invocation || snap?.inCombat)

  return (
    // The tab owns exactly the height it's given: the dashboard (flexGrow) takes what's left
    // after the header and the FIXED-height combat log, and nothing here may spill into the
    // app's scrolling content area. Before Task #56 the unbounded log below did exactly that —
    // it grew past the viewport and pushed the dashboard to 0px, leaving "just a combat log".
    <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {/* ── HEADER ──────────────────────────────────────────────────────────────────────
          SUBJECT, then LENS. The bar used to be a single rank of five same-weight controls plus
          a raw Switch — a toolbar dump: nothing in it said what you were looking at, so the eye
          had to read every control to find out. It is now two explicit lines that answer two
          different questions, in the order you actually ask them.

          LINE 1 — SUBJECT ("what am I looking at"). The scope toggle is fused tight against the
          encounter selector as ONE unit, because scope is not a peer of anything: it only
          decides what that selector may LIST. The selector HUGS its content (it used to
          flexGrow across the whole bar, which parked the dropdown caret at the far right, a
          screen away from the name it opens) and truncates instead of stretching. The line then
          ends, hard right, in the headline stat — the selected fight's dps, the one number this
          tab exists to show, at the size that claims it.

          That headline is also why the CLOSED trigger no longer prints the rate: it is the same
          number for the same fight, and showing it twice in one bar makes the reader check
          whether they differ. The MENU rows keep theirs — comparing pulls is the entire reason
          you open the list.

          LINE 2 — LENS ("how am I looking at it"), left to right in decreasing consequence:
          the view switch (the tab's navigation, the only control wearing the accent), the
          direction filter (dash only), then right-aligned the one setting that changes the
          numbers (combine pets), and past a divider the purely passive readout — modifier
          slots and the in-combat dot, which are STATE, not controls.

          The two lines are EXPLICIT rather than a wrapping row: at the 900px minimum window
          everything cannot fit on one line, and a wrap point that moves with the fight name is
          exactly the mess this replaces. */}
      <Paper
        variant="outlined"
        data-testid="combat-header"
        sx={{ flexShrink: 0, px: 1.25, py: 0.75, bgcolor: 'rgba(255,255,255,0.015)' }}
      >
        {/* ── LINE 1: SUBJECT ── */}
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          {/* The subject unit: scope + selector share one bordered affordance, so the pair reads
              as "which list, and which row of it" rather than as two independent controls. It is
              capped so the caret stays next to the fight name; long names ellipsize. */}
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            sx={{
              minWidth: 0,
              maxWidth: 'min(560px, 55%)',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              px: 0.5,
              py: '2px'
            }}
          >
            {/* SCOPE: an explicit choice — Fight never becomes Overall on its own. */}
            <ToggleButtonGroup
              size="small"
              exclusive
              data-testid="scope-toggle"
              value={scope}
              onChange={(_e, v) => v && setScope(v)}
              sx={segmented('quiet')}
            >
              <ToggleButton value="fight">Fight</ToggleButton>
              <ToggleButton value="overall">Overall</ToggleButton>
            </ToggleButtonGroup>
            {/* The encounter selector. Exactly ONE scope's rows are ever listed — the fight scope
                shows no zone sessions and vice versa (dashboardData.scopeOptions is the single
                filter) — and the open list is FROZEN against live snapshot ticks so a fight
                finalizing mid-pull can't move the row under your pointer. See FightPicker's
                header for the freeze + stale-response semantics. */}
            <FightPicker
              opts={opts}
              scope={scope}
              selection={selection}
              onSelect={setSelection}
              onLoadMore={loadMore}
              capped={capped}
              // While hydrating, the fight list is a churning replay artifact — don't invite a
              // pick from it (the value stays on the head row and the list settles the moment the
              // tail runs).
              disabled={hydrating}
              now={now}
            />
          </Stack>

          <Box sx={{ flexGrow: 1, minWidth: 8 }} />

          {/* HEADLINE STAT: the subject line's payoff. Outgoing dps is what the Combat tab is
              for, so it gets the size and the accent; total and duration ride along dim, as the
              context that makes the rate mean something. */}
          {seg && (
            <Stack
              data-testid="headline-stat"
              direction="row"
              spacing={0.75}
              alignItems="baseline"
              sx={{ flexShrink: 0 }}
            >
              <Typography
                noWrap
                sx={{
                  fontSize: 17.5,
                  fontWeight: 700,
                  lineHeight: 1.2,
                  color: 'primary.main',
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                {formatRate(seg.outDps)}
              </Typography>
              <Typography
                variant="caption"
                noWrap
                sx={{ color: 'text.disabled', fontVariantNumeric: 'tabular-nums' }}
              >
                {fmt(seg.outTotal)} · {fmtDur(seg.durationSec)}
              </Typography>
            </Stack>
          )}
        </Stack>

        {/* ── LINE 2: LENS + REFINEMENTS ── controls left, passive state right. It wraps (rather
            than overflows) if a very long modifier name ever meets a very narrow window; at the
            900px minimum window it is one line. */}
        <Stack
          direction="row"
          spacing={0.75}
          rowGap={0.5}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          sx={{ mt: 0.5, minWidth: 0 }}
        >
          <Tooltip
            title={
              noTimeline
                ? "Timeline follows a single fight — it's kept for the live and recent encounters. The zone aggregate and older fights have no event ring."
                : ''
            }
          >
            {/* The tooltip sits on the GROUP, not on a span around the disabled button: wrapping
                one child of a ToggleButtonGroup breaks the group's own first/last-child
                styling, and the explanation belongs to the pair anyway. */}
            <ToggleButtonGroup
              size="small"
              exclusive
              data-testid="view-toggle"
              value={view}
              onChange={(_e, v) => v && setView(v)}
              sx={segmented('primary')}
            >
              <ToggleButton value="dash">Dashboard</ToggleButton>
              <ToggleButton value="timeline" disabled={noTimeline}>
                Timeline
              </ToggleButton>
            </ToggleButtonGroup>
          </Tooltip>

          {view === 'dash' && (
            <>
              <Divider orientation="vertical" flexItem sx={{ my: 0.25 }} />
              <Tooltip title="Which direction of damage the meter lists">
                <ToggleButtonGroup
                  size="small"
                  exclusive
                  data-testid="direction-toggle"
                  value={mode}
                  onChange={(_e, v) => v && setMode(v)}
                  sx={segmented('text')}
                >
                  <ToggleButton value="out">Outgoing</ToggleButton>
                  <ToggleButton value="in">Incoming</ToggleButton>
                </ToggleButtonGroup>
              </Tooltip>
            </>
          )}

          <Box sx={{ flexGrow: 1, minWidth: 8 }} />

          {/* A toggle CHIP, not a Switch: the raw Switch + label was the widest thing on this
              line (~120px — what pushed the lens line to wrap at the 900px minimum window) and
              the one control still speaking a different visual language than the line's pills.
              As a chip it reads as what it is: a lens option, on or off. */}
          <Tooltip title="Roll every pet's damage into its owner's row">
            <ToggleButton
              value="combine"
              size="small"
              data-testid="combine-pets"
              selected={combinePets}
              onChange={() => setCombinePets(!combinePets)}
              sx={{
                border: 0,
                borderRadius: '999px',
                px: 1,
                py: '1px',
                minHeight: 0,
                fontSize: 11,
                fontWeight: 600,
                lineHeight: 1.7,
                textTransform: 'none',
                color: 'text.secondary',
                flexShrink: 0,
                '&:hover': { bgcolor: 'rgba(255,255,255,0.06)', color: 'text.primary' },
                '&.Mui-selected': { bgcolor: 'rgba(255,255,255,0.09)', color: 'text.primary', fontWeight: 700 },
                '&.Mui-selected:hover': { bgcolor: 'rgba(255,255,255,0.09)' }
              }}
            >
              Combine pets
            </ToggleButton>
          </Tooltip>

          {/* Everything past this divider is READ-ONLY state, not a control. */}
          {hasStatus && <Divider orientation="vertical" flexItem sx={{ my: 0.25 }} />}
          {snap?.stance && <StanceReadout stance={snap.stance} />}
          {snap?.inCombat && (
            <Stack direction="row" spacing={0.5} alignItems="center">
              <CircleIcon sx={{ fontSize: 8, color: 'success.main' }} />
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                in combat
              </Typography>
            </Stack>
          )}
        </Stack>
      </Paper>

      {hydrating ? (
        <HydratingPanel />
      ) : view === 'timeline' ? (
        tl ? (
          <CombatTimeline tl={tl} />
        ) : (
          // Defensive only: the Timeline option now disables (and this view falls back to the
          // dashboard) whenever the selection has no event ring, so this pane should be
          // unreachable. It stays as the belt-and-braces for a selection that loses its ring
          // between renders.
          <Paper variant="outlined" sx={{ p: 2, flexGrow: 1 }}>
            <Typography color="text.secondary">No timeline for this selection — pick a recent fight.</Typography>
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
          <SegmentBody seg={seg} tl={tl} mode={mode} drill={drill} setDrill={setDrill} />
          <DpsChartCard tl={tl} live={live} ringless={ringless} />
          <BreakdownPreviewCard
            source={previewSource}
            onOpen={() => previewSource && setDrill({ kind: 'entity', entityId: previewSource.id })}
          />
          <MobDamageCard seg={seg} tl={tl} ringless={ringless} drill={drill} setDrill={setDrill} />
        </Box>
      ) : (
        // Empty scope. A Fight scope with nothing in it stays empty on purpose — it does NOT
        // borrow the zone aggregate to look busy; Overall is one click away and says so.
        <Paper variant="outlined" data-testid="scope-empty" sx={{ p: 2, flexGrow: 1 }}>
          <Typography color="text.secondary">
            {scope === 'fight'
              ? 'No fights yet — engage something and it’ll appear here live. Switch to Overall for this zone’s totals.'
              : 'No zone session yet — it starts with your first damage in a zone.'}
          </Typography>
        </Paper>
      )}

      <ProcessingLog lines={snap?.recent ?? []} showUnparsed={showUnparsed} setShowUnparsed={setShowUnparsed} />
    </Stack>
  )
}
