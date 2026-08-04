// lib/telemetry.ts — the renderer's one door onto usage analytics.
//
// Every `window.eq.track()` call in the app goes through `track()` here, for two reasons:
//
//   1. IT VALIDATES FIRST, with the SAME shared function main runs at the IPC handler and wave
//      A2's ingest Lambda will run on arrival. A mistake is then caught where it was made,
//      instead of vanishing silently at a boundary three files away. (Main validates again
//      regardless — the renderer is untrusted there, and that never changes.)
//   2. IT CANNOT THROW. Analytics is the one feature in this app that must never make noise
//      when it fails: a broken counter must not take a click, a view switch, or a dialog with
//      it. Every failure here is a dropped event and nothing else.
//
// THE SCHEMA IS THE PRIVACY BOUNDARY, not this file. `TelemetryEvent` (src/shared/telemetry.ts)
// has no free-text field anywhere in it, so a call site literally cannot pass a character name,
// a zone, a spell, a search string or a line of log — there is no parameter for one.
//
// NOTE THAT NOTHING IS SENT. This build has no telemetry endpoint compiled in; these calls fill
// a local ring the user can read in Preferences and nothing else.

import { useEffect, useRef } from 'react'
import type { TelemetryEvent, TelemetryFeature } from '@shared/telemetry'
import { validateTelemetryEvent } from '@shared/telemetryValidate'

/** Record one event. Never throws, never rejects, never blocks the caller. */
export function track(event: TelemetryEvent): void {
  try {
    if (!validateTelemetryEvent(event).ok) return
    window.eq.track(event)
  } catch {
    // A counter is never worth a user-visible failure.
  }
}

/** `featureUse` for a single use of one of the closed feature ids — the common case by far. */
export function trackFeature(feature: TelemetryFeature): void {
  track({ t: 'featureUse', feature, count: 1 })
}

/** The dwell enum, named here so call sites do not have to reach into the union themselves.
 *  It is the same set as the app's own `View` union (appViews.ts) — by construction, since a
 *  view the schema does not list cannot be reported at all. */
export type ViewDwellId = Extract<TelemetryEvent, { t: 'viewDwell' }>['view']

/** Below this, a "view" was a pass-through — a click on the way to somewhere else. Recording
 *  those would make the dwell histogram mostly noise about how fast people can click. */
const MIN_DWELL_MS = 1_000

/**
 * Report how long each tab was on screen, once per switch (plan §2: "flushed on switch").
 *
 * Deliberately NOT a timer: it reads the clock when the view changes and again when the app
 * unmounts. A polling version would have to decide what "still looking at it" means while the
 * window is in the background, and it would produce an event per tick instead of per switch.
 *
 * `view` is typed as the closed `viewDwell` enum, so a view id this schema does not know cannot
 * be reported at all — the caller has to widen the schema first, which is the point.
 */
export function useViewDwell(view: ViewDwellId): void {
  const since = useRef(Date.now())
  const current = useRef(view)

  useEffect(() => {
    const now = Date.now()
    const previous = current.current
    const ms = now - since.current
    since.current = now
    current.current = view
    if (previous !== view && ms >= MIN_DWELL_MS) track({ t: 'viewDwell', view: previous, ms })
  }, [view])

  // The LAST view of a session never gets a switch, so the unmount reports it. Reads the refs
  // rather than closing over `view`, so it stays a mount/unmount effect with no dependencies.
  useEffect(() => {
    return () => {
      const ms = Date.now() - since.current
      if (ms >= MIN_DWELL_MS) track({ t: 'viewDwell', view: current.current, ms })
    }
  }, [])
}
