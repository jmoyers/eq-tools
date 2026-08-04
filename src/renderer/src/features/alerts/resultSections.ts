// resultSections — the suggest dialog's row set, as a pure function.
//
// docs/plans/suggest-dialog-redesign.md §2: one filtered catalog becomes FIVE row groups, in
// this order — "From your fights" (everything the log has actually seen, in the catalog's own
// recency order), then Buffs · Debuffs · Illusions · Poisons for the rest. A row appears in
// exactly ONE group: an observed spell is listed where the observation is the point, and the
// type sections carry the tail the log has never shown you.
//
// THE ROW BUDGET IS THE PERF FIX'S INVARIANT, and it survives the sectioning. The dialog mounts
// at most MAX_ROWS memoized `SpellRow`s in total (never per section), because the whole reason
// the paper holds still is that the row count is bounded and the list scrolls inside a fixed
// height. Sections are filled IN ORDER until the budget runs out; each one reports its TRUE
// match count so a truncated section can say how many it is not showing rather than lie by
// omission. Collapsed sections mount nothing at all and hand their budget on.
//
// Pure + RELATIVE value imports (the mobSearch.ts precedent) so tests/spellSearch.test.mts can
// drive it over the REAL catalog with no vite alias.

import type { SpellCatalogEntry } from '@shared/types'
import type { AlertGroup } from '@shared/alertGroups'
import {
  SPELL_SECTIONS,
  SPELL_SECTION_LABEL,
  filterSpells,
  groupSpellSections,
  type SpellSearchToken,
  type SpellSection
} from '../../../../shared/spellSearch'

/** Most rows the dialog will mount at once — the perf fix's cap, now shared across sections. */
export const MAX_ROWS = 200

/** One rendered group: what it is called, what it shows, and how much it matched. */
export interface ResultSection {
  /** stable id — the collapse-state key. */
  id: SpellSection | 'fights'
  title: string
  /** the rows to mount (already capped). */
  rows: SpellCatalogEntry[]
  /** how many rows MATCHED — `rows.length` when nothing was cut. */
  total: number
}

export interface SuggestResults {
  /** "From your fights": the observed rows (usageCount > 0), catalog order = recency order. */
  fights: ResultSection
  /** Buffs · Debuffs · Illusions · Poisons, in that order. */
  sections: ResultSection[]
  /** total MATCHES across every group — 0 means the query found nothing at all. */
  matched: number
}

/**
 * Fill sections in order from a shared row budget. `collapsed` sections are skipped entirely
 * (they mount nothing), which is also what lets a user with everything collapsed but Poisons
 * see every poison rather than the tail of a spent budget.
 */
function capRows(
  groups: readonly { id: ResultSection['id']; title: string; all: SpellCatalogEntry[] }[],
  collapsed: ReadonlySet<string>,
  budget: number
): ResultSection[] {
  let left = budget
  return groups.map((g) => {
    if (collapsed.has(g.id)) return { id: g.id, title: g.title, rows: [], total: g.all.length }
    const rows = g.all.slice(0, Math.max(0, left))
    left -= rows.length
    return { id: g.id, title: g.title, rows, total: g.all.length }
  })
}

/**
 * The dialog's whole result set for one (catalog, query) pair.
 *
 * `tokens` is the DEFERRED query's tokens — never the raw one (that is the perf fix's rule: the
 * row subtree may never sit on a keystroke's critical path).
 */
export function buildSuggestResults(
  entries: readonly SpellCatalogEntry[],
  tokens: readonly SpellSearchToken[],
  collapsed: ReadonlySet<string> = new Set(),
  budget: number = MAX_ROWS
): SuggestResults {
  const matches = filterSpells(entries, tokens)
  const observed: SpellCatalogEntry[] = []
  const rest: SpellCatalogEntry[] = []
  for (const e of matches) (e.usageCount > 0 ? observed : rest).push(e)
  const bySection = groupSpellSections(rest)
  const capped = capRows(
    [
      { id: 'fights', title: 'From your fights', all: observed },
      ...SPELL_SECTIONS.map((id) => ({ id, title: SPELL_SECTION_LABEL[id], all: bySection[id] }))
    ],
    collapsed,
    budget
  )
  return { fights: capped[0], sections: capped.slice(1), matched: matches.length }
}

/**
 * The ready-made sets that survive the query. TEXT tokens only, matched against the set's own
 * words (title, subtitle, and each def's name + the verified log line it quotes) — so "range"
 * finds the out-of-range set the way "root" finds a root spell.
 *
 * A query carrying ANY spell-only token (`level:`, `class:`, `type:`, a bare number) hides the
 * section outright: those facets are statements about spells, and a set that matched them by
 * accident would be a wrong answer, not a bonus one.
 */
export function filterAlertGroups(
  groups: readonly AlertGroup[],
  tokens: readonly SpellSearchToken[]
): AlertGroup[] {
  if (tokens.length === 0) return [...groups]
  if (tokens.some((t) => t.kind !== 'text')) return []
  const texts = tokens.map((t) => (t.kind === 'text' ? t.text : ''))
  return groups.filter((g) => {
    const hay = [g.title, g.subtitle, ...g.defs.map((d) => `${d.name} ${d.line}`)]
      .join(' ')
      .toLowerCase()
    return texts.every((t) => hay.includes(t))
  })
}
