// The ActiveBuff PROJECTION for the buffs model (see buffs.ts): turn one live buff
// instance — (spell, entity) plus how it got there — into the row the UI renders.
// Pure: it reads the learned per-spell stats and the current pet identities and writes
// nothing, so every caller in the instance store shares one definition of what a row says.

import type { ActiveBuff, BuffClass } from '../../shared/types'
import type { EntityDisposition } from '../combat/entityRules'
import { SELF_KEY } from './buffsShapes'
import type { PetEntities } from './buffsEntities'
import type { SpellStats } from './buffsStats'

/** Everything that identifies the instance being projected, plus how it was established. */
export interface ActiveSpec {
  spell: string
  key: string
  entityKey: string
  startedTs: number
  provisional?: boolean
  dispOverride?: EntityDisposition
  opts?: { messageDriven?: boolean; permanent?: boolean }
}

/**
 * Target label + inference. Self: none. Otherwise the bound entity's display name; a
 * debuff whose target was inferred (no confirmed message) is flagged inferredTarget.
 */
function resolveTargetLabel(
  a: { entityKey: string; cls: BuffClass; self: boolean; disp?: EntityDisposition; messageDriven: boolean },
  pets: PetEntities
): { target: string | undefined; inferredTarget: boolean } {
  const { entityKey, cls, disp } = a
  if (a.self) return { target: undefined, inferredTarget: false }
  // Self-keyed debuff = an inferred, not-yet-named hostile target.
  if (cls === 'debuff' && entityKey === SELF_KEY) {
    return { target: pets.petTargetDisplay, inferredTarget: true }
  }
  if (disp === 'summoned' && pets.summonedKey === entityKey) {
    return { target: pets.summonedDisplay, inferredTarget: false }
  }
  if (disp === 'charmed' && pets.charmedKey === entityKey) {
    return { target: pets.charmedDisplay, inferredTarget: false }
  }
  if (entityKey === pets.petTargetKey) {
    return { target: pets.petTargetDisplay, inferredTarget: cls === 'debuff' }
  }
  if (entityKey === 'unknown-hostile') return { target: undefined, inferredTarget: true }
  // A cast-timing-inferred debuff target (no confirming message) is a best guess.
  return { target: pets.entityDisplayFor(entityKey), inferredTarget: cls === 'debuff' && !a.messageDriven }
}

/** The row's duration/estimate fields, from the per-spell mined stats + the DB prior. */
function durationFields(
  key: string,
  permanent: boolean,
  stats: SpellStats
): { estimatedMs: number | null; p25: number | null; p75: number | null; n: number; durationSource?: 'db' | 'observed' } {
  const st = stats.statFor(key)
  const est = stats.estimateFor(key)
  return {
    estimatedMs: permanent ? null : est.ms,
    p25: st?.p25 ?? null,
    p75: st?.p75 ?? null,
    n: st?.n ?? 0,
    ...(est.source && !permanent ? { durationSource: est.source } : {})
  }
}

export function buildActive(spec: ActiveSpec, stats: SpellStats, pets: PetEntities): ActiveBuff {
  const { spell, key, entityKey, startedTs, provisional, dispOverride, opts } = spec
  const cls = stats.classOf(key)
  const disp: EntityDisposition | undefined = dispOverride
  // A DEBUFF is never the player's own buff, even if cast-timing bound it to the self key
  // before its class was known (no DB, first cast): a debuff on 'self' really means "an
  // inferred hostile target we couldn't name yet" (Task #35). Present it as non-self.
  const self = entityKey === SELF_KEY && cls !== 'debuff'
  const messageDriven = opts?.messageDriven === true
  const { target, inferredTarget } = resolveTargetLabel({ entityKey, cls, self, disp, messageDriven }, pets)
  const permanent = opts?.permanent === true
  const d = durationFields(key, permanent, stats)
  return {
    spell,
    cls,
    self,
    disposition: disp,
    startedTs,
    estimatedMs: d.estimatedMs,
    p25: d.p25,
    p75: d.p75,
    n: d.n,
    target,
    ...(inferredTarget ? { inferredTarget: true } : {}),
    ...(provisional ? { provisional: true } : {}),
    ...(d.durationSource ? { durationSource: d.durationSource } : {}),
    ...(permanent ? { permanent: true } : {}),
    ...(messageDriven ? { messageDriven: true } : {})
  }
}
