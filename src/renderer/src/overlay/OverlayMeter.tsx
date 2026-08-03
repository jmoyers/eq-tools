import { useEffect, useMemo, useRef, useState } from 'react'
import type { OverlayConfig, OverlayDrill, OverlayKind } from '@shared/types'
import type { DamageCategory, SegmentView } from '@shared/combat'
import { CATEGORY_LABEL } from '@shared/combat'
import { formatNum as fmt, formatRate } from '../lib/formatRate'
import { formatTime } from '../lib/formatDate'
import {
  LIVE_SELECTION,
  defaultSelection,
  flattenSkills,
  scopeOptions,
  type FlatSkill,
  type ScopeOption,
  type SkillRow
} from '../features/combat/dashboardData'
import { OverlaySelect, type OverlaySelectRow } from './OverlaySelect'
import { useOverlayCombat } from './useOverlayCombat'

// Palette (matches the app's combat colors; the overlay has no MUI theme).
const GOLD = '#d9b25f'
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
type Drill = OverlayDrill

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
  if (s.hits === 0) return `0 landed · ${s.resists ?? 0} resisted`
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
  if (s.hits === 0) return `0 landed · ${s.resists ?? 0} resisted`
  const misses = s.misses ?? 0
  const swings = s.hits + misses
  const resists = s.resists ?? 0
  const casts = s.hits + resists
  const bits = [
    `total ${fmt(s.total)}`,
    `${s.hits} hits`,
    `avg per hit ${fmt(Math.round(s.total / s.hits))}`,
    `${s.crits} crits (${Math.round((s.crits / s.hits) * 100)}% crit)`
  ]
  if (misses > 0) bits.push(`${Math.round((misses / swings) * 100)}% miss (${misses} of ${swings} swings avoided)`)
  if (resists > 0) bits.push(`${resists} resisted of ${casts} casts (${Math.round((resists / casts) * 100)}%)`)
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
function MeterBars({
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

export default function OverlayMeter(): JSX.Element {
  // `kind` comes from the preload bridge (read from the window's ?kind= query). Fall back to
  // 'fight' if the bridge is momentarily absent (e.g. an HMR reload before the preload re-runs).
  const kind: OverlayKind = window.eqOverlay?.kind ?? 'fight'
  const [cfg, setCfg] = useState<OverlayConfig | null>(null)
  // Selection is SCOPED to this overlay's kind and never crosses over: a 'fight' overlay lists
  // (and shows) only fights — the current one while a pull is open, else the LAST one — and a
  // 'overall' overlay lists only zone sessions. A fight meter silently becoming a zone meter
  // between pulls was the same bug the Combat tab had.
  const [selection, setSelection] = useState<string>(defaultSelection(kind === 'fight' ? 'fight' : 'overall'))
  const [hovering, setHovering] = useState(false)
  const hoveringRef = useRef(false)

  const combinePets = kind === 'fight'
  const snap = useOverlayCombat(selection === LIVE ? undefined : selection, combinePets)

  // Hydrate from the persisted config (position, alpha, topN, lock AND the drill-down) and stay
  // subscribed to main's echo. The first snapshot renders against whatever this resolves to.
  useEffect(() => {
    void window.eqOverlay.getConfig().then(setCfg)
    return window.eqOverlay.onConfig(setCfg)
  }, [])

  const locked = cfg?.locked ?? false
  const bgAlpha = cfg?.bgAlpha ?? 0.72
  const topN = cfg?.topN ?? 5
  // Config IS the drill state — no local mirror to drift, and every change is already persisted.
  const drill = cfg?.drill ?? null
  const now = Date.now()

  // HYDRATION (Task #56): while the engine replays the log, every snapshot is a HISTORICAL
  // moment — an overlay pinned over the game would churn through hours-old pulls as if they
  // were live. Render quiet and empty until the tail takes over (the main window shows the
  // same "Reading log…" state); one flag gates the whole surface.
  const hydrating = snap?.hydrating ?? true
  const seg = hydrating ? undefined : snap?.selected ?? undefined
  const live = !hydrating && !!snap?.inCombat
  const isFight = kind === 'fight'

  // Header title + rate/duration for the selected segment.
  const headerName = hydrating ? 'Reading log…' : seg?.name ?? (isFight ? 'No fight' : 'No zone')
  const durationSec = seg?.durationSec ?? 0
  const totalDps = seg?.outDps ?? 0

  // Selector options — ONE scope's rows, filtered by the shared helper the main view uses.
  const opts = scopeOptions(
    isFight ? 'fight' : 'overall',
    hydrating ? [] : snap?.segments ?? [],
    hydrating ? [] : snap?.zoneSessions ?? []
  )
  const rows = selectorRows(opts.head, opts.rest, now)
  /** On the head row, but the head row is the LAST (finished) fight — never dress it up as live. */
  const headIsLast = selection === LIVE && !!opts.head && !opts.head.live

  const patch = (p: Partial<OverlayConfig>): void => {
    setCfg((c) => (c ? { ...c, ...p } : c))
    void window.eqOverlay.setConfig(p)
  }

  // Drill/undrill writes straight through to the store — immediate, not debounced like bounds:
  // it's a rare, deliberate click. `patch` applies it locally first so the bars swap this frame.
  const setDrill = (d: Drill | null): void => patch({ drill: d })

  /** A drill is per-segment: picking a different fight / zone session undrills. This lives on the
   *  selector's change handler, NOT in an effect keyed on `selection` — an effect fires on mount
   *  (twice, under StrictMode) and would clear the drill we just hydrated. Only genuine user
   *  actions — this and the back chevron — ever clear the stored value. */
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
        border: locked ? '1px solid rgba(255,255,255,0.04)' : `1px solid rgba(217,178,95,0.4)`,
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
          {isFight ? 'FIGHT' : 'ZONE'}
          {/* The head row is a FINISHED fight (no pull is open). Say so in the header, because a
              LOCKED overlay hides the selector entirely — the tag would otherwise be the only
              thing on screen and it would read as if this fight were still going. */}
          {headIsLast && <span style={{ opacity: 0.75 }}> · LAST</span>}
        </span>
        <span
          style={{ fontWeight: 700, color: GOLD, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexGrow: 1 }}
        >
          {headerName}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {fmtDur(durationSec)} · {formatRate(totalDps)}
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

      {/* Selector — interactive mode only (a locked overlay is click-through, so it is simply
          not rendered and installs no listeners). Styled to the meter, not to the OS. */}
      {!locked && (
        <OverlaySelect
          rows={rows}
          value={selection}
          onChange={selectSegment}
          accent={GOLD}
          emptyLabel={isFight ? 'No fights yet' : 'No zone sessions yet'}
          noDragStyle={noDrag}
        />
      )}

      {/* Bars + mini drill-down. Locked mode RENDERS the remembered drill (the pinned "damage by
          type" breakdown the user plays with) but hands MeterBars no setter, so there are no
          click targets, no pointer cursors and no back chevron — the window stays click-through. */}
      <div style={{ flexGrow: 1, overflow: 'auto', padding: '4px 6px' }}>
        <MeterBars seg={seg} topN={topN} drill={drill} setDrill={locked ? null : setDrill} live={live} />
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
        background: accent ? 'rgba(217,178,95,0.2)' : 'transparent',
        color: danger ? '#cf6679' : 'inherit',
        padding: 0
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.14)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = accent ? 'rgba(217,178,95,0.2)' : 'transparent')}
    >
      {children}
    </button>
  )
}
