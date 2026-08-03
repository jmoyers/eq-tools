// Default overlay window placement (Task #59).
//
// Overlay windows persist their bounds the moment the user moves/resizes them, so this only
// ever decides where a kind appears the FIRST time it is opened (or after its stored bounds are
// cleared). The persisted position ALWAYS wins — see createOverlayWindow in index.ts, which
// prefers `cfg.bounds` and calls in here only when there are none.
//
// Layout: every kind docks to the BOTTOM-RIGHT of the primary display's work area, stacked
// upward in OVERLAY_KINDS order with a small gutter, so opening two or three overlays never
// lands one exactly on top of another. A kind with no explicit size gets the fallback, so
// adding a kind to OVERLAY_KINDS is enough to give it a sane first position.

import { OVERLAY_KINDS, type OverlayKind } from '../shared/types'

export interface Size {
  width: number
  height: number
}
export interface Bounds extends Size {
  x: number
  y: number
}

/** Size for a kind whose default isn't spelled out below. */
const FALLBACK_SIZE: Size = { width: 320, height: 220 }

/** Default window size per kind (the taller ones carry a selector / a scrolling feed). */
const SIZES: Partial<Record<OverlayKind, Size>> = {
  fight: { width: 320, height: 220 },
  overall: { width: 340, height: 240 },
  // The event log is a list, not a bar chart — it wants vertical room.
  events: { width: 360, height: 300 },
  // The healing meters (Task #59) carry an absorption section under the healer bars, so they
  // need a little more height than their damage twins or it is clipped away on first open.
  'heal-fight': { width: 340, height: 250 },
  'heal-overall': { width: 360, height: 270 }
}

/** The first-open size for a kind. */
export function overlayDefaultSize(kind: OverlayKind): Size {
  return SIZES[kind] ?? FALLBACK_SIZE
}

/** Gap from the screen edge and between stacked overlays. */
const MARGIN = 16
const GUTTER = 10

/**
 * Where a kind's window goes when it has no persisted bounds: docked bottom-right, offset
 * upward past every kind stacked below it (whether or not those are currently open — the slot
 * is reserved so positions stay stable and predictable). Clamped to the work area.
 */
export function defaultOverlayBounds(kind: OverlayKind, workArea: Bounds): Bounds {
  const size = overlayDefaultSize(kind)
  const idx = Math.max(0, OVERLAY_KINDS.indexOf(kind))
  let offset = 0
  for (let i = 0; i < idx; i++) offset += overlayDefaultSize(OVERLAY_KINDS[i]).height + GUTTER
  const x = workArea.x + workArea.width - size.width - MARGIN
  let y = workArea.y + workArea.height - size.height - MARGIN - offset
  // On a short screen the stack would run off the top; wrap back down rather than go off-screen.
  if (y < workArea.y) y = workArea.y + ((offset % Math.max(1, workArea.height)) % Math.max(1, workArea.height))
  return {
    ...size,
    x: Math.max(workArea.x, x),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size.height))
  }
}
