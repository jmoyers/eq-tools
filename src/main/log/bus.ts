// A minimal, synchronous, in-main event bus for the canonical LogEvent stream.
//
// Both feeders (the historical scan and the live tailer) call emit(); every
// consumer (loot/kills/levels/AA reducers, the combat engine, the coming world
// model + extension framework) subscribes. Subscribers fire in registration
// order, synchronously, in the emitting call stack — no async, no queue — so the
// scan's strict file order is preserved end-to-end and reducers see events in the
// exact sequence the log produced them.
//
// `live` distinguishes the two feeders: false during the initial historical
// replay, true for lines the game appends while the app runs. Consumers use it to
// gate side effects that should only happen live (IPC pushes, classification-ring
// logging) while still folding historical events into their snapshot state.

import type { LogEvent } from '../../shared/logEvents'

export type LogEventListener = (ev: LogEvent, live: boolean) => void

export class LogBus {
  private listeners: LogEventListener[] = []
  /**
   * DERIVED-event queue (Task #47). A consumer (the buffs module) may synthesize a RESOLVED
   * event (`buffExpired`) while folding a primary event and hand it back to the bus via
   * emitDerived(). We queue it rather than emit it inline so we never re-enter the listener
   * loop mid-delivery; it is drained AFTER the current primary event finishes reaching every
   * listener, then delivered through the SAME listener loop (so a later-registered consumer —
   * e.g. alerts — sees it). No feedback loop is possible: buffs, the only producer, ignores
   * `buffExpired`, so a derived event never spawns another. `live` is inherited from the
   * primary event so a replayed wear-off stays live:false (alerts never fire on replay).
   */
  private derived: Array<{ ev: LogEvent; live: boolean }> = []
  private delivering = false

  /** Register a listener; returns an unsubscribe fn. Order is registration order. */
  subscribe(fn: LogEventListener): () => void {
    this.listeners.push(fn)
    return () => {
      const i = this.listeners.indexOf(fn)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }

  /** Synchronously deliver an event to all subscribers in registration order. */
  emit(ev: LogEvent, live: boolean): void {
    for (const fn of this.listeners) fn(ev, live)
    // Drain any derived events synthesized during this delivery (and any they in turn
    // synthesize — though in practice buffs never derives from a derived event). The
    // `delivering` guard means a nested emit() (should one ever occur) doesn't double-drain.
    if (this.delivering) return
    this.delivering = true
    try {
      while (this.derived.length > 0) {
        const next = this.derived.shift()!
        for (const fn of this.listeners) fn(next.ev, next.live)
      }
    } finally {
      this.delivering = false
    }
  }

  /**
   * Queue a DERIVED event (Task #47) to be delivered after the current primary event. Called
   * by a consumer from inside its own onEvent while folding the primary event. See the
   * `derived` field for the no-feedback-loop rationale.
   */
  emitDerived(ev: LogEvent, live: boolean): void {
    this.derived.push({ ev, live })
  }

  /** Drop all subscribers (used when re-pointing at a new character). */
  clear(): void {
    this.listeners = []
    this.derived = []
  }
}
