// turnins module — completed NPC trades / quest turn-ins. Wraps the offer/trade
// pairing state from reducers.ts: offers accumulate per NPC until the matching
// "complete the trade" line closes the group. Delta = turn-ins appended.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { TurnInDelta, TurnInEvent, TurnInSnap } from '../../shared/types'

export class TurnInsModule implements EqModule<TurnInSnap, TurnInDelta> {
  readonly id = 'turnins'
  private turnIns: TurnInEvent[] = []
  private pendingOffer: { npc: string; items: string[] } | null = null
  private seq = 0
  private pending: TurnInEvent[] = []

  reset(): void {
    this.turnIns = []
    this.pendingOffer = null
    this.seq = 0
    this.pending = []
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // Character rebirth (Task #49): turn-ins before the boundary are a dead same-name
      // character's. Clear them so Plane-of-Sky quest AUTO-completion (which re-derives from
      // this module) reflects only the current character. Drop any half-formed offer group.
      this.turnIns = []
      this.pendingOffer = null
      this.pending = []
      return
    }
    if (ev.kind === 'offer') {
      if (this.pendingOffer?.npc === ev.npc) this.pendingOffer.items.push(ev.item)
      else this.pendingOffer = { npc: ev.npc, items: [ev.item] }
      return
    }
    if (ev.kind === 'trade') {
      if (this.pendingOffer?.npc === ev.npc) {
        const t: TurnInEvent = { ts: ev.ts, npc: ev.npc, items: this.pendingOffer.items }
        this.turnIns.push(t)
        this.pending.push(t)
      }
      this.pendingOffer = null
    }
  }

  snapshot(): { seq: number; state: TurnInSnap } {
    return { seq: this.seq, state: this.turnIns }
  }

  flushDelta(): { seq: number; delta: TurnInDelta } | null {
    if (this.pending.length === 0) return null
    const delta: TurnInDelta = { appended: this.pending }
    this.pending = []
    return { seq: this.seq, delta }
  }
}
