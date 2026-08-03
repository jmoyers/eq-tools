// The buffs model's ENTITY state (the who/what) — a tiny parallel to the combat
// WorldModel, sharing its pure rules via combat/entityRules.ts. See buffs.ts for the
// model this belongs to.
//
// Entities, not names; DISPOSITION, not identity (law 4): a buff binds to the entity a
// landing message named, and retiring that entity censors every instance bound to its key.
// "pet" is simply the entity currently claimed — there are no pet-specific branches in the
// instance store; the only pet-shaped knowledge lives here, in the slots below.

import { classifyFadeTarget, type EntityDisposition } from '../combat/entityRules'
import { idKey } from '../log/parser'
import { SELF_KEY } from './buffsShapes'

export class PetEntities {
  charmedKey?: string
  charmedDisplay?: string
  /**
   * A charm that just BROKE but whose entity is NOT yet retired (Task #37). Charm/uncharm
   * changes an entity's DISPOSITION, never its identity: when Allure/Charm wears off, the mob
   * KEEPS its buffs and is merely hostile-capable for a few seconds until you re-charm it. We
   * remember its key/display here so a re-charm of the SAME name (with no intervening death or
   * zone of that name) reconnects to the SAME entity — its buffs never having been censored.
   * A death or zone of that name in the meantime retires it (clears this), so the next charm
   * of that name is a genuinely new entity.
   */
  brokenCharmKey?: string
  brokenCharmDisplay?: string
  summonedKey?: string
  summonedDisplay?: string
  /** The pet's CURRENT hostile fight target (canonical key + display), if cheaply known. */
  petTargetKey?: string
  petTargetDisplay?: string
  /** Display casing for arbitrary bound entities (mobs/players named by a buff message). */
  namedEntityDisplay = new Map<string, string>()

  reset(): void {
    this.clearForGap()
    this.namedEntityDisplay = new Map()
  }

  /** Session-gap / rebirth clear: every live pet binding goes, learned display casing stays. */
  clearForGap(): void {
    this.charmedKey = undefined
    this.charmedDisplay = undefined
    this.brokenCharmKey = undefined
    this.brokenCharmDisplay = undefined
    this.summonedKey = undefined
    this.summonedDisplay = undefined
    this.petTargetKey = undefined
    this.petTargetDisplay = undefined
  }

  /**
   * Current pet identities, for the shared classifyFadeTarget helper. During a charm-break
   * hostile window (Task #37) the ex-pet is still the SAME entity, so its name is classified as
   * the (charmed) pet — a buff fading on it in that 7s window is the pet's buff fading, NOT a
   * hostile debuff. `charmedKey` falls back to the broken-charm key while the charm is down.
   */
  petState(): { charmedKey?: string; summonedKey?: string } {
    return { charmedKey: this.charmedKey ?? this.brokenCharmKey, summonedKey: this.summonedKey }
  }

  /** The current pet's canonical entity key (summoned preferred, else charmed), or undefined. */
  currentPetKey(): string | undefined {
    return this.summonedKey ?? this.charmedKey
  }

  /** The current pet's display name (summoned preferred, else charmed), or undefined. */
  currentPetDisplay(): string | undefined {
    return this.summonedDisplay ?? this.charmedDisplay
  }

  /** Disposition for a named message target: a live pet, else hostile. */
  dispForNamedTarget(target: string): EntityDisposition {
    const k = idKey(target)
    if (this.charmedKey && k === this.charmedKey) return 'charmed'
    if (this.summonedKey && k === this.summonedKey) return 'summoned'
    return 'hostile'
  }

  /** The canonical entity key a cast of this disposition binds to. */
  entityKeyFor(disp: EntityDisposition): string {
    if (disp === 'self') return SELF_KEY
    if (disp === 'summoned') return this.summonedKey ?? SELF_KEY
    if (disp === 'charmed') return this.charmedKey ?? SELF_KEY
    // hostile debuff: the inferred fight target, if known; else a stable 'unknown' bucket.
    return this.petTargetKey ?? 'unknown-hostile'
  }

  /** Resolve a buffFade's raw target into an entity key + disposition. */
  fadeTargetEntity(rawTarget?: string): { entityKey: string; disp: EntityDisposition } {
    if (!rawTarget) return { entityKey: SELF_KEY, disp: 'self' }
    if (rawTarget === 'pet') {
      // Possessive 'Your pet's …' — resolve against the CURRENT pet entity.
      const petKey = this.currentPetKey()
      const disp = classifyFadeTarget('pet', this.petState())
      return { entityKey: petKey ?? 'pet', disp }
    }
    const nameKey = idKey(rawTarget)
    const disp = classifyFadeTarget(nameKey, this.petState())
    return { entityKey: nameKey, disp }
  }

  /**
   * The `buffExpired.target` display for a buffFade (Task #47). Targetless → 'self'; the
   * possessive 'pet' form → the current pet's display name (or the literal 'pet'); a named
   * mob → its raw display name (the fade line preserves casing).
   */
  buffFadeTargetDisplay(rawTarget: string | undefined, entityKey: string): string {
    if (!rawTarget) return 'self'
    if (rawTarget === 'pet') {
      return this.namedEntityDisplay.get(entityKey) ?? this.currentPetDisplay() ?? 'pet'
    }
    return rawTarget
  }

  /** Map an entity key to a `buffExpired.target` value: 'self' or the entity's display name. */
  targetDisplayFor(entityKey: string): string {
    if (entityKey === SELF_KEY) return 'self'
    return this.namedEntityDisplay.get(entityKey) ?? entityKey
  }

  /** Best display name for an entity key (a pet, the inferred target, a named mob, else key). */
  entityDisplayFor(entityKey: string): string | undefined {
    if (entityKey === this.summonedKey) return this.summonedDisplay
    if (entityKey === this.charmedKey) return this.charmedDisplay
    if (entityKey === this.petTargetKey) return this.petTargetDisplay
    if (entityKey === 'unknown-hostile' || entityKey === 'pet') return undefined
    return this.namedEntityDisplay.get(entityKey) ?? entityKey
  }

  /** Clear the entity from pet state if it was a pet (charmed / broken-charm / summoned). */
  retireSlots(entityKey: string): void {
    if (entityKey === this.charmedKey) {
      this.charmedKey = undefined
      this.charmedDisplay = undefined
    }
    if (entityKey === this.brokenCharmKey) {
      this.brokenCharmKey = undefined
      this.brokenCharmDisplay = undefined
    }
    if (entityKey === this.summonedKey) {
      this.summonedKey = undefined
      this.summonedDisplay = undefined
    }
  }

  /**
   * Zone: the charmed pet is left behind, and so is a broken-charm entity (Task #37) — its
   * actives were censored by the instance store's 'charmed'-disposition sweep, so we drop its
   * state here so a later charm of that name is a fresh entity (rule #3, the zone-between
   * case). The inferred fight target goes unconditionally. Returns whether anything changed.
   */
  clearOnZone(): boolean {
    let changed = false
    if (this.charmedKey) {
      this.charmedKey = undefined
      this.charmedDisplay = undefined
      changed = true
    }
    if (this.brokenCharmKey) {
      this.brokenCharmKey = undefined
      this.brokenCharmDisplay = undefined
      changed = true
    }
    this.petTargetKey = undefined
    this.petTargetDisplay = undefined
    return changed
  }
}
