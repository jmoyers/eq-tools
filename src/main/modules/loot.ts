// loot module — the self-loot history. Wraps the pure loot fold from reducers.ts
// (a LootEvent tagged with the zone it happened in). Delta = the rows appended
// since the last flush; the renderer concats them.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { LootDelta, LootEvent, LootSnap } from '../../shared/types'

export class LootModule implements EqModule<LootSnap, LootDelta> {
  readonly id = 'loot'
  private loot: LootEvent[] = []
  private zone: string | undefined
  private seq = 0
  private pending: LootEvent[] = []

  reset(): void {
    this.loot = []
    this.zone = undefined
    this.seq = 0
    this.pending = []
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // Character rebirth (Task #49): loot before the boundary is a dead same-name
      // character's. Clear the history so held-count / quest-progress derivation sees only
      // the current character. Keep `zone` (world state, not character-scoped — the next
      // zone line refreshes it regardless).
      this.loot = []
      this.pending = []
      return
    }
    if (ev.kind === 'zone') {
      this.zone = ev.zone
      return
    }
    if (ev.kind !== 'loot') return
    const row: LootEvent = {
      ts: ev.ts,
      item: ev.item,
      source: ev.source,
      zone: this.zone,
      disposition: ev.disposition,
      count: ev.count,
      created: ev.created
    }
    this.loot.push(row)
    this.pending.push(row)
  }

  snapshot(): { seq: number; state: LootSnap } {
    return { seq: this.seq, state: this.loot }
  }

  flushDelta(): { seq: number; delta: LootDelta } | null {
    if (this.pending.length === 0) return null
    const delta: LootDelta = { appended: this.pending }
    this.pending = []
    return { seq: this.seq, delta }
  }
}
