// buffs module (Task #19; latency+coverage Task #30; ENTITY-AWARE simulation Task #32)
// — a log-mined buff/debuff-duration model AND a small who/what/when simulation of
// which ENTITY each buff is bound to. All state is derived from events.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED IN TASK #32 (the entity model). Buffs now BIND to WHO they're on:
//   self | summoned pet | charmed pet | hostile mob (debuff target).
// The module tracks a tiny entity state fed by charm/uncharm/petClaim/death/zone —
// conceptually parallel to the combat WorldModel, and SHARING its pure lifecycle
// rules via combat/entityRules.ts (isLeftBehindOnZone / deathCensors /
// classifyFadeTarget). It does NOT touch the engine's live world instance — modules
// are independent event consumers.
//
// The point of the entity model is CENSORING unobservable fades so they never pollute
// duration stats:
//   - ZONE: the player keeps self buffs; a SUMMONED pet follows and keeps its buffs; a
//     CHARMED pet is LEFT BEHIND (charm can't survive a zone) and hostile mobs are left
//     behind too → their open casts can NEVER be observed fading, so they are CENSORED
//     (no sample) and removed from the active display. (This kills the old 23.8h "Swift
//     Like the Wind" outlier class — a pet buff whose fade landed only after re-charm/
//     zone, producing a bogus multi-hour duration.)
//   - DEATH: an entity's death strips + censors its buffs/debuffs (deathCensors()).
//     playerDeath clears self (existing behavior).
//
// DEBUFFS are a distinct class (e.g. Languid Pace, an enchanter slow on enemies):
//   - classified per spell by observed fade-target disposition — a spell that has EVER
//     faded on a HOSTILE entity is a debuff.
//   - a debuff NEVER appears as a self buff (guaranteed: a debuff's provisional/active
//     entry is bound to the inferred hostile target, class 'debuff', never 'self').
//   - active-debuff target is INFERRED (castBegin carries no target): bound to the
//     current charmed/summoned pet's fight target if cheaply known, else surfaced with
//     `inferredTarget:true` so the UI can show a "target: inferred" chip — never a
//     silent guess.
//
// ─────────────────────────────────────────────────────────────────────────────
// MINING MODEL (byte-identical to Task #30 for the SELF/PET path — regression-gated):
//   castBegin(S)   → S becomes the PENDING cast (replaces prior pending) AND is shown
//                    OPTIMISTICALLY right away (provisional) if S is a known buff/debuff.
//   castFizzle(S) / castInterrupted(S) → clears pending S + retracts its provisional.
//   buffFade(S,target?) → S's active entry expired on `target`; pairs with the matching
//                    landed cast → duration sample; records the target disposition
//                    (self/pet/hostile) that CLASSIFIES the spell.
//   playerDeath    → strips ALL self buffs; censors open SELF casts.
//
// LANDING (mining) APPROXIMATION (unchanged): a pending cast LANDS when neither a fizzle
// nor interrupt of S occurs before EITHER the next castBegin OR 15s of log-time elapse.
// A buffFade of the pending spell also implies it landed. Landed ts = cast-BEGIN ts.
//
// CENSORING (the Task #32 addition to mining): an open cast is discarded with NO sample
// when its BOUND ENTITY is retired before the fade — zone-left-behind (charmed pet or
// hostile), or entity death — in addition to the existing recast-refresh and playerDeath
// censors. Self buffs and summoned-pet buffs survive zoning (not censored).

import type { EqModule } from './types'
import type { LogEvent } from '../../shared/logEvents'
import type { ActiveBuff, BuffClass, BuffStat, BuffsDelta, BuffsSnap } from '../../shared/types'
import { idKey } from '../log/parser'
import {
  charmedPetDiesOnDeathLine,
  classifyFadeTarget,
  isLeftBehindOnZone,
  type EntityDisposition,
  type PetKind
} from '../combat/entityRules'

/** Land a pending cast this many ms after castBegin if nothing cleared it first. */
const LAND_TIMEOUT_MS = 15_000

/**
 * Sanity ceiling on a mined duration sample. No EQ Legends buff lasts anywhere near
 * this long (the longest observed real buffs — Focus/Intensify Death — are ~1h). A
 * land→fade gap beyond this is DEFINITIONALLY a missed censor: the real fade was never
 * observed (the entity zoned/died/was re-charmed unobserved) and the open cast paired
 * with a much-later, unrelated fade of the same spell. Such a "sample" is DROPPED
 * (censored), not recorded — this is the final backstop for the unobservable-fade
 * outlier class (the 9-day Reckless Strength, 219h Spirit Armor pairings) that the
 * entity model's zone/death censors don't catch (e.g. an orphaned open cast across a
 * multi-day logoff with no intervening zone line in the scanned window).
 */
const MAX_SAMPLE_MS = 3 * 60 * 60_000 // 3 hours

/** Map a fade-target disposition to the buff CLASS surfaced to the UI. */
function classForDisposition(d: EntityDisposition): BuffClass {
  return d === 'hostile' ? 'debuff' : d === 'self' ? 'self' : 'pet'
}

/** A cast that has landed (produced a buff) and is awaiting its next fade. */
interface OpenCast {
  spell: string
  key: string
  landedTs: number
  /** The entity disposition this cast is bound to (for censoring on zone/death). */
  disp: EntityDisposition
  /** Canonical name key of the bound entity ('pet' sentinel / mob key / undefined self). */
  boundKey?: string
}

/** A cast in flight (You begin casting …) not yet landed/cleared. */
interface Pending {
  spell: string
  key: string
  beganTs: number
  /** Refresh whose new startedTs is staged until confirmation (see landPending). */
  stagedRefresh: boolean
}

/** Per-spell accumulated duration samples + display name + observed classes. */
interface SpellSamples {
  spell: string
  samples: number[]
}

/** Canonical spell key (case-stable). */
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
  /**
   * Per-spell fade-disposition tally (self/summoned/charmed/hostile). The spell's
   * CLASS is a PLURALITY VOTE over these, not a sticky "ever hostile" flag: a real pet
   * buff (e.g. Swift Like the Wind) occasionally fades during a charm gap and would be
   * mislabeled a debuff by a sticky rule; a real debuff (Languid Pace) is hostile in
   * the majority. Rule 5(a) — a debuff never appears as self — holds because 'self'
   * only wins when self is the plurality (see classOf). */
  private dispTally = new Map<string, { self: number; summoned: number; charmed: number; hostile: number }>()
  /** Last fade target label per spell key ('pet' | mob name | undefined) — for display. */
  private fadeTarget = new Map<string, string | undefined>()
  /** Last fade disposition per spell key — for open-cast entity binding at land time. */
  private fadeDisp = new Map<string, EntityDisposition>()

  // ── entity state (the who/what) — a tiny parallel to the combat WorldModel ──
  /** Canonical name key of the live charmed pet, or undefined. */
  private charmedKey?: string
  private charmedDisplay?: string
  /** Canonical name key of the live summoned pet, or undefined. */
  private summonedKey?: string
  private summonedDisplay?: string
  /** The pet's CURRENT hostile fight target (canonical key + display), if cheaply
   *  known from recent charm/cc/death context — used to bind debuff casts. */
  private petTargetKey?: string
  private petTargetDisplay?: string

  /** Set whenever state changed since the last flush. */
  private dirty = false

  reset(): void {
    this.seq = 0
    this.pending = null
    this.open = new Map()
    this.active = new Map()
    this.samples = new Map()
    this.everFaded = new Set()
    this.dispTally = new Map()
    this.fadeTarget = new Map()
    this.fadeDisp = new Map()
    this.charmedKey = undefined
    this.charmedDisplay = undefined
    this.summonedKey = undefined
    this.summonedDisplay = undefined
    this.petTargetKey = undefined
    this.petTargetDisplay = undefined
    this.dirty = false
  }

  /** Current pet identities, for the shared classifyFadeTarget helper. */
  private petState(): { charmedKey?: string; summonedKey?: string } {
    return { charmedKey: this.charmedKey, summonedKey: this.summonedKey }
  }

  /** Pet kind for the 'pet' possessive-form fade (summoned preferred, else charmed). */
  private petKindForPossessive(): PetKind | undefined {
    if (this.summonedKey) return 'summoned'
    if (this.charmedKey) return 'charmed'
    return undefined
  }

  onEvent(ev: LogEvent): void {
    this.seq = ev.seq
    // Time-based landing: any event with a timestamp can trip the pending cast's
    // 15s land timeout (the fold is time-ordered).
    this.maybeLandPendingByTime(ev.ts)

    switch (ev.kind) {
      case 'castBegin': {
        this.landPending(ev.ts)
        const key = spellKey(ev.spell)
        const existing = this.active.get(key)
        const stagedRefresh = !!existing && !existing.provisional
        this.pending = { spell: ev.spell, key, beganTs: ev.ts, stagedRefresh }
        if (!existing && this.everFaded.has(key)) {
          this.active.set(key, this.buildActive(ev.spell, key, ev.ts, true))
          this.dirty = true
        }
        break
      }
      case 'castFizzle':
      case 'castInterrupted': {
        const key = spellKey(ev.spell)
        if (this.pending && this.pending.key === key) {
          const wasStagedRefresh = this.pending.stagedRefresh
          this.pending = null
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
        // Classify the fade by target disposition (self/summoned/charmed/hostile).
        const targetKey = ev.target ? (ev.target === 'pet' ? 'pet' : idKey(ev.target)) : undefined
        const disp = classifyFadeTarget(targetKey, this.petState())
        this.fadeDisp.set(key, disp)
        this.fadeTarget.set(key, ev.target)
        let tally = this.dispTally.get(key)
        if (!tally) {
          tally = { self: 0, summoned: 0, charmed: 0, hostile: 0 }
          this.dispTally.set(key, tally)
        }
        tally[disp]++
        // A fade of the pending spell implies that cast landed just now-ish.
        if (this.pending && this.pending.key === key) this.landPending(ev.ts)
        this.recordFade(key, ev.spell, ev.ts)
        break
      }
      case 'playerDeath': {
        this.onPlayerDeath()
        break
      }
      // ── entity lifecycle (the who/what state) ──
      case 'charm': {
        this.charmedKey = idKey(ev.mob)
        this.charmedDisplay = ev.mob
        // A fresh charm resets the inferred pet target (new fight).
        this.petTargetKey = undefined
        this.petTargetDisplay = undefined
        break
      }
      case 'petClaim': {
        // A petClaim can be either pet kind; if it names the charmed mob it's the
        // charmed pet (already tracked), otherwise it's a summoned (proper-named) pet.
        const key = idKey(ev.name)
        if (key !== this.charmedKey) {
          this.summonedKey = key
          this.summonedDisplay = ev.name
        }
        break
      }
      case 'uncharm': {
        if (this.charmedKey === idKey(ev.mob)) this.retireEntity('charmed', ev.ts)
        break
      }
      case 'cc': {
        // The pet's current fight target (mez/root landed on it) — used to bind debuffs.
        this.petTargetKey = idKey(ev.mob)
        this.petTargetDisplay = ev.mob
        break
      }
      case 'death': {
        const key = idKey(ev.name)
        // A death line naming YOUR pet is twin-ambiguous (a same-named hostile the pet
        // was fighting vs the pet itself). The SHARED pure rule (world.ts semantics)
        // keeps the pet alive on such a line — the pet is retired only by uncharm/zone,
        // never censored by a name-only slain line. So a pet-name death does NOT retire
        // the pet; it only clears an inferred hostile target of the same name.
        const petMatch = key === this.charmedKey || key === this.summonedKey
        if (petMatch) {
          const killerIsYou = ev.bySelf || idKey(ev.killer ?? '') === 'you'
          const killerSameName = !ev.bySelf && ev.killer != null && idKey(ev.killer) === key
          if (charmedPetDiesOnDeathLine({ killerIsYou, killerSameName })) {
            this.retireEntity(key === this.charmedKey ? 'charmed' : 'summoned', ev.ts)
          }
          // else: keep the pet (conservative). Still fall through to hostile-target
          // clearing below in case a same-named hostile twin was the pet's target.
        } else {
          // A plain hostile death censors any open debuff bound to it.
          this.censorHostileEntity(key)
        }
        if (key === this.petTargetKey) {
          this.petTargetKey = undefined
          this.petTargetDisplay = undefined
        }
        break
      }
      case 'zone': {
        this.onZone(ev.ts)
        break
      }
      default:
        return
    }
  }

  /** Wall-clock heartbeat (Task #30): drive the 15s land timeout in real time. */
  onTick(nowMs: number): void {
    this.maybeLandPendingByTime(nowMs)
  }

  private maybeLandPendingByTime(now: number): void {
    if (this.pending && now - this.pending.beganTs >= LAND_TIMEOUT_MS) {
      this.landPending(now)
    }
  }

  /**
   * Promote the pending cast to a landed/active buff (MINING + CONFIRMATION). Binds
   * the open cast to a TARGET ENTITY (from the spell's last fade disposition) so a
   * later zone/death can censor it. Mining semantics for self/pet are byte-identical
   * to Task #30 (the `open`/`samples` path), plus per-entity censoring.
   */
  private landPending(_now: number): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    const landedTs = p.beganTs

    // Bind the open cast to a TARGET ENTITY so zone/death can censor it. castBegin
    // carries no target, so infer the CURRENT target from the entity state + the
    // spell's learned class (Task #32):
    //   - a known DEBUFF (majority-hostile) → the inferred hostile fight target.
    //   - otherwise, prefer the live pet the player is buffing (charmed, else summoned);
    //     a charmed-pet buff MUST bind 'charmed' so a later zone/uncharm CENSORS it
    //     (this is what kills the 13h Clarity / 23.8h Swift outliers — an open cast on
    //     a left-behind pet can never be observed fading).
    //   - no live pet → self.
    const disp = this.inferCastDisposition(p.key)
    const boundKey = this.boundKeyFor(disp)
    // Refresh censoring: replacing the map entry discards a prior open cast's pairing.
    this.open.set(p.key, { spell: p.spell, key: p.key, landedTs, disp, boundKey })

    // Surface as a CONFIRMED active buff (only spells known to be buffs/debuffs show).
    if (this.everFaded.has(p.key)) {
      this.active.set(p.key, this.buildActive(p.spell, p.key, landedTs, false))
    }
    this.dirty = true
  }

  /**
   * Infer the target disposition of a cast at LAND time from the current entity state
   * and the spell's learned class. This is what makes zone/death censoring correct: an
   * open cast on the live charmed pet is bound 'charmed', so the pet being left behind
   * on a zone censors it (no bogus multi-hour sample).
   */
  private inferCastDisposition(key: string): EntityDisposition {
    if (this.classOf(key) === 'debuff') return 'hostile'
    if (this.charmedKey) return 'charmed'
    if (this.summonedKey) return 'summoned'
    return 'self'
  }

  /** The canonical name key an open cast of this disposition binds to (for censoring). */
  private boundKeyFor(disp: EntityDisposition): string | undefined {
    if (disp === 'self') return undefined
    if (disp === 'summoned') return this.summonedKey
    if (disp === 'charmed') return this.charmedKey
    // hostile debuff: the inferred fight target, if known.
    return this.petTargetKey
  }

  /** Pair a fade with its open landed cast (a duration sample) and clear active. */
  private recordFade(key: string, spell: string, fadeTs: number): void {
    const open = this.open.get(key)
    if (open) {
      const dur = fadeTs - open.landedTs
      // Record only plausible durations; a gap beyond MAX_SAMPLE_MS is a missed
      // censor (unobservable fade), so it's dropped rather than polluting stats.
      if (dur > 0 && dur <= MAX_SAMPLE_MS) this.addSample(key, spell, dur)
      this.open.delete(key)
    }
    this.active.delete(key)
    this.dirty = true
  }

  /** playerDeath strips SELF buffs: censor open SELF casts + clear their actives. */
  private onPlayerDeath(): void {
    let changed = false
    for (const [k, o] of [...this.open]) {
      if (o.disp === 'self') {
        this.open.delete(k)
        changed = true
      }
    }
    for (const [k, a] of [...this.active]) {
      if (a.cls === 'self') {
        this.active.delete(k)
        changed = true
      }
    }
    // A pending self cast is also abandoned (death interrupts it).
    if (this.pending && (this.fadeDisp.get(this.pending.key) ?? 'self') === 'self') {
      this.pending = null
      changed = true
    }
    if (changed) this.dirty = true
  }

  /**
   * Retire one of YOUR pets: on uncharm/death/zone-left-behind. Censors every open
   * cast bound to that pet (the fade can no longer be observed) and clears its actives.
   */
  private retireEntity(kind: 'charmed' | 'summoned', _ts: number): void {
    const retiredKey = kind === 'charmed' ? this.charmedKey : this.summonedKey
    const cls: BuffClass = 'pet'
    let changed = false
    for (const [k, o] of [...this.open]) {
      const matches =
        o.disp === kind || (o.boundKey != null && o.boundKey === retiredKey) ||
        (o.boundKey === 'pet' && this.dispMatchesPetForm(o.disp, kind))
      if (matches) {
        this.open.delete(k)
        changed = true
      }
    }
    for (const [k, a] of [...this.active]) {
      if (a.cls === cls && this.activeBelongsToPet(a, kind, retiredKey)) {
        this.active.delete(k)
        changed = true
      }
    }
    if (kind === 'charmed') {
      this.charmedKey = undefined
      this.charmedDisplay = undefined
    } else {
      this.summonedKey = undefined
      this.summonedDisplay = undefined
    }
    if (changed) this.dirty = true
  }

  private dispMatchesPetForm(disp: EntityDisposition, kind: 'charmed' | 'summoned'): boolean {
    return disp === kind
  }

  private activeBelongsToPet(a: ActiveBuff, kind: 'charmed' | 'summoned', retiredKey?: string): boolean {
    // Bind by disposition first; fall back to matching the display name to the pet.
    if (a.disposition === kind) return true
    if (a.target && retiredKey && idKey(a.target) === retiredKey) return true
    // 'pet' possessive form buffs belong to whichever pet kind owned the possessive.
    if (a.target === 'pet') return this.petKindForPossessive() === kind
    return false
  }

  /** Censor open DEBUFF casts bound to a hostile entity that just died / was left behind. */
  private censorHostileEntity(hostileKey: string): void {
    let changed = false
    for (const [k, o] of [...this.open]) {
      if (o.disp === 'hostile' && (o.boundKey == null || o.boundKey === hostileKey)) {
        this.open.delete(k)
        changed = true
      }
    }
    for (const [k, a] of [...this.active]) {
      if (a.cls === 'debuff' && (a.target == null || idKey(a.target) === hostileKey || a.inferredTarget)) {
        this.active.delete(k)
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /**
   * ZONE (the user's rule): the player keeps self buffs; the SUMMONED pet follows and
   * keeps its buffs; the CHARMED pet is LEFT BEHIND (retire + censor); hostile mobs are
   * left behind (censor open debuffs). Uses the SHARED isLeftBehindOnZone rule.
   */
  private onZone(ts: number): void {
    let changed = false
    // Censor every open cast whose bound entity is left behind by the zone.
    for (const [k, o] of [...this.open]) {
      let leftBehind: boolean
      if (o.disp === 'self') leftBehind = false
      else if (o.disp === 'summoned') leftBehind = isLeftBehindOnZone('summoned') // false
      else if (o.disp === 'charmed') leftBehind = isLeftBehindOnZone('charmed') // true
      else leftBehind = true // hostile → left behind
      if (leftBehind) {
        this.open.delete(k)
        changed = true
      }
    }
    // Remove active buffs on left-behind entities from display.
    for (const [k, a] of [...this.active]) {
      const leftBehind =
        a.cls === 'debuff' ||
        a.disposition === 'charmed' ||
        (a.cls === 'pet' && a.disposition !== 'summoned' && this.petKindForPossessive() === 'charmed')
      if (leftBehind) {
        this.active.delete(k)
        changed = true
      }
    }
    // The charmed pet + inferred hostile target are gone; the summoned pet follows.
    if (this.charmedKey) {
      this.charmedKey = undefined
      this.charmedDisplay = undefined
      changed = true
    }
    this.petTargetKey = undefined
    this.petTargetDisplay = undefined
    // A pending cast targeting a left-behind entity is abandoned.
    if (this.pending) {
      const d = this.fadeDisp.get(this.pending.key) ?? 'self'
      if (d === 'charmed' || d === 'hostile') {
        this.pending = null
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  private addSample(key: string, spell: string, durMs: number): void {
    let s = this.samples.get(key)
    if (!s) {
      s = { spell, samples: [] }
      this.samples.set(key, s)
    }
    s.samples.push(durMs)
    const a = this.active.get(key)
    if (a) this.active.set(key, this.buildActive(a.spell, key, a.startedTs, a.provisional))
    this.dirty = true
  }

  private statFor(key: string): BuffStat | null {
    const s = this.samples.get(key)
    if (!s || s.samples.length === 0) return null
    const sorted = [...s.samples].sort((a, b) => a - b)
    return {
      spell: s.spell,
      cls: this.classOf(key),
      n: sorted.length,
      medianMs: percentile(sorted, 0.5),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1]
    }
  }

  /**
   * The display class of a spell key by PLURALITY VOTE over its fade dispositions:
   *   - self is the plurality           → 'self'
   *   - friendly (self+pet) ≥ hostile   → 'pet' (or 'self' if self dominates friendly)
   *   - hostile strictly dominates      → 'debuff'
   * This makes a real pet buff that occasionally fades during a charm gap a BUFF, and a
   * real debuff (majority hostile) a DEBUFF. Rule 5(a) holds: 'self' requires a self
   * plurality, which a debuff (majority hostile, ~zero self) can never have.
   */
  private classOf(key: string): BuffClass {
    const t = this.dispTally.get(key)
    if (!t) {
      const disp = this.fadeDisp.get(key)
      return disp ? classForDisposition(disp) : 'self'
    }
    const friendly = t.self + t.summoned + t.charmed
    if (t.hostile > friendly) return 'debuff'
    if (t.self >= t.summoned + t.charmed && t.self > 0) return 'self'
    return 'pet'
  }

  private buildActive(
    spell: string,
    key: string,
    startedTs: number,
    provisional?: boolean
  ): ActiveBuff {
    const st = this.statFor(key)
    const cls = this.classOf(key)
    const disp = this.fadeDisp.get(key)
    // Target label + inference. Self: none. Pet: the pet's name/'pet' form. Debuff:
    // the inferred hostile fight target (or flagged inferred when unknown).
    let target: string | undefined
    let inferredTarget = false
    if (cls === 'debuff') {
      if (this.petTargetDisplay) {
        target = this.petTargetDisplay
        inferredTarget = true // castBegin has no target — this is an inference, not fact
      } else {
        target = undefined
        inferredTarget = true
      }
    } else if (cls === 'pet') {
      // Prefer the concrete pet name for the bound kind; else the last fade label.
      if (disp === 'summoned' && this.summonedDisplay) target = this.summonedDisplay
      else if (disp === 'charmed' && this.charmedDisplay) target = this.charmedDisplay
      else target = this.fadeTarget.get(key)
    } else {
      target = undefined // self
    }
    return {
      spell,
      cls,
      disposition: disp,
      startedTs,
      estimatedMs: st?.medianMs ?? null,
      p25: st?.p25 ?? null,
      p75: st?.p75 ?? null,
      n: st?.n ?? 0,
      target,
      ...(inferredTarget ? { inferredTarget: true } : {}),
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
        const disp = this.samples.get(key)?.spell
        stats[key] = {
          spell: disp ?? key,
          cls: this.classOf(key),
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
