import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { CombatSnapshot, SnapshotOpts } from '../shared/combat'
import type { OverlayConfig, OverlayKind } from '../shared/types'

export type { CombatSnapshot, SnapshotOpts, OverlayConfig, OverlayKind }

/**
 * Minimal preload for a floating overlay DPS-meter window (Task #52; per-kind in Task #54).
 *
 * Deliberately NOT the full `window.eq` bridge — an overlay only needs to READ the combat
 * snapshot (reusing the same `combat:snapshot` transport the main app uses) and drive its own
 * window (click-through, close, config persistence). A lean surface keeps the overlay window's
 * blast radius small. Exposed as `window.eqOverlay`.
 *
 * KIND: each overlay window is launched with a `?kind=fight|overall` query so one overlay.html
 * bundle serves both windows. The preload reads it here and threads it into every kind-scoped
 * IPC call so the renderer never has to; `window.eqOverlay.kind` is also exposed for the UI.
 */
function readKind(): OverlayKind {
  try {
    const k = new URLSearchParams(window.location.search).get('kind')
    return k === 'overall' ? 'overall' : 'fight'
  } catch {
    return 'fight'
  }
}
const KIND: OverlayKind = readKind()

const overlayApi = {
  /** This overlay window's kind ('fight' | 'overall'). */
  kind: KIND,
  /** Fetch a fresh combat snapshot (same engine + IPC the main app polls). */
  getCombatSnapshot: (opts: SnapshotOpts): Promise<CombatSnapshot> =>
    ipcRenderer.invoke(IPC.getCombatSnapshot, opts),
  /** Subscribe to the throttled combat-activity nudge for sub-second updates. */
  onCombatActivity: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.onCombatActivity, listener)
    return () => ipcRenderer.removeListener(IPC.onCombatActivity, listener)
  },

  /** Read this kind's persisted overlay config (locked / bgAlpha / topN / bounds). */
  getConfig: (): Promise<OverlayConfig> => ipcRenderer.invoke(IPC.overlayGetConfig, KIND),
  /** Persist a partial config for this kind; returns the merged value. */
  setConfig: (patch: Partial<OverlayConfig>): Promise<OverlayConfig> =>
    ipcRenderer.invoke(IPC.overlaySetConfig, KIND, patch),
  /** Subscribe to config changes pushed from main; ignores pushes for the other kind. */
  onConfig: (cb: (c: OverlayConfig) => void): (() => void) => {
    const listener = (_e: unknown, payload: { kind: OverlayKind; config: OverlayConfig }): void => {
      if (payload?.kind === KIND) cb(payload.config)
    }
    ipcRenderer.on(IPC.onOverlayConfig, listener)
    return () => ipcRenderer.removeListener(IPC.onOverlayConfig, listener)
  },

  /** Set locked (click-through) vs interactive for this kind. Persisted + applied to the window. */
  setLocked: (locked: boolean): void => ipcRenderer.send(IPC.overlaySetLocked, KIND, locked),
  /**
   * Fine-grained pass-through toggle used by the hover sensor while locked:
   * `ignore:true` lets clicks fall through to the game, `false` captures them so a
   * hovered control (the pin button) is clickable. Fire-and-forget.
   */
  setIgnoreMouse: (ignore: boolean): void => ipcRenderer.send(IPC.overlaySetIgnoreMouse, KIND, ignore),
  /** Close this overlay from its own close button (interactive mode only). */
  close: (): void => ipcRenderer.send(IPC.overlayClose, KIND)
}

export type EqOverlayApi = typeof overlayApi

contextBridge.exposeInMainWorld('eqOverlay', overlayApi)
