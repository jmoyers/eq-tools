import { useEffect, useMemo, useRef, useState } from 'react'
import type { OverlayConfig, OverlayKind } from '@shared/types'
import type { DamageCategory, SegmentView, SkillView, SourceView } from '@shared/combat'
import { formatNum as fmt, formatRate } from '../lib/formatRate'
import { useOverlayCombat } from './useOverlayCombat'

// Palette (matches the app's combat colors; the overlay has no MUI theme).
const GOLD = '#d9b25f'
const KIND_COLOR: Record<string, string> = { you: '#d9b25f', pet: '#6fb3d2', enemy: '#cf6679' }
const CAT_COLOR: Record<DamageCategory, string> = {
  melee: '#d9b25f',
  slay: '#e8d48a',
  spell: '#a98fe0',
  dot: '#6fb3d2',
  ds: '#cf6679'
}

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

/** A single horizontal bar: label + right-text + pct-fill. Dense + high-contrast. Clickable to drill. */
function Bar({
  color,
  pct,
  rank,
  label,
  right,
  onClick,
  accent
}: {
  color: string
  pct: number
  rank?: number
  label: React.ReactNode
  right: string
  onClick?: () => void
  /** Full-height left stripe — keeps a skill row's category readable at any bar width. */
  accent?: string
}): JSX.Element {
  return (
    <div
      onClick={onClick}
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

// Mini drill-down (Task #54): interactive-only. null = level 1 (entities); {entityId} = level 2,
// ONE flat ranked skill/spell list across every category (color = category, no legend — the
// overlay is too dense for one). Same data + flattening as the main view.
interface Drill {
  entityId: string
}

/** A skill row tagged with the category it was rolled up under (the color key). */
type FlatSkill = SkillView & { category: DamageCategory }

/** Flatten a source's per-category skills into one damage-desc list, re-basing the bar pct
 *  on the global max (the engine's pct is relative to each skill's own category max). */
function flattenSkills(e: SourceView): FlatSkill[] {
  const rows: FlatSkill[] = e.categories.flatMap((c) => c.skills.map((s) => ({ ...s, category: c.category })))
  rows.sort((a, b) => b.total - a.total || b.hits - a.hits || a.name.localeCompare(b.name))
  const max = Math.max(1, ...rows.map((r) => r.total))
  return rows.map((r) => ({ ...r, pct: (r.total / max) * 100 }))
}

/** The bar body: entities → flat skill list, driven by the drill state. */
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
  setDrill: (d: Drill | null) => void
  live: boolean
}): JSX.Element {
  const rows = useMemo(() => (seg?.entities ?? []).slice(0, topN), [seg, topN])
  // A stale drill (entity gone after a fight change) simply falls back to level 1.
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
      <MeterCrumb name={drilled.name} onBack={() => setDrill(null)}>
        {flattenSkills(drilled).map((s) => (
          <Bar
            key={`${s.category}|${s.name}`}
            color={CAT_COLOR[s.category]}
            accent={CAT_COLOR[s.category]}
            pct={s.pct}
            label={s.name}
            right={s.hits > 0 ? `${fmt(s.total)} · ${s.hits}` : `${s.resists ?? 0} resist`}
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
          onClick={() => setDrill({ entityId: e.id })}
        />
      ))}
    </>
  )
}

/** A back-chevron crumb header for the drill-down levels. */
function MeterCrumb({
  name,
  onBack,
  children
}: {
  name: string
  onBack: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <div
        onClick={onBack}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          cursor: 'pointer',
          fontSize: 11,
          color: 'rgba(255,255,255,0.7)',
          marginBottom: 3
        }}
      >
        <span style={{ fontSize: 13 }}>‹</span>
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
  // Selection: for 'fight' → LIVE or a finalized fight id; for 'overall' → 'zone' or a zs<n>.
  const [selection, setSelection] = useState<string>(kind === 'fight' ? LIVE : 'zone')
  const [drill, setDrill] = useState<Drill | null>(null)
  const [hovering, setHovering] = useState(false)
  const hoveringRef = useRef(false)

  const combinePets = kind === 'fight'
  const snap = useOverlayCombat(selection === LIVE ? undefined : selection, combinePets)

  useEffect(() => {
    void window.eqOverlay.getConfig().then(setCfg)
    return window.eqOverlay.onConfig(setCfg)
  }, [])

  // Reset drill when the selection changes (a drill is per-segment).
  useEffect(() => setDrill(null), [selection])

  const locked = cfg?.locked ?? false
  const bgAlpha = cfg?.bgAlpha ?? 0.72
  const topN = cfg?.topN ?? 5
  const now = Date.now()

  const seg = snap?.selected ?? undefined
  const live = !!snap?.inCombat
  const isFight = kind === 'fight'

  // Header title + rate/duration for the selected segment.
  const headerName = seg?.name ?? (isFight ? 'No fight' : 'No zone')
  const durationSec = seg?.durationSec ?? 0
  const totalDps = seg?.outDps ?? 0

  // Selector options.
  const fightRows = (snap?.segments ?? []).filter((s) => s.kind === 'fight')
  const zoneRows = snap?.zoneSessions ?? []

  const patch = (p: Partial<OverlayConfig>): void => {
    setCfg((c) => (c ? { ...c, ...p } : c))
    void window.eqOverlay.setConfig(p)
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

      {/* Selector — interactive mode only. Dense native select in the overlay header. */}
      {!locked && (
        <div style={{ ...noDrag, padding: '4px 8px 2px', flexShrink: 0 }}>
          <select
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
            style={{
              width: '100%',
              background: 'rgba(0,0,0,0.35)',
              color: '#f2f2f2',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 4,
              fontSize: 11,
              padding: '2px 4px',
              outline: 'none'
            }}
          >
            {isFight ? (
              <>
                <option value={LIVE}>▶ Current fight (live)</option>
                {fightRows.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {formatRate(s.dps)} · {relativeAge(s.startTs, now)} · {fmtDur(s.durationSec)}
                  </option>
                ))}
              </>
            ) : (
              zoneRows.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.live ? '◆ ' : ''}
                  {z.zone} · {formatRate(z.dps)}
                  {z.live ? ' · live' : ` · ${relativeAge(z.startTs, now)}`}
                </option>
              ))
            )}
          </select>
        </div>
      )}

      {/* Bars + mini drill-down (drilling only in interactive mode; locked keeps click-through). */}
      <div style={{ flexGrow: 1, overflow: 'auto', padding: '4px 6px' }}>
        <MeterBars
          seg={seg}
          topN={topN}
          drill={locked ? null : drill}
          setDrill={locked ? () => {} : setDrill}
          live={live}
        />
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
