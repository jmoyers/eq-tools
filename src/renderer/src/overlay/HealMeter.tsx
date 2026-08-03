import { useEffect, useMemo, useRef, useState } from 'react'
import type { OverlayConfig, OverlayDrill, OverlayKind } from '@shared/types'
import type { HealSourceView, HealSpellView, MitigationView, SegmentView } from '@shared/combat'
import { formatNum as fmt, formatHealRate } from '../lib/formatRate'
import { formatTime } from '../lib/formatDate'
import { scopeOptions } from '../features/combat/dashboardData'
import { OverlaySelect, type OverlaySelectRow } from './OverlaySelect'
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
/** Absorption is a different KIND of number, so it gets a deliberately different, cooler hue —
 *  a rune bar can never be mistaken for a green "hit points restored" bar at a glance. */
const MIT_COLOR = '#8fb8d8'
const KIND_COLOR: Record<string, string> = {
  you: '#7fd1a0',
  pet: '#6fb3d2',
  other: '#a98fe0',
  enemy: '#cf6679'
}

/** The one honest line about the assumption, surfaced on hover (never as a caption). */
const ABSORB_NOTE =
  'The log records absorption GRANTED, not consumed — counted here as effective sustain.'

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

const pct = (n: number): string => `${Math.round(n)}%`

/** A single horizontal bar: label + right-text + pct-fill. Same treatment as the DPS overlay. */
function Bar({
  color,
  pct: fill,
  rank,
  label,
  right,
  onClick,
  accent,
  title
}: {
  color: string
  pct: number
  rank?: number
  label: React.ReactNode
  right: string
  onClick?: () => void
  accent?: string
  title?: string
}): JSX.Element {
  return (
    <div
      onClick={onClick}
      title={title}
      style={{
        position: 'relative',
        height: 18,
        borderRadius: 3,
        marginBottom: 2,
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        background: 'rgba(255,255,255,0.06)'
      }}
    >
      <div style={{ position: 'absolute', inset: 0, width: `${Math.max(2, fill)}%`, background: color, opacity: 0.55 }} />
      {accent && <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: accent }} />}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          padding: accent ? '0 6px 0 9px' : '0 6px',
          gap: 6,
          fontSize: 11,
          lineHeight: 1,
          textShadow: '0 1px 2px rgba(0,0,0,0.9)'
        }}
      >
        {rank != null && (
          <span style={{ color: 'rgba(255,255,255,0.55)', width: 12, textAlign: 'right' }}>{rank}</span>
        )}
        <span style={{ fontWeight: 600, flexGrow: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
        <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{right}</span>
      </div>
    </div>
  )
}

type Drill = OverlayDrill

/**
 * The per-spell stat run, embedded INSIDE the bar after the name — the same form the DPS overlay
 * uses (`12% miss · 3 - 145dmg`), carrying the stats healing actually has:
 *   `18% over · 4 - 472`
 * Density comes from carrying FEWER stats, never from compressing labels. The row TOTAL is not
 * here — it owns the right end of the bar. Full, labeled figures live in the hover `title`.
 */
/** `{min} - {max}`, collapsed to a single figure when every tick was the same size. */
function range(min: number | undefined, max: number): string {
  const lo = min ?? 0
  return lo !== max ? `${fmt(lo)} - ${fmt(max)}` : `${fmt(max)}`
}

const isAbsorb = (r: { classification: string }): boolean => r.classification === 'absorbed'

function spellStat(s: HealSpellView): string {
  // An absorption lane has no overheal and no crits by construction — showing "0% over" would
  // imply the log measured something it never records.
  if (isAbsorb(s)) return `${s.count}x · ${range(s.min, s.max)} granted`
  const parts: string[] = []
  const over = s.total + s.overheal > 0 ? (s.overheal / (s.total + s.overheal)) * 100 : 0
  if (s.overheal > 0) parts.push(`${pct(over)} over`)
  parts.push(range(s.min, s.max))
  return parts.join(' · ')
}

function spellTitle(s: HealSpellView): string {
  if (isAbsorb(s)) {
    return `${s.name} (absorbed) — ${fmt(s.total)} absorption granted over ${s.count} runes · range ${range(s.min, s.max)}. ${ABSORB_NOTE}`
  }
  const over = s.total + s.overheal > 0 ? (s.overheal / (s.total + s.overheal)) * 100 : 0
  const bits = [
    `${fmt(s.total)} effective`,
    `${s.count} ticks`,
    `avg ${fmt(Math.round(s.total / Math.max(1, s.count)))}`
  ]
  if (s.crits > 0) bits.push(`${s.crits} crits (${pct((s.crits / Math.max(1, s.count)) * 100)})`)
  if (s.overheal > 0) {
    bits.push(`${fmt(s.overheal)} overheal (${pct(over)} of raw)`)
    if (s.fullOverheal > 0) bits.push(`${s.fullOverheal} landed on a full health bar`)
  } else {
    bits.push('no overheal recorded')
  }
  bits.push((s.min ?? 0) !== s.max ? `range ${range(s.min, s.max)}` : `always ${fmt(s.max)}`)
  const note =
    s.name === 'Unspecified' ? ' — the log named no spell on these lines' : ''
  return `${s.name}${note} — ${bits.join(' · ')}`
}

function healerStat(h: HealSourceView): string {
  // A row can be MIXED, so the stats describe its RESTORED half and the absorbed share is called
  // out separately — never averaged in as if it were a heal.
  const parts = h.count > 0 ? [`${h.count}x`] : []
  if (h.crits > 0) parts.push(`${pct(h.critPct)} crit`)
  if (h.overheal > 0) parts.push(`${pct(h.overhealPct)} over`)
  if (h.absorbedTotal > 0) parts.push(`${fmt(h.absorbedTotal)} absorbed`)
  return parts.join(' · ')
}

function healerTitle(h: HealSourceView): string {
  const restored = h.total - h.absorbedTotal
  const bits = [`${fmt(restored)} restored`, `${h.count} heals`]
  if (h.crits > 0) bits.push(`${h.crits} crits (${pct(h.critPct)})`)
  if (h.overheal > 0) {
    bits.push(`${fmt(h.overheal)} overheal (${pct(h.overhealPct)} of raw)`)
    if (h.fullOverheal > 0) bits.push(`${h.fullOverheal} fully wasted`)
  } else if (h.count > 0) {
    bits.push('no overheal recorded')
  }
  if (h.count > 0) {
    bits.push((h.min ?? 0) !== h.max ? `range ${range(h.min, h.max)}` : `always ${fmt(h.max)}`)
  }
  // THE ASSUMPTION LIVES HERE (plus the header's total). One line, on hover, no methodology.
  if (h.absorbedTotal > 0) bits.push(`+ ${fmt(h.absorbedTotal)} absorbed. ${ABSORB_NOTE}`)
  return `${h.name} — ${bits.join(' · ')}`
}

/** True when the amount-less absorption families have anything to say. */
const hasCounts = (mit: MitigationView | undefined): boolean =>
  !!mit && (mit.absorbedSwings > 0 || mit.absorbedDamageShields > 0)

/**
 * The COUNT-ONLY absorption families. The rune lane is not here any more — it has an amount, so
 * it ranks among the bars above as an `absorbed` row. These two do not: the log gives them no
 * number at all, so they are counts under the bars, in no total, never a bar (a bar would imply
 * a magnitude that was never recorded).
 */
function AbsorbCounts({ mit }: { mit: MitigationView }): JSX.Element | null {
  if (!hasCounts(mit)) return null
  return (
    <div
      style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', padding: '5px 2px 0', lineHeight: 1.5 }}
      title="The log records these as events with no amount, so they are shown as counts and enter no total."
    >
      {mit.absorbedSwings > 0 && <>{mit.absorbedSwings} swings absorbed</>}
      {mit.absorbedSwings > 0 && mit.absorbedDamageShields > 0 && ' · '}
      {mit.absorbedDamageShields > 0 && <>{mit.absorbedDamageShields} damage shields absorbed</>}
      <span style={{ color: 'rgba(255,255,255,0.35)' }}> · no amount logged</span>
    </div>
  )
}

/** The bar body: healers → that healer's spell list, driven by the drill state.
 *  `setDrill` is null in locked mode: the same levels render, minus every affordance. */
function HealBars({
  seg,
  topN,
  drill,
  setDrill,
  live
}: {
  seg: SegmentView | undefined
  topN: number
  drill: Drill | null
  setDrill: ((d: Drill | null) => void) | null
  live: boolean
}): JSX.Element {
  const healing = seg?.healing
  const rows = useMemo(() => (healing?.healers ?? []).slice(0, topN), [healing, topN])
  // A stale drill falls back to level 1 for THIS render only — the persisted value is untouched,
  // so it re-applies the moment that healer is back in the segment (same rule as the DPS overlay).
  const drilled = drill && healing ? healing.healers.find((h) => h.id === drill.entityId) : undefined
  const mit = healing?.mitigation

  if (!healing || (!drilled && rows.length === 0)) {
    // A quiet state, not a zeroed meter. The amount-less absorption families can still have
    // fired with nothing to rank (swings eaten by a rune granted before this fight), so show
    // those counts rather than go blank. A rune GRANT would have produced a row above.
    return (
      <>
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
          {live ? 'No healing yet…' : 'Waiting for healing…'}
        </div>
        {mit && <AbsorbCounts mit={mit} />}
      </>
    )
  }

  // Level 2: the healer's spells.
  if (drilled) {
    return (
      <Crumb name={drilled.name} onBack={setDrill ? () => setDrill(null) : null}>
        {/* ONE flat ranked list: heal spells and the absorption lane together, biggest first.
            No grouping level — that is what hid the flat breakdown in the damage drill-down.
            The absorption lane is told apart by COLOR + chip, never by where it sits. */}
        {drilled.spells.map((s) => (
          <Bar
            key={`${s.classification}:${s.name}`}
            color={isAbsorb(s) ? MIT_COLOR : KIND_COLOR[drilled.kind] ?? '#888'}
            accent={isAbsorb(s) ? MIT_COLOR : KIND_COLOR[drilled.kind] ?? '#888'}
            pct={s.pct}
            label={
              <>
                {s.name}
                {/* Heal lines that named no spell get an explicit, labeled lane — never folded
                    silently into a real spell's numbers. */}
                {s.name === 'Unspecified' && (
                  <span style={{ color: 'rgba(255,255,255,0.45)', fontWeight: 400 }}> ~no spell named</span>
                )}
                {/* The classification as a plain suffix, matching this file's existing `·pet` /
                    `·enemy` convention — no badge, so it can never overflow the bar. */}
                {isAbsorb(s) && (
                  <span style={{ color: 'rgba(255,255,255,0.5)', fontWeight: 400 }}> ·absorbed</span>
                )}
                <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.62)', fontWeight: 400 }}>
                  {spellStat(s)}
                </span>
              </>
            }
            right={fmt(s.total)}
            title={spellTitle(s)}
          />
        ))}
      </Crumb>
    )
  }

  // Level 1: healers, then the absorption section.
  return (
    <>
      {rows.map((h, i) => (
        <Bar
          key={h.id}
          color={KIND_COLOR[h.kind] ?? '#888'}
          // A row carrying absorption gets the cool accent stripe, so it reads as mixed before a
          // single number is read. The split itself is in the stat run and the drill.
          accent={h.absorbedTotal > 0 ? MIT_COLOR : undefined}
          pct={h.pct}
          rank={i + 1}
          label={
            <>
              {h.name}
              {h.kind === 'pet' ? ' ·pet' : h.kind === 'enemy' ? ' ·enemy' : ''}
              <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.62)', fontWeight: 400 }}>
                {healerStat(h)}
              </span>
            </>
          }
          right={`${formatHealRate(h.hps)} · ${fmt(h.total)}`}
          onClick={setDrill ? () => setDrill({ entityId: h.id }) : undefined}
          title={healerTitle(h)}
        />
      ))}
      {mit && <AbsorbCounts mit={mit} />}
      {/* Counter-healing is an ANNOTATION on your damage, not part of your sustain, so it never
          enters the ranking above — it gets one honest line. */}
      {healing.enemyTotal > 0 && (
        <div
          style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', padding: '6px 2px 0' }}
          title={`Healing that landed on mobs you were engaged with — it undid this much of your damage. Top: ${healing.enemyHealers
            .slice(0, 3)
            .map((h) => `${h.name} ${fmt(h.total)}`)
            .join(', ')}`}
        >
          enemies healed {fmt(healing.enemyTotal)}
        </div>
      )}
    </>
  )
}

/** A crumb header for the drill level: a back chevron when interactive, static text when locked. */
function Crumb({
  name,
  onBack,
  children
}: {
  name: string
  onBack: (() => void) | null
  children: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <div
        onClick={onBack ?? undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          cursor: onBack ? 'pointer' : 'default',
          fontSize: 11,
          color: 'rgba(255,255,255,0.7)',
          marginBottom: 3
        }}
      >
        <span style={{ fontSize: 13 }}>{onBack ? '‹' : '·'}</span>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
      </div>
      {children}
    </div>
  )
}

export default function HealMeter(): JSX.Element {
  // `kind` comes from the preload bridge (read from the window's ?kind= query). Fall back to
  // 'heal-fight' if the bridge is momentarily absent (e.g. an HMR reload before preload re-runs).
  const kind: OverlayKind = window.eqOverlay?.kind ?? 'heal-fight'
  const isFight = kind !== 'heal-overall'
  const [cfg, setCfg] = useState<OverlayConfig | null>(null)
  // Selection mirrors the damage pair exactly: LIVE / a finalized fight id, or 'zone' / a zs<n>.
  const [selection, setSelection] = useState<string>(isFight ? LIVE : 'zone')
  const [hovering, setHovering] = useState(false)
  const hoveringRef = useRef(false)

  // combinePets folds pet DAMAGE into You; healing rows are keyed by HEALER regardless, so this
  // only affects the (unused here) damage bars. Kept aligned with the fight overlay's choice.
  const snap = useOverlayCombat(selection === LIVE ? undefined : selection, isFight)

  useEffect(() => {
    void window.eqOverlay.getConfig().then(setCfg)
    return window.eqOverlay.onConfig(setCfg)
  }, [])

  const locked = cfg?.locked ?? false
  const bgAlpha = cfg?.bgAlpha ?? 0.72
  const topN = cfg?.topN ?? 5
  const drill = cfg?.drill ?? null
  const now = Date.now()

  // HYDRATION (Task #56): while the engine replays the log every snapshot is HISTORICAL. Render
  // quiet and empty until the tail takes over rather than churning through hours-old pulls.
  const hydrating = snap?.hydrating ?? true
  const seg = hydrating ? undefined : snap?.selected ?? undefined
  const live = !hydrating && !!snap?.inCombat

  const headerName = hydrating ? 'Reading log…' : seg?.name ?? (isFight ? 'No fight' : 'No zone')
  const durationSec = seg?.durationSec ?? 0
  const healing = seg?.healing
  const totalHps = healing?.hps ?? 0
  // The stat line's rate now includes absorption, so the stat line is where the split (and the
  // assumption behind it) is available on hover. One line, no methodology panel.
  const totalTitle = healing
    ? healing.absorbedTotal > 0
      ? `${fmt(healing.total)} total · ${fmt(healing.restoredTotal)} restored + ${fmt(healing.absorbedTotal)} absorbed. ${ABSORB_NOTE}`
      : `${fmt(healing.total)} healing restored`
    : ''

  // Scope-filtered selector rows — the SAME helper the damage meters use, so a heal-fight
  // overlay lists only fights (never crossing over to zone sessions between pulls) and
  // heal-overall lists only zone sessions. Rate is omitted: a fight's dps is not this
  // meter's subject, and the name + timing already disambiguate same-named pulls.
  const selectRows: OverlaySelectRow[] = useMemo(() => {
    if (hydrating) return []
    const { head, rest } = scopeOptions(
      isFight ? 'fight' : 'overall',
      snap?.segments ?? [],
      snap?.zoneSessions ?? []
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
  }, [hydrating, isFight, snap?.segments, snap?.zoneSessions, now])

  const patch = (p: Partial<OverlayConfig>): void => {
    setCfg((c) => (c ? { ...c, ...p } : c))
    void window.eqOverlay.setConfig(p)
  }
  const setDrill = (d: Drill | null): void => patch({ drill: d })

  /** A drill is per-segment: picking a different fight / zone session undrills. On the change
   *  handler, NOT an effect — an effect fires on mount (twice under StrictMode) and would clear
   *  the drill we just hydrated. */
  const selectSegment = (id: string): void => {
    setSelection(id)
    setDrill(null)
  }

  const toggleLock = (): void => {
    const next = !locked
    window.eqOverlay.setLocked(next)
    patch({ locked: next })
    if (next) setHoverCapture(false)
  }

  const setHoverCapture = (capture: boolean): void => {
    if (hoveringRef.current === capture) return
    hoveringRef.current = capture
    setHovering(capture)
    window.eqOverlay.setIgnoreMouse(!capture)
  }
  const onEnter = (): void => {
    if (locked) setHoverCapture(true)
  }
  const onLeave = (): void => {
    if (locked) setHoverCapture(false)
  }

  const dragRegion = !locked ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : {}
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

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
      {/* Header: kind tag + encounter/zone name + duration + live dot. Drag handle when interactive. */}
      <div
        style={{
          ...dragRegion,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          fontSize: 11,
          flexShrink: 0
        }}
      >
        <span
          title={live ? 'In combat' : 'Idle'}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            flexShrink: 0,
            background: live ? '#5fbf72' : 'rgba(255,255,255,0.25)',
            boxShadow: live ? '0 0 5px #5fbf72' : 'none'
          }}
        />
        <span
          style={{
            fontSize: 8,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            color: 'rgba(255,255,255,0.4)',
            flexShrink: 0
          }}
        >
          {isFight ? 'HEAL · FIGHT' : 'HEAL · ZONE'}
        </span>
        <span
          style={{ fontWeight: 700, color: HEAL_GOLD, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexGrow: 1 }}
        >
          {headerName}
        </span>
        <span
          title={totalTitle}
          style={{ color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
        >
          {fmtDur(durationSec)} · {formatHealRate(totalHps)}
        </span>

        {(!locked || hovering) && (
          <div style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 2, marginLeft: 2 }}>
            <IconButton title={locked ? 'Unlock (interactive)' : 'Lock (click-through)'} onClick={toggleLock} accent={locked}>
              {locked ? '🔓' : '📌'}
            </IconButton>
            {!locked && (
              <IconButton title="Close overlay" onClick={() => window.eqOverlay.close()} danger>
                ✕
              </IconButton>
            )}
          </div>
        )}
      </div>

      {/* Selector — interactive mode only. Same rows as the damage pair's selector. */}
      {!locked && (
        <div style={{ ...noDrag, padding: '4px 8px 2px', flexShrink: 0 }}>
          <OverlaySelect
            rows={selectRows}
            value={selection}
            onChange={selectSegment}
            accent={HEAL_GOLD}
            emptyLabel={isFight ? 'No fights yet' : 'No zone sessions yet'}
            noDragStyle={noDrag}
          />
        </div>
      )}

      {/* Bars + mini drill-down. Locked mode RENDERS the remembered drill read-only (no setter ⇒
          no click targets, no cursors, no back chevron) so the window stays click-through. */}
      <div style={{ flexGrow: 1, overflow: 'auto', padding: '4px 6px' }}>
        <HealBars seg={seg} topN={topN} drill={drill} setDrill={locked ? null : setDrill} live={live} />
      </div>

      {/* Footer controls — interactive mode only: bg-alpha slider + top-N toggle. */}
      {!locked && (
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
      )}
    </div>
  )
}

/** A small square icon button (plain, no MUI — the overlay bundle stays lean). */
function IconButton({
  onClick,
  title,
  children,
  danger,
  accent
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
  danger?: boolean
  accent?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        width: 20,
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        fontSize: 11,
        lineHeight: 1,
        background: accent ? 'rgba(127,209,160,0.2)' : 'transparent',
        color: danger ? '#cf6679' : 'inherit',
        padding: 0
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.14)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = accent ? 'rgba(127,209,160,0.2)' : 'transparent')}
    >
      {children}
    </button>
  )
}
