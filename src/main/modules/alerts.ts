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
// COMPOSITE triggers (Task #47): a trigger may be `{type:'any'|'all', conditions:[…]}` over
// the primitive event/raw/app shapes. 'any' fires when ANY condition matches a single event
// (OR); 'all' fires only when EVERY condition matches THE SAME event (AND — same-event only,
// no cross-event windows). Cooldown stays alert-level. It also matches the DERIVED
// `buffExpired` event the buffs module synthesizes (a resolved, unambiguous "wears off you /
// your pet" signal) — see shared/logEvents.ts BuffExpiredEvent + log/bus.ts emitDerived.
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
  AlertTriggerPrimitive,
  FiredAlert
} from '../../shared/types'

const DEFAULT_COOLDOWN_MS = 2000
/** Max fires kept per alert in the recent-fires ring buffer (Task #22). */
const HISTORY_CAP = 20
/**
 * Max distinct spell DISPLAY names kept in the rank recency map. A character's own cast
 * vocabulary is well under 300 in the reference log; the cap is a bound, not a policy, and
 * it evicts the least-recently-cast name so the map always describes what you use NOW.
 */
const SPELL_CAST_CAP = 400

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

/**
 * Stringify ONE event field for matching. A `where` key names an arbitrary field of an
 * arbitrary LogEvent, so the value is nearly always a string/number/boolean — but a few fields
 * hold arrays (`damage.modifiers`, the buff-landing `candidates` lists, one of which is an
 * array of OBJECTS).
 *
 * This reproduces JS's own `String()` coercion rather than improving on it, because the coerced
 * text is exactly what every existing alert def is matched against: an array joins its elements
 * with ',' (a nullish element contributing ''), and an object element renders as the literal
 * '[object Object]'. That last one IS what a def matching on the object-shaped `candidates` list
 * sees today — making it nicer would silently change which alerts fire. The final fallback also
 * absorbs bigint/symbol/function, which no LogEvent field holds.
 */
function fieldText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value == null) return '' // only reachable as an array ELEMENT — join() renders nullish as ''
  if (Array.isArray(value)) return (value as unknown[]).map(fieldText).join(',')
  return '[object Object]'
}

/** A single PRIMITIVE condition prepared for fast evaluation (regex compiled once). */
interface CompiledCondition {
  event?: { kind: string; fields: { key: string; test: (v: string) => boolean }[] }
  raw?: RegExp
  // 'app' primitives compile to neither event nor raw → they never match main-side.
}

/**
 * A compiled alert. A primitive trigger compiles to a single condition (`composite:'single'`);
 * a composite compiles to its type ('any'/'all') + the list of compiled conditions (Task #47).
 */
interface CompiledAlert {
  def: AlertDef
  composite: 'single' | 'any' | 'all'
  conditions: CompiledCondition[]
}

/** Compile one PRIMITIVE trigger into a matcher condition. */
function compileCondition(t: AlertTriggerPrimitive): CompiledCondition {
  if (t.type === 'event') {
    const fields = Object.entries(t.where ?? {}).map(([key, spec]) => ({
      key,
      test: compileFieldMatch(spec)
    }))
    return { event: { kind: t.kind, fields } }
  }
  if (t.type === 'raw') {
    let re: RegExp
    try {
      re = new RegExp(t.regex, 'i')
    } catch {
      // A bad regex should never match (and never throw); use a pattern that can't.
      re = /$.^/
    }
    return { raw: re }
  }
  // 'app' triggers are renderer-evaluated; compile to an empty condition (never matches here).
  return {}
}

// ---- spell context on the firing payload (docs/plans/voice-alerts.md §1) ----
//
// A spoken alert can say the spell that set it off ("Mesmerization", "Swift"), which means the
// FIRING has to carry it: the renderer receives `FiredAlert`, and before this it carried only
// the alert id, the timestamp and the matched raw line. Re-deriving the spell renderer-side
// would mean a second parser for lines main has already parsed.
//
// WHICH FIELD NAMES THE SPELL, PER KIND — measured against shared/logEvents.ts, not assumed.
// Most of the families spell it `spell`; three do not, and the exceptions are the whole reason
// this is a table instead of a property read:
//   * poisonProc  → `strike`  (the Strike's own name; a proc has no cast line at all)
//   * poisonCoat  → `poison`  (and it is the literal string 'unknown' for the generic
//                              third-person coat line, which is filtered below — 'unknown' is
//                              a stated absence, not a spell name)
//   * damage      → `skill`, but ONLY for dtype 'spell' | 'dot' (verified in log/parseCombat.ts:
//                   the typed-nuke and DoT shapes put the spell name there). For 'melee' it is
//                   a melee skill and for 'ds' it is the damage-shield element — neither is a
//                   spell, so neither is claimed. Handled separately, below.
//
// FAMILIES THAT CARRY NO SPELL, and therefore fall back to the alert's name when a spell speech
// mode fires on them: zone, loot, offer, trade, level, expGain, aaGain, aaSpend, aaActivate (an
// AA name is not a spell), death, playerDeath, mitigation, miss, charm, uncharm, petClaim,
// spellEmote (the emote text names no spell — that ambiguity is the point of the family),
// illusionFade (27-way ambiguous by design), poisonDry, stanceChange, invocationChange, selfWho,
// skillUp, itemActivate, itemMerge, itemMergeFailed, consider, epoch, sessionStart, campStart,
// campAbort, offlineGap, unknown — plus EVERY 'raw' trigger that matched a spell-less line and
// every renderer-evaluated 'app' signal (bossDefeat / questComplete, which arrive via appFired
// and never see a LogEvent at all).
//
// `cc` and `heal` declare `spell?` — present on some shapes only (a CC application names no
// spell; its worn-off keep-alive does). An absent field is simply an absent spell.

/** Event kind → the field on that event whose value is the triggering spell's DISPLAY name. */
const SPELL_FIELD_BY_KIND: Partial<Record<LogEvent['kind'], string>> = {
  castBegin: 'spell',
  castFizzle: 'spell',
  castInterrupted: 'spell',
  resist: 'spell',
  cc: 'spell',
  heal: 'spell',
  buffApply: 'spell',
  buffFade: 'spell',
  buffWearOff: 'spell',
  buffExpired: 'spell',
  poisonProc: 'strike',
  poisonCoat: 'poison'
}

/**
 * The spell that set this event off, DISPLAY form with the rank suffix INTACT — or undefined
 * when the family names none. Rank-stripping belongs to the speech resolver
 * (shared/speechText.ts), never to the producer: a consumer that wants "Mesmerization III"
 * must still be able to see the III.
 *
 * The one dynamic read mirrors `conditionMatches`'s own field access (the `where` matcher has
 * always indexed events by an arbitrary key), so this introduces no new escape hatch.
 */
function firingSpell(ev: LogEvent): string | undefined {
  if (ev.kind === 'damage') {
    return ev.dtype === 'spell' || ev.dtype === 'dot' ? ev.skill.trim() || undefined : undefined
  }
  const field = SPELL_FIELD_BY_KIND[ev.kind]
  if (field === undefined) return undefined
  const value = (ev as unknown as Record<string, unknown>)[field]
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  // 'unknown' is what a poisonCoat says when the line deliberately hides which poison it was.
  return name && name !== 'unknown' ? name : undefined
}

function compileAlert(def: AlertDef): CompiledAlert {
  const t: AlertTrigger = def.trigger
  if ('conditions' in t) {
    return { def, composite: t.type, conditions: t.conditions.map(compileCondition) }
  }
  return { def, composite: 'single', conditions: [compileCondition(t)] }
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
  /**
   * RANK-PRESERVING cast recency: spell DISPLAY name (suffix intact — "Mesmerization III") →
   * the newest ts you were seen to begin casting it.
   *
   * WHY IT LIVES HERE. The buffs model's own `lastSeen` map is keyed by `spellCanonKey`, which
   * STRIPS the rank — so it cannot answer "which rank am I actually using", the question the
   * suggestions surface and the upgrade offers are built on. `castBegin` is the literal
   * definition of "most recently cast" and is the ONE event family that keeps the rank
   * (fizzle / interrupt / wears-off lines all drop it). Recording it here costs one map write
   * per cast and adds no IPC: the alerts snapshot already flows to the renderer via useModule.
   *
   * Recorded for REPLAY events too (unlike firing, which is live-only) so the map is complete
   * the moment the renderer hydrates.
   */
  private spellLastCast = new Map<string, number>()
  /** Names whose recency advanced since the last flush (delta payload). */
  private castPending = new Map<string, number>()

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
    // only the per-character firing bookkeeping resets. The cast-recency map IS character
    // state (a different character casts different ranks), so it resets with it — the
    // replay that follows repopulates it.
    this.seq = 0
    this.lastFire = new Map()
    this.pending = []
    this.spellLastCast = new Map()
    this.castPending = new Map()
  }

  /**
   * Record a rank-preserving cast. Runs for replay events as well as live ones — the map
   * describes the character, not the session, and the renderer must see it at hydration.
   */
  private noteCast(ev: LogEvent): void {
    if (ev.kind !== 'castBegin') return
    const name = ev.spell.trim()
    if (!name) return
    const prev = this.spellLastCast.get(name)
    if (prev !== undefined && prev >= ev.ts) return
    // Re-insert so Map iteration order stays least-recent-first for the eviction below.
    this.spellLastCast.delete(name)
    this.spellLastCast.set(name, ev.ts)
    this.castPending.set(name, ev.ts)
    if (this.spellLastCast.size > SPELL_CAST_CAP) {
      const oldest = this.spellLastCast.keys().next()
      if (!oldest.done) this.spellLastCast.delete(oldest.value)
    }
  }

  onEvent(ev: LogEvent, live: boolean): void {
    this.seq = ev.seq
    this.noteCast(ev)
    // Fire on LIVE events only — replay must never make a sound.
    if (!live) return
    // Resolved once per firing (fires are rare), not once per compiled alert.
    let spell: string | undefined
    let spellResolved = false
    for (const c of this.compiled) {
      if (!c.def.enabled) continue
      const matchedText = this.matches(c, ev)
      if (matchedText == null) continue
      if (this.onCooldown(c.def, ev.ts)) continue
      this.lastFire.set(c.def.id, ev.ts)
      if (!spellResolved) {
        spell = firingSpell(ev)
        spellResolved = true
      }
      const fired: FiredAlert = { alertId: c.def.id, ts: ev.ts, matchedText }
      // Omitted rather than set to undefined: the delta is JSON over IPC, and an absent key
      // is the honest encoding of "this family names no spell".
      if (spell !== undefined) fired.spell = spell
      this.pending.push(fired)
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

  /**
   * Returns the matched text if the alert's trigger matches `ev`, else null.
   *
   * Composite semantics (Task #47) — evaluated against the SINGLE incoming event:
   *   'any'    → fires when at least ONE condition matches (OR).
   *   'all'    → fires only when EVERY condition matches THE SAME event (AND).
   *   'single' → the one primitive condition (backward-compatible, unchanged).
   * Cross-event correlation is deliberately out of scope; an 'all' over conditions that can
   * never co-occur on one event (e.g. two different `kind`s) simply never fires.
   */
  private matches(c: CompiledAlert, ev: LogEvent): string | null {
    if (c.composite === 'all') {
      // Every condition must match this one event. An empty condition list can't be satisfied
      // meaningfully — treat it as no-match to avoid a firehose.
      if (c.conditions.length === 0) return null
      for (const cond of c.conditions) {
        if (!this.conditionMatches(cond, ev)) return null
      }
      return ev.raw
    }
    // 'any' and 'single': fire on the first matching condition.
    for (const cond of c.conditions) {
      if (this.conditionMatches(cond, ev)) return ev.raw
    }
    return null
  }

  /** Whether ONE primitive condition matches `ev`. */
  private conditionMatches(cond: CompiledCondition, ev: LogEvent): boolean {
    if (cond.event) {
      if (ev.kind !== cond.event.kind) return false
      for (const f of cond.event.fields) {
        const raw = (ev as unknown as Record<string, unknown>)[f.key]
        if (raw == null) return false
        if (!f.test(fieldText(raw))) return false
      }
      return true
    }
    if (cond.raw) {
      return cond.raw.test(ev.raw)
    }
    // 'app' conditions never match main-side.
    return false
  }

  snapshot(): { seq: number; state: AlertsSnap } {
    return {
      seq: this.seq,
      state: {
        defs: this.defs(),
        history: this.historyObj(),
        spellLastCast: Object.fromEntries(this.spellLastCast)
      }
    }
  }

  flushDelta(): { seq: number; delta: AlertsDelta } | null {
    // A flush is warranted by EITHER a fire or a cast-recency advance — the upgrade offers
    // recompute off the latter, and they must not wait for an unrelated alert to fire.
    if (this.pending.length === 0 && this.castPending.size === 0) return null
    const fired = this.pending
    this.pending = []
    const cast = [...this.castPending].map(([spell, ts]) => ({ spell, ts }))
    this.castPending = new Map()
    return { seq: this.seq, delta: cast.length > 0 ? { fired, cast } : { fired } }
  }
}
