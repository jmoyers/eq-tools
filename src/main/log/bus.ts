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
  }

  /** Drop all subscribers (used when re-pointing at a new character). */
  clear(): void {
    this.listeners = []
  }
}
