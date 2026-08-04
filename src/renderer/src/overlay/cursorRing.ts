// cursorRing.ts — the entire renderer half of the cursor ring.
//
// It lives in `src/renderer/src/overlay/` beside the meters but shares NOTHING with them: no
// React, no MUI, no theme, no shared component. The meters are a UI; this is one <div> that
// moves. Pulling in a framework to move a div would add a reconciler to the hottest path in the
// app for no expressible benefit — so this file is plain DOM, and it is the whole module.
//
// ============================ THE PERFORMANCE CONTRACT ============================
// The owner's requirement was "it can't feel like it's lagging". Three rules make that true,
// and every one of them is visible in the ~15 lines of real code below:
//
//   1. THE REAL CURSOR IS NEVER TOUCHED. Windows draws the system pointer; this window is
//      click-through and `cursor: none`. Only the halo follows, so even if a frame is dropped
//      the pointer the user is aiming with is exactly where it always was. There is no path by
//      which this feature can make the mouse itself feel heavy.
//   2. NEWEST POINT WINS; STALE POINTS ARE DROPPED, NEVER QUEUED. Main streams samples at
//      ~8 ms — faster than any display refreshes. We keep ONE variable and paint it on the next
//      animation frame. A backlog is therefore impossible by construction: if ten samples land
//      between two frames, nine are overwritten and cost a single assignment each. Queueing
//      them would be exactly the "feels laggy" failure — a ring replaying where the mouse USED
//      to be.
//   3. COMPOSITOR-ONLY PAINTING. The ring element is created once, sized once (and again only
//      when the user changes the setting), and thereafter only its `transform` changes. That is
//      a GPU layer translation: no canvas, no repaint, no layout, no style recalc that touches
//      anything else. There is no timer in this file at all — no rAF is scheduled while the
//      mouse is still, because main sends nothing while the point is unchanged.

import type { CursorPoint, CursorRingPrefs } from '@shared/presencePrefs'

/** The bridge `preload/cursor.ts` installs. Narrow on purpose — this window can receive its
 *  config and a stream of points, and can do nothing else. */
declare global {
  interface Window {
    eqCursor?: {
      getConfig: () => Promise<CursorRingPrefs>
      onConfig: (cb: (c: CursorRingPrefs) => void) => () => void
      onPoint: (cb: (p: CursorPoint) => void) => () => void
    }
  }
}

const ringEl = document.getElementById('ring')
// cursor.html always carries #ring; fail loudly rather than silently tracking nothing.
if (!ringEl) throw new Error('cursorRing: #ring element missing from cursor.html')
// Re-bound with a non-null declared type: TS resets narrowing inside the closures below.
const ring: HTMLElement = ringEl

/** Half the diameter — the offset that centres the ring on the pointer. Recomputed only when
 *  the size setting changes, so the hot path is two subtractions. */
let radius = 0

function applyConfig(cfg: CursorRingPrefs): void {
  radius = cfg.sizePx / 2
  ring.style.width = `${cfg.sizePx}px`
  ring.style.height = `${cfg.sizePx}px`
  ring.style.borderWidth = `${cfg.thicknessPx}px`
  // Re-centre on the last known point. Without this a size change while the mouse is STILL
  // would leave the ring off-centre by the radius delta until the pointer next moved — and a
  // Preferences slider is exactly the moment the pointer is somewhere else entirely.
  schedulePaint()
}

// ---- the hot path ----
//
// `latest` is the only mutable state. `queued` is a plain boolean rather than a rAF handle
// because we never cancel a frame — we simply refuse to schedule a second one.
let latest: CursorPoint | null = null
let queued = false

function paint(): void {
  queued = false
  if (!latest) return
  // Translate only. Rounding to whole pixels keeps the ring off half-pixel boundaries, where
  // the compositor would resample the border and make a crisp 4px stroke look soft.
  ring.style.transform = `translate3d(${Math.round(latest.x - radius)}px, ${Math.round(latest.y - radius)}px, 0)`
}

/** Ask for at most ONE frame. Calling this ten times between two frames costs nine boolean
 *  reads — that is the whole anti-backlog mechanism. */
function schedulePaint(): void {
  if (queued) return
  queued = true
  requestAnimationFrame(paint)
}

function onPoint(p: CursorPoint): void {
  latest = p
  schedulePaint()
}

const bridge = window.eqCursor
if (bridge) {
  void bridge.getConfig().then(applyConfig)
  bridge.onConfig(applyConfig)
  bridge.onPoint(onPoint)
}
