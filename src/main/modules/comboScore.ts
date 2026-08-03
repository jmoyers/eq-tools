// SCORING for the class-combo model (docs/plans/class-combo-inference.md § 4.2–4.4).
//
// PURE: observations in, slots out. No Electron, no log, no I/O — which is what makes the
// golden windows in tests/comboWindows.test.mts possible.
//
// WHAT DOES NOT WORK, measured, so nobody re-tries it: ranking classes by how often they are
// named. A frequency model run against all 11 `/who` anchors returns ENC for EVERY window
// (`ENC:264.7 BST:46.8 SHM:22.8 PAL:21.1` against a truth of PAL/MNK/ENC) because this player
// casts ENC spells constantly and every shared heal props BST/SHM/DRU up. Volume is not truth.
//
// WHAT DOES WORK: presence · exclusivity · sustain, over DISTINCT LABELS.
//   exclusive(c)  distinct labels whose candidate set is exactly {c}
//   support(c)    Σ over distinct labels naming c of weight / |candidates|
//   sustain(c)    distinct 1-hour buckets holding any evidence for c
// 177 Backstab skill-ups count ONCE for "ROG is present"; what earns a second point is a
// DIFFERENT rogue label. That is the whole fix.
//
// AND THE MODEL SAYS "I DON'T KNOW" OUT LOUD. A slot that resolves holds one candidate; a slot
// the evidence can only narrow to {CLR,PAL} holds both (measured: CLR is NEVER exclusively
// evidenced in this log — Reckless Strength, Wrath, Smite, Furor, Center, Courage, Daring,
// Stun and Holy Armor are all {CLR,PAL}); a slot with nothing behind it holds all 16 at
// confidence 0. World-model law 1: never silently guess.

import {
  CLASS_ABBRS,
  type ClassAbbr,
  type ClassObservation,
  type ComboSlot
} from '../../shared/classCombo'

const HOUR_MS = 3_600_000

/** A class's standing in one window. */
export interface ClassScore {
  cls: ClassAbbr
  exclusive: number
  support: number
  sustain: number
  /** the distinct labels naming it, strongest source first — the slot's `because`. */
  labels: string[]
}

/** A distinct label, folded across every occurrence of it in the window. */
interface LabelFold {
  key: string
  display: string
  candidates: ClassAbbr[]
  weight: number
  buckets: Set<number>
}

/** Fold observations into DISTINCT labels. `source:label` is the key — a stance and a spell
 *  may share a word, and they are not the same evidence. */
function foldLabels(observations: readonly ClassObservation[]): LabelFold[] {
  const byKey = new Map<string, LabelFold>()
  for (const o of observations) {
    if (o.source === 'who') continue // /who overrides, it never scores (§ 4.4)
    const key = `${o.source}:${o.label}`
    const seen = byKey.get(key)
    if (seen) {
      seen.buckets.add(Math.floor(o.ts / HOUR_MS))
      continue
    }
    byKey.set(key, {
      key,
      display: `${o.source === 'skillUp' ? 'skill' : o.source}:${o.label}`,
      candidates: o.candidates,
      weight: o.weight,
      buckets: new Set([Math.floor(o.ts / HOUR_MS)])
    })
  }
  return [...byKey.values()]
}

/** Per-class exclusivity / support / sustain over a window's observations. */
export function scoreClasses(observations: readonly ClassObservation[]): Map<ClassAbbr, ClassScore> {
  const scores = new Map<ClassAbbr, ClassScore>()
  const buckets = new Map<ClassAbbr, Set<number>>()
  for (const fold of foldLabels(observations)) {
    for (const cls of fold.candidates) {
      const s = scores.get(cls) ?? { cls, exclusive: 0, support: 0, sustain: 0, labels: [] }
      if (fold.candidates.length === 1) s.exclusive += 1
      s.support += fold.weight / fold.candidates.length
      s.labels.push(fold.display)
      scores.set(cls, s)
      const b = buckets.get(cls) ?? new Set<number>()
      for (const bucket of fold.buckets) b.add(bucket)
      buckets.set(cls, b)
    }
  }
  for (const [cls, s] of scores) s.sustain = buckets.get(cls)?.size ?? 0
  return scores
}

/** Admission ranking: exclusivity first, support as the tie-break. Deterministic (code last). */
function byStrength(a: ClassScore, b: ClassScore): number {
  return b.exclusive - a.exclusive || b.support - a.support || a.cls.localeCompare(b.cls)
}

/**
 * The classes ADMITTED to the combo: at least one exclusive label AND evidence in at least two
 * hourly buckets, strongest first, capped at `expectedSlots`.
 *
 * `sustain >= 2` alone is NOT what rejects item clickies — wave 1 measured that post-swap ENC
 * clears it comfortably. Clicky rejection happens upstream, at intake (comboEvidence.ts). This
 * clause still earns its place: it rejects a class named by one exclusive label inside a single
 * hour, which is what a genuinely stray observation looks like.
 */
export function admitted(
  scores: ReadonlyMap<ClassAbbr, ClassScore>,
  expectedSlots: number
): ClassScore[] {
  return [...scores.values()]
    .filter((s) => s.exclusive >= 1 && s.sustain >= 2)
    .sort(byStrength)
    .slice(0, expectedSlots)
}

/** § 4.3's ladder, for a slot resolved by inference. */
function resolvedConfidence(s: ClassScore): number {
  if (s.exclusive >= 2) return 0.9
  return s.sustain >= 3 ? 0.75 : 0.5
}

/** An AMBIGUOUS cluster: labels that name none of the admitted classes, intersected. */
interface Cluster {
  candidates: ClassAbbr[]
  support: number
  labels: string[]
}

/**
 * Residual clustering (§ 4.3 step 2). Labels already explained by an admitted class are
 * dropped — a {CLR,PAL} cast with PAL admitted explains itself and yields NO new slot. What is
 * left is grouped by EXACT candidate set and ranked by total support.
 *
 * DELIBERATE DEVIATION from the design, which said to intersect overlapping clusters greedily.
 * INTERSECTION CAN EXCLUDE THE TRUTH, and it did: on the `[7 CLR/BER]` window it folded a
 * `defensive` stance {PAL,SHD,WAR} into the {CLR,PAL} casts and produced {PAL,SHD} — a slot
 * that does not contain the class the `/who` row names. The flaw is in the premise, not the
 * code: two shared labels need not describe the SAME slot, so intersecting them is not a
 * narrowing, it is an assumption. Grouping by exact set can never remove a candidate that some
 * single piece of evidence did not already remove. The one safe fold is kept — a BROADER group
 * whose set contains a stronger group's is consistent with it and lends it support.
 */
function clusterResidual(folds: LabelFold[], admittedSet: ReadonlySet<ClassAbbr>): Cluster[] {
  const groups = new Map<string, Cluster>()
  // A residual EXCLUSIVE label is a class that FAILED admission — one stray `Rampage I` cast in
  // one hour. It gets no slot and no group: letting it seed one would resolve through the back
  // door exactly the class the admission rule just refused.
  const residual = folds.filter(
    (f) => f.candidates.length >= 2 && !f.candidates.some((c) => admittedSet.has(c))
  )
  for (const fold of residual) {
    const key = fold.candidates.join('|')
    const group = groups.get(key)
    if (group) {
      group.support += fold.weight / fold.candidates.length
      group.labels.push(fold.display)
    } else {
      groups.set(key, {
        candidates: [...fold.candidates],
        support: fold.weight / fold.candidates.length,
        labels: [fold.display]
      })
    }
  }
  const ranked = [...groups.values()].sort((a, b) => b.support - a.support)
  return ranked.filter((group, i) => {
    const stronger = ranked.find((g, j) => j < i && g.candidates.every((c) => group.candidates.includes(c)))
    if (!stronger) return true
    stronger.support += group.support
    stronger.labels.push(...group.labels)
    return false
  })
}

/** An explicit UNKNOWN slot: all 16 candidates, zero confidence, no story. Never a guess. */
export function unknownSlot(): ComboSlot {
  return { candidates: [...CLASS_ABBRS], confidence: 0, provenance: 'inferred', because: [] }
}

/** A slot the log (or the user) STATED: resolved, confidence 1.0, no inference involved. */
export function statedSlots(
  classes: readonly ClassAbbr[],
  provenance: 'who' | 'user'
): ComboSlot[] {
  return classes.map((c) => ({
    candidates: [c],
    confidence: 1,
    provenance,
    because: [provenance]
  }))
}

/**
 * Observations → slots (§ 4.2–4.3). Always returns exactly `expectedSlots` entries: admitted
 * classes first, then ambiguous clusters, then explicit unknowns. Shorter is never returned —
 * "we found two of three" is a statement the UI has to be able to make.
 */
export function scoreSlots(
  observations: readonly ClassObservation[],
  expectedSlots: number
): ComboSlot[] {
  const scores = scoreClasses(observations)
  const admit = admitted(scores, expectedSlots)
  const slots: ComboSlot[] = admit.map((s) => ({
    candidates: [s.cls],
    confidence: resolvedConfidence(s),
    provenance: 'inferred',
    because: s.labels.slice(0, 8)
  }))
  const admittedSet = new Set(admit.map((s) => s.cls))
  for (const cluster of clusterResidual(foldLabels(observations), admittedSet)) {
    if (slots.length >= expectedSlots) break
    if (cluster.candidates.length === 0) continue
    slots.push({
      candidates: [...cluster.candidates].sort(),
      // "we know the SET, not the member" — a two-way ambiguity is worth 0.3, not 0.6.
      confidence: 0.6 / cluster.candidates.length,
      provenance: 'inferred',
      because: cluster.labels.slice(0, 8)
    })
  }
  while (slots.length < expectedSlots) slots.push(unknownSlot())
  return slots.slice(0, expectedSlots)
}
