import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { CombatSnapshot, SnapshotOpts } from '../shared/combat'
import type {
  ItemKnowledge,
  MobKnowledge,
  ModuleDelta,
  ModuleSnapshot,
  OverlayConfig,
  OverlayDrill,
  OverlayKind
} from '../shared/types'
import { OVERLAY_KINDS } from '../shared/types'

export type { CombatSnapshot, SnapshotOpts, OverlayConfig, OverlayDrill, OverlayKind, MobKnowledge }

/**
 * Minimal preload for a floating overlay DPS-meter window (Task #52; per-kind in Task #54).
 *
 * Deliberately NOT the full `window.eq` bridge — an overlay only needs to READ the combat
 * snapshot (reusing the same `combat:snapshot` transport the main app uses) and drive its own
 * window (click-through, close, config persistence). A lean surface keeps the overlay window's
 * blast radius small. Exposed as `window.eqOverlay`.
 *
 * KIND: each overlay window is launched with a `?kind=<OverlayKind>` query so one overlay.html
 * bundle serves every window. The preload reads it here and threads it into every kind-scoped
 * IPC call so the renderer never has to; `window.eqOverlay.kind` is also exposed for the UI.
 * Validated against OVERLAY_KINDS so an unknown/absent query can only ever fall back to 'fight'
 * (never leak a bogus kind into the store's per-kind config).
 */
function readKind(): OverlayKind {
  try {
    const k = new URLSearchParams(window.location.search).get('kind')
    if (k && (OVERLAY_KINDS as string[]).includes(k)) return k as OverlayKind
    return 'fight'
  } catch {
    return 'fight'
  }
}
const KIND: OverlayKind = readKind()

const overlayApi = {
  /** This overlay window's kind ('fight' | 'overall' | 'events'). */
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

  // ---- module transport (Task #59: the 'events' overlay reads the eventFeed module) ----
  // The SAME hydrate-then-ride-deltas transport the main app uses, exposed here so an overlay
  // window can consume a module directly instead of inventing a second channel.
  /** Hydrate a module's full state (`module:getSnapshot`). Null when the id is unknown. */
  getModuleSnapshot: <S>(id: string): Promise<ModuleSnapshot<S> | null> =>
    ipcRenderer.invoke(IPC.getModuleSnapshot, id),
  /** Subscribe to `module:delta` pushes (all modules; the caller filters by moduleId). */
  onModuleDelta: <D>(cb: (d: ModuleDelta<D>) => void): (() => void) => {
    const listener = (_e: unknown, d: ModuleDelta<D>): void => cb(d)
    ipcRenderer.on(IPC.onModuleDelta, listener)
    return () => ipcRenderer.removeListener(IPC.onModuleDelta, listener)
  },
  /** Item knowledge for the feed's hover card — cache-first in main, never rejects. */
  lookupItem: (name: string): Promise<ItemKnowledge> => ipcRenderer.invoke(IPC.itemsLookup, name),
  /** Mob knowledge for a CONSIDER row's hover card (Task #63) — same cache-first door. */
  lookupMob: (name: string): Promise<MobKnowledge> => ipcRenderer.invoke(IPC.mobsLookup, name),

  /**
   * Read this kind's persisted overlay config (locked / bgAlpha / topN / bounds / drill).
   * The overlay hydrates from this on mount — including the mini drill-down, so a meter that
   * was left drilled into an entity comes back drilled after a restart.
   */
  getConfig: (): Promise<OverlayConfig> => ipcRenderer.invoke(IPC.overlayGetConfig, KIND),
  /**
   * Persist a partial config for this kind; returns the merged value. Same path for every
   * remembered field: alpha/topN/lock from the footer controls, bounds from main, and the
   * drill-down (rare, so written immediately rather than debounced).
   */
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
  /**
   * DEEP LINK (Task #64): "take me to this mob in the app". Main raises + focuses the main
   * window and forwards the request to its renderer, which switches to the Mobs tab and opens
   * the mob's page. Fire-and-forget — an overlay never waits on the app it just raised.
   *
   * Interactive mode only, by the caller's construction: a LOCKED overlay is click-through by
   * law, so it has no clicks to give.
   */
  focusMob: (mob: string): void => ipcRenderer.send(IPC.focusView, { view: 'mobs', mob }),

  /** Close this overlay from its own close button (interactive mode only). */
  close: (): void => ipcRenderer.send(IPC.overlayClose, KIND)
}

export type EqOverlayApi = typeof overlayApi

contextBridge.exposeInMainWorld('eqOverlay', overlayApi)
