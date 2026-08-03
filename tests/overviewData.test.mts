// OVERVIEW DROP-FEED TEST (Task #65) — the pure half of the Overview tab: the recent-drops feed
// (cap + order) and THE highlight rule.
//
// Pure, no Electron, no fixtures, NEVER skips. It exists because the highlight predicate is the
// one place three sources meet — the local Plane of Sky set, the async wiki `ItemKnowledge`, and
// the tradeskill-only carve-out — and each of them can be wrong in a way the UI would render as
// a confident claim.
//
// The carve-out is the assertion that matters most: an item page's stats block carries the
// QUEST ITEM flag on things no quest anywhere uses (Gnome Meat, Spider Legs), so
// `isNotableKnowledge` alone would highlight every ingredient in a grinding session and drown
// the one coin that actually starts a quest. The row must still RENDER — only the highlight is
// withheld (docs/plans/overview-tab.md §1.2).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ItemKnowledge, LootEvent } from '../src/shared/types'
// RELATIVE, not `@shared/…`/`@renderer/…`: these are VALUE imports and the aliases only exist
// inside the vite build (mobSearch.ts:33 documents the same constraint for the same reason).
import {
  DROP_FEED_CAP,
  buildDropRows,
  isHighlighted
} from '../src/renderer/src/features/overview/overviewData'

/** A loot line, as the loot module serves it (oldest→newest). */
function loot(ts: number, item: string, source?: string): LootEvent {
  return source === undefined ? { ts, item } : { ts, item, source }
}

/** The BASE knowledge record — every flag off, which is "ordinary vendor trash". */
function knowledge(over: Partial<ItemKnowledge> = {}): ItemKnowledge {
  return { name: 'x', lore: false, quest: false, questUses: [], cached: true, ...over }
}

/** A QUEST-ITEM-flagged recipe component: the flag is on, no quest uses it, a recipe does. */
const TRADESKILL_ONLY = knowledge({
  name: 'Spider Legs',
  quest: true,
  recipes: [{ recipe: 'Spider Silk Net', tradeskill: 'Tailoring', trivial: 21 }]
})

/** A genuinely notable item: LORE, which no recipe carve-out may ever suppress. */
const LORE_ITEM = knowledge({ name: 'Shiny Brass Idol', lore: true })

const NO_POSKY = new Set<string>()
const NO_KNOWLEDGE = new Map<string, ItemKnowledge>()

// =================================================================================
// 1. THE FEED: cap + order
// =================================================================================

test('buildDropRows caps at DROP_FEED_CAP and returns the NEWEST rows, newest-first', () => {
  // 40 loots, oldest first — exactly how the loot module serves its snapshot.
  const history = Array.from({ length: 40 }, (_, i) => loot(1000 + i, `Item ${String(i)}`))
  const rows = buildDropRows(history, NO_POSKY, NO_KNOWLEDGE)

  assert.equal(rows.length, DROP_FEED_CAP)
  // Newest first: the last loot in history leads.
  assert.equal(rows[0].item, 'Item 39')
  assert.equal(rows[rows.length - 1].item, `Item ${String(40 - DROP_FEED_CAP)}`)
  // Strictly descending timestamps — the cap kept the TAIL, not the head.
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].ts > rows[i].ts, 'ts must descend')
  // Ids are unique even when two loots share a timestamp (the `|i` half of the key).
  const dupTs = [loot(500, 'Bone Chips'), loot(500, 'Bone Chips')]
  const dupRows = buildDropRows(dupTs, NO_POSKY, NO_KNOWLEDGE)
  assert.equal(new Set(dupRows.map((r) => r.id)).size, 2)
})

test('a short history is returned whole, and the row carries the RAW item name', () => {
  const rows = buildDropRows([loot(1, 'Sphinx Claw +1', 'a sphinx')], NO_POSKY, NO_KNOWLEDGE)
  assert.equal(rows.length, 1)
  // Display raw (law 2): the ` +1` survives on `item` and is stripped only on `key`.
  assert.equal(rows[0].item, 'Sphinx Claw +1')
  assert.equal(rows[0].key, 'sphinx claw')
  assert.equal(rows[0].source, 'a sphinx')
})

// =================================================================================
// 2. THE HIGHLIGHT RULE
// =================================================================================

test('a posky turn-in item highlights with NO knowledge present at all', () => {
  // The local dataset is the whole point: it is offline, synchronous, and available on the very
  // first render, so a Sky item never waits on a wiki probe to be recognized.
  const posky = new Set(['sphinx claw'])
  const rows = buildDropRows([loot(1, 'Sphinx Claw +1')], posky, NO_KNOWLEDGE)
  assert.equal(rows[0].posky, true)
  assert.equal(rows[0].knowledge, undefined)
  assert.equal(rows[0].highlighted, true)
  // …and the `+N` variant resolved through itemCountKey to get there.
  assert.equal(isHighlighted(false, undefined), false)
})

test('a lore item is un-highlighted until its knowledge lands, then upgrades IN PLACE', () => {
  const history = [loot(1, 'Shiny Brass Idol')]
  const before = buildDropRows(history, NO_POSKY, NO_KNOWLEDGE)
  assert.equal(before.length, 1, 'an unprobed row RENDERS — it is never absent')
  assert.equal(before[0].highlighted, false)
  assert.equal(before[0].knowledge, undefined)

  const after = buildDropRows(history, NO_POSKY, new Map([['shiny brass idol', LORE_ITEM]]))
  assert.equal(after.length, 1)
  assert.equal(after[0].highlighted, true)
  assert.equal(after[0].knowledge?.lore, true)
})

test('a QUEST-ITEM-flagged tradeskill-only component does NOT highlight but IS rendered', () => {
  const rows = buildDropRows(
    [loot(1, 'Spider Legs')],
    NO_POSKY,
    new Map([['spider legs', TRADESKILL_ONLY]])
  )
  assert.equal(rows.length, 1, 'the ledger row still shows — only the highlight is withheld')
  assert.equal(rows[0].knowledge?.quest, true, 'the page really does carry the QUEST ITEM flag')
  assert.equal(rows[0].highlighted, false)
  // The predicate directly, so the carve-out cannot be lost in the join.
  assert.equal(isHighlighted(false, TRADESKILL_ONLY), false)
  // LORE beats the carve-out: isTradeskillOnly returns false for a lore item by construction.
  assert.equal(isHighlighted(false, { ...TRADESKILL_ONLY, lore: true }), true)
  // A posky item that ALSO looks tradeskill-only still highlights — posky is certain knowledge.
  assert.equal(isHighlighted(true, TRADESKILL_ONLY), true)
})

test('a quest USE (not just the flag) highlights, which is what rescues real quest items', () => {
  const used = knowledge({
    name: 'Rubicite Ore',
    quest: true,
    questUses: [{ source: 'wiki', quest: 'The Smith of Highpass', role: 'required' }],
    recipes: [{ recipe: 'Rubicite Bar', tradeskill: 'Smithing' }]
  })
  // A recipe consumes it AND a quest requires it — the carve-out must not fire.
  assert.equal(isHighlighted(false, used), true)
  const rows = buildDropRows([loot(9, 'Rubicite Ore')], NO_POSKY, new Map([['rubicite ore', used]]))
  assert.equal(rows[0].highlighted, true)
})

test('a `+N` variant resolves knowledge through itemCountKey', () => {
  // The probe map is keyed by the counting key, so the upgraded drop finds the base item's
  // record instead of sitting un-highlighted forever.
  const rows = buildDropRows(
    [loot(1, 'Shiny Brass Idol +2')],
    NO_POSKY,
    new Map([['shiny brass idol', LORE_ITEM]])
  )
  assert.equal(rows[0].item, 'Shiny Brass Idol +2')
  assert.equal(rows[0].highlighted, true)
})
