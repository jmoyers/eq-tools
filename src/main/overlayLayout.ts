// Default overlay window placement (Task #59).
//
// Overlay windows persist their bounds the moment the user moves/resizes them, so this only
// ever decides where a kind appears the FIRST time it is opened (or after its stored bounds are
// cleared). The persisted position ALWAYS wins — see createOverlayWindow in index.ts, which
// prefers `cfg.bounds` and calls in here only when there are none.
//
// Layout: every kind docks to the BOTTOM-RIGHT of the primary display's work area, stacked
// upward in OVERLAY_KINDS order with a small gutter, so opening two or three overlays never
// lands one exactly on top of another. When the stack would run past the top of the work area it
// WRAPS INTO A NEW COLUMN to the left instead — with one uniform size that is exact, so no two
// kinds can ever overlap on their first open.
//
// SIZE IS UNIFORM across kinds (user decision): every overlay opens at the same width x height,
// whatever it renders. It is erring on the large side of the old per-kind values so the event
// log — the only kind that is a list rather than a handful of dense bars — is not cramped.

import { OVERLAY_KINDS, type OverlayKind } from '../shared/types'

export interface Size {
  width: number
  height: number
}
export interface Bounds extends Size {
  x: number
  y: number
}

/**
 * The ONE default size every overlay kind opens at. Chosen to be ≥ every per-kind size this
 * replaced (the largest was the event log's 360x300): wide enough for a meter's `name · stats ·
 * rate · total` bar row without ellipsis, tall enough for ~8 event-log lines plus chrome.
 */
const DEFAULT_SIZE: Size = { width: 380, height: 320 }

/** The first-open size for a kind — the same for all of them. */
export function overlayDefaultSize(_kind: OverlayKind): Size {
  return { ...DEFAULT_SIZE }
}

/** Gap from the screen edge and between stacked overlays. */
const MARGIN = 16
const GUTTER = 10

/**
 * Where a kind's window goes when it has no persisted bounds: docked bottom-right, offset upward
 * past every kind stacked below it (whether or not those are currently open — the slot is
 * RESERVED so positions stay stable and predictable), wrapping into a fresh column to the left
 * once a column is full. Clamped to the work area as a last resort on a display too small to
 * hold even one full column.
 */
export function defaultOverlayBounds(kind: OverlayKind, workArea: Bounds): Bounds {
  const size = overlayDefaultSize(kind)
  const idx = Math.max(0, OVERLAY_KINDS.indexOf(kind))
  // How many uniform slots fit between the bottom and top margins of this work area.
  const perColumn = Math.max(
    1,
    Math.floor((workArea.height - 2 * MARGIN + GUTTER) / (size.height + GUTTER))
  )
  const col = Math.floor(idx / perColumn)
  const row = idx % perColumn
  const x = workArea.x + workArea.width - size.width - MARGIN - col * (size.width + GUTTER)
  const y = workArea.y + workArea.height - size.height - MARGIN - row * (size.height + GUTTER)
  return {
    ...size,
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - size.width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - size.height))
  }
}
