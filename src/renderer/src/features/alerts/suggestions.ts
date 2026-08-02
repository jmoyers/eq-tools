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

export type TemplateKind = 'wearsOff' | 'fade' | 'lands'

/** UI + authoring metadata for each template. */
export const SUGGEST_TEMPLATES: Record<
  TemplateKind,
  { chip: string; kind: LogEventKind; verb: string; sound: string }
> = {
  // Beneficial + wears-off message: the authoritative self-expiry line.
  wearsOff: { chip: 'When it wears off you', kind: 'buffWearOff', verb: 'wears off', sound: 'warning' },
  // Beneficial: pet/named-target fades.
  fade: { chip: 'When it fades on pet/target', kind: 'buffFade', verb: 'fades', sound: 'chime' },
  // Detrimental + cast-on-other: the debuff landing on a target.
  lands: { chip: 'When it lands on a target', kind: 'buffApply', verb: 'lands', sound: 'chime' }
}

/** A concrete suggestion: the template it came from + the exact AlertDef it authors. */
export interface Suggestion {
  template: TemplateKind | 'illusion'
  def: AlertDef
}

/** The default sound pack the seeded built-ins use (see store.ts). */
const DEFAULT_PACK = 'default'
/** Default cooldown for a suggested alert (ms). */
const DEFAULT_COOLDOWN_MS = 3000

function suggestionId(spellKey: string, template: TemplateKind): string {
  return `suggest:${spellKey}:${template}`
}

/** Build the AlertDef for one (spell, template) pair. */
function buildDef(entry: SpellCatalogEntry, template: TemplateKind): AlertDef {
  const t = SUGGEST_TEMPLATES[template]
  return {
    id: suggestionId(entry.key, template),
    name: `${entry.name} ${t.verb}`,
    enabled: true,
    trigger: { type: 'event', kind: t.kind, where: { spell: entry.name } },
    sound: { packId: DEFAULT_PACK, soundId: t.sound },
    cooldownMs: DEFAULT_COOLDOWN_MS,
    note: `Suggested alert (Task #38) — ${template} for ${entry.name}.`
  }
}

/** All suggestions the spell DB supports for this catalog entry (excludes the shared illusion one). */
export function suggestionsFor(entry: SpellCatalogEntry): Suggestion[] {
  const out: Suggestion[] = []
  if (entry.templates.wearsOff) out.push({ template: 'wearsOff', def: buildDef(entry, 'wearsOff') })
  if (entry.templates.fade) out.push({ template: 'fade', def: buildDef(entry, 'fade') })
  if (entry.templates.lands) out.push({ template: 'lands', def: buildDef(entry, 'lands') })
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
      sound: { packId: DEFAULT_PACK, soundId: 'warning' },
      cooldownMs: DEFAULT_COOLDOWN_MS,
      note: 'Suggested alert (Task #38) — fires when your illusion clicks/wears off.'
    }
  }
}
