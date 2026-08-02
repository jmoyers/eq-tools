// WorldModel — entity-instance tracking for the combat engine.
//
// PURPOSE
// The engine historically keyed everything by bare name. That collapses same-named
// twins: when you charm one "a fire giant warrior" while a hostile "a fire giant
// warrior" is present, both share a name key, so the pet and the mob it tanks are
// indistinguishable. This model gives every spawn a distinct INSTANCE identity
// (`${nameKey}#${gen}`) so twins are separate entities in encounter aggregation and
// so charm/death lifecycle can be reasoned about deterministically.
//
// An instance is: { instanceId, nameKey, display, charmed, firstSeenTs, lastSeenTs,
// retired }. Per nameKey we keep an ordered list of instances; `gen` increments per
// spawn. At most a handful are "active" (not retired) at once. Display disambiguates
// the Nth live generation as e.g. "a fire giant warrior (2)".
//
// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE DECISION TABLE (all rules deterministic; ambiguity is flagged, never
// silently guessed toward the worse failure mode — a false pet-death drops all
// subsequent pet damage, so we bias AWAY from retiring the pet on ambiguity):
//
//  EVENT            RULE
//  ─────────────    ───────────────────────────────────────────────────────────
//  see(name)        Resolve an active instance for `name`. If none active, spawn a
//                   new hostile instance (gen++). Used to resolve damage/heal
//                   attacker & target to instances. Same-name twins are separated
//                   by evidence (see noteTwinEvidence): a second active instance is
//                   spawned when the log proves two co-exist.
//
//  charm(name)      The charmed pet must be an ACTIVE instance marked charmed.
//                   - If an active, not-yet-charmed hostile instance of `name`
//                     exists AND there is no evidence of a second live twin, BIND
//                     it: mark that instance charmed (the mob you were fighting is
//                     now your pet).
//                   - Otherwise SPAWN a fresh charmed instance (gen++). This covers
//                     the first charm of a name never seen, and re-charming while a
//                     hostile twin is already live.
//
//  twin evidence    You→name damage while an instance of name is charmed, OR
//                   name→name damage, proves a hostile twin co-exists with the pet.
//                   Ensure a second (hostile) active instance of name exists so the
//                   pet and the twin are distinct. (noteTwinEvidence)
//
//  uncharm(name)    Clear `charmed` on the charmed instance of name (it stays the
//                   SAME instance, now hostile-capable again). Does not retire.
//
//  death(name,      Decide WHICH instance of name dies:
//        killerKey)   1. If no charmed instance of name is active → retire the
//                       oldest active hostile instance of name (plain mob death).
//                     2. If a charmed instance IS active:
//                        a. killerKey === 'you' → the pet cannot be slain-by-you;
//                           retire a hostile twin if one exists, else (only the pet
//                           is live and you "killed" it — a charm-break-then-kill
//                           race) retire the pet.  [pet-safe]
//                        b. killerKey !== name (a different-named killer, e.g. a
//                           fire giant wizard) → this killer was fighting SOMETHING
//                           named `name`. Retire the pet ONLY if evidence shows the
//                           pet was the instance tanking THIS killer (petTankedBy);
//                           otherwise retire the hostile twin and, if no twin
//                           exists, flag ambiguity + retire the twin-slot (never
//                           silently kill the pet).  [bias: keep pet alive]
//                        c. killerKey === name (same-name "slain by") → genuinely
//                           ambiguous (pet↔twin). If a hostile twin exists, retire
//                           the twin (keep pet). If ONLY the pet is live, this is a
//                           real pet death (the game named the pet's killer as the
//                           same-named mob it was tanking, now despawned) → retire
//                           the pet. Flag ambiguity in both sub-cases.
//                     When ambiguous and a twin exists we always keep the pet.
//
//  zone             Retire ALL instances and clear charm (charm cannot survive a
//                   zone; matches the engine's existing zone reset).
// ─────────────────────────────────────────────────────────────────────────────

import { idKey } from '../log/parser'

/**
 * How an instance became your pet:
 *   'charmed'  — bound by a `<mob> has been charmed.` line; cannot survive a zone.
 *   'summoned' — a class pet (random proper name) bound by a petClaim (direct
 *                tell). Persists across zone lines (verified in the real log: a
 *                summoned pet kept dealing damage after 3 zone transitions with no
 *                re-summon), so zone() does NOT retire it.
 */
export type PetKind = 'charmed' | 'summoned'

export interface Instance {
  instanceId: string
  nameKey: string
  display: string
  charmed: boolean
  /** Set while `charmed` is true; distinguishes zone behavior. Undefined = hostile. */
  petKind?: PetKind
  firstSeenTs: number
  lastSeenTs: number
  retired: boolean
  /** gen ordinal (1-based) among all instances ever spawned for this nameKey. */
  gen: number
}

/** Result of a death() decision, for engine logging / ambiguity surfacing. */
export interface DeathResolution {
  retired: Instance | null
  wasPet: boolean
  ambiguous: boolean
  reason: string
}

export class WorldModel {
  /** All instances ever, keyed by nameKey → ordered spawn list. */
  private byName = new Map<string, Instance[]>()
  /** gen counter per nameKey. */
  private gens = new Map<string, number>()
  /** Killers each charmed pet has been observed tanking (pet instanceId → set of
   *  attacker nameKeys that hit it / that it hit). Drives death case (b). */
  private petTankedBy = new Map<string, Set<string>>()

  reset(): void {
    this.byName.clear()
    this.gens.clear()
    this.petTankedBy.clear()
  }

  /** Active (non-retired) instances for a nameKey, oldest→newest. */
  private active(nameKey: string): Instance[] {
    return (this.byName.get(nameKey) ?? []).filter((i) => !i.retired)
  }

  private spawn(nameKey: string, display: string, ts: number, charmed: boolean, petKind?: PetKind): Instance {
    const gen = (this.gens.get(nameKey) ?? 0) + 1
    this.gens.set(nameKey, gen)
    const inst: Instance = {
      instanceId: `${nameKey}#${gen}`,
      nameKey,
      display,
      charmed,
      petKind: charmed ? petKind : undefined,
      firstSeenTs: ts,
      lastSeenTs: ts,
      retired: false,
      gen
    }
    const list = this.byName.get(nameKey) ?? []
    list.push(inst)
    this.byName.set(nameKey, list)
    return inst
  }

  /** The charmed active instance for a nameKey, if any. */
  private charmedActive(nameKey: string): Instance | undefined {
    return this.active(nameKey).find((i) => i.charmed)
  }
  /** The oldest active hostile (non-charmed) instance for a nameKey, if any. */
  private hostileActive(nameKey: string): Instance | undefined {
    return this.active(nameKey).find((i) => !i.charmed)
  }

  /**
   * Resolve a raw name to a live instance for attribution, spawning a hostile one
   * if none is active. `preferCharmed` picks the charmed pet when both a pet and a
   * hostile twin are live and the caller knows this reference is the pet (e.g. the
   * pet as damage attacker). Otherwise prefers a hostile instance (mob references).
   */
  resolve(name: string, ts: number, preferCharmed = false): Instance {
    if (idKey(name) === 'you') {
      // 'you' is not modeled as a spawnable instance; caller handles it. Return a
      // synthetic sentinel so callers never crash (they special-case 'you' first).
      return {
        instanceId: 'you',
        nameKey: 'you',
        display: 'You',
        charmed: false,
        firstSeenTs: ts,
        lastSeenTs: ts,
        retired: false,
        gen: 1
      }
    }
    const key = idKey(name)
    const act = this.active(key)
    if (act.length === 0) {
      return this.spawn(key, name, ts, false)
    }
    let inst: Instance
    if (preferCharmed) {
      inst = this.charmedActive(key) ?? this.hostileActive(key) ?? act[0]
    } else {
      inst = this.hostileActive(key) ?? act[0]
    }
    inst.lastSeenTs = ts
    if (inst.display !== name && idKey(inst.display) === key) inst.display = name
    return inst
  }

  /** Look up the charmed pet instance for a name (attribution helper). */
  petInstance(name: string): Instance | undefined {
    return this.charmedActive(idKey(name))
  }

  /**
   * charm(name): produce the charmed pet instance (see decision table).
   * Returns the instance now marked charmed.
   */
  charm(name: string, ts: number): Instance {
    const key = idKey(name)
    // Bind an existing lone hostile instance only if there's exactly one active
    // instance and it isn't already charmed — no evidence of a second twin yet.
    const act = this.active(key)
    const hostiles = act.filter((i) => !i.charmed)
    if (!this.charmedActive(key) && hostiles.length === 1 && act.length === 1) {
      const inst = hostiles[0]
      inst.charmed = true
      inst.petKind = 'charmed'
      inst.lastSeenTs = ts
      this.petTankedBy.set(inst.instanceId, new Set())
      return inst
    }
    // Otherwise spawn a fresh charmed instance (first-ever charm, or re-charm while
    // a hostile twin is already live).
    const inst = this.spawn(key, name, ts, true, 'charmed')
    this.petTankedBy.set(inst.instanceId, new Set())
    return inst
  }

  /**
   * claim(name): mark a SUMMONED pet (see petClaim / PetKind). Idempotent — a pet
   * re-tells you every few seconds. If an instance of `name` is already a live pet
   * (charmed or summoned) this is a no-op that just refreshes lastSeen; else it
   * binds a lone live hostile instance as summoned, or spawns a fresh summoned
   * instance. Summoned pets survive zoning, so they must NOT be created via the
   * hostile-spawn path (which zone() would retire).
   */
  claim(name: string, ts: number): Instance {
    const key = idKey(name)
    const existing = this.active(key).find((i) => i.charmed)
    if (existing) {
      existing.lastSeenTs = ts
      return existing
    }
    const act = this.active(key)
    const hostiles = act.filter((i) => !i.charmed)
    if (hostiles.length === 1 && act.length === 1) {
      const inst = hostiles[0]
      inst.charmed = true
      inst.petKind = 'summoned'
      inst.lastSeenTs = ts
      this.petTankedBy.set(inst.instanceId, new Set())
      return inst
    }
    const inst = this.spawn(key, name, ts, true, 'summoned')
    this.petTankedBy.set(inst.instanceId, new Set())
    return inst
  }

  /**
   * uncharm(name): clear the charmed flag on the pet instance (same instance).
   * Summoned pets are never un-charmed by a worn-off charm-spell line (they have
   * proper names, not the charmed mob's name), so this is a no-op for them.
   */
  uncharm(name: string, ts: number): Instance | undefined {
    const inst = this.charmedActive(idKey(name))
    if (inst && inst.petKind !== 'summoned') {
      inst.charmed = false
      inst.petKind = undefined
      inst.lastSeenTs = ts
      return inst
    }
    return undefined
  }

  /**
   * Record evidence that a hostile twin of `name` co-exists with a charmed pet of
   * the same name: ensure a second active hostile instance exists. Called when the
   * engine sees You→charmed-name damage or name→name damage.
   */
  noteTwinEvidence(name: string, ts: number): void {
    const key = idKey(name)
    if (!this.charmedActive(key)) return // only meaningful while a pet is live
    if (!this.hostileActive(key)) this.spawn(key, name, ts, false)
  }

  /**
   * Note that a charmed pet is tanking / trading blows with a killer of nameKey
   * `otherKey`. Drives death case (b): if that killer later "slays" name, and the
   * pet was tanking it, the pet is the one that died.
   */
  notePetEngagement(petName: string, otherKey: string): void {
    const pet = this.charmedActive(idKey(petName))
    if (!pet) return
    const set = this.petTankedBy.get(pet.instanceId) ?? new Set()
    set.add(otherKey)
    this.petTankedBy.set(pet.instanceId, set)
  }

  /**
   * death(name, killerKey): decide which instance retires. Returns the resolution
   * (retired instance, whether it was the pet, ambiguity flag, reason).
   */
  death(name: string, ts: number, killerKey: string | undefined): DeathResolution {
    const key = idKey(name)
    const act = this.active(key)
    if (act.length === 0) {
      return { retired: null, wasPet: false, ambiguous: false, reason: 'no active instance' }
    }
    const pet = this.charmedActive(key)
    const hostile = this.hostileActive(key)

    // Case 1: no charmed instance — plain hostile death.
    if (!pet) {
      const victim = hostile ?? act[0]
      this.retire(victim, ts)
      return { retired: victim, wasPet: false, ambiguous: false, reason: 'plain hostile death' }
    }

    const kk = killerKey

    // Case 2a: killer is You. The pet can't be slain BY you; a hostile twin died.
    if (kk === 'you') {
      if (hostile) {
        this.retire(hostile, ts)
        return { retired: hostile, wasPet: false, ambiguous: false, reason: 'you slew hostile twin' }
      }
      // Only the pet is live and the game says you slew it — charm broke this tick
      // then you killed it. Retire the pet (rare, deterministic).
      this.retire(pet, ts)
      return { retired: pet, wasPet: true, ambiguous: false, reason: 'you slew pet (charm-break race)' }
    }

    // Case 2b: killer is a DIFFERENT name (e.g. a fire giant wizard).
    if (kk && kk !== key) {
      const petTanked = this.petTankedBy.get(pet.instanceId)?.has(kk) ?? false
      if (petTanked && !hostile) {
        // Only the pet was tanking this killer and no hostile twin exists → pet died.
        this.retire(pet, ts)
        return { retired: pet, wasPet: true, ambiguous: false, reason: `pet slain by ${kk} it was tanking` }
      }
      if (hostile) {
        // Prefer retiring the hostile twin (keep the pet — the safe bias).
        this.retire(hostile, ts)
        const ambiguous = petTanked
        return {
          retired: hostile,
          wasPet: false,
          ambiguous,
          reason: ambiguous ? `ambiguous: pet also tanked ${kk}; kept pet, retired twin` : `hostile twin slain by ${kk}`
        }
      }
      // No hostile twin AND no evidence the pet tanked this killer: the killer was
      // fighting a same-named mob we hadn't separately instanced. Spawn+retire a
      // hostile twin slot; keep the pet, flag ambiguity (never silently kill pet).
      const ghost = this.spawn(key, name, ts, false)
      this.retire(ghost, ts)
      return { retired: ghost, wasPet: false, ambiguous: true, reason: `ambiguous: ${kk} slew a ${name}; kept pet` }
    }

    // Case 2c: killer is the SAME name ("a fire giant warrior slain by a fire giant
    // warrior") — pet↔twin, genuinely ambiguous.
    if (hostile) {
      // A hostile twin exists — retire it, keep the pet. Flag ambiguity.
      this.retire(hostile, ts)
      return { retired: hostile, wasPet: false, ambiguous: true, reason: 'ambiguous same-name death; kept pet, retired twin' }
    }
    // Only the pet is live and a same-named mob slew it → real pet death.
    this.retire(pet, ts)
    return { retired: pet, wasPet: true, ambiguous: true, reason: 'ambiguous same-name death; only pet live → pet died' }
  }

  private retire(inst: Instance, ts: number): void {
    inst.retired = true
    inst.lastSeenTs = ts
    inst.charmed = false
    inst.petKind = undefined
    this.petTankedBy.delete(inst.instanceId)
  }

  /**
   * zone: retire everything EXCEPT summoned pets. Charm cannot survive a zone and
   * hostile mobs don't follow you, so both are retired; SUMMONED class pets persist
   * across zone lines (real-log verified), so they're kept live. Returns the
   * summoned pet instances that survived, so the engine can keep their name keys in
   * its charmed set.
   */
  zone(ts: number): Instance[] {
    const survivors: Instance[] = []
    for (const list of this.byName.values()) {
      for (const inst of list) {
        if (inst.retired) continue
        if (inst.charmed && inst.petKind === 'summoned') {
          inst.lastSeenTs = ts
          survivors.push(inst)
        } else {
          this.retire(inst, ts)
        }
      }
    }
    return survivors
  }

  private find(instanceId: string): Instance | undefined {
    const hash = instanceId.lastIndexOf('#')
    if (hash <= 0) return undefined
    return this.byName.get(instanceId.slice(0, hash))?.find((i) => i.instanceId === instanceId)
  }

  /** True if the instance with this id has been retired (dead/zoned). Unknown ids
   *  (never spawned) are treated as retired — they can't be a live engagement. */
  isRetired(instanceId: string): boolean {
    const inst = this.find(instanceId)
    return inst ? inst.retired : true
  }

  /** True if the instance is currently your (live, non-retired) charmed/summoned pet.
   *  Such an instance is never a hostile we're trying to kill, so it must NOT block
   *  an encounter's death-close (a charmed pet never dies, so it would pin every
   *  charm-grind fight open forever). */
  isLivePet(instanceId: string): boolean {
    const inst = this.find(instanceId)
    return !!inst && !inst.retired && inst.charmed
  }

  /** Currently-charmed pet instances (for snapshot.charmed). */
  charmedInstances(): Instance[] {
    const out: Instance[] = []
    for (const list of this.byName.values()) for (const i of list) if (!i.retired && i.charmed) out.push(i)
    return out
  }

  /**
   * Display label for an instance in encounter views. When more than one instance
   * of a nameKey has ever been engaged, later gens get a " (N)" suffix so twins are
   * visually distinct; the first gen keeps the bare name.
   */
  label(inst: Instance): string {
    const total = this.gens.get(inst.nameKey) ?? 1
    if (total <= 1 || inst.gen === 1) return inst.display
    return `${inst.display} (${inst.gen})`
  }
}
