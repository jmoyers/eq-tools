// The module registry: the single owner of the extension push loop.
//
// Responsibilities:
//   - hold the registered modules (registration order = bus delivery order),
//   - subscribe each to the LogBus so they fold every event,
//   - after LIVE events, schedule a trailing ~100ms flush; for each module a
//     non-null flushDelta() is pushed to the renderer as `module:delta`,
//   - answer `module:getSnapshot(id)` by returning that module's snapshot().
//
// During historical replay (live:false) modules fold silently and NO flush is
// scheduled — the renderer hydrates via getSnapshot once, then rides deltas. The
// seq on every delta/snapshot is the last LogEvent seq the module consumed, which
// the renderer uses for gap detection + dupe rejection.

import type { EqModule, ModuleDelta } from './types'
import type { LogBus } from '../log/bus'

const FLUSH_THROTTLE_MS = 100

export interface RegistryHost {
  /** Push a `module:delta` to the renderer. */
  emitDelta(delta: ModuleDelta): void
}

export class ModuleRegistry {
  private modules: EqModule[] = []
  private byId = new Map<string, EqModule>()
  private unsub: (() => void) | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private host: RegistryHost) {}

  /** Register in delivery order. Call before wiring to the bus. */
  register(mod: EqModule): void {
    this.modules.push(mod)
    this.byId.set(mod.id, mod)
  }

  get<T extends EqModule = EqModule>(id: string): T | undefined {
    return this.byId.get(id) as T | undefined
  }

  /** Subscribe every module to the bus (registration order). Returns unsubscribe. */
  attach(bus: LogBus): () => void {
    const off = bus.subscribe((ev, live) => {
      for (const mod of this.modules) mod.onEvent(ev, live)
      if (live) this.scheduleFlush()
    })
    this.unsub = off
    return off
  }

  /** Reset every module (character (re)load) and drop any pending flush. */
  reset(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    for (const mod of this.modules) mod.reset()
  }

  /** Full snapshot for `module:getSnapshot`. Null when the id is unknown. */
  snapshot(id: string): { seq: number; state: unknown } | null {
    return this.byId.get(id)?.snapshot() ?? null
  }

  /** Flush every module now (used to push a character-switch immediately). */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.doFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.doFlush()
    }, FLUSH_THROTTLE_MS)
  }

  private doFlush(): void {
    for (const mod of this.modules) {
      const out = mod.flushDelta()
      if (out) this.host.emitDelta({ moduleId: mod.id, seq: out.seq, delta: out.delta })
    }
  }
}
