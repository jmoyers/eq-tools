// meterBars — the damage overlay's BAR BODY: the ranked entity list and, one click down, the
// flat per-skill list for one entity. Split out of OverlayMeter so that file is the window
// chrome (header, selector, footer) and this one is the meter itself.
//
// MUI-FREE ON PURPOSE: the overlay is its own renderer entry (overlay.html) with no theme and
// no component library — every pixel here is plain React + inline styles. Do not import
// @mui/* into this bundle.

import { type JSX, useMemo } from 'react'
import type { OverlayDrill } from '@shared/types'
import { CATEGORY_LABEL, type DamageCategory, type SegmentView } from '@shared/combat'
import { formatNum as fmt, formatRate } from '../lib/formatRate'
import { flattenSkills, type FlatSkill, type SkillRow } from '../features/combat/dashboardData'
import { landEvidence } from '../features/combat/landEvidence'

const KIND_COLOR: Record<string, string> = { you: '#d9b25f', pet: '#6fb3d2', enemy: '#cf6679' }
// KEEP IN SYNC with the app's CAT_COLOR (features/combat/combatShared.tsx) — the overlay is a
// separate renderer entry with no MUI theme, so it carries its own copy. 'slay' is a radiant
// ivory, deliberately far from melee gold: a Slay Undead proc flattens into a row named after
// its weapon skill, so at the old pale-gold it was invisible next to the plain melee row.
const CAT_COLOR: Record<DamageCategory, string> = {
  melee: '#d9b25f',
  slay: '#f6f0da',
  spell: '#a98fe0',
  dot: '#6fb3d2',
  ds: '#cf6679'
}

/** A single horizontal bar: label + right-text + pct-fill. Dense + high-contrast. Clickable to drill. */
function Bar({
  color,
  pct,
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
  /** Full-height left stripe — keeps a skill row's category readable at any bar width. */
  accent?: string
  /** Native hover tooltip spelling out the compacted right-hand stats (interactive mode only —
   *  a locked overlay is click-through, so nothing hovers it). */
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
      <div style={{ position: 'absolute', inset: 0, width: `${Math.max(2, pct)}%`, background: color, opacity: 0.55 }} />
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

// Mini drill-down (Task #54): null = level 1 (entities); {entityId} = level 2, ONE flat ranked
// skill/spell list across every category (color = category, no legend — the overlay is too dense
// for one). Same data + flattening as the main view.
//
// The drill lives in the PERSISTED config (`overlays.<kind>.drill`), not component state, so it
// survives a restart exactly like window position does — the user plays pinned with a "damage by
// type" breakdown up and expects to find it there again. Locked mode RENDERS it (read-only,
// static crumb, zero affordances, still fully click-through); only interactive mode can change it.
export type Drill = OverlayDrill

// Flattening + the Slay Undead grouping come from the app's dashboardData — it is pure TS (no
// React, no MUI), which is the only reason the overlay duplicates anything at all — the copies
// here (colors, bar chrome) exist to stay MUI-free, not to fork the DATA shaping. One flatten
// means the overlay's drill can never rank or group rows differently from the main view.

/**
 * The overlay's per-skill stat run, embedded INSIDE the bar after the name — identical form to
 * the main view's bars (features/combat/combatShared.tsx skillStatText):
 *   `12% miss · 3 - 145dmg`
 * Density here comes from carrying FEWER stats, never from compressing labels (`12%m` / `145/3`
 * are unreadable in a glance-and-forget overlay). The counts the main view puts one click down
 * in its expanded readout live in this row's hover `title` instead — the overlay has no room
 * for an expansion, and in locked (click-through) mode there would be no way to collapse one.
 * The row TOTAL is not here — it owns the right end of the bar.
 */
function skillStat(s: FlatSkill): string {
  // A lane with no damage line of its own — an effect proc counted from its landing emotes, or a
  // spell that only ever resisted. `landEvidence` is the ONE spelling of that row (see its
  // header): the main view's bar renders the identical string, and neither surface manufactures
  // a 100% resist rate out of resists alone.
  if (s.hits === 0) return landEvidence(s).text
  const misses = s.misses ?? 0
  const swings = s.hits + misses
  const parts: string[] = []
  if (misses > 0 && swings > 0) parts.push(`${Math.round((misses / swings) * 100)}% miss`)
  const min = s.min ?? 0
  parts.push(min > 0 && min !== s.max ? `${fmt(min)} - ${fmt(s.max)}dmg` : `${fmt(s.max)}dmg`)
  return parts.join(' · ')
}

/** The labeled stat run for one row, shared by the row title and its children lines. */
function skillFacts(s: FlatSkill): string {
  const land = landEvidence(s)
  // The overlay has no expansion, so the damage-less row's hover carries the BASIS too — where
  // the landings came from, or why a resist rate is being withheld.
  if (s.hits === 0) return `${land.text} · ${land.hint}`
  const misses = s.misses ?? 0
  const swings = s.hits + misses
  const resists = s.resists ?? 0
  const bits = [
    `total ${fmt(s.total)}`,
    `${s.hits} hits`,
    `avg per hit ${fmt(Math.round(s.total / s.hits))}`,
    `${s.crits} crits (${Math.round((s.crits / s.hits) * 100)}% crit)`
  ]
  if (misses > 0) bits.push(`${Math.round((misses / swings) * 100)}% miss (${misses} of ${swings} swings avoided)`)
  if (resists > 0) bits.push(land.resistText)
  const min = s.min ?? 0
  bits.push(min > 0 && min !== s.max ? `damage range ${fmt(min)} - ${fmt(s.max)}` : `damage range ${fmt(s.max)}`)
  return bits.join(' · ')
}

/**
 * The overlay's stand-in for the main view's expanded per-ability readout: the same figures,
 * fully labeled, as the row's hover title (interactive mode — a locked overlay is
 * click-through, so it neither hovers nor could collapse an inline expansion).
 * For the GROUPED Slay Undead row this title also carries what the main view puts in the
 * expansion — the per-weapon-skill split, one labeled line each. The overlay's 18px rows have
 * no room for an inline breakdown and locked mode could never collapse one, so the hover title
 * is where that detail lives here.
 */
function skillTitle(s: SkillRow, catLabel: string): string {
  const head = `${s.name} (${catLabel}) — ${skillFacts(s)}`
  if (!s.children || s.children.length === 0) return head
  const lines = s.children.map((c) => `  ${c.name} — ${skillFacts(c)}`)
  return `${head}\nBy skill:\n${lines.join('\n')}`
}

/** The bar body: entities → flat skill list, driven by the drill state.
 *  `setDrill` is null in locked mode: the same levels render, minus every affordance. */
export function MeterBars({
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
  const rows = useMemo(() => (seg?.entities ?? []).slice(0, topN), [seg, topN])
  // A stale drill falls back to level 1 for THIS render only — the persisted value is untouched,
  // so a restored `pet:<instanceId>` from a past session, a fight that moved on, or a 'you' that
  // blinks out between fights all re-drill silently the moment the entity is back in the segment.
  const drilled = drill && seg ? seg.entities.find((e) => e.id === drill.entityId) : undefined

  if (!seg || (!drilled && rows.length === 0)) {
    return (
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
        {live ? 'Engaging…' : 'Waiting for combat…'}
      </div>
    )
  }

  // Level 2: one flat, category-colored skill/spell list for the entity.
  if (drilled) {
    return (
      <MeterCrumb name={drilled.name} onBack={setDrill ? () => setDrill(null) : null}>
        {flattenSkills(drilled).map((s) => (
          <Bar
            key={`${s.category}|${s.name}`}
            color={CAT_COLOR[s.category]}
            accent={CAT_COLOR[s.category]}
            pct={s.pct}
            label={
              <>
                {s.name}
                {/* A lone Slay Undead proc flattens into a row named after its weapon skill, so
                    without this tag it is a duplicate of the plain melee row. The category has
                    to be readable from the ROW; the overlay has no legend to fall back on.
                    A GROUP row is already named "Slay Undead" — tagging it would stutter — and
                    instead says how many weapon skills it merges; the split is in its title. */}
                {s.category === 'slay' && !s.children && (
                  <span style={{ color: CAT_COLOR.slay, fontWeight: 600 }}> · Slay Undead</span>
                )}
                {s.children && s.children.length > 0 && (
                  <span style={{ color: 'rgba(255,255,255,0.62)', fontWeight: 400 }}>
                    {' '}
                    · {s.children.length} skills
                  </span>
                )}
                {/* Labeled stats ride inside the bar, dimmed against the name; the right end
                    of every row stays the total alone so the list scans as a ranking. */}
                <span style={{ marginLeft: 6, color: 'rgba(255,255,255,0.62)', fontWeight: 400 }}>
                  {skillStat(s)}
                </span>
              </>
            }
            right={fmt(s.total)}
            title={skillTitle(s, CATEGORY_LABEL[s.category])}
          />
        ))}
      </MeterCrumb>
    )
  }

  // Level 1: entities.
  return (
    <>
      {rows.map((e, i) => (
        <Bar
          key={e.id}
          color={KIND_COLOR[e.kind] ?? '#888'}
          pct={e.pct}
          rank={i + 1}
          label={
            <>
              {e.name}
              {e.kind === 'pet' ? ' ·pet' : ''}
            </>
          }
          right={`${formatRate(e.dps)} · ${fmt(e.total)}`}
          onClick={setDrill ? () => setDrill({ entityId: e.id }) : undefined}
        />
      ))}
    </>
  )
}

/** A crumb header for the drill-down level: a back chevron when interactive, and the SAME row as
 *  static text when `onBack` is null (locked mode — the drill still shows, nothing is clickable). */
function MeterCrumb({
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