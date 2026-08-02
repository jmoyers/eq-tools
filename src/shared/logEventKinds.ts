// The runtime list of every LogEventKind (Task #47).
//
// TypeScript types are erased at runtime, so the alerts editor needs a concrete array to
// populate its "event kind" picker. This is that array — and it is EXHAUSTIVENESS-CHECKED
// against the `LogEventKind` union: the `satisfies` below fails to compile if a kind is added
// to the union (logEvents.ts / types.ts) but forgotten here, or vice-versa. So the picker can
// never silently drift from the real set of events a trigger can match.
//
// Ordering is UI-facing (grouped roughly: world/loot, progression, combat, buffs, derived),
// not the union's declaration order — the exhaustiveness check is order-independent.

import type { LogEventKind } from './types'

/** Every LogEventKind, for the alerts editor's kind picker. Exhaustive by construction. */
export const ALL_LOG_EVENT_KINDS = [
  'zone',
  'loot',
  'offer',
  'trade',
  'level',
  'aaGain',
  'aaSpend',
  'aaActivate',
  'death',
  'playerDeath',
  'damage',
  'heal',
  'miss',
  'charm',
  'uncharm',
  'cc',
  'petClaim',
  'castBegin',
  'castFizzle',
  'castInterrupted',
  'buffApply',
  'buffFade',
  'buffWearOff',
  'illusionFade',
  'buffExpired',
  'spellEmote',
  'unknown'
] as const satisfies readonly LogEventKind[]

// Compile-time guarantee that the array covers the WHOLE union (no missing kinds). If a new
// kind is added to LogEventKind but not to the array above, `_exhaustive` errors because the
// union is not assignable to the array's element type.
type _KindsInArray = (typeof ALL_LOG_EVENT_KINDS)[number]
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _exhaustive: _KindsInArray = null as unknown as LogEventKind
void _exhaustive
