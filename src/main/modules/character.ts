// character module — the active CharacterRef + current zone. Zone comes from the
// log stream; the CharacterRef is owned by index.ts (it resolves which log to
// tail) and pushed in via setCharacter(). Both surface through the same module
// transport so a view can subscribe to "who am I / where am I" without a bespoke
// channel. Delta is a partial merge (zone changed, or character changed, or both).

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { CharacterDelta, CharacterRef, CharacterSnap } from '../../shared/types'

export class CharacterModule implements EqModule<CharacterSnap, CharacterDelta> {
  readonly id = 'character'
  private character: CharacterRef | null = null
  private zone: string | undefined
  private seq = 0
  private pending: CharacterDelta = {}

  reset(): void {
    // Keep the character ref across a reset — reset() runs on (re)load and the
    // ref is set by index.ts right before/after. Only log-derived zone clears.
    this.zone = undefined
    this.seq = 0
    this.pending = {}
  }

  /** Called by index.ts when the tailed character changes. */
  setCharacter(ref: CharacterRef | null): void {
    this.character = ref
    this.pending.character = ref
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'zone' && ev.zone !== this.zone) {
      this.zone = ev.zone
      this.pending.zone = ev.zone
    }
  }

  snapshot(): { seq: number; state: CharacterSnap } {
    return { seq: this.seq, state: { character: this.character, zone: this.zone } }
  }

  flushDelta(): { seq: number; delta: CharacterDelta } | null {
    if (Object.keys(this.pending).length === 0) return null
    const delta = this.pending
    this.pending = {}
    return { seq: this.seq, delta }
  }
}
