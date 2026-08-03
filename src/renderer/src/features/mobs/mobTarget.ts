// mobTarget.ts — what it takes to open a mob's page, from whichever surface asked.
//
// Its own file (no React, no MUI, no data imports) because FOUR surfaces name this shape and
// none of them should have to import another feature's view to do it: the Mobs tab's search
// results and considered strip, the Raid Targets tab's roster cards, and App.tsx routing a
// deep link in from the events overlay.

import type { ConsiderFaction } from '@shared/logEvents'
import type { KillInfo, MobEntry, MobKnowledge } from '@shared/types'

/** The consider facts the caller already has from the log line (absent for a raid-roster card). */
export interface MobConsiderContext {
  faction: ConsiderFaction
  level?: number
  rare: boolean
  /** VERBATIM difficulty clause */
  difficulty: string
  /** how many times we've conned it this session */
  cons?: number
  /** the zone we were in at the time */
  zone?: string
}

/** Everything a caller can hand the mob page. Only `mob` is required — the page fetches. */
export interface MobTarget {
  /** RAW display name as the log (or the catalog) spells it */
  mob: string
  /**
   * The catalog row the user actually CLICKED, when they clicked one. Load-bearing for the
   * search results: a name can name several pages ("a bandit" is nine different mobs in nine
   * zones with nine drop tables), and a lookup by name can only ever resolve one of them. An
   * entry pins the identity half of the page to the row you picked.
   */
  entry?: MobEntry
  /** knowledge the caller already holds (a consider row's enrichment) — paints instantly */
  seed?: MobKnowledge
  /** the consider facts, when this was opened from a considered mob */
  con?: MobConsiderContext
  /** what the kills module knows about this mob, when the caller has it */
  kill?: Pick<KillInfo, 'count' | 'bestTier' | 'firstTs' | 'lastTs'>
}
