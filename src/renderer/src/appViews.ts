// The app's top-level view identity: the union the nav drawer, the content switch and the
// persisted "which tab was I on" key all agree on. Lives outside App.tsx so the nav drawer
// can import it without importing the app itself.

import { DEV_TOOLS } from './devFlags'

export type View =
  | 'overview'
  | 'combat'
  | 'mobs'
  | 'maps'
  | 'bosses'
  | 'posky'
  | 'alerts'
  | 'leveling'
  | 'loot'
  | 'buffs'
  | 'preferences'
  // DEV-ONLY view (src/renderer/src/features/triage/**). It stays in the union
  // unconditionally because a union member is a TYPE and types are erased — nothing of it
  // survives compilation. What actually strips is the CODE: the nav row, the content branch
  // and the whole component tree sit behind `__EQ_DEV_TOOLS__`, and `KNOWN_VIEWS` below drops
  // the string itself in a build without the flag, so a persisted 'triage' can never leave a
  // shipped app staring at an empty content area.
  | 'triage'

export const VIEW_KEY = 'eq.view'
export const DEFAULT_VIEW: View = 'overview'

// Every member of `View` this BUILD can actually render. A view missing here is silently
// bounced to the default on the next launch, so the two lists are edited together — always.
const KNOWN_VIEWS: View[] = [
  'overview',
  'combat',
  'mobs',
  'maps',
  'bosses',
  'posky',
  'alerts',
  'leveling',
  'loot',
  'buffs',
  'preferences',
  // Compile-time: `false ? [...] : []` folds away, taking the literal with it.
  ...(DEV_TOOLS ? (['triage'] as const) : [])
]

export function loadView(): View {
  const v = localStorage.getItem(VIEW_KEY)
  // The Inventory feature was folded into Loot (Task #55) — land those users on Loot
  // instead of silently bouncing them to the default view.
  if (v === 'inventory') return 'loot'
  return v && (KNOWN_VIEWS as string[]).includes(v) ? (v as View) : DEFAULT_VIEW
}
