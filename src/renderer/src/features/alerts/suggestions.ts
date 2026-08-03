// Suggested-alert templates + id convention (Task #38).
//
// The ONE place that maps a spell (catalog entry) → the exact AlertDef a one-click
// suggestion authors. Kept separate from the dialog so the id convention is a single source
// of truth: the wizard uses it to build defs AND to detect already-created suggestions
// (checked/disabled), and AGENTS.md documents it.
//
// ID CONVENTION:  `suggest:<spellKey>:<template>`
//   spellKey = the catalog entry's canonical (lowercased, rank-stripped) key.
//   template ∈ 'wearsOff' | 'fade' | 'lands'.
//   Illusion is the SHARED, deduped suggestion `suggest:illusion:fade` (one alert for the
//   generic `Your illusion fades.` line, which names no spell — see logEvents.ts IllusionFade).
//
// Each template's trigger was validated to actually fire in the AlertsModule against a
// matching synthetic LogEvent (scripts/_task38_harness.mts): the `where.spell` matcher tests
// the event's `spell` field case-insensitively; illusionFade carries no spell field, so its
// suggestion has no `where`.

import type { AlertDef, LogEventKind, SpellCatalogEntry } from '@shared/types'
import { spellIdFragment, type SpellRank } from '@shared/spellLines'

export type TemplateKind = 'wearsOff' | 'fade' | 'lands'

/**
 * RANK-AWARE templates (spell levelling intelligence). Everything above is rank-LESS by
 * construction: the fade / wears-off / landing lines the parser matches drop the roman-numeral
 * suffix, so an alert on them survives every rank change untouched. Two families keep the
 * suffix, and those are the ones worth pinning to a rank — and the ones the upgrade offers
 * exist for:
 *   castRank   `You begin casting Mesmerization III.`      → castBegin { spell }
 *   resistRank `<mob> resisted your Mesmerization III!`     → resist { caster:'you', spell }
 * Both shapes were verified against the real log (359 and 136 occurrences for that one rank).
 */
export type RankTemplateKind = 'castRank' | 'resistRank'

/** UI + authoring metadata for each template. */
export const SUGGEST_TEMPLATES: Record<
  TemplateKind,
  { chip: string; kind: LogEventKind; verb: string; sound: string; where?: (name: string) => Record<string, string> }
> = {
  // Beneficial: the DUAL-DEFAULT expiry (Task #47). The user's directive — "the wears off for
  // you is different than for somebody else … build good sane defaults that help with both by
  // default." The buffs module emits a RESOLVED `buffExpired { spell, target }` for BOTH sides:
  // a self message wears-off (target 'self') AND a fade on your pet/target (target = its name).
  // So ONE simple trigger `{buffExpired, where:{spell}}` (target omitted → matches any) fires
  // whether the buff wears off YOU or your pet — the sane both-sides default, no composite
  // needed for this template. (The composite machinery still ships for user-authored combos.)
  wearsOff: {
    chip: 'When it wears off (you or your pet)',
    kind: 'buffExpired',
    verb: 'wears off',
    // "A moment of your time, if you'd be so kind."
    sound: 'input-required-input-required-01',
    where: (name) => ({ spell: name })
  },
  // Beneficial: JUST the pet/named-target fade side (target-only), for users who want to
  // separate it from the self-side. Uses the raw buffFade the parser already emits.
  // "That, as they say, is that."
  fade: {
    chip: 'When it fades on pet/target only',
    kind: 'buffFade',
    verb: 'fades',
    sound: 'resource-limit-resource-limit-09',
    where: (name) => ({ spell: name })
  },
  // Detrimental + cast-on-other: the debuff landing on a target.
  // "Consider this my opening move."
  lands: {
    chip: 'When it lands on a target',
    kind: 'buffApply',
    verb: 'lands',
    sound: 'task-acknowledge-task-acknowledge-05',
    where: (name) => ({ spell: name })
  }
}

/** UI metadata for the two rank-pinned templates. `chip` takes the rank display name. */
export const RANK_TEMPLATES: Record<
  RankTemplateKind,
  { chip: (rank: string) => string; kind: LogEventKind; verb: string; sound: string }
> = {
  castRank: {
    chip: (rank) => `When you cast ${rank}`,
    kind: 'castBegin',
    verb: 'cast',
    // "Consider this my opening move."
    sound: 'task-acknowledge-task-acknowledge-05'
  },
  resistRank: {
    chip: (rank) => `When ${rank} is resisted`,
    kind: 'resist',
    verb: 'resisted',
    // a dry error read — it was shrugged off.
    sound: 'task-error-task-error-01'
  }
}

/** A concrete suggestion: the template it came from + the exact AlertDef it authors. */
export interface Suggestion {
  template: TemplateKind | RankTemplateKind | 'illusion'
  def: AlertDef
  /** the rank display name a rank-pinned suggestion targets (absent for rank-less ones). */
  rank?: string
}

/**
 * The default sound pack — the ONE pack the app ships, the pack every picker
 * pre-selects (AlertsView), and the pack the seeded built-ins + these suggestions use.
 * Mirrors DEFAULT_ALERT_PACK_ID / DEFAULT_ALERT_SOUNDS in src/main/data/defaultPacks.ts
 * — repeated as literals because the renderer bundle can't import from src/main. Keep
 * the two in sync (the ids there carry the spoken line each one is).
 */
export const DEFAULT_PACK_ID = 'alan-rickman'
/** Default cooldown for a suggested alert (ms). */
const DEFAULT_COOLDOWN_MS = 3000

function suggestionId(spellKey: string, template: TemplateKind): string {
  return `suggest:${spellKey}:${template}`
}

/** Build the AlertDef for one (spell, template) pair. */
function buildDef(entry: SpellCatalogEntry, template: TemplateKind): AlertDef {
  const t = SUGGEST_TEMPLATES[template]
  const where = t.where ? t.where(entry.name) : undefined
  return {
    id: suggestionId(entry.key, template),
    name: `${entry.name} ${t.verb}`,
    enabled: true,
    trigger: { type: 'event', kind: t.kind, where },
    sound: { packId: DEFAULT_PACK_ID, soundId: t.sound },
    cooldownMs: DEFAULT_COOLDOWN_MS,
    note: `Suggested alert (Task #38/#47) — ${template} for ${entry.name}.`
  }
}

/**
 * Build the AlertDef for one (rank, rank-template) pair. The trigger pins the DISPLAY name
 * with its suffix, which is exactly what makes the def go stale on a level-up — and exactly
 * what `detectRankUpgrades` (shared/spellLines.ts) looks for.
 */
function buildRankDef(entry: SpellCatalogEntry, rank: string, template: RankTemplateKind): AlertDef {
  const t = RANK_TEMPLATES[template]
  // resist carries a caster field: pin it to YOUR casts so a pet's or a bystander's resist of
  // the same spell never fires the alert (the parser sets caster='you' for your own — Task #51).
  const where: Record<string, string> =
    template === 'resistRank' ? { caster: 'you', spell: rank } : { spell: rank }
  return {
    id: `suggest:${entry.key}:${template}:${spellIdFragment(rank)}`,
    name: `${rank} ${t.verb}`,
    enabled: true,
    trigger: { type: 'event', kind: t.kind, where },
    sound: { packId: DEFAULT_PACK_ID, soundId: t.sound },
    cooldownMs: DEFAULT_COOLDOWN_MS,
    note: `Suggested alert — ${template} for ${rank}.`
  }
}

/**
 * All suggestions the spell DB supports for this catalog entry (excludes the shared illusion
 * one). When a `rank` is supplied — the MOST RECENTLY CAST rank of the entry's line, per the
 * owner's ordering rule — the two rank-pinned templates are offered as well.
 */
export function suggestionsFor(entry: SpellCatalogEntry, rank?: SpellRank | null): Suggestion[] {
  const out: Suggestion[] = []
  if (entry.templates.wearsOff) out.push({ template: 'wearsOff', def: buildDef(entry, 'wearsOff') })
  if (entry.templates.fade) out.push({ template: 'fade', def: buildDef(entry, 'fade') })
  if (entry.templates.lands) out.push({ template: 'lands', def: buildDef(entry, 'lands') })
  // Rank-pinned chips are offered only for a rank we have actually SEEN cast: a rank the log
  // has never printed cannot be confirmed to exist for this character, and an alert on a
  // spelling we guessed would sit there silently forever.
  if (rank?.lastCastMs != null) {
    out.push({ template: 'castRank', rank: rank.name, def: buildRankDef(entry, rank.name, 'castRank') })
    if (entry.spellType === 'Detrimental') {
      out.push({
        template: 'resistRank',
        rank: rank.name,
        def: buildRankDef(entry, rank.name, 'resistRank')
      })
    }
  }
  return out
}

/** The single, shared illusion-fade suggestion (deduped — one alert for any illusion). */
export function illusionSuggestion(): Suggestion {
  return {
    template: 'illusion',
    def: {
      id: 'suggest:illusion:fade',
      name: 'Illusion fades',
      enabled: true,
      trigger: { type: 'event', kind: 'illusionFade' },
      // "It has all gone rather pear-shaped."
      sound: { packId: DEFAULT_PACK_ID, soundId: 'task-error-task-error-08' },
      cooldownMs: DEFAULT_COOLDOWN_MS,
      note: 'Suggested alert (Task #38) — fires when your illusion clicks/wears off.'
    }
  }
}
