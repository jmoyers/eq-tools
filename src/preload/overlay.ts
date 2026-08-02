import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { CombatSnapshot, SnapshotOpts } from '../shared/combat'
import type { OverlayConfig } from '../shared/types'

export type { CombatSnapshot, SnapshotOpts, OverlayConfig }

/**
 * Minimal preload for the floating overlay DPS meter (Task #52).
 *
 * Deliberately NOT the full `window.eq` bridge — the overlay only needs to READ
 * the combat snapshot (reusing the same `combat:snapshot` transport the main app
 * uses) and drive its own window (click-through, close, config persistence). A
 * lean surface keeps the overlay window's blast radius small and makes its data
 * dependencies obvious. Exposed as `window.eqOverlay`.
 */
const overlayApi = {
  /** Fetch a fresh combat snapshot (same engine + IPC the main app polls). */
  getCombatSnapshot: (opts: SnapshotOpts): Promise<CombatSnapshot> =>
    ipcRenderer.invoke(IPC.getCombatSnapshot, opts),
  /** Subscribe to the throttled combat-activity nudge for sub-second updates. */
  onCombatActivity: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.onCombatActivity, listener)
    return () => ipcRenderer.removeListener(IPC.onCombatActivity, listener)
  },

  /** Read the persisted overlay config (locked / bgAlpha / topN / bounds). */
  getConfig: (): Promise<OverlayConfig> => ipcRenderer.invoke(IPC.overlayGetConfig),
  /** Persist a partial overlay config; returns the merged value. */
  setConfig: (patch: Partial<OverlayConfig>): Promise<OverlayConfig> =>
    ipcRenderer.invoke(IPC.overlaySetConfig, patch),
  /** Subscribe to config changes pushed from main (e.g. locked toggled elsewhere). */
  onConfig: (cb: (c: OverlayConfig) => void): (() => void) => {
    const listener = (_e: unknown, c: OverlayConfig): void => cb(c)
    ipcRenderer.on(IPC.onOverlayConfig, listener)
    return () => ipcRenderer.removeListener(IPC.onOverlayConfig, listener)
  },

  /** Set locked (click-through) vs interactive. Persisted + applied to the window. */
  setLocked: (locked: boolean): void => ipcRenderer.send(IPC.overlaySetLocked, locked),
  /**
   * Fine-grained pass-through toggle used by the hover sensor while locked:
   * `ignore:true` lets clicks fall through to the game, `false` captures them so a
   * hovered control (the pin button) is clickable. Fire-and-forget.
   */
  setIgnoreMouse: (ignore: boolean): void => ipcRenderer.send(IPC.overlaySetIgnoreMouse, ignore),
  /** Close the overlay from its own close button (interactive mode only). */
  close: (): void => ipcRenderer.send(IPC.overlayClose)
}

export type EqOverlayApi = typeof overlayApi

contextBridge.exposeInMainWorld('eqOverlay', overlayApi)
