// Pure turn-in matching + celebration detection (Task #46) — the testable core of
// the "celebrate a Sky quest turn-in exactly once, never on load" rule. Kept free of
// React/data-bundle imports so tests can exercise it directly (the useProgress module
// pulls in @shared value imports the bare test runner can't alias-resolve).
//
// The celebration mirrors the boss-defeat baseline contract (bossStatus.newDefeats):
// the FIRST observation seeds a silent baseline, and only quest keys that appear in the
// matched set AFTER the baseline count as live transitions. This keeps historical
// completions (already persisted, or found in the initial log scan) from firing
// confetti/sound on launch, and guarantees exactly-once per quest across a session.

import type { PoskyQuest, TurnInEvent } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'
import { questKey } from './keys'

/**
 * Match logged turn-ins to quests: a quest is turned in when its giver received
 * (in one trade) every item the quest requires. The +N variant is normalized at the
 * matching boundary (a `Sphinx Claw +1` offer satisfies a `Sphinx Claw` requirement,
 * Task #42), so the user's `Brass Knuckles +2` loot satisfies the base requirement.
 */
export function matchTurnIns(turnIns: TurnInEvent[], quests: PoskyQuest[]): Set<string> {
  const matched = new Set<string>()
  for (const t of turnIns) {
    const npc = t.npc.toLowerCase()
    const offered = new Set(t.items.map((i) => itemCountKey(i)))
    for (const q of quests) {
      if (!q.giver || q.giver.toLowerCase() !== npc) continue
      if (q.items.length > 0 && q.items.every((it) => offered.has(itemCountKey(it.name)))) {
        matched.add(questKey(q))
      }
    }
  }
  return matched
}

/**
 * Given the previous matched-turn-in key set (null = not yet baselined) and the
 * current matched set, return the keys that just transitioned to completed via a
 * LIVE turn-in. Returns [] on the baseline run (prev == null) — the historical set
 * is seeded silently and never celebrated.
 */
export function newlyCompletedTurnIns(
  prevMatched: Set<string> | null,
  matched: Set<string>
): string[] {
  if (prevMatched == null) return []
  const out: string[] = []
  for (const key of matched) if (!prevMatched.has(key)) out.push(key)
  return out
}
