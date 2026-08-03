// The app's top-level view identity: the union the nav drawer, the content switch and the
// persisted "which tab was I on" key all agree on. Lives outside App.tsx so the nav drawer
// can import it without importing the app itself.

export type View =
  | 'overview'
  | 'combat'
  | 'mobs'
  | 'bosses'
  | 'posky'
  | 'alerts'
  | 'leveling'
  | 'loot'
  | 'buffs'
  | 'preferences'

export const VIEW_KEY = 'eq.view'
export const DEFAULT_VIEW: View = 'combat'

// Every member of `View`. A view missing here is silently bounced to the default on the next
// launch, so the two lists are edited together — always.
const KNOWN_VIEWS: View[] = [
  'overview',
  'combat',
  'mobs',
  'bosses',
  'posky',
  'alerts',
  'leveling',
  'loot',
  'buffs',
  'preferences'
]

export function loadView(): View {
  const v = localStorage.getItem(VIEW_KEY)
  // The Inventory feature was folded into Loot (Task #55) — land those users on Loot
  // instead of silently bouncing them to the default view.
  if (v === 'inventory') return 'loot'
  return v && (KNOWN_VIEWS as string[]).includes(v) ? (v as View) : DEFAULT_VIEW
}
