// Spell database load + derived lookup tables (Task #34).
//
// Loads the committed src/main/data/spells.json (scraped from the wiki's
// Template:Spellpage — see scripts/scrape-spells.ts) and builds the message→spell lookup
// tables the parser uses to emit PRECISE, message-driven buff events:
//
//   msgCastOnYou  ("A cool breeze slips through your mind.")  → buffApply { spell, self }
//   msgCastOnOther ("Someone looks tranquil." → "<Name> looks tranquil.") → buffApply { spell, target }
//   msgWearsOff   ("The cool breeze fades.")                  → buffWearOff { spell, self }
//
// The cast-on-other wiki text names the subject as "Someone" (e.g. "Someone looks
// tranquil."); the LOG names the actual target ("a froglok looks tranquil."). So the
// cast-on-other table is keyed by the SUFFIX after stripping the leading "Someone "/name,
// and the parser recovers the target from the matched prefix.
//
// AMBIGUITY: several spells share a landing/wears-off message (e.g. "You feel much faster."
// is Alacrity/Celerity/Quickness/Swift; "You feel armored." is 7 shielding spells). Rank
// variants also share their message ("A cool breeze slips through your mind." is Clarity +
// several others). So the tables map a message to ALL its candidate spells — the buffs
// module resolves an ambiguous apply against the player's own recent cast history (which of
// the candidates they actually cast). A message with a single candidate is unambiguous.
//
// This module is loaded in MAIN at startup and injected into the parser via the ruleset
// config path (installSpellDb → getParserConfig().spellDb), preserving parser purity: a
// profile with no DB installed emits none of the new events and works exactly as before.

import type { SpellCatalog, SpellCatalogEntry, SpellDbFile, SpellEntry } from '../../shared/types'
// Import the committed catalog directly so it's BUNDLED into the main build (electron-vite
// inlines JSON imports). A readFileSync from a path relative to import.meta.url would look
// beside out/main/index.js in production, where the JSON isn't copied — so import it.
import spellsJson from './spells.json'

/** The derived, message-driven lookup tables the parser consumes. Each message maps to
 *  the LIST of candidate spells sharing it (length 1 when unambiguous). */
export interface SpellDb {
  /** All spells, keyed by canonical (lowercased, rank-stripped) name. */
  byKey: Map<string, SpellEntry>
  /** msgCastOnYou text → candidate spells (self landing message). */
  castOnYou: Map<string, SpellEntry[]>
  /** msgWearsOff text → candidate spells (buff-fade message). */
  wearsOff: Map<string, SpellEntry[]>
  /**
   * cast-on-other SUFFIX → candidate spells. The suffix is the wiki msg_cast_on_other with
   * a leading "Someone " (or "Someone's "/"Someone 's ") stripped — the invariant tail
   * ("looks tranquil.", "'s face contorts …") that follows whatever the log names the
   * target. Matched by testing whether a log line ENDS WITH the suffix.
   */
  castOnOtherSuffix: Map<string, SpellEntry[]>
  /** The raw spell list (for stats / diagnostics). */
  spells: SpellEntry[]
}

/** Rank tail (mirrors parser.spellCanonKey — kept local to avoid a cycle). */
const RANK_TAIL_RE = / (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$/i
function canonKey(name: string): string {
  return name.trim().replace(RANK_TAIL_RE, '').trim().toLowerCase()
}

/**
 * The invariant SUFFIX of a cast-on-other message: strip the leading subject token the
 * wiki uses ("Someone", possibly with a stray "'s"/" 's") so the remainder is what
 * follows the (log-named) target. Returns null when the message has no usable suffix.
 *   "Someone looks tranquil."                 → "looks tranquil."
 *   "Someone 's face contorts and stretches…" → "'s face contorts and stretches…"  (kept
 *                                                so "<Name>'s face …" still ends with it)
 */
export function castOnOtherSuffix(msg: string): string | null {
  const m = msg.trim()
  // "Someone 's ..." (wiki's spaced possessive) → keep the "'s ..." so a real "<Name>'s"
  // line still matches on the suffix. "Someone looks ..." → drop "Someone ".
  const spaced = /^Someone\s+'s\b(.*)$/i.exec(m)
  if (spaced) return ("'s" + spaced[1]).trim()
  const poss = /^Someone's\b(.*)$/i.exec(m)
  if (poss) return ("'s" + poss[1]).trim()
  const lead = /^Someone\s+(.*)$/i.exec(m)
  if (lead) return lead[1].trim()
  return null
}

/** Add a spell to a message→candidates multimap, de-duping identical names. */
function pushCandidate(map: Map<string, SpellEntry[]>, msg: string, s: SpellEntry): void {
  const list = map.get(msg)
  if (!list) {
    map.set(msg, [s])
    return
  }
  // De-dupe same-named entries (rank variants of the same base spell) so a burst apply
  // doesn't see the "same" spell N times; keep the first (canonical) occurrence.
  if (!list.some((e) => canonKey(e.name) === canonKey(s.name))) list.push(s)
}

/** Build the derived lookup tables from a spell list. Each message maps to ALL candidates
 *  sharing it; the buffs module resolves an ambiguous apply via cast history. */
export function buildSpellDb(spells: SpellEntry[]): SpellDb {
  const byKey = new Map<string, SpellEntry>()
  const castOnYou = new Map<string, SpellEntry[]>()
  const wearsOff = new Map<string, SpellEntry[]>()
  const castOnOtherSuffixMap = new Map<string, SpellEntry[]>()
  for (const s of spells) {
    const key = canonKey(s.name)
    if (!byKey.has(key)) byKey.set(key, s)
    if (s.msgCastOnYou) pushCandidate(castOnYou, s.msgCastOnYou, s)
    if (s.msgWearsOff) pushCandidate(wearsOff, s.msgWearsOff, s)
    if (s.msgCastOnOther) {
      const suf = castOnOtherSuffix(s.msgCastOnOther)
      if (suf) pushCandidate(castOnOtherSuffixMap, suf, s)
    }
  }
  return { byKey, castOnYou, wearsOff, castOnOtherSuffix: castOnOtherSuffixMap, spells }
}

/**
 * Build the slim, searchable spell catalog for the suggested-alerts wizard (Task #38).
 * Derived from the effective DB (spells.json + overlay corrections already applied to `db`),
 * with per-spell live usage folded in from `usage` (the buffs module's snapshot stats `n`,
 * keyed by canonical spell key).
 *
 * A spell earns a template flag ONLY when the DB has the field the parser needs for that
 * template's event to fire — so the wizard never offers an alert that can't actually trigger:
 *   - wearsOff : Beneficial AND msgWearsOff present → buffWearOff{spell} fires.
 *   - fade     : Beneficial (any) → buffFade{spell} fires (pet/named-target fades).
 *   - lands    : Detrimental AND msgCastOnOther present → buffApply{spell} fires (cast-on-other).
 * Illusion spells additionally get the shared illusion-fade suggestion (deduped in the UI).
 * A spell with NO template and no illusion flag is dropped (nothing to suggest for it).
 */
export function buildSpellCatalog(db: SpellDb, usage: Map<string, number>): SpellCatalog {
  const entries: SpellCatalogEntry[] = []
  let hasIllusions = false
  for (const [key, s] of db.byKey) {
    const beneficial = s.spellType === 'Beneficial'
    const detrimental = s.spellType === 'Detrimental'
    const templates = {
      wearsOff: beneficial && !!s.msgWearsOff,
      fade: beneficial,
      lands: detrimental && !!s.msgCastOnOther
    }
    if (s.illusion) hasIllusions = true
    // Nothing to suggest for a spell with no template and not an illusion — skip it.
    if (!templates.wearsOff && !templates.fade && !templates.lands && !s.illusion) continue
    entries.push({
      key,
      name: s.name,
      spellType: s.spellType,
      illusion: s.illusion,
      templates,
      usageCount: usage.get(key) ?? 0
    })
  }
  // Sort frequent-first (usage desc), then alphabetical — the wizard's default order.
  entries.sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name))
  const withUsage = entries.reduce((n, e) => n + (e.usageCount > 0 ? 1 : 0), 0)
  return { entries, total: db.byKey.size, withUsage, hasIllusions }
}

let cached: SpellDb | null = null

/** Load + build the spell DB (cached) from the bundled spells.json. */
export function loadSpellDb(): SpellDb {
  if (cached) return cached
  const file = spellsJson as SpellDbFile
  cached = buildSpellDb(file.spells)
  return cached
}

/**
 * Apply observed-message-overlay corrections to the DB's cast-on-you table (Task #36) — the
 * EFFECTIVE DB (spells.json + overlay, overlay WINS). For each VERIFIED / CONTRADICTS-WIKI
 * landing message the overlay learned, register that exact text → the observed spell, so the
 * parser recognizes a self-landing line the wiki got wrong or omitted (e.g. Symbol of
 * Pinzarn's real "The symbol of Pinzarn flashes before your eyes.", whose wiki
 * msg_cast_on_you is inaccurate). Additive + idempotent: an existing correct mapping is left
 * alone; a contradiction REPLACES the message's candidates with the observed spell (overlay
 * wins). Unknown/shared messages contribute nothing (a shared message can't name a spell).
 */
export function applyOverlayCorrections(
  db: SpellDb,
  corrections: Map<string, { spell: string; contradicts?: string }>
): number {
  let applied = 0
  for (const [text, corr] of corrections) {
    const spell = db.byKey.get(canonKey(corr.spell))
    if (!spell) continue
    // A cast-on-YOU landing message is a BENEFICIAL-buff signal (a detrimental spell the
    // player casts lands on a MOB, not on themselves). A "correction" pointing at a
    // Detrimental spell is a mining false positive (the self line coincided with a debuff
    // cast); never let it override the DB. Skip it.
    if (spell.spellType === 'Detrimental') continue
    const existing = db.castOnYou.get(text)
    if (corr.contradicts) {
      // Wiki contradiction: the observed line really means THIS spell — override.
      db.castOnYou.set(text, [spell])
      applied++
    } else if (!existing) {
      // A verified landing message the DB didn't have — fill the gap.
      db.castOnYou.set(text, [spell])
      applied++
    } else if (!existing.some((e) => canonKey(e.name) === canonKey(spell.name))) {
      // The DB maps this text to other spells too; add ours as a candidate.
      existing.push(spell)
      applied++
    }
  }
  return applied
}
