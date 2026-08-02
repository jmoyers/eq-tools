// buffs module (Task #19) — a log-mined buff-duration model, all state from events.
//
// The player's own casts drive a small state machine and a duration miner:
//
//   castBegin(S)   → S becomes the PENDING cast (replaces any prior pending).
//   castFizzle(S)  → if S is pending, clear it (the cast produced no buff).
//   castInterrupted(S) → same (cleared).
//   buffFade(S)    → S's active buff expired; pairs with the matching landed cast
//                    to yield a duration sample.
//   playerDeath    → death strips ALL buffs; clears active state AND censors every
//                    open (unpaired) landed cast (no sample — death, not expiry).
//
// LANDING APPROXIMATION (documented): cast times are unknown, so a pending self/pet
// buff is considered LANDED when neither a fizzle nor an interrupt of that spell
// occurs before EITHER the next castBegin OR 15s of log-time elapse (whichever comes
// first). A buffFade of the pending spell also implies it landed. This is the
// "simplest robust rule" from the design; it over-counts only in the rare case of a
// cast that was silently aborted (no fizzle/interrupt line) — acceptable for v1.
//
// DURATION MINING: for each landed cast of S, pair it with the NEXT buffFade of S →
// sample = fade_ts − land_ts. CENSORED (no sample) when a recast of S lands before
// the fade (a refresh — the active timer restarts, the old open cast is discarded)
// or playerDeath occurs before the fade. Zone lines do NOT clear buffs (EQ buffs
// persist through zoning), so zoning is ignored here.
//
// BUFF FILTER (the honest discriminator): only spells that have EVER produced a
// buffFade are treated as buffs. Nukes/mez/charm emit castBegin too but never
// self-fade, so they're excluded from both `stats` and `active`. A self-buff never
// yet observed fading simply appears the first time a fade is seen (acceptable v1).
//
// LIVE state: a landed buff of S → active (estimatedMs = mined median, or null when
// n===0), with startedTs; buffFade(S) removes it; a recast refreshes startedTs;
// playerDeath clears all. The module ships its whole (small) snapshot as each delta.

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
  /** Currently-active (landed, not faded) buffs, keyed by spell key. */
  private active = new Map<string, ActiveBuff>()
  /** Mined samples per spell key. */
  private samples = new Map<string, SpellSamples>()
  /** Spell keys ever seen fading — the buff discriminator. */
  private everFaded = new Set<string>()
  /** Last fade target per spell key ('pet' | undefined) — labels active buffs,
   * since castBegin carries no target but buffFade does. */
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
        this.pending = { spell: ev.spell, key: spellKey(ev.spell), beganTs: ev.ts }
        break
      }
      case 'castFizzle':
      case 'castInterrupted': {
        // Clears the pending cast when it's the same spell (the cast produced no buff).
        if (this.pending && this.pending.key === spellKey(ev.spell)) this.pending = null
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

  /** Land the pending cast if it's older than the land timeout at `now`. */
  private maybeLandPendingByTime(now: number): void {
    if (this.pending && now - this.pending.beganTs >= LAND_TIMEOUT_MS) {
      this.landPending(now)
    }
  }

  /**
   * Promote the pending cast to a landed/active buff. The landed timestamp is the
   * cast's OWN begin time (`beganTs`): cast times are seconds while buff durations
   * are minutes, so cast-start is the best available proxy for buff application —
   * and it means a fade that lands the pending cast still yields a real (non-zero)
   * duration. A recast of an already-open spell is a REFRESH: it restarts the active
   * timer and DISCARDS the previous open cast's pairing (no sample — censored). Only
   * spells that have ever faded are surfaced as active buffs; others still open a
   * cast so a first-ever fade can pair.
   */
  private landPending(_now: number): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    const landedTs = p.beganTs

    // Refresh censoring: an existing open cast for this spell is discarded (its fade
    // pairing is abandoned because the buff was re-applied before it wore off).
    // Replacing the map entry below does exactly that.
    this.open.set(p.key, { spell: p.spell, key: p.key, landedTs })

    // Surface as an active buff (self by default; buffFade carries the pet flag, but
    // castBegin doesn't — the target is inferred from this spell's last fade).
    // Record active only for spells known to be buffs (ever faded); a never-yet-faded
    // spell won't show as active until its first fade classifies it.
    if (this.everFaded.has(p.key)) {
      this.active.set(p.key, this.buildActive(p.spell, p.key, landedTs, this.fadeTarget.get(p.key)))
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
    // If this spell is currently active, its estimate just improved — refresh it.
    const a = this.active.get(key)
    if (a) this.active.set(key, this.buildActive(a.spell, key, a.startedTs, a.target))
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

  private buildActive(spell: string, key: string, startedTs: number, target?: string): ActiveBuff {
    const st = this.statFor(key)
    return {
      spell,
      startedTs,
      estimatedMs: st?.medianMs ?? null,
      p25: st?.p25 ?? null,
      p75: st?.p75 ?? null,
      n: st?.n ?? 0,
      target
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
