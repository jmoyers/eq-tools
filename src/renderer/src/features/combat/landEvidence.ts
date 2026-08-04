// LANDED vs RESISTED, on a lane that may print no damage at all (owner report, 2026-08-04).
//
// THE DEFECT THIS EXISTS TO END. A rogue effect proc lands by printing a per-spell EMOTE
// (`<mob>'s limbs move slower!`) and never a damage line, while its resists print the spell name
// like every other spell (`A wanderer resisted your Weakening Strike!`). So the combat drill
// built the lane entirely out of resists and rendered `0 landed · 34 resisted` — a 100% resist
// rate for a proc that landed 562 times in the same log, three inches from a Procs tab counting
// every one of those emotes.
//
// `SkillView.lands` now carries those landings (joined in at view-build from the proc ledger's
// own strike map — see `procViews.effectLandings`). Two shapes follow from it, and the SECOND is
// the one that keeps this honest:
//   - landing evidence EXISTS (damage hits, emote landings, or both) ⇒ a resist rate is a real
//     division and gets stated.
//   - NO landing evidence exists at all ⇒ there is no denominator. A hand-cast Divine Stun deals
//     no damage AND prints nothing when it lands, so `8 resisted` is everything the log will
//     ever say about it, and inventing `100% resist` out of the resists alone is the exact lie
//     being removed. The count is exact; only the division is withheld — law 5, the same rule
//     the proc rates already follow.
//
// ITS OWN MODULE rather than a corner of dashboardData.ts: three surfaces read it (the bar's
// inline run, the expanded readout's Resists figure, and the hover that explains an absence),
// and the wording is the whole point, so it earns a file where the reasoning sits beside it.
// MUI-free and JSX-free, like its neighbours, so the node tests can assert the strings directly.

import type { SkillView } from '@shared/combat'

/** What a lane's row says about landing and resisting, in ONE spelling for the bar, the
 *  expanded readout and the clipboard. */
export interface LandEvidence {
  /** Damage hits + non-damage landings. */
  landed: number
  resists: number
  /** `resists / (landed + resists)` as a percentage. ABSENT when there is no landing evidence at
   *  all — see the header. Never 0-filled. */
  resistPct?: number
  /** The inline run for a lane that carries no damage: `0 dmg · 562 landed · 34 resisted`. */
  text: string
  /** The expanded readout's Resists figure — `34 of 596 attempts (6%)`, or the named absence.
   *  The readout omits the whole item when nothing was resisted. */
  resistText: string
  /** The hover, which states the basis or names the absence. */
  hint: string
}

/** `a` is the `~` sample-estimate marker the event-derived lists wear on a downsampled ring. */
export function landEvidence(s: SkillView, a = ''): LandEvidence {
  const resists = s.resists ?? 0
  const lands = s.lands ?? 0
  const landed = s.hits + lands
  const attempts = landed + resists
  if (landed === 0) {
    return {
      landed,
      resists,
      text: `${a}${resists} resisted`,
      resistText: `${a}${resists} (no landing recorded — rate unknown)`,
      hint:
        `${resists} resisted. No landing of this spell is recorded: it prints no damage line and no ` +
        'landing message, so the log cannot say how many times it succeeded — and a resist RATE ' +
        'needs that number. The count is exact; only the division is withheld.'
    }
  }
  const pct = (resists / attempts) * 100
  const resisted = resists > 0 ? ` · ${a}${resists} resisted` : ''
  return {
    landed,
    resists,
    ...(resists > 0 ? { resistPct: pct } : {}),
    text: `0 dmg · ${a}${landed} landed${resisted}`,
    resistText: `${a}${resists} of ${a}${attempts} attempts (${Math.round(pct)}%)`,
    hint:
      `${landed} landed of ${attempts} attempt${attempts === 1 ? '' : 's'}` +
      (lands > 0
        ? ' — counted from this proc’s own landing emotes, which is the only line it prints when it works.'
        : '.')
  }
}
