// The marker vocabulary — ONE source for the hue and the word every surface uses to say
// "a stance was committed" / "a coat went on" / "a slow landed".
//
// Extracted from CombatDashboard.tsx (Task #64), which owned the only copy while ProcsPanel and
// the header slots kept hand-copied hexes of the same values — a third copy waiting to drift.
// The precedent is CAT_COLOR in combatShared.tsx: a color that means something is data, and
// data has one home. MUI-free and free of `@shared/*` VALUE imports on purpose, so the pure
// modules that build tooltip text can import it without becoming un-loadable outside the
// renderer bundle.
//
// MARKER COLORS are deliberately the SAME hues as the header's modifier slots, so a violet tick
// on the curve and the violet "3: Neurotoxic" pill are obviously the same fact:
//   stance      gold   (slot 1)
//   invocation  violet (slot 2)
//   coat        magenta(slot 3)
//   slow        green  — the one marker that is an OUTCOME rather than a choice, so it also
//                        gets a flag head instead of a plain tick. It is what the user is
//                        looking for on these charts; it must not read as another setting.

import type { TimelineMarker } from '@shared/combat'

export const MARKER_COLOR: Record<TimelineMarker['kind'], string> = {
  stance: '#d9b25f',
  invocation: '#a98fe0',
  coat: '#c46fd2',
  slow: '#57e0a0'
}

// The WORD is extracted verbatim from its old home — the DPS curve's legend and native tick
// titles read from it, and this move is behavior-preserving by construction.
export const MARKER_WORD: Record<TimelineMarker['kind'], string> = {
  stance: 'stance',
  invocation: 'invocation',
  coat: 'coat',
  slow: 'slow landed'
}

/** The verb a marker's instant is stated with: a coat/slow HAPPENED, a stance was CHOSEN. */
export const MARKER_VERB: Record<TimelineMarker['kind'], string> = {
  stance: 'committed',
  invocation: 'committed',
  coat: 'applied',
  slow: 'landed'
}
