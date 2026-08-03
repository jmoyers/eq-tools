// The buff-INSTANCE store of the buffs model (see buffs.ts for the model's contract).
//
// A buff INSTANCE is a pair (spell, targetEntity) keyed by (spellKey, entityKey). This
// module owns the three live collections — the single pending cast, the landed-and-open
// casts awaiting their fade, and the currently-active instances — plus every mutation of
// them: landing, message-driven application, fade pairing (the duration sample), and the
// CENSORING paths (death / zone / session gap / hygiene / entity retirement).
//
// It knows nothing about log events: BuffsModule translates events into these calls. It
// reads learned per-spell knowledge from SpellStats and the pet bindings from PetEntities,
// and reports a RESOLVED expiry back through the `onExpired` callback it is constructed
// with (Task #47's derived buffExpired) — the module stamps and emits that.

import type { ActiveBuff } from '../../shared/types'
import { isLeftBehindOnZone, type EntityDisposition } from '../combat/entityRules'
import { idKey } from '../log/parser'
import {
  hygieneCapMs,
  instanceEntityKey,
  instanceKey,
  LAND_TIMEOUT_MS,
  MAX_SAMPLE_MS,
  SELF_KEY,
  spellKey,
  type OpenCast,
  type Pending
} from './buffsShapes'
import type { PetEntities } from './buffsEntities'
import type { SpellStats } from './buffsStats'
import { buildActive, type ActiveSpec } from './buffsView'

/** Does this open cast belong to the entity being retired? (`hostileOnly` = a plain mob death.) */
function openMatches(o: OpenCast, entityKey: string, hostileOnly: boolean): boolean {
  if (!hostileOnly) return o.entityKey === entityKey
  return o.disp === 'hostile' && (o.entityKey === entityKey || o.entityKey === 'unknown-hostile')
}

/** Does this active instance belong to the entity being retired? */
function activeMatches(a: ActiveBuff, aKey: string, entityKey: string, hostileOnly: boolean): boolean {
  if (!hostileOnly) return aKey === entityKey
  return a.cls === 'debuff' && (aKey === entityKey || aKey === 'unknown-hostile' || a.inferredTarget === true)
}

/**
 * ZONE (the user's rule): the player keeps self buffs; a SUMMONED pet follows and keeps
 * its buffs; a CHARMED pet is LEFT BEHIND (retire + censor); hostile mobs are left behind
 * (censor open debuffs). Uses the SHARED isLeftBehindOnZone rule.
 */
function openLeftBehindOnZone(o: OpenCast): boolean {
  if (o.disp === 'self') return false
  if (o.disp === 'summoned') return isLeftBehindOnZone('summoned') // false
  if (o.disp === 'charmed') return isLeftBehindOnZone('charmed') // true
  return true // hostile → left behind
}

export class BuffInstances {
  /** The single cast currently in flight (You begin …), or null. */
  pending: Pending | null = null
  /** Landed casts awaiting their fade, keyed by INSTANCE key (spell, entity) — Task #35. */
  open = new Map<string, OpenCast>()
  /** Currently-active buff instances, keyed by INSTANCE key (spell, entity) — Task #35. */
  active = new Map<string, ActiveBuff>()
  /** Set whenever state changed since the last flush. */
  dirty = false

  constructor(
    private readonly stats: SpellStats,
    private readonly pets: PetEntities,
    /** Report a RESOLVED expiry (spell + target display) so the module can emit it. */
    private readonly onExpired: (spell: string, target: string) => void
  ) {}

  reset(): void {
    this.pending = null
    this.open = new Map()
    this.active = new Map()
    this.dirty = false
  }

  /** True when any active instance is of this spell key (the ambiguous-apply tiebreak). */
  hasActiveSpell(key: string): boolean {
    for (const a of this.active.values()) if (spellKey(a.spell) === key) return true
    return false
  }

  /**
   * ILLUSION EXCLUSIVITY (Task #36, the user's rule): only ONE illusion can be active on a
   * given entity at a time (Permanent Illusion AA or not). Removes every illusion-flagged
   * active + open instance bound to `entityKey` EXCEPT the one being applied now (`keepKey`).
   * A new illusion apply on an entity replaces any prior illusion on that entity — applies
   * to self AND pet (a pet illusion like Boon-on-pet replaces a prior pet illusion).
   */
  clearIllusionsOn(entityKey: string, keepKey: string): void {
    for (const [ik, a] of [...this.active]) {
      if (ik === keepKey) continue
      if (instanceEntityKey(ik) !== entityKey) continue
      if (this.stats.isIllusion(spellKey(a.spell))) {
        this.active.delete(ik)
        this.open.delete(ik)
        this.dirty = true
      }
    }
  }

  /** Remove the (single) illusion-flagged SELF active — the `Your illusion fades.` handler. */
  clearSelfIllusion(): void {
    for (const [ik, a] of [...this.active]) {
      if (!a.self) continue
      if (this.stats.isIllusion(spellKey(a.spell))) {
        this.active.delete(ik)
        this.open.delete(ik)
        this.dirty = true
        // DERIVED buffExpired (Task #47): the raw `Your illusion fades.` line names no spell,
        // but we've RESOLVED it to the one active self illusion — emit that resolved spell so
        // an alert `where:{spell:'Illusion: Wood Elf'}` can fire on the player-side click-off.
        this.onExpired(a.spell, 'self')
      }
    }
  }

  maybeLandPendingByTime(now: number): void {
    if (this.pending && now - this.pending.beganTs >= LAND_TIMEOUT_MS) {
      this.landPending(now)
    }
  }

  /**
   * Promote the pending cast to a landed/active INSTANCE (Task #35). Binds it to a TARGET
   * ENTITY so a later zone/death censors it. Self/pet mining is byte-identical to Task #30.
   */
  landPending(_now: number): void {
    const p = this.pending
    if (!p) return
    this.pending = null
    const landedTs = p.beganTs

    const disp = this.inferCastDisposition(p.key, p.emoteSubjectKey)
    const eKey = this.pets.entityKeyFor(disp)
    const iKey = instanceKey(p.key, eKey)
    // Refresh censoring: replacing the same instance discards a prior open cast's pairing.
    this.open.set(iKey, { spell: p.spell, spellKey: p.key, entityKey: eKey, landedTs, disp })

    if (this.stats.everFaded.has(p.key)) {
      this.active.set(iKey, this.build({ spell: p.spell, key: p.key, entityKey: eKey, startedTs: landedTs, provisional: false, dispOverride: disp }))
      // ILLUSION EXCLUSIVITY (Task #36): landing an illusion cast replaces any prior
      // illusion on the same entity.
      if (this.stats.isIllusion(p.key)) this.clearIllusionsOn(eKey, iKey)
    }
    this.dirty = true
  }

  /**
   * Stage a new cast in flight, and show it OPTIMISTICALLY right away (provisional) when the
   * spell is a known buff/debuff — bound to the entity this cast most likely targets NOW
   * (self, live pet, or the inferred hostile target for a debuff).
   */
  beginCast(spell: string, key: string, ts: number): void {
    const disp = this.inferCastDisposition(key, undefined)
    const eKey = this.pets.entityKeyFor(disp)
    const iKey = instanceKey(key, eKey)
    const existing = this.active.get(iKey)
    const stagedRefresh = !!existing && !existing.provisional
    this.pending = { spell, key, beganTs: ts, stagedRefresh }
    if (!existing && this.stats.everFaded.has(key)) {
      this.active.set(iKey, this.build({ spell, key, entityKey: eKey, startedTs: ts, provisional: true, dispOverride: disp }))
      // ILLUSION EXCLUSIVITY (Task #36): an optimistic illusion cast also replaces any
      // prior illusion on the same entity (a message apply confirms it later).
      if (this.stats.isIllusion(key)) this.clearIllusionsOn(eKey, iKey)
      this.dirty = true
    }
  }

  /** A fizzle/interrupt of `key` clears the pending cast and retracts its optimistic instance. */
  clearPendingCast(key: string): void {
    const p = this.pending
    if (p?.key !== key) return
    this.pending = null
    if (p.stagedRefresh) return
    // Retract the optimistic provisional instance this cast created.
    for (const [ik, a] of [...this.active]) {
      if (a.provisional && spellKey(a.spell) === key) {
        this.active.delete(ik)
        this.dirty = true
      }
    }
  }

  /**
   * Infer the target disposition of a cast at LAND time from the current entity state, a
   * LEARNED landing emote (Task #33), and the spell's class. A learned self-emote proves a
   * SELF cast even while a pet is live. A debuff → the inferred hostile fight target. Else
   * the live pet, else self.
   */
  inferCastDisposition(key: string, emoteSubjectKey?: string): EntityDisposition {
    const pets = this.pets
    if (emoteSubjectKey === SELF_KEY) return 'self'
    if (emoteSubjectKey && emoteSubjectKey !== SELF_KEY) {
      if (pets.charmedKey && emoteSubjectKey === pets.charmedKey) return 'charmed'
      if (pets.summonedKey && emoteSubjectKey === pets.summonedKey) return 'summoned'
      return pets.summonedKey ? 'summoned' : 'charmed'
    }
    if (this.stats.classOf(key) === 'debuff') return 'hostile'
    if (pets.charmedKey) return 'charmed'
    if (pets.summonedKey) return 'summoned'
    return 'self'
  }

  /**
   * The message is GROUND TRUTH for this cast's target. Drop any cast-timing-inferred
   * instance of the SAME spell (a provisional / unknown-hostile guess from the castBegin)
   * so we don't double-list the spell as both an inferred and a message-bound instance.
   */
  private dropInferredDuplicates(key: string, keepKey: string): void {
    for (const [ik, a] of [...this.active]) {
      if (ik === keepKey) continue
      if (spellKey(a.spell) === key && (a.provisional || a.inferredTarget)) {
        this.active.delete(ik)
        this.open.delete(ik)
      }
    }
  }

  /**
   * Apply a buff from an EXACT chat MESSAGE match (Task #34/#35). Confident, immediate,
   * non-provisional, messageDriven. `target` is 'self' for a cast-on-you / self-heal line,
   * else the named target (pet/player/mob) — bound to THAT entity's key.
   */
  applyMessageBuff(
    spell: string,
    spec: {
      target: string
      ts: number
      illusion: boolean
      durationMs: number | null
      /** ts from which the Permanent Illusion AA is owned, when it is. */
      permanentIllusionOwnedTs?: number
    }
  ): void {
    const { target, ts, illusion, durationMs } = spec
    if (durationMs == null && !illusion) return
    const key = spellKey(spell)
    // A SELF apply of a DETRIMENTAL spell is an incoming debuff a MOB cast on the player —
    // not the player's own buff. Skip it (the bar shows only the player's beneficial buffs).
    if (target === 'self' && this.stats.classOf(key) === 'debuff') return
    this.stats.everFaded.add(key)
    this.stats.touchLastSeen(key, ts)
    if (this.pending?.key === key) this.pending = null

    const self = target === 'self'
    const disp: EntityDisposition = self ? 'self' : this.pets.dispForNamedTarget(target)
    const eKey = self ? SELF_KEY : idKey(target)
    const iKey = instanceKey(key, eKey)
    // Remember the target's display casing so the row's target chip reads "Cazic-Thule",
    // not the lowercased key (Task #35).
    if (!self) this.pets.namedEntityDisplay.set(eKey, target)
    const permanent = isPermanentIllusion(self, illusion, ts, spec.permanentIllusionOwnedTs)

    this.dropInferredDuplicates(key, iKey)

    if (!permanent) {
      this.open.set(iKey, { spell, spellKey: key, entityKey: eKey, landedTs: ts, disp })
    } else {
      this.open.delete(iKey)
    }

    this.active.set(
      iKey,
      this.build({
        spell, key, entityKey: eKey, startedTs: ts, provisional: false, dispOverride: disp,
        opts: { messageDriven: true, permanent }
      })
    )
    // ILLUSION EXCLUSIVITY (Task #36): a new illusion apply on this entity replaces any
    // prior illusion active on it (self OR pet). Only one illusion per entity at a time.
    if (illusion) this.clearIllusionsOn(eKey, iKey)
    this.dirty = true
  }

  /**
   * AUTHORITATIVE removal (Task #34): a msg_wears_off proves the SELF instance expired NOW.
   * Pairs a duration sample if the self open cast exists, then clears that instance.
   */
  private removeAuthoritative(key: string, entityKey: string, ts: number): void {
    const iKey = instanceKey(key, entityKey)
    const spell = this.active.get(iKey)?.spell ?? this.stats.samples.get(key)?.spell ?? key
    this.stats.everFaded.add(key)
    this.recordFade(key, entityKey, spell, ts)
    // DERIVED buffExpired (Task #47): the wear-off is now RESOLVED to `spell` on `entityKey`.
    // Alerts match this reliable, unambiguous kind instead of the raw ambiguous buffWearOff.
    this.onExpired(spell, this.pets.targetDisplayFor(entityKey))
  }

  /**
   * SHARED wears-off resolution (Task #45). A wears-off line whose message maps to MULTIPLE
   * candidate spells (haste/strength/armor families) removes whichever matching ACTIVE self
   * buff(s) exist — resolve against the active set, don't guess a single spell:
   *   • exactly ONE candidate active → remove it (the common case; EQ stacking keeps one
   *     member of a family up at a time);
   *   • MULTIPLE candidates active → remove ALL of them (they honestly share this message);
   *   • NONE active → no-op (nothing to remove — don't fabricate a fade sample).
   * Each removal is AUTHORITATIVE (pairs a duration sample + clears the instance).
   */
  removeSharedWearOff(candidateNames: string[], entityKey: string, ts: number): void {
    const cands = new Set(candidateNames.map(spellKey))
    // Find the candidates that actually have an ACTIVE instance on this entity.
    const matched: string[] = []
    for (const [ik, a] of this.active) {
      if (instanceEntityKey(ik) !== entityKey) continue
      const k = spellKey(a.spell)
      if (cands.has(k) && !matched.includes(k)) matched.push(k)
    }
    for (const k of matched) this.removeAuthoritative(k, entityKey, ts)
    // NONE active → intentional no-op: a wears-off for a buff we never tracked (e.g. cast by
    // someone else, or already swept) must not create a phantom fade sample.
  }

  /**
   * Pair a fade with its open landed instance (a duration sample) and clear the active.
   *
   * The fade names the REAL target entity; a cast-timing open cast, though, may have bound
   * to an INFERRED entity (self / the-live-pet / an inferred hostile) that differs from the
   * fade's named target — the model can't always predict the exact target at cast time
   * (castBegin carries none). So we pair the exact (spell,entity) instance when present,
   * else fall back to ANY open cast of the same spell — preserving per-spell duration mining
   * (unchanged from the pre-#35 per-spell samples) while keeping per-instance DISPLAY. We
   * prefer the SAME-entity instance, then the oldest matching open cast.
   */
  recordFade(key: string, entityKey: string, spell: string, fadeTs: number): void {
    this.stats.touchLastSeen(key, fadeTs)
    const iKey = instanceKey(key, entityKey)
    let openKey: string | undefined
    let open: OpenCast | undefined
    const exact = this.open.get(iKey)
    if (exact) {
      openKey = iKey
      open = exact
    } else {
      let oldest = Infinity
      for (const [ok, o] of this.open) {
        if (o.spellKey === key && o.landedTs < oldest) {
          oldest = o.landedTs
          openKey = ok
          open = o
        }
      }
    }
    if (openKey !== undefined && open !== undefined) {
      const dur = fadeTs - open.landedTs
      if (dur > 0 && dur <= MAX_SAMPLE_MS) this.addSample(key, spell, dur)
      this.open.delete(openKey)
      this.active.delete(openKey)
    }
    // Also clear the exact-target instance's active (the fade proves THAT entity's copy is
    // gone), even if the paired open cast was a different-entity instance.
    this.active.delete(iKey)
    this.dirty = true
  }

  private addSample(key: string, spell: string, durMs: number): void {
    this.stats.pushSample(key, spell, durMs)
    // Restat every live instance of this spell (they share the per-spell stats).
    for (const [ik, a] of [...this.active]) {
      if (spellKey(a.spell) === key) {
        this.active.set(
          ik,
          this.build({
            spell: a.spell,
            key,
            entityKey: instanceEntityKey(ik),
            startedTs: a.startedTs,
            provisional: a.provisional,
            dispOverride: a.disposition,
            opts: { messageDriven: a.messageDriven, permanent: a.permanent }
          })
        )
      }
    }
    this.dirty = true
  }

  /** Session-gap clear (Task #33, finding #5): wipe live actives/opens/pending. */
  clearForGap(): void {
    const changed = this.active.size > 0 || this.open.size > 0 || this.pending != null
    this.active.clear()
    this.open.clear()
    this.pending = null
    if (changed) this.dirty = true
  }

  /** Hygiene sweep (Task #33, finding #6): retire any active past its per-spell cap. */
  sweepHygiene(now: number): void {
    let changed = false
    for (const [ik, a] of [...this.active]) {
      if (a.provisional) continue
      if (a.permanent) continue
      const sKey = spellKey(a.spell)
      const dbMs = this.stats.dbDurationFor(sKey)
      const cap = Math.max(hygieneCapMs(a.p75, a.n), dbMs != null ? 2 * dbMs : 0)
      if (now - a.startedTs > cap) {
        this.active.delete(ik)
        this.open.delete(ik)
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /** playerDeath strips SELF buffs: censor open SELF casts + clear their actives. */
  onPlayerDeath(): void {
    let changed = false
    for (const [ik, o] of [...this.open]) {
      if (o.entityKey === SELF_KEY) {
        this.open.delete(ik)
        changed = true
      }
    }
    for (const [ik, a] of [...this.active]) {
      if (a.self) {
        this.active.delete(ik)
        changed = true
      }
    }
    if (this.pending) {
      // A pending self cast is abandoned (death interrupts it). A debuff/pet cast survives.
      const disp = this.inferCastDisposition(this.pending.key, this.pending.emoteSubjectKey)
      if (disp === 'self') {
        this.pending = null
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /**
   * Retire an ENTITY (Task #35, generalized — NO pet-specific branches). Censors every open
   * cast + active instance bound to `entityKey`. Used on uncharm / summoned-pet death /
   * hostile death / zone-left-behind / single-pet succession — the pet is just the entity
   * currently claimed. Buffs on other players / arbitrary entities are censored the same way.
   *
   * `hostileOnly` guards a plain-mob death: only DEBUFF instances on that mob are censored
   * (a friendly buff can't be on a hostile), and an unknown-hostile debuff bucket is swept
   * too (its inferred target just died).
   */
  retireEntity(entityKey: string, opts?: { hostileOnly?: boolean }): void {
    const hostileOnly = opts?.hostileOnly === true
    let changed = false
    for (const [ik, o] of [...this.open]) {
      if (openMatches(o, entityKey, hostileOnly)) {
        this.open.delete(ik)
        changed = true
      }
    }
    for (const [ik, a] of [...this.active]) {
      if (activeMatches(a, instanceEntityKey(ik), entityKey, hostileOnly)) {
        this.active.delete(ik)
        changed = true
      }
    }
    // Clear the entity from pet state if it was a pet (charmed / broken-charm / summoned).
    this.pets.retireSlots(entityKey)
    if (changed) this.dirty = true
  }

  /**
   * ZONE (the user's rule): the player keeps self buffs; a SUMMONED pet follows and keeps
   * its buffs; a CHARMED pet is LEFT BEHIND (retire + censor); hostile mobs are left behind
   * (censor open debuffs). Uses the SHARED isLeftBehindOnZone rule.
   */
  onZone(): void {
    let changed = false
    for (const [ik, o] of [...this.open]) {
      if (openLeftBehindOnZone(o)) {
        this.open.delete(ik)
        changed = true
      }
    }
    for (const [ik, a] of [...this.active]) {
      const leftBehind =
        a.cls === 'debuff' || a.disposition === 'charmed' || a.disposition === 'hostile'
      if (leftBehind) {
        this.active.delete(ik)
        changed = true
      }
    }
    if (this.pets.clearOnZone()) changed = true
    if (this.pending) {
      const disp = this.inferCastDisposition(this.pending.key, this.pending.emoteSubjectKey)
      if (disp === 'charmed' || disp === 'hostile') {
        this.pending = null
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /** Project one instance into its UI row against the current stats + pet identities. */
  private build(spec: ActiveSpec): ActiveBuff {
    return buildActive(spec, this.stats, this.pets)
  }
}

/**
 * Permanent Illusion AA (Task #34): a SELF illusion cast at or after the AA was owned never
 * expires, so it is shown with no countdown and pairs no duration sample.
 */
function isPermanentIllusion(
  self: boolean,
  illusion: boolean,
  ts: number,
  ownedTs: number | undefined
): boolean {
  return self && illusion && ownedTs != null && ts >= ownedTs
}
