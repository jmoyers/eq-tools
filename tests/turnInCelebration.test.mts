// TURN-IN CELEBRATION DETECTION TEST (Task #46): the pure baseline-guarded "which
// quests just completed via a LIVE turn-in" core that PoskyView (confetti) + App
// (snackbar + questComplete sound) fire on. Mirrors the boss-defeat baseline contract:
// the historical set is seeded silently and NEVER celebrated; only a transition after
// the baseline fires, exactly once per quest.
//
// Also replays the REAL turn-in matcher (matchTurnIns) over synthetic turn-in events to
// prove the end-to-end path: a live turn-in of the exact required set (incl. a +N variant
// normalized at the boundary) transitions the quest, and reload/hydration does not.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchTurnIns,
  newlyCompletedTurnIns
} from '../src/renderer/src/features/posky/turnInCelebration'
import { questKey } from '../src/renderer/src/features/posky/keys'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { PoskyQuest, TurnInEvent } from '../src/shared/types'

const quests = (poskyRaw as { quests: PoskyQuest[] }).quests
const monkFists = quests.find((q) => q.name === 'Monk Test of Fists')!

test('baseline run (prev == null) celebrates NOTHING — historical set seeded silently', () => {
  const historical = new Set(['Monk::Monk Test of Fists', 'Warrior::Warrior Test of Bash'])
  assert.deepEqual(newlyCompletedTurnIns(null, historical), [])
})

test('a key newly in matched after the baseline is a live transition', () => {
  const baseline = new Set(['Monk::Monk Test of Fists'])
  const next = new Set(['Monk::Monk Test of Fists', 'Warrior::Warrior Test of Bash'])
  assert.deepEqual(newlyCompletedTurnIns(baseline, next), ['Warrior::Warrior Test of Bash'])
})

test('exactly-once: a key already celebrated (still in the baseline) never re-fires', () => {
  // Simulate the ref update the hook does: after firing, the baseline becomes `next`.
  let baseline: Set<string> | null = new Set(['Monk::Monk Test of Fists'])
  const afterTurnIn = new Set(['Monk::Monk Test of Fists', 'Warrior::Warrior Test of Bash'])
  const first = newlyCompletedTurnIns(baseline, afterTurnIn)
  assert.deepEqual(first, ['Warrior::Warrior Test of Bash'])
  baseline = afterTurnIn // hook advances the baseline ref
  // A later observation with the SAME matched set (e.g. a re-render / another delta) → nothing.
  assert.deepEqual(newlyCompletedTurnIns(baseline, afterTurnIn), [])
  // Even a superset that still contains the already-fired key doesn't re-fire IT.
  const more = new Set([...afterTurnIn, 'Cleric::Cleric Test of Theurgy'])
  assert.deepEqual(newlyCompletedTurnIns(baseline, more), ['Cleric::Cleric Test of Theurgy'])
})

test('multiple simultaneous completions all fire once', () => {
  const baseline = new Set<string>()
  const next = new Set(['A::Qa', 'B::Qb', 'C::Qc'])
  assert.deepEqual(newlyCompletedTurnIns(baseline, next).sort(), ['A::Qa', 'B::Qb', 'C::Qc'])
})

test('a key LEAVING the matched set (never happens for turn-ins, but be safe) fires nothing', () => {
  const baseline = new Set(['A::Qa', 'B::Qb'])
  const next = new Set(['A::Qa'])
  assert.deepEqual(newlyCompletedTurnIns(baseline, next), [])
})

// ---- end-to-end over the REAL posky.json (Brass Knuckles data completeness, Task #46) ----

test('Monk Test of Fists now requires Brass Knuckles (efreeti-cycle item restored)', () => {
  const names = monkFists.items.map((i) => i.name)
  assert.ok(names.includes('Brass Knuckles'), 'Brass Knuckles is a required turn-in item')
  assert.ok(names.includes('Nebulous Sapphire'), 'Nebulous Sapphire still required (unchanged)')
  assert.equal(monkFists.giver, 'Holwin')
})

test('a live turn-in of the exact required set completes the quest (incl. +N normalization)', () => {
  const required = monkFists.items.map((i) => i.name)
  // The user looted a `Brass Knuckles +2` variant — offering it must still satisfy the
  // base requirement (itemCountKey folds the +N suffix, Task #42). Swap in the variant.
  const offered = required.map((n) => (n === 'Brass Knuckles' ? 'Brass Knuckles +2' : n))
  const turnIn: TurnInEvent = { ts: 1, npc: 'Holwin', items: offered }

  const matched = matchTurnIns([turnIn], quests)
  assert.ok(matched.has(questKey(monkFists)), 'the +2 turn-in matches the base requirement')

  // Baseline-guarded celebration: seed silent on load, fire on the live transition.
  assert.deepEqual(newlyCompletedTurnIns(null, matched), [], 'load never celebrates')
  assert.deepEqual(newlyCompletedTurnIns(new Set<string>(), matched), [questKey(monkFists)])
})

test('an incomplete turn-in (missing Brass Knuckles) does NOT complete the quest', () => {
  const partial = monkFists.items.filter((i) => i.name !== 'Brass Knuckles').map((i) => i.name)
  const matched = matchTurnIns([{ ts: 1, npc: 'Holwin', items: partial }], quests)
  assert.equal(matched.has(questKey(monkFists)), false, 'missing an item ⇒ not matched now Brass Knuckles is required')
})
