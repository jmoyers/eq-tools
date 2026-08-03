// healBars — the healing overlay's BAR BODY: the ranked healer list and, one click down, that
// healer's flat spell list (heal lanes and the absorption lane together). Split out of
// HealMeter so that file is the window chrome (header, selector, footer) and this one is the
// meter itself.
//
// MUI-FREE ON PURPOSE: the overlay is its own renderer entry (overlay.html) with no theme and
// no component library. Do not import @mui/* into this bundle.

import type { JSX } from 'react'
import { useMemo } from 'react'
import type { OverlayDrill } from '@shared/types'
import type { HealSourceView, HealSpellView, MitigationView, SegmentView } from '@shared/combat'
import { formatNum as fmt, formatHealRate } from '../lib/formatRate'

/** Absorption is a different KIND of number, so it gets a deliberately different, cooler hue —
 *  a rune bar can never be mistaken for a green "hit points restored" bar at a glance. */
export const MIT_COLOR = '#8fb8d8'
const KIND_COLOR: Record<string, string> = {
  you: '#7fd1a0',
  pet: '#6fb3d2',
  other: '#a98fe0',
  enemy: '#cf6679'
}

/** The one honest line about the assumption, surfaced on hover (never as a caption). */
export const ABSORB_NOTE =
  'The log records absorption GRANTED, not consumed — counted here as effective sustain.'

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

export type Drill = OverlayDrill

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
  return lo !== max ? `${fmt(lo)} - ${fmt(max)}` : fmt(max)
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

/**
 * A quiet state, not a zeroed meter. The amount-less absorption families can still have fired
 * with nothing to rank (swings eaten by a rune granted before this fight), so show those counts
 * rather than go blank. A rune GRANT would have produced a row above.
 */
function NothingToRank({ live, mit }: { live: boolean; mit: MitigationView | undefined }): JSX.Element {
  return (
    <>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
        {live ? 'No healing yet…' : 'Waiting for healing…'}
      </div>
      {mit && <AbsorbCounts mit={mit} />}
    </>
  )
}

/** The bar body: healers → that healer's spell list, driven by the drill state.
 *  `setDrill` is null in locked mode: the same levels render, minus every affordance. */
export function HealBars({
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

  if (!healing || (!drilled && rows.length === 0)) return <NothingToRank live={live} mit={mit} />

  // Level 2: the healer's spells.
  if (drilled) {
    return (
      <Crumb name={drilled.name} onBack={setDrill ? () => setDrill(null) : null}>
        {/* ONE flat ranked list: heal spells and the absorption lane together, biggest first.
            No grouping level — that is what hid the flat breakdown in the damage drill-down.
            The absorption lane is told apart by COLOR + chip, never by where it sits. */}
        {drilled.spells.map((s) => (
          <SpellBar key={`${s.classification}:${s.name}`} s={s} healerKind={drilled.kind} />
        ))}
      </Crumb>
    )
  }

  // Level 1: healers, then the absorption section.
  return (
    <>
      {rows.map((h, i) => (
        <HealerBar
          key={h.id}
          h={h}
          rank={i + 1}
          onDrill={setDrill ? () => setDrill({ entityId: h.id }) : undefined}
        />
      ))}
      {mit && <AbsorbCounts mit={mit} />}
      <EnemyHealedLine healing={healing} />
    </>
  )
}

/** One lane inside a healer's drill: a heal spell, or the absorption lane. */
function SpellBar({ s, healerKind }: { s: HealSpellView; healerKind: string }): JSX.Element {
  const color = isAbsorb(s) ? MIT_COLOR : KIND_COLOR[healerKind] ?? '#888'
  return (
    <Bar
      color={color}
      accent={color}
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
  )
}

/** One ranked healer at level 1. */
function HealerBar({
  h,
  rank,
  onDrill
}: {
  h: HealSourceView
  rank: number
  onDrill?: () => void
}): JSX.Element {
  return (
    <Bar
      color={KIND_COLOR[h.kind] ?? '#888'}
      // A row carrying absorption gets the cool accent stripe, so it reads as mixed before a
      // single number is read. The split itself is in the stat run and the drill.
      accent={h.absorbedTotal > 0 ? MIT_COLOR : undefined}
      pct={h.pct}
      rank={rank}
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
      onClick={onDrill}
      title={healerTitle(h)}
    />
  )
}

/** Counter-healing is an ANNOTATION on your damage, not part of your sustain, so it never
 *  enters the ranking above — it gets one honest line. */
function EnemyHealedLine({
  healing
}: {
  healing: NonNullable<SegmentView['healing']>
}): JSX.Element | null {
  if (healing.enemyTotal <= 0) return null
  return (
    <div
      style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', padding: '6px 2px 0' }}
      title={`Healing that landed on mobs you were engaged with — it undid this much of your damage. Top: ${healing.enemyHealers
        .slice(0, 3)
        .map((h) => `${h.name} ${fmt(h.total)}`)
        .join(', ')}`}
    >
      enemies healed {fmt(healing.enemyTotal)}
    </div>
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
