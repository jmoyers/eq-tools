import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { CursorPoint, CursorRingPrefs } from '../shared/presencePrefs'

export type { CursorPoint, CursorRingPrefs }

/**
 * The THIRD preload, for the cursor-ring window (`cursor.html`) — and the smallest surface in
 * the app: three receive-only methods and no way to change anything.
 *
 * WHY NOT REUSE `preload/overlay.ts`. That bridge can persist overlay config, toggle
 * click-through, close its window and deep-link into the main app. The ring needs none of it,
 * and a window that cannot act cannot be made to act — the same reasoning that made the overlay
 * bridge a separate, leaner surface than `window.eq` in the first place. Handing the ring the
 * meters' capabilities to save one build entry would be a second, weaker opinion about the
 * blast radius of a window whose whole job is to draw a circle.
 *
 * There is deliberately no SETTER here. The ring is configured from Preferences (the main
 * window's `window.eq` bridge); this window only ever learns what was decided elsewhere.
 *
 * Exposed as `window.eqCursor`.
 */
const cursorApi = {
  /** The ring's current size/thickness/enabled prefs. Read once on mount. */
  getConfig: (): Promise<CursorRingPrefs> => ipcRenderer.invoke(IPC.cursorRingGet),
  /** Subscribe to prefs changes so a slider in Preferences resizes the live ring. */
  onConfig: (cb: (c: CursorRingPrefs) => void): (() => void) => {
    const listener = (_e: unknown, c: CursorRingPrefs): void => cb(c)
    ipcRenderer.on(IPC.onCursorRingConfig, listener)
    return () => ipcRenderer.removeListener(IPC.onCursorRingConfig, listener)
  },
  /**
   * Subscribe to cursor samples, already converted to THIS window's CSS px by main.
   *
   * Samples arrive at ~8 ms and are meant to be COALESCED, not consumed one by one: the
   * renderer keeps the latest and paints it on the next animation frame (see
   * `renderer/src/overlay/cursorRing.ts`). Main sends nothing at all while the pointer is
   * still, or while the ring is gated off.
   */
  onPoint: (cb: (p: CursorPoint) => void): (() => void) => {
    const listener = (_e: unknown, p: CursorPoint): void => cb(p)
    ipcRenderer.on(IPC.onCursorPoint, listener)
    return () => ipcRenderer.removeListener(IPC.onCursorPoint, listener)
  }
}

export type EqCursorApi = typeof cursorApi

contextBridge.exposeInMainWorld('eqCursor', cursorApi)
