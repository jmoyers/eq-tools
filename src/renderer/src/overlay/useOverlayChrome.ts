// useOverlayChrome — the window plumbing every overlay KIND shares, in one place.
//
// All five overlays (damage fight/overall, healing fight/overall, event log) are the same
// window with a different body: a persisted config (position, background alpha, row count,
// lock AND the drill-down), a lock toggle that flips click-through, and the hover dance that
// briefly re-captures the mouse over a LOCKED overlay so its own controls stay reachable.
// This hook is that plumbing; each overlay file keeps only its header, selector and body.
//
// CONFIG IS THE STATE. `patch` writes locally first (so the UI moves this frame) and then
// through to main, which echoes it back over onConfig — there is no second copy to drift, and
// a drill survives a restart exactly like window position does.
//
// MUI-FREE ON PURPOSE: the overlay is its own renderer entry (overlay.html) with no theme and
// no component library. Do not import @mui/* into this bundle.

import { useEffect, useRef, useState } from 'react'
import type { OverlayConfig, OverlayDrill } from '@shared/types'

export interface OverlayChrome {
  /** click-through + no chrome; the persisted lock state */
  locked: boolean
  bgAlpha: number
  topN: number
  /** Config IS the drill state — no local mirror to drift. */
  drill: OverlayDrill | null
  /** the mouse is currently captured over a locked overlay (its controls are showing) */
  hovering: boolean
  patch: (p: Partial<OverlayConfig>) => void
  setDrill: (d: OverlayDrill | null) => void
  toggleLock: () => void
  onEnter: () => void
  onLeave: () => void
  /** spread onto the header: the whole bar drags the window when interactive */
  dragRegion: React.CSSProperties
  /** spread onto anything clickable inside a drag region */
  noDrag: React.CSSProperties
}

export function useOverlayChrome(): OverlayChrome {
  const [cfg, setCfg] = useState<OverlayConfig | null>(null)
  const [hovering, setHovering] = useState(false)
  const hoveringRef = useRef(false)

  // Hydrate from the persisted config and stay subscribed to main's echo. The first snapshot
  // renders against whatever this resolves to.
  useEffect(() => {
    void window.eqOverlay.getConfig().then(setCfg)
    return window.eqOverlay.onConfig(setCfg)
  }, [])

  const locked = cfg?.locked ?? false
  const bgAlpha = cfg?.bgAlpha ?? 0.72
  const topN = cfg?.topN ?? 5
  const drill = cfg?.drill ?? null

  const patch = (p: Partial<OverlayConfig>): void => {
    setCfg((c) => (c ? { ...c, ...p } : c))
    void window.eqOverlay.setConfig(p)
  }

  // Drill/undrill writes straight through to the store — immediate, not debounced like bounds:
  // it's a rare, deliberate click. `patch` applies it locally first so the bars swap this frame.
  const setDrill = (d: OverlayDrill | null): void => patch({ drill: d })

  const setHoverCapture = (capture: boolean): void => {
    if (hoveringRef.current === capture) return
    hoveringRef.current = capture
    setHovering(capture)
    window.eqOverlay.setIgnoreMouse(!capture)
  }

  const toggleLock = (): void => {
    const next = !locked
    window.eqOverlay.setLocked(next)
    patch({ locked: next })
    if (next) setHoverCapture(false)
  }

  const onEnter = (): void => {
    if (locked) setHoverCapture(true)
  }
  const onLeave = (): void => {
    if (locked) setHoverCapture(false)
  }

  return {
    locked,
    bgAlpha,
    topN,
    drill,
    hovering,
    patch,
    setDrill,
    toggleLock,
    onEnter,
    onLeave,
    dragRegion: !locked ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : {},
    noDrag: { WebkitAppRegion: 'no-drag' } as React.CSSProperties
  }
}
