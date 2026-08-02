// buffs module (Task #19; latency+coverage fix Task #30) — a log-mined buff-duration
// model, all state from events.
//
// The player's own casts drive a small state machine and a duration miner:
//
//   castBegin(S)   → S becomes the PENDING cast (replaces any prior pending), AND is
//                    shown OPTIMISTICALLY right away (see LANDING MODEL below).
//   castFizzle(S)  → if S is pending, clear it (the cast produced no buff) and
//                    retract its optimistic display.
//   castInterrupted(S) → same (cleared + retracted).
//   buffFade(S)    → S's active buff expired; pairs with the matching landed cast
//                    to yield a duration sample.
//   playerDeath    → death strips ALL buffs; clears active state AND censors every
//                    open (unpaired) landed cast (no sample — death, not expiry).
//
// LANDING (mining) APPROXIMATION (documented, UNCHANGED from v1): cast times are
// unknown, so a pending self/pet buff is considered LANDED (for MINING) when neither
// a fizzle nor an interrupt of that spell occurs before EITHER the next castBegin OR
// 15s of log-time elapse (whichever comes first). A buffFade of the pending spell also
// implies it landed. The landed timestamp is the cast-BEGIN ts (cast seconds are
// negligible vs minute-scale durations). Mining semantics are byte-identical to v1 so
// duration samples are unchanged — the `open`/`samples` maps and `landPending` mining
// path are untouched.
//
// OPTIMISTIC DISPLAY WITH RETRACTION (Task #30 — the latency fix): the DISPLAY (the
// `active` map) no longer waits for confirmation. On castBegin(S):
//   - if S already has a CONFIRMED active entry, KEEP it displayed but stage a
//     provisional refresh (`stagedRefresh`) — we do NOT move its startedTs until the
//     cast confirms, so a refresh that fizzles leaves the prior confirmed buff intact.
//   - else if S ∈ everFaded (known to be a buff) and has no active entry, create a
//     PROVISIONAL active entry (`provisional: true`, startedTs = beganTs) immediately.
// A fizzle/interrupt of S drops the provisional active entry / abandons the staged
// refresh (a previously-confirmed active buff MUST survive its refresh fizzling).
// CONFIRMATION happens exactly when MINING lands the cast (next-castBegin / +15s / its
// own fade) — at that point `provisional` clears and a staged refresh moves startedTs.
// A never-before-faded spell still shows nothing until its first fade classifies it.
//
// WALL-CLOCK TICK (Task #30 — the idle fix): the 15s land timeout used to advance only
// inside onEvent (a later log line). Standing idle after a cast meant no line evaluated
// the timeout, so the buff stayed provisional forever. `onTick(nowMs)` (called ~1×/sec
// by the registry with Date.now() during the LIVE tail only) runs maybeLandPendingByTime
// so confirmation fires in real time while the log is idle. Log timestamps and Date.now()
// share the local clock, so mixing them is safe. This also gives RESTART CURRENCY: after
// a scan, a pending cast from minutes ago confirms on the first live tick (now ≫ beganTs).
//
// DURATION MINING: for each landed cast of S, pair it with the NEXT buffFade of S →
// sample = fade_ts − land_ts. CENSORED (no sample) when a recast of S lands before the
// fade (a refresh — the active timer restarts, the old open cast is discarded) or
// playerDeath occurs before the fade. Zone lines do NOT clear buffs (EQ buffs persist
// through zoning), so zoning is ignored here.
//
// BUFF FILTER (the honest discriminator): only spells that have EVER produced a
// buffFade are treated as buffs. Named-target fades (Task #30 parser change) also count
// — a buff cast on the charmed pet BY NAME now feeds the miner; samples are keyed per
// spell (per-spell-per-target pairing is a known v1 simplification).

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { ActiveBuff, BuffStat, BuffsDelta, BuffsSnap } from '../../shared/types'

/** Land a pending cast this many ms after castBegin if nothing cleared it first. */
const LAND_TIMEOUT_MS = 15_000

/** A cast that has landed (produced a buff) and is awaiting its next fade. */
interface OpenCast {
  spell: string
  key: string
  landedTs: number
  /** 'pet' when the buff is on the pet; undefined for self. */
  target?: string
}

/** A cast in flight (You begin casting …) not yet landed/cleared. */
interface Pending {
  spell: string
  key: string
  beganTs: number
  /**
   * True when, at castBegin time, S already had a CONFIRMED active entry: this cast
   * is a REFRESH whose new startedTs is STAGED (not applied to the visible active
   * entry until confirmation). If it fizzles, the prior confirmed buff is untouched.
   */
  stagedRefresh: boolean
}

/** Per-spell accumulated duration samples + display name. */
interface SpellSamples {
  spell: string
  samples: number[]
}

/** Canonical spell key (case-stable; buff names are consistent but be safe). */
function spellKey(s: string): string {
  return s.trim().toLowerCase()
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  if (sortedAsc.length === 1) return sortedAsc[0]
  const idx = (sortedAsc.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedAsc[lo]
  const frac = idx - lo
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac
}

export class BuffsModule implements EqModule<BuffsSnap, BuffsDelta> {
  readonly id = 'buffs'
  private seq = 0

  /** The single cast currently in flight (You begin …), or null. */
  private pending: Pending | null = null
  /** Landed casts awaiting their fade, keyed by spell key (one open cast per spell). */
  private open = new Map<string, OpenCast>()
  /** Currently-active (landed OR provisional, not faded) buffs, keyed by spell key. */
  private active = new Map<string, ActiveBuff>()
  /** Mined samples per spell key. */
  private samples = new Map<string, SpellSamples>()
  /** Spell keys ever seen fading — the buff discriminator. */
  private everFaded = new Set<string>()
  /** Last fade target per spell key ('pet' | mob name | undefined) — labels active
   * buffs, since castBegin carries no target but buffFade does. */
  private fadeTarget = new Map<string, string | undefined>()

  /** Set whenever state changed since the last flush. */
  private dirty = false

  reset(): void {
    this.seq = 0
    this.pending = null
    this.open = new Map()
    this.active = new Map()
    this.samples = new Map()
    this.everFaded = new Set()
    this.fadeTarget = new Map()
    this.dirty = false
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    // Time-based landing: any event with a timestamp can trip the pending cast's
    // 15s land timeout (the fold is time-ordered).
    this.maybeLandPendingByTime(ev.ts)

    switch (ev.kind) {
      case 'castBegin': {
        // A new cast lands the prior pending (nothing cleared it) before replacing it.
        this.landPending(ev.ts)
        const key = spellKey(ev.spell)
        // Optimistic display: if this spell already has a CONFIRMED active entry, keep
        // it and stage the refresh; otherwise show a fresh provisional entry now.
        const existing = this.active.get(key)
        const stagedRefresh = !!existing && !existing.provisional
        this.pending = { spell: ev.spell, key, beganTs: ev.ts, stagedRefresh }
        if (!existing && this.everFaded.has(key)) {
          this.active.set(
            key,
            this.buildActive(ev.spell, key, ev.ts, this.fadeTarget.get(key), true)
          )
          this.dirty = true
        }
        break
      }
      case 'castFizzle':
      case 'castInterrupted': {
        // Clears the pending cast when it's the same spell (the cast produced no buff)
        // and retracts its optimistic display.
        const key = spellKey(ev.spell)
        if (this.pending && this.pending.key === key) {
          const wasStagedRefresh = this.pending.stagedRefresh
          this.pending = null
          // A fresh provisional entry is removed; a staged refresh leaves the prior
          // CONFIRMED active buff untouched (it survives the fizzle).
          if (!wasStagedRefresh) {
            const a = this.active.get(key)
            if (a?.provisional) {
              this.active.delete(key)
              this.dirty = true
            }
          }
        }
        break
      }
      case 'buffFade': {
        const key = spellKey(ev.spell)
        this.everFaded.add(key)
        this.fadeTarget.set(key, ev.target)
        // A fade of the pending spell implies that cast landed just now-ish; land it
        // so it can pair with this very fade.
        if (this.pending && this.pending.key === key) this.landPending(ev.ts)
        this.recordFade(key, ev.spell, ev.ts)
        break
      }
      case 'playerDeath': {
        this.onPlayerDeath()
        break
      }
      default:
        return
    }
  }

  /**
   * Wall-clock heartbeat (Task #30). Runs the same 15s land-timeout check as onEvent
   * but driven by real time, so a cast confirms while the log is idle. Called ~1×/sec
   * by the registry with Date.now() during the LIVE tail only (never during replay).
   */
  onTick(nowMs: number): void {
    this.maybeLandPendingByTime(nowMs)
  }

  /** Land the pending cast if it's older than the land timeout at `now`. */
  private maybeLandPendingByTime(now: number): void {
    if (this.pending && now - this.pending.beganTs >= LAND_TIMEOUT_MS) {
      this.landPending(now)
    }
  }

  /**
   * Promote the pending cast to a landed/active buff (MINING + CONFIRMATION). The
   * landed timestamp is the cast's OWN begin time (`beganTs`): cast times are seconds
   * while buff durations are minutes, so cast-start is the best available proxy for
   * buff application — and it means a fade that lands the pending cast still yields a
   * real (non-zero) duration. A recast of an already-open spell is a REFRESH: it
   * restarts the active timer and DISCARDS the previous open cast's pairing (no
   * sample — censored). Only spells that have ever faded are surfaced as active buffs.
   *
   * MINING (the `open`/`samples` path) is byte-identical to v1. Confirmation of the
   * DISPLAY happens here too: it clears the provisional flag (and applies a staged
   * refresh's startedTs) on the active entry.
   */
  private landPending(_now: number): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    const landedTs = p.beganTs

    // Refresh censoring: an existing open cast for this spell is discarded (its fade
    // pairing is abandoned because the buff was re-applied before it wore off).
    // Replacing the map entry below does exactly that. (UNCHANGED mining semantics.)
    this.open.set(p.key, { spell: p.spell, key: p.key, landedTs })

    // Surface as a CONFIRMED active buff. castBegin carries no target, so infer it
    // from this spell's last fade. Only spells known to be buffs (ever faded) show.
    if (this.everFaded.has(p.key)) {
      // A staged refresh moves startedTs to this cast; a fresh confirmation uses it
      // too. Either way the resulting entry is confirmed (provisional=false).
      this.active.set(p.key, this.buildActive(p.spell, p.key, landedTs, this.fadeTarget.get(p.key), false))
    }
    this.dirty = true
  }

  /** Pair a fade with its open landed cast (a duration sample) and clear active. */
  private recordFade(key: string, spell: string, fadeTs: number): void {
    const open = this.open.get(key)
    if (open) {
      const dur = fadeTs - open.landedTs
      if (dur > 0) this.addSample(key, spell, dur)
      this.open.delete(key)
    }
    // The fade removes any active entry for this spell.
    this.active.delete(key)
    this.dirty = true
  }

  /** playerDeath strips all buffs: clear active + censor every open cast. */
  private onPlayerDeath(): void {
    if (this.active.size || this.open.size || this.pending) this.dirty = true
    this.active.clear()
    this.open.clear()
    this.pending = null
  }

  private addSample(key: string, spell: string, durMs: number): void {
    let s = this.samples.get(key)
    if (!s) {
      s = { spell, samples: [] }
      this.samples.set(key, s)
    }
    s.samples.push(durMs)
    // If this spell is currently active, its estimate just improved — refresh it
    // (preserving its provisional flag).
    const a = this.active.get(key)
    if (a) this.active.set(key, this.buildActive(a.spell, key, a.startedTs, a.target, a.provisional))
    this.dirty = true
  }

  private statFor(key: string): BuffStat | null {
    const s = this.samples.get(key)
    if (!s || s.samples.length === 0) {
      // Ever-faded but never cleanly paired → an n=0 stat so the UI can still list it.
      return null
    }
    const sorted = [...s.samples].sort((a, b) => a - b)
    return {
      spell: s.spell,
      n: sorted.length,
      medianMs: percentile(sorted, 0.5),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1]
    }
  }

  private buildActive(
    spell: string,
    key: string,
    startedTs: number,
    target?: string,
    provisional?: boolean
  ): ActiveBuff {
    const st = this.statFor(key)
    return {
      spell,
      startedTs,
      estimatedMs: st?.medianMs ?? null,
      p25: st?.p25 ?? null,
      p75: st?.p75 ?? null,
      n: st?.n ?? 0,
      target,
      ...(provisional ? { provisional: true } : {})
    }
  }

  private buildSnap(): BuffsSnap {
    const stats: Record<string, BuffStat> = {}
    for (const key of this.everFaded) {
      const st = this.statFor(key)
      if (st) {
        stats[key] = st
      } else {
        // Seen fading but no clean pair yet — expose an n=0 row (display name from
        // the sample bucket if present, else the fade key title-cased loosely).
        const disp = this.samples.get(key)?.spell
        stats[key] = {
          spell: disp ?? key,
          n: 0,
          medianMs: null,
          p25: null,
          p75: null,
          minMs: null,
          maxMs: null
        }
      }
    }
    return {
      active: [...this.active.values()].sort((a, b) => a.startedTs - b.startedTs),
      stats
    }
  }

  snapshot(): { seq: number; state: BuffsSnap } {
    return { seq: this.seq, state: this.buildSnap() }
  }

  flushDelta(): { seq: number; delta: BuffsDelta } | null {
    if (!this.dirty) return null
    this.dirty = false
    return { seq: this.seq, delta: this.buildSnap() }
  }
}
