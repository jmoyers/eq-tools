import { useEffect, useMemo, useRef, useState } from 'react'
import type { OverlayConfig } from '@shared/types'
import type { SegmentSummary, SourceView } from '@shared/combat'
import { useOverlayCombat } from './useOverlayCombat'

// Palette (matches the app's combat colors; the overlay has no MUI theme).
const GOLD = '#d9b25f'
const KIND_COLOR: Record<string, string> = { you: '#d9b25f', pet: '#6fb3d2', enemy: '#cf6679' }

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(Math.round(n))
}
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A single source bar: name, DPS, total, pct-fill. Dense + high-contrast. */
function Bar({ e, rank }: { e: SourceView; rank: number }): JSX.Element {
  const color = KIND_COLOR[e.kind] ?? '#888'
  return (
    <div
      style={{
        position: 'relative',
        height: 18,
        borderRadius: 3,
        marginBottom: 2,
        overflow: 'hidden',
        background: `rgba(255,255,255,0.06)`
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          width: `${Math.max(2, e.pct)}%`,
          background: color,
          opacity: 0.55
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 6px',
          gap: 6,
          fontSize: 11,
          lineHeight: 1,
          // Text shadow keeps names legible over the game AND the bar fill,
          // independent of the panel's background alpha.
          textShadow: '0 1px 2px rgba(0,0,0,0.9)'
        }}
      >
        <span style={{ color: 'rgba(255,255,255,0.55)', width: 12, textAlign: 'right' }}>{rank}</span>
        <span style={{ fontWeight: 600, flexGrow: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {e.name}
          {e.kind === 'pet' ? ' ·pet' : ''}
        </span>
        <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(e.dps)}/s
          <span style={{ color: 'rgba(255,255,255,0.55)', marginLeft: 5 }}>{fmt(e.total)}</span>
        </span>
      </div>
    </div>
  )
}

export default function OverlayMeter(): JSX.Element {
  const snap = useOverlayCombat()
  const [cfg, setCfg] = useState<OverlayConfig | null>(null)
  // True while the cursor is over the overlay in LOCKED mode — reveals the pin
  // button and (via setIgnoreMouse) temporarily captures the mouse so it's clickable.
  const [hovering, setHovering] = useState(false)
  const hoveringRef = useRef(false)

  // Load persisted config once + subscribe to pushes (e.g. locked toggled elsewhere).
  useEffect(() => {
    void window.eqOverlay.getConfig().then(setCfg)
    return window.eqOverlay.onConfig(setCfg)
  }, [])

  const locked = cfg?.locked ?? false
  const bgAlpha = cfg?.bgAlpha ?? 0.72
  const topN = cfg?.topN ?? 5

  // The current encounter's outgoing rows (already pet-combined by the snapshot opts).
  const seg = snap?.selected
  const current: SegmentSummary | undefined = snap?.segments.find((s) => s.kind === 'current')
  const rows = useMemo(() => (seg?.entities ?? []).slice(0, topN), [seg, topN])
  const live = !!snap?.inCombat
  const encounterName = seg?.name ?? current?.name ?? 'No encounter'
  const durationSec = seg?.durationSec ?? current?.durationSec ?? 0
  const totalDps = seg?.outDps ?? current?.dps ?? 0

  const patch = (p: Partial<OverlayConfig>): void => {
    setCfg((c) => (c ? { ...c, ...p } : c))
    void window.eqOverlay.setConfig(p)
  }

  const toggleLock = (): void => {
    const next = !locked
    // When we re-enter interactive mode, stop passing mouse events through.
    window.eqOverlay.setLocked(next)
    patch({ locked: next })
    if (next) setHoverCapture(false)
  }

  // While LOCKED, the whole overlay ignores the mouse so clicks reach the game.
  // A pointer-move sensor toggles capture ON when the cursor is over the overlay
  // so the hover-revealed pin button is clickable, and OFF when it leaves.
  const setHoverCapture = (capture: boolean): void => {
    if (hoveringRef.current === capture) return
    hoveringRef.current = capture
    setHovering(capture)
    // ignore = pass-through. capture => don't ignore.
    window.eqOverlay.setIgnoreMouse(!capture)
  }

  // In locked mode the window starts ignoring the mouse (set by main on lock). We
  // still receive pointer events via forward:true, so onMouseEnter/Leave fire.
  const onEnter = (): void => {
    if (locked) setHoverCapture(true)
  }
  const onLeave = (): void => {
    if (locked) setHoverCapture(false)
  }

  // Interactive mode: the header is a drag handle (-webkit-app-region: drag).
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
        // The translucent dark panel. Alpha is user-adjustable; a subtle border +
        // shadow lifts it off the game. In interactive mode the whole thing is a
        // little more opaque-feeling thanks to the outline.
        background: `rgba(14,17,21,${bgAlpha})`,
        border: locked ? '1px solid rgba(255,255,255,0.04)' : `1px solid rgba(217,178,95,0.4)`,
        borderRadius: 8,
        boxSizing: 'border-box',
        overflow: 'hidden'
      }}
    >
      {/* Header: encounter name + duration + live/idle dot. Drag handle when interactive. */}
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
            fontWeight: 700,
            color: GOLD,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flexGrow: 1
          }}
        >
          {encounterName}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {fmtDur(durationSec)} · {fmt(totalDps)}/s
        </span>

        {/* Controls. The pin (lock/unlock) is ALWAYS actionable; in locked mode the
            whole control cluster is only revealed on hover. */}
        {(!locked || hovering) && (
          <div style={{ ...noDrag, display: 'flex', alignItems: 'center', gap: 2, marginLeft: 2 }}>
            <IconButton
              title={locked ? 'Unlock (interactive)' : 'Lock (click-through)'}
              onClick={toggleLock}
              accent={locked}
            >
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

      {/* Bars */}
      <div style={{ flexGrow: 1, overflow: 'hidden', padding: '5px 6px' }}>
        {rows.length ? (
          rows.map((e, i) => <Bar key={e.id} e={e} rank={i + 1} />)
        ) : (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '8px 2px' }}>
            {live ? 'Engaging…' : 'Waiting for combat…'}
          </div>
        )}
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
