// alerts module — the first real proof of the EqModule extension contract.
//
// It evaluates 'event' and 'raw' alert triggers against LIVE LogEvents only (the
// registry never flushes during replay, but we ALSO gate here so a future direct
// caller can't accidentally fire on historical events), respecting each alert's
// enabled flag and cooldown. Each fire is accumulated and pushed as the standard
// `module:delta` payload `{ fired: FiredAlert[] }`; the renderer's always-mounted
// player turns those into actual audio.
//
// 'app'-type triggers (e.g. bossDefeat) are evaluated RENDERER-side (they depend
// on derived boss state that lives in the renderer), so this module stores/serves
// their defs via snapshot() but never fires them itself.
//
// Alert defs are owned by the store; the module holds a live copy that main keeps
// in sync (setDefs) whenever the user saves/deletes an alert.

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type {
  AlertDef,
  AlertFireRecord,
  AlertsDelta,
  AlertsSnap,
  AlertTrigger,
  FiredAlert
} from '../../shared/types'

const DEFAULT_COOLDOWN_MS = 2000
/** Max fires kept per alert in the recent-fires ring buffer (Task #22). */
const HISTORY_CAP = 20

/**
 * Compile a matcher value into a predicate. A value wrapped in slashes (`/.../`)
 * is a case-insensitive regex; anything else is a case-insensitive exact match on
 * the stringified field. Invalid regex falls back to literal equality so a bad
 * def degrades gracefully instead of throwing in the hot path.
 */
function compileFieldMatch(spec: string): (fieldValue: string) => boolean {
  if (spec.length >= 2 && spec.startsWith('/') && spec.endsWith('/')) {
    const body = spec.slice(1, -1)
    try {
      const re = new RegExp(body, 'i')
      return (v) => re.test(v)
    } catch {
      // fall through to literal
    }
  }
  const lower = spec.toLowerCase()
  return (v) => v.toLowerCase() === lower
}

/** A trigger prepared for fast evaluation (regex compiled once at setDefs time). */
interface CompiledEventTrigger {
  kind: string
  fields: Array<{ key: string; test: (v: string) => boolean }>
}

interface CompiledAlert {
  def: AlertDef
  event?: CompiledEventTrigger
  raw?: RegExp
}

function compileAlert(def: AlertDef): CompiledAlert {
  const t: AlertTrigger = def.trigger
  if (t.type === 'event') {
    const fields = Object.entries(t.where ?? {}).map(([key, spec]) => ({
      key,
      test: compileFieldMatch(spec)
    }))
    return { def, event: { kind: t.kind, fields } }
  }
  if (t.type === 'raw') {
    let re: RegExp
    try {
      re = new RegExp(t.regex, 'i')
    } catch {
      // A bad regex should never match (and never throw); use a pattern that can't.
      re = /$.^/
    }
    return { def, raw: re }
  }
  // 'app' triggers are renderer-evaluated; nothing to compile here.
  return { def }
}

export class AlertsModule implements EqModule<AlertsSnap, AlertsDelta> {
  readonly id = 'alerts'
  private compiled: CompiledAlert[] = []
  private seq = 0
  /** alertId → last fire timestamp (ms), for cooldown gating. */
  private lastFire = new Map<string, number>()
  /** fires accumulated since the last flush. */
  private pending: FiredAlert[] = []
  /**
   * Per-alert ring buffer of recent fires (last HISTORY_CAP, newest last). The
   * single source of truth for the renderer's "recent fires" panel — fed by both
   * main-side event/raw fires (onEvent) and renderer-routed app fires (appFired).
   * Persists across character switches so history isn't lost on a reload.
   */
  private history = new Map<string, AlertFireRecord[]>()

  /** Replace the live alert set (called by main after load + every save/delete). */
  setDefs(defs: AlertDef[]): void {
    this.compiled = defs.map(compileAlert)
  }

  /** The defs currently loaded (for snapshot()). */
  private defs(): AlertDef[] {
    return this.compiled.map((c) => c.def)
  }

  reset(): void {
    // Defs persist across character switches (they're user prefs, not log state);
    // only the per-character firing bookkeeping resets.
    this.seq = 0
    this.lastFire = new Map()
    this.pending = []
  }

  onEvent(ev: LogEvent, live: boolean): void {
    this.seq = ev.seq
    // Fire on LIVE events only — replay must never make a sound.
    if (!live) return
    for (const c of this.compiled) {
      if (!c.def.enabled) continue
      const matchedText = this.matches(c, ev)
      if (matchedText == null) continue
      if (this.onCooldown(c.def, ev.ts)) continue
      this.lastFire.set(c.def.id, ev.ts)
      this.pending.push({ alertId: c.def.id, ts: ev.ts, matchedText })
      this.record(c.def.id, ev.ts, matchedText)
    }
  }

  /**
   * Record a renderer-evaluated 'app' fire (e.g. bossDefeat) into the history so
   * the module stays the single source of truth for recent fires. `context` is the
   * signal's matched text (e.g. the boss name). The renderer already applied the
   * cooldown before calling this; we just append to the ring. Returns the updated
   * history for that alert so main can push it back if desired.
   */
  appFired(alertId: string, context: string, ts: number = Date.now()): void {
    // Only record for a known 'app' alert id (ignore stale/unknown ids).
    const known = this.compiled.some((c) => c.def.id === alertId)
    if (!known) return
    this.record(alertId, ts, context)
    // Also queue a delta so the renderer's history updates over the same module
    // transport as event/raw fires. Bump seq so useModule doesn't reject it as a
    // dupe (app fires arrive off the bus, so there's no fresh LogEvent seq); a
    // trailing flushNow() by main pushes it. matchedText = the signal context.
    this.seq += 1
    this.pending.push({ alertId, ts, matchedText: context })
  }

  /** Append a fire to an alert's ring buffer, capping at HISTORY_CAP (newest last). */
  private record(alertId: string, ts: number, matchedText: string): void {
    const arr = this.history.get(alertId) ?? []
    arr.push({ ts, matchedText })
    if (arr.length > HISTORY_CAP) arr.splice(0, arr.length - HISTORY_CAP)
    this.history.set(alertId, arr)
  }

  /** The recent-fires ring as a plain object for the snapshot. */
  private historyObj(): Record<string, AlertFireRecord[]> {
    const out: Record<string, AlertFireRecord[]> = {}
    for (const [id, arr] of this.history) out[id] = arr.slice()
    return out
  }

  /** Whether alert `def` is still within its cooldown window at `ts`. */
  private onCooldown(def: AlertDef, ts: number): boolean {
    const cd = def.cooldownMs ?? DEFAULT_COOLDOWN_MS
    const last = this.lastFire.get(def.id)
    return last !== undefined && ts - last < cd
  }

  /** Returns the matched text if the alert's trigger matches `ev`, else null. */
  private matches(c: CompiledAlert, ev: LogEvent): string | null {
    if (c.event) {
      if (ev.kind !== c.event.kind) return null
      for (const f of c.event.fields) {
        const raw = (ev as unknown as Record<string, unknown>)[f.key]
        if (raw == null) return null
        if (!f.test(String(raw))) return null
      }
      return ev.raw
    }
    if (c.raw) {
      return c.raw.test(ev.raw) ? ev.raw : null
    }
    // 'app' triggers never match here.
    return null
  }

  snapshot(): { seq: number; state: AlertsSnap } {
    return { seq: this.seq, state: { defs: this.defs(), history: this.historyObj() } }
  }

  flushDelta(): { seq: number; delta: AlertsDelta } | null {
    if (this.pending.length === 0) return null
    const fired = this.pending
    this.pending = []
    return { seq: this.seq, delta: { fired } }
  }
}
