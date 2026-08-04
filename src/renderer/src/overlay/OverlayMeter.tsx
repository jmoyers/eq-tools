import { type JSX, useState } from 'react'
import type { OverlayKind } from '@shared/types'
import type { CombatSnapshot, SegmentView } from '@shared/combat'
import { formatRate } from '../lib/formatRate'
import { formatTime } from '../lib/formatDate'
import {
  LIVE_SELECTION,
  defaultSelection,
  scopeOptions,
  type ScopeOption
} from '../features/combat/dashboardData'
import { type OverlaySelectRow } from './OverlaySelect'
import { OverlayHeader } from './OverlayHeader'
import { MeterBars } from './meterBars'
import { useOverlayChrome, type OverlayChrome } from './useOverlayChrome'
import { useOverlayCombat } from './useOverlayCombat'

// Palette (matches the app's combat colors; the overlay has no MUI theme).
const GOLD = '#d9b25f'

/** The "head row" sentinel — one definition, shared with the main view (dashboardData). */
const LIVE = LIVE_SELECTION

function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Coarse, live-updating relative age for selector rows (Task #54 disambiguation timing). */
function relativeAge(ts: number, now: number): string {
  if (!ts) return ''
  const secs = Math.max(0, (now - ts) / 1000)
  if (secs < 45) return 'now'
  const mins = secs / 60
  if (mins < 60) return `${Math.round(mins)}m`
  const hrs = mins / 60
  if (hrs < 36) return `${Math.round(hrs)}h`
  return `${Math.round(hrs / 24)}d`
}

/**
 * The dense disambiguation line under a selector row: start clock · coarse age · duration
 * (the still-running zone session says 'live' instead of a length it doesn't have yet).
 * Same information as the main view's selector, spelled terser for an 11px overlay.
 */
function overlayTiming(o: ScopeOption, now: number): string {
  const bits: string[] = []
  if (o.startTs) bits.push(formatTime(o.startTs))
  const age = relativeAge(o.startTs, now)
  if (age) bits.push(age)
  bits.push(o.durationSec > 0 ? fmtDur(o.durationSec) : o.live ? 'live' : '—')
  return bits.join(' · ')
}

/** Scope-filtered rows for the overlay selector: head first, then the rest. */
function selectorRows(head: ScopeOption | null, rest: ScopeOption[], now: number): OverlaySelectRow[] {
  return [...(head ? [head] : []), ...rest].map((o) => ({
    value: o.value,
    label: o.label,
    rate: formatRate(o.dps),
    timing: overlayTiming(o, now),
    live: o.live
  }))
}

/** Everything the chrome renders, resolved from one snapshot in one place. */
interface MeterView {
  seg: SegmentView | undefined
  live: boolean
  headerName: string
  durationSec: number
  totalDps: number
  rows: OverlaySelectRow[]
  /** on the head row, but the head row is the LAST (finished) fight — never dress it up as live */
  headIsLast: boolean
}

/** Header title + live dot + rate/duration for the selected segment. */
function headerFor(
  snap: CombatSnapshot | null,
  seg: SegmentView | undefined,
  isFight: boolean,
  hydrating: boolean
): Pick<MeterView, 'live' | 'headerName' | 'durationSec' | 'totalDps'> {
  return {
    live: !hydrating && !!snap?.inCombat,
    headerName: hydrating ? 'Reading log…' : seg?.name ?? (isFight ? 'No fight' : 'No zone'),
    durationSec: seg?.durationSec ?? 0,
    totalDps: seg?.outDps ?? 0
  }
}

/** Selector options — ONE scope's rows, filtered by the shared helper the main view uses. */
function scopeRows(
  snap: CombatSnapshot | null,
  isFight: boolean,
  hydrating: boolean,
  now: number
): { rows: OverlaySelectRow[]; head: ScopeOption | null } {
  const opts = scopeOptions(
    isFight ? 'fight' : 'overall',
    hydrating ? [] : snap?.segments ?? [],
    hydrating ? [] : snap?.zoneSessions ?? []
  )
  return { rows: selectorRows(opts.head, opts.rest, now), head: opts.head }
}

/**
 * HYDRATION (Task #56): while the engine replays the log, every snapshot is a HISTORICAL
 * moment — an overlay pinned over the game would churn through hours-old pulls as if they
 * were live. Render quiet and empty until the tail takes over (the main window shows the
 * same "Reading log…" state); one flag gates the whole surface.
 */
function meterView(
  snap: CombatSnapshot | null,
  isFight: boolean,
  selection: string,
  now: number
): MeterView {
  const hydrating = snap?.hydrating ?? true
  const seg = hydrating ? undefined : snap?.selected ?? undefined
  const { rows, head } = scopeRows(snap, isFight, hydrating, now)
  return {
    seg,
    ...headerFor(snap, seg, isFight, hydrating),
    rows,
    headIsLast: selection === LIVE && !!head && !head.live
  }
}

export default function OverlayMeter(): JSX.Element {
  // `kind` comes from the preload bridge (read from the window's ?kind= query). Fall back to
  // 'fight' if the bridge is momentarily absent (e.g. an HMR reload before the preload re-runs).
  const kind: OverlayKind = window.eqOverlay?.kind ?? 'fight'
  const isFight = kind === 'fight'
  // Selection is SCOPED to this overlay's kind and never crosses over: a 'fight' overlay lists
  // (and shows) only fights — the current one while a pull is open, else the LAST one — and a
  // 'overall' overlay lists only zone sessions. A fight meter silently becoming a zone meter
  // between pulls was the same bug the Combat tab had.
  const [selection, setSelection] = useState<string>(defaultSelection(isFight ? 'fight' : 'overall'))

  const snap = useOverlayCombat(selection === LIVE ? undefined : selection, isFight)
  const { locked, bgAlpha, topN, drill, hovering, patch, setDrill, toggleLock, onEnter, onLeave, dragRegion, noDrag } =
    useOverlayChrome()

  const { seg, live, headerName, durationSec, totalDps, rows, headIsLast } = meterView(
    snap,
    isFight,
    selection,
    Date.now()
  )

  /** A drill is per-segment: picking a different fight / zone session undrills. This lives on the
   *  selector's change handler, NOT in an effect keyed on `selection` — an effect fires on mount
   *  (twice, under StrictMode) and would clear the drill we just hydrated. Only genuine user
   *  actions — this and the back chevron — ever clear the stored value. */
  const selectSegment = (id: string): void => {
    setSelection(id)
    setDrill(null)
  }

  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, "Segoe UI", Roboto, system-ui, sans-serif',
        color: '#f2f2f2',
        background: `rgba(14,17,21,${bgAlpha})`,
        border: locked ? '1px solid rgba(255,255,255,0.04)' : `1px solid rgba(217,178,95,0.4)`,
        borderRadius: 8,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      {/* Header AND selector, one row: the title is the selected segment's own name, and in
          interactive mode the row is the trigger — clicking it drops the fight/zone list under
          the header. A locked overlay gets the same row minus every affordance. */}
      <OverlayHeader
        live={live}
        tag={isFight ? 'FIGHT' : 'ZONE'}
        last={headIsLast}
        title={headerName}
        titleColor={GOLD}
        tail={`${fmtDur(durationSec)} · ${formatRate(totalDps)}`}
        select={{ rows, value: selection, onChange: selectSegment, accent: GOLD }}
        chrome={{ locked, hovering, dragRegion, noDrag, toggleLock }}
      />

      {/* Bars + mini drill-down. Locked mode RENDERS the remembered drill (the pinned "damage by
          type" breakdown the user plays with) but hands MeterBars no setter, so there are no
          click targets, no pointer cursors and no back chevron — the window stays click-through. */}
      <div style={{ flexGrow: 1, overflow: 'auto', padding: '4px 6px' }}>
        <MeterBars seg={seg} topN={topN} drill={drill} setDrill={locked ? null : setDrill} live={live} />
      </div>

      {!locked && <MeterFooter bgAlpha={bgAlpha} topN={topN} patch={patch} noDrag={noDrag} />}
    </div>
  )
}

/** Footer controls — interactive mode only: bg-alpha slider + top-N toggle. */
function MeterFooter({
  bgAlpha,
  topN,
  patch,
  noDrag
}: {
  bgAlpha: number
  topN: number
  patch: OverlayChrome['patch']
  noDrag: React.CSSProperties
}): JSX.Element {
  return (
    <div
      style={{
        ...noDrag,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 8px 5px',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        fontSize: 10,
        color: 'rgba(255,255,255,0.6)',
        flexShrink: 0
      }}
    >
      <span title="Background opacity">bg</span>
      <input
        type="range"
        min={0.1}
        max={1}
        step={0.02}
        value={bgAlpha}
        onChange={(e) => patch({ bgAlpha: Number(e.target.value) })}
        style={{ flexGrow: 1, accentColor: GOLD, height: 4 }}
      />
      <button
        type="button"
        onClick={() => patch({ topN: topN >= 10 ? 5 : 10 })}
        title="Toggle number of rows"
        style={{
          background: 'rgba(255,255,255,0.06)',
          color: 'inherit',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 4,
          padding: '1px 6px',
          cursor: 'pointer',
          fontSize: 10
        }}
      >
        top {topN}
      </button>
    </div>
  )
}
