// entityRules.ts — SHARED PURE entity-lifecycle rules (Task #32).
//
// The combat WorldModel (world.ts) and the buffs simulation (modules/buffs.ts) both
// reason about the SAME small set of facts: what KIND of entity is this (self /
// summoned pet / charmed pet / hostile mob), and what happens to it on the two
// lifecycle events that STRIP its buffs-or-attribution unobservably — a ZONE line and
// a DEATH. Rather than duplicate the semantics (and risk them drifting), the honest
// pure rules live here and are imported by both consumers.
//
// This file is deliberately DEPENDENCY-FREE and BEHAVIOR-FREE — just data + pure
// predicates. It does NOT reach into any live world instance; each consumer keeps its
// own state and asks these functions for a verdict. (The user's rule: "modules are
// independent event consumers — do NOT reach into the engine's live world instance".)

/**
 * How an entity became your pet — the single fact that decides zone behavior.
 *   'charmed'  — bound by a `<mob> has been charmed.` line. A charmed pet is LEFT
 *                BEHIND on a zone line (charm cannot survive a zone) and its buffs
 *                can never be observed fading after that, so its open casts are
 *                CENSORED, not sampled.
 *   'summoned' — a class pet (random proper name) bound by a petClaim. It FOLLOWS you
 *                through zones and keeps its buffs (real-log verified in world.ts), so
 *                its open casts survive a zone.
 *
 * (Kept byte-identical to world.ts's PetKind so the two models share one vocabulary;
 * world.ts re-exports this type.)
 */
export type PetKind = 'charmed' | 'summoned'

/**
 * The four buff-target dispositions the buffs simulation binds a buff to. `self` and
 * the two pet kinds are YOURS; `hostile` is a debuff target (an enemy mob).
 */
export type EntityDisposition = 'self' | 'summoned' | 'charmed' | 'hostile'

/**
 * TRUE if an entity of this pet-kind is LEFT BEHIND (retired) by a zone line — i.e.
 * its subsequent fade can never be observed, so any open buff/debuff on it must be
 * CENSORED (no duration sample) rather than left to pollute stats with a fake
 * multi-hour duration. Charmed pets and hostile mobs are left behind; summoned pets
 * follow. `undefined` kind = a hostile mob (debuff target) → left behind.
 *
 * This is the pure core of world.ts's `zone()` survivor rule (which keeps summoned
 * pets, retires everything else) expressed for a single entity.
 */
export function isLeftBehindOnZone(kind: PetKind | undefined): boolean {
  return kind !== 'summoned'
}

/**
 * TRUE if a buff/debuff open on an entity that just DIED (or was retired) must be
 * CENSORED. Death always strips buffs and the fade can never be observed — so ANY
 * entity's death censors its open casts. (Mirrors world.ts's `retire()`: a retired
 * instance's engagement ends unobservably.)
 */
export function deathCensors(): boolean {
  return true
}

/**
 * Classify a fade-target name against the CURRENT pet identities into a buff-target
 * disposition. This is the buffs-side analog of world.ts's charmed/hostile split, but
 * keyed by NAME (the buffs module tracks names, not twin instances):
 *   - a targetless/self fade  → 'self'
 *   - the literal 'pet' form   → the pet's own kind (summoned pet is the common case;
 *                                a charmed pet's targetless fade is rare — callers pass
 *                                the current pet kind)
 *   - the summoned pet's name  → 'summoned'
 *   - the charmed pet's name   → 'charmed'
 *   - anything else            → 'hostile' (a debuff on an enemy)
 *
 * `nameKey` is the CANONICAL lowercase key (callers pass idKey(rawTarget)); the two
 * pet keys are likewise canonical. Returns the disposition; callers decide grouping.
 */
export function classifyFadeTarget(
  targetNameKey: string | undefined,
  petState: { charmedKey?: string; summonedKey?: string }
): EntityDisposition {
  if (!targetNameKey) return 'self'
  if (targetNameKey === 'pet') {
    // A possessive "Your pet's …" fade: prefer the summoned pet (the class pet is the
    // canonical "pet" in EQ), else the charmed pet if that's all that's live.
    if (petState.summonedKey) return 'summoned'
    if (petState.charmedKey) return 'charmed'
    return 'summoned' // no known pet: still a pet-form fade, treat as your pet
  }
  if (petState.summonedKey && targetNameKey === petState.summonedKey) return 'summoned'
  if (petState.charmedKey && targetNameKey === petState.charmedKey) return 'charmed'
  return 'hostile'
}

/** TRUE if a disposition is one of YOUR entities (self or either pet). */
export function isFriendly(d: EntityDisposition): boolean {
  return d !== 'hostile'
}

/**
 * PURE core of world.ts's death() decision, for a name-keyed consumer (the buffs
 * simulation) that does NOT track twin instances. Given a `<mob> slain` line whose
 * name MATCHES the live charmed pet's name, decide whether the CHARMED PET is the one
 * that died (vs a same-named hostile twin). This mirrors world.ts cases 2a/2b/2c but
 * without the twin-slot bookkeeping — it answers only "did the pet die?":
 *
 *   killerIsYou (2a)        → the pet CANNOT be slain by you (a same-named hostile
 *                             twin died, or a charm-break-then-kill race). For a
 *                             name-keyed consumer we bias to KEEPING the pet: a false
 *                             pet-death would wrongly censor a live pet's buffs. → NOT dead.
 *   killerSameName (2c) or  → genuinely ambiguous (pet↔twin / a differently-named
 *   different killer (2b)     killer slew SOMETHING of this name). Without twin
 *                             tracking we cannot prove which died; world.ts biases
 *                             toward keeping the pet whenever a twin *could* exist.
 *                             The name-keyed consumer has no twin evidence either way,
 *                             so it also keeps the pet (conservative — never silently
 *                             censor a live pet's buffs on an ambiguous death). → NOT dead.
 *
 * Net: a `<charmedName> slain` line NEVER censors the pet's buffs on its own — the pet
 * is retired only by an explicit `uncharm` (charm-spell worn off) or a `zone`. This is
 * the honest conservative rule the WorldModel arrives at for the twin-ambiguous case;
 * the small cost is that a genuine pet death that the log reports ONLY as a same-named
 * slain line (no uncharm) leaves the buffs open until the next zone censors them.
 */
export function charmedPetDiesOnDeathLine(_opts: {
  killerIsYou: boolean
  killerSameName: boolean
}): boolean {
  return false
}
