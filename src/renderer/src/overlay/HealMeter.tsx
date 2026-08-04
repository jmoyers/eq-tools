import { type JSX, useMemo, useState } from 'react'
import type { OverlayKind } from '@shared/types'
import type { CombatSnapshot, SegmentView } from '@shared/combat'
import { formatNum as fmt, formatHealRate } from '../lib/formatRate'
import { formatTime } from '../lib/formatDate'
import { scopeOptions } from '../features/combat/dashboardData'
import { type OverlaySelectRow } from './OverlaySelect'
import { OverlayHeader } from './OverlayHeader'
import { HealBars, ABSORB_NOTE } from './healBars'
import { ICON_ACCENT_GREEN } from './IconButton'
import { useOverlayChrome, type OverlayChrome } from './useOverlayChrome'
import { useOverlayCombat } from './useOverlayCombat'

/**
 * The floating HEALING overlay (Task #59) — the 'heal-fight' / 'heal-overall' twin of the DPS
 * OverlayMeter. Same window machinery (kind from `?kind=`, per-kind persisted config, locked
 * click-through vs interactive, persisted drill), same selection semantics ('heal-fight' picks a
 * FIGHT, 'heal-overall' picks a ZONE SESSION), and the same bar treatment: labeled stats embedded
 * after the name, `{min} - {max}` ranges, the TOTAL alone at the right end.
 *
 * Its own file on purpose: the damage meter's flattening, category colors and stat run are about
 * damage taxonomy, and healing has none of that. The small amount of shared bar styling is
 * duplicated below rather than extracted, so this component can evolve without touching the DPS
 * overlay.
 *
 * WHAT THE LOG SUPPORTS (and what it does NOT) — the honesty contract this UI keeps:
 *   - EFFECTIVE healing is what a heal line reports; OVERHEAL is real and derived, not invented:
 *     EQ writes `for N (M) hit points` exactly when M > N and omits the parens otherwise.
 *   - HoT ticks are INDISTINGUISHABLE from direct heals (no `healed over time` / `regeneration`
 *     line family exists), so there is no HoT/direct split anywhere in this UI.
 *   - ABSORPTION RANKS AS HEALING, LABELED. Rune grants are a lane in the SAME flat drill list as
 *     the heal spells and count toward the total, because a shield is sustain. It is told apart
 *     by its own cool COLOR and by WORDING — "Rune", "granted", "absorbed" in the stat run —
 *     never by a chip: a badge overflowed the bar at overlay width, and the color plus the words
 *     already say it. The honesty note (absorption GRANTED, not consumed) lives in the hover
 *     title, not in inline chrome. Absorption is never called restored hit points and never
 *     shows an overheal (a rune has none, and one is not invented for it).
 *   - The other two absorption families (absorbed swings, absorbed damage-shield ticks) carry NO
 *     amount at all, so they are COUNTS in the footer — never a bar, never in a total.
 *
 * DRILL SHAPE: healer → ONE flat ranked list of lanes (`Lay on Hands VI · Healing · Rune`). No
 * grouping level, deliberately: removing the category level is what made the damage drill-down
 * legible, and a separate "absorption" section here would repeat that mistake.
 */

// Palette. The overlay has no MUI theme, so it carries its own colors — a green-leaning ramp so a
// pinned healing meter is never confused with the gold DPS one at a glance.
const HEAL_GOLD = '#7fd1a0'

const LIVE = '__live__'

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

/** Everything the chrome renders, resolved from one snapshot in one place. */
interface HealView {
  seg: SegmentView | undefined
  live: boolean
  headerName: string
  durationSec: number
  totalHps: number
  totalTitle: string
}

/**
 * HYDRATION (Task #56): while the engine replays the log every snapshot is HISTORICAL. Render
 * quiet and empty until the tail takes over rather than churning through hours-old pulls.
 *
 * The stat line's rate includes absorption, so the stat line is also where the split (and the
 * assumption behind it) is available on hover. One line, no methodology panel.
 */
/** The selected segment, or nothing at all while the engine is still replaying the log. */
function selectedSeg(snap: CombatSnapshot | null): {
  hydrating: boolean
  seg: SegmentView | undefined
} {
  const hydrating = snap?.hydrating ?? true
  return { hydrating, seg: hydrating ? undefined : snap?.selected ?? undefined }
}

function healView(snap: CombatSnapshot | null, isFight: boolean): HealView {
  const { hydrating, seg } = selectedSeg(snap)
  const healing = seg?.healing
  const totalHps = healing?.hps ?? 0
  const totalTitle = healing
    ? absorbTitle(healing.total, healing.restoredTotal, healing.absorbedTotal)
    : ''
  const live = !hydrating && !!snap?.inCombat
  const durationSec = seg?.durationSec ?? 0
  return { seg, live, headerName: headerNameFor(hydrating, seg, isFight), durationSec, totalHps, totalTitle }
}

/** "Reading log…" during hydration, then the segment's name — never a borrowed one. */
function headerNameFor(hydrating: boolean, seg: SegmentView | undefined, isFight: boolean): string {
  if (hydrating) return 'Reading log…'
  return seg?.name ?? (isFight ? 'No fight' : 'No zone')
}

/** The hover title on the header's rate: the restored/absorbed split when there is one. */
function absorbTitle(total: number, restored: number, absorbed: number): string {
  return absorbed > 0
    ? `${fmt(total)} total · ${fmt(restored)} restored + ${fmt(absorbed)} absorbed. ${ABSORB_NOTE}`
    : `${fmt(total)} healing restored`
}

/**
 * Scope-filtered selector rows — the SAME helper the damage meters use, so a heal-fight overlay
 * lists only fights (never crossing over to zone sessions between pulls) and heal-overall lists
 * only zone sessions. Rate is omitted: a fight's dps is not this meter's subject, and the name +
 * timing already disambiguate same-named pulls.
 */
function healSelectRows(snap: CombatSnapshot | null, isFight: boolean, now: number): OverlaySelectRow[] {
  if (snap?.hydrating !== false) return []
  const { head, rest } = scopeOptions(
    isFight ? 'fight' : 'overall',
    snap.segments ?? [],
    snap.zoneSessions ?? []
  )
  return [...(head ? [head] : []), ...rest].map((o) => ({
    value: o.value,
    label: o.label,
    rate: '',
    timing: [o.startTs ? formatTime(o.startTs) : '', relativeAge(o.startTs, now), o.durationSec > 0 ? fmtDur(o.durationSec) : o.live ? 'live' : '—']
      .filter(Boolean)
      .join(' · '),
    live: o.live
  }))
}

export default function HealMeter(): JSX.Element {
  // `kind` comes from the preload bridge (read from the window's ?kind= query). Fall back to
  // 'heal-fight' if the bridge is momentarily absent (e.g. an HMR reload before preload re-runs).
  const kind: OverlayKind = window.eqOverlay?.kind ?? 'heal-fight'
  const isFight = kind !== 'heal-overall'
  // Selection mirrors the damage pair exactly: LIVE / a finalized fight id, or 'zone' / a zs<n>.
  const [selection, setSelection] = useState<string>(isFight ? LIVE : 'zone')

  // combinePets folds pet DAMAGE into You; healing rows are keyed by HEALER regardless, so this
  // only affects the (unused here) damage bars. Kept aligned with the fight overlay's choice.
  const snap = useOverlayCombat(selection === LIVE ? undefined : selection, isFight)
  const { locked, bgAlpha, topN, drill, hovering, patch, setDrill, toggleLock, onEnter, onLeave, dragRegion, noDrag } =
    useOverlayChrome()
  const now = Date.now()

  const { seg, live, headerName, durationSec, totalHps, totalTitle } = healView(snap, isFight)
  const selectRows = useMemo(
    () => healSelectRows(snap, isFight, now),
    // Same deps as before the extraction: the two lists the rows are built from, plus the
    // clock that ages them.
    [snap, isFight, now]
  )

  /** A drill is per-segment: picking a different fight / zone session undrills. On the change
   *  handler, NOT an effect — an effect fires on mount (twice under StrictMode) and would clear
   *  the drill we just hydrated. */
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
        border: locked ? '1px solid rgba(255,255,255,0.04)' : `1px solid rgba(127,209,160,0.4)`,
        borderRadius: 8,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      {/* Header AND selector, one row — same treatment as the damage pair: the title is the
          selected segment's name, and interactive mode makes the row the trigger. */}
      <OverlayHeader
        live={live}
        tag={isFight ? 'HEAL · FIGHT' : 'HEAL · ZONE'}
        title={headerName}
        titleColor={HEAL_GOLD}
        tail={`${fmtDur(durationSec)} · ${formatHealRate(totalHps)}`}
        tailTitle={totalTitle}
        iconAccentBg={ICON_ACCENT_GREEN}
        select={{ rows: selectRows, value: selection, onChange: selectSegment, accent: HEAL_GOLD }}
        chrome={{ locked, hovering, dragRegion, noDrag, toggleLock }}
      />

      {/* Bars + mini drill-down. Locked mode RENDERS the remembered drill read-only (no setter ⇒
          no click targets, no cursors, no back chevron) so the window stays click-through. */}
      <div style={{ flexGrow: 1, overflow: 'auto', padding: '4px 6px' }}>
        <HealBars seg={seg} topN={topN} drill={drill} setDrill={locked ? null : setDrill} live={live} />
      </div>

      {!locked && <HealFooter bgAlpha={bgAlpha} topN={topN} patch={patch} noDrag={noDrag} />}
    </div>
  )
}

/** Footer controls — interactive mode only: bg-alpha slider + top-N toggle. */
function HealFooter({
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
        style={{ flexGrow: 1, accentColor: HEAL_GOLD, height: 4 }}
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
