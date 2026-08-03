// Per-SPELL learned knowledge for the buffs model (see buffs.ts): the mined duration
// samples, the fade-disposition tally that classifies a spell absent from the DB, the
// recency map, and the authoritative spell DB itself.
//
// This is GAME knowledge, not character state — a spell's duration and its cast messages
// are identical across a character rebirth — which is why the module's rebirth/session-gap
// clears deliberately leave everything here intact (see BuffsModule.onEvent).

import type { SpellDb } from '../data/spellDb'
import type { BuffClass, BuffStat } from '../../shared/types'
import type { EntityDisposition } from '../combat/entityRules'
import { percentile, RECENT_SAMPLE_WINDOW, type SpellSamples } from './buffsShapes'

/** Per-spell tally of the entity dispositions its fades landed on. */
interface DispTally {
  self: number
  summoned: number
  charmed: number
  hostile: number
}

export class SpellStats {
  /** The scraped spell database (Task #34), optional — the authoritative prior. */
  readonly db?: SpellDb
  /** Mined samples per SPELL key (per-spell, not per-instance — a v1 simplification). */
  samples = new Map<string, SpellSamples>()
  /** Spell keys ever seen fading / applied — the buff discriminator. */
  everFaded = new Set<string>()
  /**
   * Per-spell fade-disposition tally — the FALLBACK classifier for spells ABSENT from the
   * DB (Task #35): a spell that mostly fades on hostile entities is a debuff. DB spellType
   * wins when present.
   */
  dispTally = new Map<string, DispTally>()
  /**
   * Per-spell LAST-SEEN event ts (Task #45): the newest castBegin / apply / fade involving
   * the spell — the cheapest consistent recency signal. Feeds the suggested-alerts wizard's
   * recency sort (recent spells sort to the top over merely-frequent ones). Keyed by
   * canonical spell key; survives session gaps like the other learned maps.
   */
  lastSeen = new Map<string, number>()

  constructor(db?: SpellDb) {
    this.db = db
  }

  reset(): void {
    this.samples = new Map()
    this.everFaded = new Set()
    this.dispTally = new Map()
    this.lastSeen = new Map()
  }

  /** Record the newest ts a spell was seen (cast/apply/fade) — the recency signal (Task #45). */
  touchLastSeen(key: string, ts: number): void {
    const prev = this.lastSeen.get(key)
    if (prev == null || ts > prev) this.lastSeen.set(key, ts)
  }

  /** Authoritative DB duration (ms) for a spell key, or null when unknown. */
  dbDurationFor(key: string): number | null {
    const s = this.db?.byKey.get(key)
    return s?.durationMs ?? null
  }

  /** True when a spell KEY is illusion-flagged in the DB (Task #36). */
  isIllusion(key: string): boolean {
    return this.db?.byKey.get(key)?.illusion ?? false
  }

  /** Tally one observed fade disposition for a spell (the no-DB class fallback's input). */
  tallyFade(key: string, disp: EntityDisposition): void {
    let tally = this.dispTally.get(key)
    if (!tally) {
      tally = { self: 0, summoned: 0, charmed: 0, hostile: 0 }
      this.dispTally.set(key, tally)
    }
    tally[disp]++
  }

  /** Append a mined duration sample (the caller re-stats the live instances). */
  pushSample(key: string, spell: string, durMs: number): void {
    let s = this.samples.get(key)
    if (!s) {
      s = { spell, samples: [] }
      this.samples.set(key, s)
    }
    s.samples.push(durMs)
  }

  statFor(key: string): BuffStat | null {
    const s = this.samples.get(key)
    if (!s || s.samples.length === 0) return null
    const sorted = [...s.samples].sort((a, b) => a - b)
    const est = this.estimateFor(key)
    return {
      spell: s.spell,
      cls: this.classOf(key),
      n: sorted.length,
      medianMs: percentile(sorted, 0.5),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
      dbDurationMs: this.dbDurationFor(key),
      estimateMs: est.ms,
      estimatorSource: est.source,
      lastSeenMs: this.lastSeen.get(key) ?? null
    }
  }

  estimateFor(key: string): { ms: number | null; source: 'db' | 'observed' | undefined } {
    const dbMs = this.dbDurationFor(key)
    if (dbMs != null) return { ms: dbMs, source: 'db' }
    const s = this.samples.get(key)
    if (!s || s.samples.length === 0) return { ms: null, source: undefined }
    const recent = s.samples.slice(-RECENT_SAMPLE_WINDOW)
    return { ms: Math.max(...recent), source: 'observed' }
  }

  /**
   * The buff/debuff class of a spell (Task #35). SPELL PROPERTY:
   *   (1) DB spellType — Detrimental → 'debuff', Beneficial → 'buff' — authoritative.
   *   (2) FALLBACK for a spell absent from the DB: plurality of fade dispositions — hostile
   *       majority → 'debuff', else 'buff'.
   * There is NO 'pet' class; who the buff is on is an entity binding, not a class.
   */
  classOf(key: string): BuffClass {
    const st = this.db?.byKey.get(key)?.spellType
    if (st === 'Detrimental') return 'debuff'
    if (st === 'Beneficial') return 'buff'
    const t = this.dispTally.get(key)
    if (!t) return 'buff'
    const friendly = t.self + t.summoned + t.charmed
    return t.hostile > friendly ? 'debuff' : 'buff'
  }

  /** The snapshot's per-spell stats record: every spell ever faded, with or without samples. */
  buildStats(): Record<string, BuffStat> {
    const stats: Record<string, BuffStat> = {}
    for (const key of this.everFaded) {
      const st = this.statFor(key)
      if (st) {
        stats[key] = st
      } else {
        const disp = this.samples.get(key)?.spell
        const dbMs = this.dbDurationFor(key)
        const dbSpell = this.db?.byKey.get(key)?.name
        stats[key] = {
          spell: disp ?? dbSpell ?? key,
          cls: this.classOf(key),
          n: 0,
          medianMs: null,
          p25: null,
          p75: null,
          minMs: null,
          maxMs: null,
          dbDurationMs: dbMs,
          estimateMs: dbMs,
          estimatorSource: dbMs != null ? 'db' : undefined,
          lastSeenMs: this.lastSeen.get(key) ?? null
        }
      }
    }
    return stats
  }
}
