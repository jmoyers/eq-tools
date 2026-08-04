// lineIntel — the renderer's join for spell-LINE intelligence.
//
// Three inputs, all of which the app already carries; this file adds no IPC:
//   * the spell CATALOG (spells:catalog) — per line: the DB's rank names + per-class levels,
//   * the ALERTS module snapshot's `spellLastCast` — rank-preserving cast recency, kept live
//     by module deltas (a cast pushes a delta, so nothing here polls),
//   * the CLASS-COMBO snapshot — which classes are RESOLVED for the current loadout, so a
//     level chip can say "yours" instead of "one of these".
//
// Everything computational lives in shared/spellLines.ts (pure, tested); this is wiring plus
// the one piece of local state the feature owns — per-offer dismissals, kept in localStorage
// beside `eq.combat.scope` rather than in the electron-store schema, because a dismissed
// suggestion is a UI preference and adding a persisted shape would demand a store migration.

import { useCallback, useMemo, useState } from 'react'
import type { AlertDef, PoisonSlowRecency, SpellCatalog, SpellCatalogEntry } from '@shared/types'
import type { ClassAbbr } from '@shared/classCombo'
import { resolvedClasses } from '@shared/classCombo'
import {
  buildSpellLine,
  detectPoisonSlowOffers,
  detectRankUpgrades,
  spellLineKey,
  type ClassLevel,
  type PoisonSlowOffer,
  type RankUpgradeOffer,
  type SpellLine
} from '@shared/spellLines'
import { useComboSnap } from '../profiles/ClassComboData'

/**
 * localStorage key for offers the user waved away (session-independent, schema-free).
 *
 * ONE SET FOR EVERY OFFER STRIP. Offer ids are namespaced by construction (`upgrade:…`,
 * `offer:poison-slow`), so a second kind of offer needs no second key — and "I waved this
 * away" is one idea, not one per feature.
 */
const DISMISSED_KEY = 'eq.alerts.upgradeDismissed'

function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set()
  } catch {
    // A corrupt/absent value must never take the alerts view down — start clean.
    return new Set()
  }
}

/** The dismissal set + the one action that grows it, shared by every offer strip. */
export interface OfferDismissals {
  dismissed: Set<string>
  dismiss: (id: string) => void
}

/**
 * Per-offer dismissals. The write RE-READS storage and merges before saving, so two strips
 * holding their own copies of the set can never clobber each other's dismissals — the hook is
 * called once per strip, and only the merged write is authoritative.
 */
export function useOfferDismissals(): OfferDismissals {
  const [dismissed, setDismissed] = useState<Set<string>>(readDismissed)
  const dismiss = useCallback((id: string) => {
    const merged = readDismissed().add(id)
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...merged]))
    } catch {
      // Storage full/blocked: the dismissal still holds for this session.
    }
    setDismissed((prev) => new Set(prev).add(id))
  }, [])
  return { dismissed, dismiss }
}

/**
 * Build every LINE we know about: the DB's rank names per catalog row, UNIONED with every
 * rank display name actually observed cast. The union matters — the log casts
 * "Mesmerization III" where the DB holds only "Mesmerization", so a DB-only line model would
 * see no ranks at all for the spells you use most.
 */
export function buildLines(
  catalog: SpellCatalog | null,
  spellLastCast: Readonly<Record<string, number>>
): Map<string, SpellLine> {
  const names = new Map<string, string[]>()
  const push = (key: string, name: string): void => {
    const list = names.get(key)
    if (list) list.push(name)
    else names.set(key, [name])
  }
  // DB names first so their casing wins the dedupe in buildSpellLine.
  for (const e of catalog?.entries ?? []) {
    for (const name of e.rankNames ?? [e.name]) push(e.key, name)
  }
  for (const name of Object.keys(spellLastCast)) push(spellLineKey(name), name)
  const out = new Map<string, SpellLine>()
  for (const [key, list] of names) out.set(key, buildSpellLine(key, list, spellLastCast))
  return out
}

/** The lines, memoized on the two inputs that can change them. */
export function useSpellLines(
  catalog: SpellCatalog | null,
  spellLastCast: Readonly<Record<string, number>>
): Map<string, SpellLine> {
  return useMemo(() => buildLines(catalog, spellLastCast), [catalog, spellLastCast])
}

/**
 * The classes the combo module has RESOLVED for the CURRENT loadout (slots holding exactly
 * one candidate). Empty is the normal, honest state early on — a level chip then falls back
 * to the minimum across every class that can cast the line, flagged ambiguous.
 */
export function useResolvedClasses(): ClassAbbr[] {
  const combo = useComboSnap()
  return useMemo(() => (combo.current ? resolvedClasses(combo.current) : []), [combo])
}

/** One class-level chip: the DB fact, plus whether it is a class YOUR loadout resolved to. */
export interface ClassLevelChip extends ClassLevel {
  /** true when the combo module has RESOLVED this class for the current loadout. */
  yours: boolean
}

/**
 * The row's class-level chips, RESOLVED CLASSES FIRST (redesign §3), then by level.
 *
 * The compact row shows the first few and folds the rest into a "+N" chip, so the ordering is
 * load-bearing: the level that is actually yours must never be the one that got folded away.
 * Every chip states a DB fact for ONE class — which is why this replaced the old single
 * "min lvl N" chip: with the classes named, there is nothing left to be ambiguous about
 * (world-model law 1). Ranks within a line still have no level of their own; the tooltip says so.
 */
export function classLevelChips(
  entry: SpellCatalogEntry,
  resolved: readonly ClassAbbr[]
): ClassLevelChip[] {
  return (entry.classLevels ?? [])
    .map((c) => ({ ...c, yours: resolved.includes(c.cls) }))
    .sort((a, b) => Number(b.yours) - Number(a.yours) || a.level - b.level || a.cls.localeCompare(b.cls))
}

/** The upgrade-offer strip's state: the live offers plus the per-offer dismiss action. */
export interface UpgradeOffers {
  offers: RankUpgradeOffer[]
  dismiss: (id: string) => void
}

/**
 * Pending rank upgrades for the current alert set. Recomputes whenever the alert list or the
 * cast-recency map changes — i.e. on a save/delete and on the delta a new cast pushes. There
 * is no timer and no rewrite: an offer is only ever applied by a click.
 *
 * Lines are built from OBSERVED casts alone (no catalog): an upgrade is only ever about a rank
 * you have actually cast, so the spell DB's own rank list adds nothing here and the alerts view
 * never pays for a catalog fetch it does not need.
 */
export function useUpgradeOffers(
  alerts: readonly AlertDef[],
  spellLastCast: Readonly<Record<string, number>>
): UpgradeOffers {
  const lines = useSpellLines(null, spellLastCast)
  const { dismissed, dismiss } = useOfferDismissals()

  const offers = useMemo(
    () => detectRankUpgrades(alerts, [...lines.values()]).filter((o) => !dismissed.has(o.id)),
    [alerts, lines, dismissed]
  )

  return { offers, dismiss }
}

/** The poison-slow offer strip's state: the live offer (0 or 1) plus its dismiss action. */
export interface PoisonSlowOffers {
  offers: PoisonSlowOffer[]
  dismiss: (id: string) => void
}

/**
 * The observed-driven "a rogue is slowing your mobs — want an alert?" offer.
 *
 * Same shape and same rules as the upgrade strip: pure detection in shared/, dismissal in the
 * SAME localStorage set (offer ids are namespaced), recompute driven by the alerts module's
 * own delta — the module flushes the moment a slow lands, so nothing here polls and nothing
 * waits for a re-hydration.
 */
export function usePoisonSlowOffers(
  alerts: readonly AlertDef[],
  poisonSlowSeen: PoisonSlowRecency | null | undefined
): PoisonSlowOffers {
  const { dismissed, dismiss } = useOfferDismissals()
  const offers = useMemo(
    () => detectPoisonSlowOffers(alerts, poisonSlowSeen).filter((o) => !dismissed.has(o.id)),
    [alerts, poisonSlowSeen, dismissed]
  )
  return { offers, dismiss }
}
