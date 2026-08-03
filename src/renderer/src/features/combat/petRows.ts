// PET NESTING — a PRESENTATION regrouping of the snapshot's existing source rows. No JSX, no
// MUI, no engine involvement: the snapshot is still pulled with `combinePets: false`, so the
// engine hands us YOU and each PET as separate, authoritative `SourceView`s and this module
// only decides how they are LAID OUT.
//
// WHY (owner direction, 2026-08-03): the game is mostly played solo, so "your damage" and "the
// pet's damage" are two rows of a two-row meter and the interesting list is one level down. The
// default view is therefore YOUR breakdown with the pet as ONE line item inside it, drillable to
// the pet's own skills. A preference ('Combine pet into your damage') turns the nesting off and
// restores today's separate sources.
//
// HONESTY (world-model law 4 — "pet" is presentation, never a data-model class; law 5 —
// aggregates lie, derive from identities):
//   - The pet row is labelled with the pet's REAL display name off its own source row. It is
//     never a coined label ("Pet"), and it is never folded into one of YOUR skill lanes: your
//     per-skill numbers stay exactly the engine's, and the pet's total sits BESIDE them as its
//     own row. Nothing here adds a point of pet damage to a row of yours.
//   - The engine's own `combinePets` fold is a DIFFERENT thing (it merges the pet's lanes into
//     a synthetic "You +pets" source with namespaced skill names). This module deliberately does
//     not use it: one line item that drills is what the owner asked for, not a merged lane list.
//   - `total` here is self + nested pets, which is exactly `SegmentView.outTotal` whenever the
//     only outgoing sources are you and your pets (they are, by construction — the aggregate
//     keys outgoing damage as 'you' or 'pet:<id>'). Every surface that shows a combined headline
//     reads `outTotal`, so the two can't drift.

import { flattenSkills, type SkillRow } from './dashboardData'
import type { SourceView } from '@shared/combat'

/** The synthetic line item that stands for ONE pet inside your breakdown. */
export interface PetRow {
  /** `SourceView.id` of the pet — what a drill hands `setDrill({ kind: 'entity', … })`. */
  id: string
  /** the pet's real display name, straight off its source row. */
  name: string
  total: number
  dps: number
  hits: number
  crits: number
  misses: number
  resists: number
}

/**
 * One row of the combined "your damage" list: either a real skill lane of YOURS, or the
 * synthetic aggregate for one pet. `total`/`pct` are lifted to the union so the two kinds sort
 * and size against each other without the caller having to know which it is holding.
 */
export type OwnRow =
  | { kind: 'skill'; total: number; pct: number; skill: SkillRow }
  | { kind: 'pet'; total: number; pct: number; pet: PetRow }

export interface OwnBreakdown {
  /** your source row, or null when this segment has none (a segment with no outgoing damage). */
  self: SourceView | null
  /** the pet sources nested into `rows` — empty when the preference is off, or petless. */
  pets: SourceView[]
  /** your skill lanes + one row per nested pet, ranked by damage desc. */
  rows: OwnRow[]
  /** self + nested pets. Equals `SegmentView.outTotal` for the combined case (see the header). */
  total: number
}

/** Your own source row. Keyed on `kind`, never on the aggregate's 'you' key — the id is the
 *  engine's business and the kind is the model's. */
export function selfSource(entities: SourceView[]): SourceView | null {
  return entities.find((e) => e.kind === 'you') ?? null
}

/** Every pet source in this segment (there is usually exactly one — the single-pet invariant
 *  retires the prior pet — but a segment spanning two pets legitimately carries both). */
export function petSources(entities: SourceView[]): SourceView[] {
  return entities.filter((e) => e.kind === 'pet')
}

function toPetRow(p: SourceView): PetRow {
  return {
    id: p.id,
    name: p.name,
    total: p.total,
    dps: p.dps,
    hits: p.hits,
    crits: p.crits,
    misses: p.misses,
    resists: p.resists
  }
}

function rowLabel(r: OwnRow): string {
  return r.kind === 'pet' ? r.pet.name : r.skill.name
}

/**
 * ONE source's flat skill list with `pets` nested into it as line items, ranked together.
 * Pass no pets and this is exactly `flattenSkills` — which is what a drill into the PET itself
 * (or into any non-self source) uses, so there is one row builder for every level-2 list.
 *
 * Bar widths are re-based on the MERGED maximum — the pet is often the largest row, and a list
 * where two rows both render full-width would be lying about the ranking. A grouped row's
 * children keep their own (group-relative) pct: that expansion is its own ranking.
 */
export function nestedRows(source: SourceView | null, pets: SourceView[]): OwnRow[] {
  const skills: OwnRow[] = source
    ? flattenSkills(source).map((s) => ({ kind: 'skill' as const, total: s.total, pct: 0, skill: s }))
    : []
  const petRows: OwnRow[] = pets.map((p) => ({ kind: 'pet' as const, total: p.total, pct: 0, pet: toPetRow(p) }))
  const merged = [...skills, ...petRows].sort((a, b) => b.total - a.total || rowLabel(a).localeCompare(rowLabel(b)))
  const max = Math.max(1, ...merged.map((r) => r.total))
  return merged.map((r) => {
    const pct = (r.total / max) * 100
    return r.kind === 'skill' ? { ...r, pct, skill: { ...r.skill, pct } } : { ...r, pct }
  })
}

/**
 * YOUR breakdown for a whole segment: your skill lanes with every pet nested in. `combine` off
 * ⇒ pets are left out entirely (they stay separate source rows at level 1, exactly as today).
 */
export function ownBreakdown(entities: SourceView[], combine: boolean): OwnBreakdown {
  const self = selfSource(entities)
  const pets = combine ? petSources(entities) : []
  return {
    self,
    pets,
    rows: nestedRows(self, pets),
    total: (self?.total ?? 0) + pets.reduce((n, p) => n + p.total, 0)
  }
}
