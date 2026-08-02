// The extension contract. A module is a self-contained consumer of the canonical
// LogEvent stream that owns a slice of derived state and exposes it to the
// renderer through ONE generic transport (see registry.ts + shared/ipc.ts):
//
//   - snapshot()   full state for hydration, tagged with the last consumed seq.
//   - flushDelta() everything accumulated since the previous flush (or null),
//                  tagged with the last consumed seq. The registry throttles this
//                  and pushes non-null results as `module:delta`.
//
// `seq` is the sequence number of the last LogEvent the module folded in. The
// renderer uses it for gap detection (delta.seq must be > known seq to apply) and
// dupe rejection. During historical replay (live:false) modules fold silently —
// the registry never flushes deltas until the live tail is running.
//
// Built-ins (loot / turnins / kills / leveling / character) wrap the pure reducer
// core in reducers.ts. Combat is a valid *transport variant* of this contract: it
// keeps its existing `combat:snapshot` IPC + `combat:activity` nudge (a snapshot
// that's re-fetched on a ping instead of diffed into deltas) and is NOT registered
// here — documented so the one-transport rule has an explicit, intentional
// exception rather than a silent one.

import type { LogEvent } from '../../shared/logEvents'

// Transport payloads live in shared/types so preload + renderer can import them
// without crossing the main<->web tsconfig boundary; re-exported here for callers
// that already import from the modules barrel.
export type { ModuleDelta, ModuleSnapshot } from '../../shared/types'

export interface EqModule<Snap = unknown, Delta = unknown> {
  /** Stable id, e.g. 'loot' | 'turnins' | 'kills' | 'leveling' | 'character'. */
  id: string
  /** Called on character (re)load, before the historical replay begins. */
  reset(): void
  /** Fold one event. `live` gates nothing here — the registry gates the push. */
  onEvent(ev: LogEvent, live: boolean): void
  /** Full current state for hydration, plus the last seq folded in. */
  snapshot(): { seq: number; state: Snap }
  /** Everything since the last flush, or null if nothing changed. */
  flushDelta(): { seq: number; delta: Delta } | null
}
