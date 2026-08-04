// Presence-driven preferences: the CURSOR RING and OVERLAY AUTO-HIDE blobs.
//
// Both settings answer the same question — "what should the app do about the EQ window?" — and
// both are read by main (to gate the presence watcher), written by Preferences, and normalized
// by a store migration. That is exactly the `shared/speechText.ts` situation, so it gets the
// same shape: a PURE module with no Electron, no parser and no `types.ts` import, so
// `storeMigrations.ts` (which runs from store.ts's module scope, before electron-store exists)
// can reach the normalizers without dragging the LogEvent union in behind them.
//
// The types are re-exported from `shared/types.ts` like every other shared shape, so consumers
// keep one import site.
//
// EVERY reader defaults. A store written by a future build, a hand edit, or a downgrade can
// leave any value in any key (storeMigrations.ts's downgrade contract), so `normalize*` takes
// `unknown` and always answers with a complete, in-range blob.

/**
 * A screen rectangle in DIP (device-independent pixels) — the coordinate space Electron's
 * `screen.getCursorScreenPoint()` and `BrowserWindow.getBounds()` both speak, and the space a
 * page's CSS px maps onto 1:1. The presence watcher reports the EQ window in it.
 */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * What the presence watcher (src/main/presence.ts) knows about EverQuest right now.
 *
 * `eqBounds` is the last known rectangle of the EQ window — it SURVIVES EQ losing focus (the
 * cursor ring is sized to it and re-positions only when it CHANGES), and is null until the EQ
 * window has been foreground at least once this session.
 */
export interface PresenceState {
  /**
   * Has the watcher reported ANYTHING yet? False for the first second or two of a launch (the
   * child pays a one-time compile before its first line) and again if it ever dies.
   *
   * This exists so the app never acts on a GUESS. `eqRunning:false` before the first report
   * means "we have not looked", not "the game is closed" — and auto-hide would otherwise blink
   * every overlay off at startup and back on a second later, on a machine where the game was
   * running the whole time.
   */
  observed: boolean
  /** Is an EverQuest process running at all? (5 s cadence — a coarse, cheap fact.) */
  eqRunning: boolean
  /** Is the EQ window the FOREGROUND window? (App-owned windows count as EQ-side — presence.ts.) */
  eqFocused: boolean
  /** Last known EQ window rectangle, or null if we have never seen it foreground. */
  eqBounds: ScreenRect | null
}

/** One cursor sample pushed to the ring window, in that window's own CSS px. */
export interface CursorPoint {
  x: number
  y: number
}

/**
 * The "ultimate mouse cursor" ring (owner request: "I lose my mouse on EQ screens"). A thick
 * white circle that follows the pointer, drawn ONLY over the EverQuest window.
 *
 * OFF BY DEFAULT and it stays that way: it costs a window, a watcher and an 8 ms poll, and a
 * user who has never lost their cursor should pay none of it.
 */
export interface CursorRingPrefs {
  /** Master switch. False ⇒ no ring window, no cursor poll, no presence watcher on its behalf. */
  enabled: boolean
  /** Outer diameter of the ring, in CSS px (= DIP; the page and the window share one scale). */
  sizePx: number
  /** Stroke width of the white ring, in CSS px. Drawn INSIDE the diameter (border-box). */
  thicknessPx: number
}

/**
 * Overlay auto-hide (owner request). TWO INDEPENDENT settings, deliberately not one tri-state:
 * "hide when the game isn't running" is housekeeping almost everyone wants, while "hide when
 * the game isn't focused" is a preference about alt-tabbing that many people actively don't.
 */
export interface OverlayAutoHidePrefs {
  /** Hide every open overlay while no EverQuest process is running. Default ON. */
  hideWhenNotRunning: boolean
  /** Hide every open overlay while EverQuest is not the foreground window. Default OFF. */
  hideWhenUnfocused: boolean
}

/** Ring size bounds. 20px is barely a dot; 200px stops being a cursor aid and starts being a
 *  window. The default is measured against the WoW addon look: a 44px halo reads at a glance
 *  without covering the thing you are clicking. */
export const MIN_RING_SIZE_PX = 20
export const MAX_RING_SIZE_PX = 200
export const DEFAULT_RING_SIZE_PX = 44

/** Stroke bounds. 1px vanishes over a busy scene; past 12px the ring fills its own hole. */
export const MIN_RING_THICKNESS_PX = 1
export const MAX_RING_THICKNESS_PX = 12
export const DEFAULT_RING_THICKNESS_PX = 4

export const DEFAULT_CURSOR_RING: CursorRingPrefs = {
  enabled: false,
  sizePx: DEFAULT_RING_SIZE_PX,
  thicknessPx: DEFAULT_RING_THICKNESS_PX
}

export const DEFAULT_OVERLAY_AUTO_HIDE: OverlayAutoHidePrefs = {
  hideWhenNotRunning: true,
  hideWhenUnfocused: false
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A finite number clamped into [lo, hi] and rounded to whole px, or `fallback` if it isn't one. */
function clampPx(value: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(value)))
}

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

/**
 * The cursor-ring prefs, defaulted + clamped field by field. Takes `unknown` on purpose — the
 * same value flows in from the store file, from a renderer slider, and from a share import.
 *
 * The thickness is additionally capped at HALF the diameter: a 4px stroke on a 6px ring is a
 * filled dot, and a stroke wider than the radius is not a ring at all.
 */
export function normalizeCursorRing(value: unknown): CursorRingPrefs {
  const v = isPlainObject(value) ? value : {}
  const sizePx = clampPx(v.sizePx, MIN_RING_SIZE_PX, MAX_RING_SIZE_PX, DEFAULT_RING_SIZE_PX)
  const thickness = clampPx(
    v.thicknessPx,
    MIN_RING_THICKNESS_PX,
    MAX_RING_THICKNESS_PX,
    DEFAULT_RING_THICKNESS_PX
  )
  return {
    enabled: bool(v.enabled, DEFAULT_CURSOR_RING.enabled),
    sizePx,
    thicknessPx: Math.max(MIN_RING_THICKNESS_PX, Math.min(thickness, Math.floor(sizePx / 2)))
  }
}

/** The overlay auto-hide prefs, defaulted field by field. */
export function normalizeOverlayAutoHide(value: unknown): OverlayAutoHidePrefs {
  const v = isPlainObject(value) ? value : {}
  return {
    hideWhenNotRunning: bool(v.hideWhenNotRunning, DEFAULT_OVERLAY_AUTO_HIDE.hideWhenNotRunning),
    hideWhenUnfocused: bool(v.hideWhenUnfocused, DEFAULT_OVERLAY_AUTO_HIDE.hideWhenUnfocused)
  }
}

/**
 * Does anything need the presence watcher running? The watcher is a child process; it starts
 * ONLY when a feature is switched on and stops the moment the last one goes off.
 *
 * Pure + exported because it is the exact predicate the gating tests pin: a user with every
 * one of these off must pay nothing at all.
 */
export function presenceNeeded(ring: CursorRingPrefs, autoHide: OverlayAutoHidePrefs): boolean {
  return ring.enabled || autoHide.hideWhenNotRunning || autoHide.hideWhenUnfocused
}
