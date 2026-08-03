// The Combat tab's HEADER — the two-rank bar above the dashboard. Split out of CombatView.tsx;
// the design rationale for both ranks lives with the markup below, where it is load-bearing.

import {
  Box,
  Divider,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  type SxProps,
  type Theme
} from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import { FightPicker } from './FightPicker'
import type { CombatScope, ScopeOptions } from './dashboardData'
import { fmtDur } from './combatShared'
import { formatDateTime } from '../../lib/formatDate'
import { formatNum as fmt, formatRate } from '../../lib/formatRate'
import type { CombatSnapshot, SegmentView } from '@shared/combat'

type StanceState = NonNullable<CombatSnapshot['stance']>
type PoisonState = CombatSnapshot['poison']

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
function ModifierSlot({
  slot,
  value,
  color,
  tip
}: {
  slot: 1 | 2 | 3
  value: string
  color: string
  /** Overrides the default "Modifier n — <group>: <value>" tooltip (slot 3 says more). */
  tip?: string
}): React.JSX.Element {
  return (
    <Tooltip title={tip ?? `Modifier ${slot} — ${slot === 1 ? 'combat stance' : 'invocation'}: ${value}`}>
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

/**
 * The passive modifier readout: stance, invocation, and (Task #64) the BLADE COAT.
 *
 * Slot 3 mirrors slots 1–2 exactly — the same `<n>: <value>` pill in the same shape, which is
 * also the contract the headless e2e harness asserts on the first two. It shows the UTILITY
 * poison, because that is the slot the player actually chooses between: combat venoms stack
 * and simply accumulate, so they belong in the tooltip, not in a one-line status. A short
 * label ("Neurotoxic") carries it — the trailing "Poison"/"Venom" is noise at pill size.
 */
function coatShortName(poison: string): string {
  return poison === 'unknown' ? 'unknown' : poison.replace(/\s+(Poison|Venom)$/, '')
}

/** Slot 3 on its own, so the readout below stays a flat list of three optional pills. */
function CoatSlotPill({ coat }: { coat: NonNullable<PoisonState>['coat'] }): React.JSX.Element | null {
  if (!coat.utility) return null
  const combat = coat.combat
  return (
    <ModifierSlot
      slot={3}
      value={coatShortName(coat.utility.poison)}
      color="#c46fd2"
      tip={
        `Modifier 3 — blade coat: ${coat.utility.poison}, applied ${formatDateTime(coat.utility.sinceTs)}` +
        (combat.length ? `. Combat venoms also up (they stack): ${combat.map((c) => c.poison).join(', ')}` : '')
      }
    />
  )
}

function StanceReadout({
  stance,
  poison
}: {
  stance: StanceState
  poison: PoisonState
}): React.JSX.Element | null {
  const coat = poison?.coat
  if (!stance.stance && !stance.invocation && !coat?.utility) return null
  return (
    <>
      {stance.stance && <ModifierSlot slot={1} value={stance.stance} color="#d9b25f" />}
      {stance.invocation && <ModifierSlot slot={2} value={stance.invocation} color="#a98fe0" />}
      {coat && <CoatSlotPill coat={coat} />}
    </>
  )
}

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
 * HEADLINE STAT: the subject line's payoff. Outgoing dps is what the Combat tab is for, so it
 * gets the size and the accent; total and duration ride along dim, as the context that makes the
 * rate mean something.
 */
function HeadlineStat({ seg }: { seg: SegmentView | null }): React.JSX.Element | null {
  if (!seg) return null
  return (
    <Stack data-testid="headline-stat" direction="row" spacing={0.75} alignItems="baseline" sx={{ flexShrink: 0 }}>
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
      <Typography variant="caption" noWrap sx={{ color: 'text.disabled', fontVariantNumeric: 'tabular-nums' }}>
        {fmt(seg.outTotal)} · {fmtDur(seg.durationSec)}
      </Typography>
    </Stack>
  )
}

/**
 * LINE 1 — SUBJECT ("what am I looking at"). The scope toggle is fused tight against the
 * encounter selector as ONE unit, because scope is not a peer of anything: it only decides what
 * that selector may LIST. The selector HUGS its content (it used to flexGrow across the whole
 * bar, which parked the dropdown caret at the far right, a screen away from the name it opens)
 * and truncates instead of stretching. The line then ends, hard right, in the headline stat —
 * the selected fight's dps, the one number this tab exists to show, at the size that claims it.
 *
 * That headline is also why the CLOSED trigger no longer prints the rate: it is the same number
 * for the same fight, and showing it twice in one bar makes the reader check whether they differ.
 * The MENU rows keep theirs — comparing pulls is the entire reason you open the list.
 */
function SubjectLine({
  seg,
  scope,
  setScope,
  opts,
  selection,
  setSelection,
  loadMore,
  capped,
  hydrating,
  now
}: {
  seg: SegmentView | null
  scope: CombatScope
  setScope: (s: CombatScope) => void
  opts: ScopeOptions
  selection: string
  setSelection: (v: string) => void
  loadMore: () => void
  capped: boolean
  hydrating: boolean
  now: number
}): React.JSX.Element {
  return (
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
          onChange={(_e: unknown, v: CombatScope | null) => v && setScope(v)}
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

      <HeadlineStat seg={seg} />
    </Stack>
  )
}

/** The view switch — the tab's navigation, and the only control wearing the accent. */
function ViewSwitch({
  view,
  setView,
  noTimeline
}: {
  view: 'dash' | 'timeline'
  setView: (v: 'dash' | 'timeline') => void
  noTimeline: boolean
}): React.JSX.Element {
  return (
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
        onChange={(_e: unknown, v: 'dash' | 'timeline' | null) => v && setView(v)}
        sx={segmented('primary')}
      >
        <ToggleButton value="dash">Dashboard</ToggleButton>
        <ToggleButton value="timeline" disabled={noTimeline}>
          Timeline
        </ToggleButton>
      </ToggleButtonGroup>
    </Tooltip>
  )
}

/** The direction filter — dash only. It filters what one panel lists; it is not a mode. */
function DirectionFilter({
  mode,
  setMode
}: {
  mode: 'out' | 'in'
  setMode: (m: 'out' | 'in') => void
}): React.JSX.Element {
  return (
    <>
      <Divider orientation="vertical" flexItem sx={{ my: 0.25 }} />
      <Tooltip title="Which direction of damage the meter lists">
        <ToggleButtonGroup
          size="small"
          exclusive
          data-testid="direction-toggle"
          value={mode}
          onChange={(_e: unknown, v: 'out' | 'in' | null) => v && setMode(v)}
          sx={segmented('text')}
        >
          <ToggleButton value="out">Outgoing</ToggleButton>
          <ToggleButton value="in">Incoming</ToggleButton>
        </ToggleButtonGroup>
      </Tooltip>
    </>
  )
}

/**
 * A toggle CHIP, not a Switch: the raw Switch + label was the widest thing on this line (~120px
 * — what pushed the lens line to wrap at the 900px minimum window) and the one control still
 * speaking a different visual language than the line's pills. As a chip it reads as what it is:
 * a lens option, on or off.
 */
function CombinePetsChip({
  combinePets,
  setCombinePets
}: {
  combinePets: boolean
  setCombinePets: (v: boolean) => void
}): React.JSX.Element {
  return (
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
  )
}

/** The in-combat dot: state, not a control. */
function InCombatDot(): React.JSX.Element {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <CircleIcon sx={{ fontSize: 8, color: 'success.main' }} />
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        in combat
      </Typography>
    </Stack>
  )
}

/** Is there any passive state at all? Decides whether the lens line grows its divider. */
function hasPassiveStatus(snap: CombatSnapshot | null): boolean {
  return (
    !!snap?.stance?.stance || !!snap?.stance?.invocation || !!snap?.poison?.coat.utility || !!snap?.inCombat
  )
}

/** Everything past the lens line's divider is READ-ONLY state, not a control. */
function PassiveStatus({ snap }: { snap: CombatSnapshot | null }): React.JSX.Element | null {
  if (!hasPassiveStatus(snap)) return null
  return (
    <>
      <Divider orientation="vertical" flexItem sx={{ my: 0.25 }} />
      {snap?.stance && <StanceReadout stance={snap.stance} poison={snap.poison} />}
      {snap?.inCombat && <InCombatDot />}
    </>
  )
}

export interface CombatHeaderProps {
  seg: SegmentView | null
  snap: CombatSnapshot | null
  scope: CombatScope
  setScope: (s: CombatScope) => void
  opts: ScopeOptions
  selection: string
  setSelection: (v: string) => void
  loadMore: () => void
  capped: boolean
  hydrating: boolean
  now: number
  view: 'dash' | 'timeline'
  setView: (v: 'dash' | 'timeline') => void
  noTimeline: boolean
  mode: 'out' | 'in'
  setMode: (m: 'out' | 'in') => void
  combinePets: boolean
  setCombinePets: (v: boolean) => void
}

/**
 * SUBJECT, then LENS. The bar used to be a single rank of five same-weight controls plus a raw
 * Switch — a toolbar dump: nothing in it said what you were looking at, so the eye had to read
 * every control to find out. It is now two explicit lines that answer two different questions,
 * in the order you actually ask them (see SubjectLine for line 1).
 *
 * LINE 2 — LENS ("how am I looking at it"), left to right in decreasing consequence: the view
 * switch (the tab's navigation, the only control wearing the accent), the direction filter (dash
 * only), then right-aligned the one setting that changes the numbers (combine pets), and past a
 * divider the purely passive readout — modifier slots and the in-combat dot, which are STATE,
 * not controls.
 *
 * The two lines are EXPLICIT rather than a wrapping row: at the 900px minimum window everything
 * cannot fit on one line, and a wrap point that moves with the fight name is exactly the mess
 * this replaces.
 */
export function CombatHeader(p: CombatHeaderProps): React.JSX.Element {
  return (
    <Paper
      variant="outlined"
      data-testid="combat-header"
      sx={{ flexShrink: 0, px: 1.25, py: 0.75, bgcolor: 'rgba(255,255,255,0.015)' }}
    >
      {/* ── LINE 1: SUBJECT ── */}
      <SubjectLine
        seg={p.seg}
        scope={p.scope}
        setScope={p.setScope}
        opts={p.opts}
        selection={p.selection}
        setSelection={p.setSelection}
        loadMore={p.loadMore}
        capped={p.capped}
        hydrating={p.hydrating}
        now={p.now}
      />

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
        <ViewSwitch view={p.view} setView={p.setView} noTimeline={p.noTimeline} />

        {p.view === 'dash' && <DirectionFilter mode={p.mode} setMode={p.setMode} />}

        <Box sx={{ flexGrow: 1, minWidth: 8 }} />

        <CombinePetsChip combinePets={p.combinePets} setCombinePets={p.setCombinePets} />

        <PassiveStatus snap={p.snap} />
      </Stack>
    </Paper>
  )
}
