// kills module — the KillMap (per-mob count / best instance tier / first+last
// seen). Reuses the pure isCountedKill filter + recordKill fold from reducers.ts
// so the count semantics stay identical to the legacy tracker. Delta = only the
// per-mob entries that changed since the last flush; the renderer merges them in.

import type { EqModule } from './types'
import { isCountedKill, recordKill } from '../log/reducers'
import { zoneTier, idKey } from '../log/parser'
import type { LogEvent } from '../../shared/logEvents'
import type { KillMap, KillsDelta, KillsSnap } from '../../shared/types'

export class KillsModule implements EqModule<KillsSnap, KillsDelta> {
  readonly id = 'kills'
  private kills: KillMap = {}
  private zone: string | undefined
  private seq = 0
  /** mob names touched since the last flush (deltas carry only these entries). */
  private dirty = new Set<string>()

  reset(): void {
    this.kills = {}
    this.zone = undefined
    this.seq = 0
    this.dirty = new Set()
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    if (ev.kind === 'epoch') {
      // Character rebirth (Task #49): kills before the boundary are a dead same-name
      // character's. Clear the KillMap. (The delta is a per-mob merge, not a full replace, so
      // a LIVE wipe relies on the re-hydration index.ts triggers via onCharacter; during a
      // rescan the reset happens mid-replay and no deltas push.)
      this.kills = {}
      this.dirty = new Set()
      return
    }
    if (ev.kind === 'zone') {
      this.zone = ev.zone
      return
    }
    if (ev.kind !== 'death') return
    if (!isCountedKill(ev)) return
    const tier = zoneTier(this.zone ?? '').tier
    // Key by the canonical lowercase name so the two casings EQ emits for the same
    // mob (sentence-start "A …" on slain-by lines, mid-sentence "a …" on
    // You-have-slain lines) fold into one entry; keep the raw name for display.
    const key = idKey(ev.name)
    recordKill(this.kills, key, ev.name, tier, ev.ts)
    this.dirty.add(key)
  }

  snapshot(): { seq: number; state: KillsSnap } {
    return { seq: this.seq, state: this.kills }
  }

  flushDelta(): { seq: number; delta: KillsDelta } | null {
    if (this.dirty.size === 0) return null
    const changed: KillMap = {}
    for (const mob of this.dirty) changed[mob] = this.kills[mob]
    this.dirty = new Set()
    return { seq: this.seq, delta: { changed } }
  }
}
