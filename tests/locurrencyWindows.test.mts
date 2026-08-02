// GOLDEN-WINDOW LOOT TEST — W14 (Task #40): Plane of Sky currency / auto-sell loot.
//
// METHODOLOGY (same as goldenWindows.test.mts): a real log span was READ LINE-BY-LINE and
// extracted verbatim into tests/fixtures/w14-sky-currency-loot.log. The window is tonight's
// Sky session, Sat Aug 01 ~22:54:55–23:03:00 (raw eqlog lines ~952259–954852). It is replayed
// through the REAL parser + LootModule and the resulting loot snapshot is asserted.
//
// What the window pins:
//   - `You looted <rune> … and stored it in your currency` (NO trailing period) parses as a
//     loot event with disposition:'currency' and the correct source — these Wind Runes are
//     Plane of Sky QUEST items that were NEVER parsed before (so Sky quest progress silently
//     missed every currency-routed rune).
//   - `You looted <item> … and sold it for free.` (trailing period) parses as disposition:'sold'.
//   - the ordinary `--You have looted a Sphinx Claw +1 …--` dashed form is UNCHANGED (no
//     disposition) and still parses.
//   - the LootModule carries `disposition` through onto its snapshot rows.
//   - QUEST COUNTING: currency-routed Wind Runes COUNT toward held (they are quest items in
//     posky.json), while 'sold' items do NOT count as held — asserted through the SAME
//     held-count + reconcile rule production uses (reconcile()), so this is the real behavior.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { LootModule } from '../src/main/modules/loot'
import { reconcile } from '../src/renderer/src/features/inventory/reconcile'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { PoskyQuest, LootEvent } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

function readFixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
}

/** Replay raw lines through the real parser + LootModule; return the loot snapshot rows. */
function replayLoot(lines: string[]): LootEvent[] {
  const mod = new LootModule()
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return mod.snapshot().state
}

const quests = (poskyRaw as { quests: PoskyQuest[] }).quests

test('W14 Sky currency loot: Wind Runes parse as currency with sources; runes never dropped', () => {
  const rows = replayLoot(readFixture('w14-sky-currency-loot.log'))

  // Every currency-routed Wind Rune in the window, by name → its source mob (hand-verified).
  const expectCurrency: Record<string, string> = {
    'Wind Rune Caza': 'a greater sphinx',
    'Wind Rune Neza': 'a blade storm',
    'Wind Rune Dena': 'an azarack',
    'Wind Rune Jaka': 'an azarack'
  }
  for (const [item, source] of Object.entries(expectCurrency)) {
    const hit = rows.find((r) => r.item === item)
    assert.ok(hit, `${item} should be parsed as a loot row`)
    assert.equal(hit!.disposition, 'currency', `${item} routed to currency`)
    assert.equal(hit!.source, source, `${item} looted from ${source}`)
  }
  // Wind Rune Heda appears TWICE in the window (azarack + watchful guard) — both currency.
  const hedas = rows.filter((r) => r.item === 'Wind Rune Heda')
  assert.equal(hedas.length, 2, 'two Wind Rune Heda currency loots in the window')
  assert.ok(hedas.every((r) => r.disposition === 'currency'), 'both Heda loots are currency')
})

test('W14: the Belt of Concordance +1 is marked sold; kept dashed loots are unchanged', () => {
  const rows = replayLoot(readFixture('w14-sky-currency-loot.log'))

  const belt = rows.find((r) => r.item === 'Belt of Concordance +1')
  assert.ok(belt, 'Belt of Concordance +1 parsed')
  assert.equal(belt!.disposition, 'sold', 'auto-sold → disposition sold')
  assert.equal(belt!.source, 'Noble Dojorn', 'sold from Noble Dojorn')

  const otherSold = rows.find((r) => r.item === 'Bracelet of Exertion +1')
  assert.ok(otherSold && otherSold.disposition === 'sold', 'sold-for-free bracelet is sold')

  // The regular dashed loot form is untouched: no disposition, still parses with source.
  const claw = rows.find((r) => r.item === 'Sphinx Claw +1')
  assert.ok(claw, 'the dashed Sphinx Claw +1 still parses')
  assert.equal(claw!.disposition, undefined, 'ordinary kept loot carries no disposition')
  assert.equal(claw!.source, 'Sister of the Spire', 'dashed loot keeps its source')

  const opal = rows.find((r) => r.item === 'Hazy Opal')
  assert.ok(opal && opal.disposition === undefined, 'another dashed loot stays kept')
})

test('W14: currency Wind Runes COUNT toward quest held; sold items do NOT', () => {
  const rows = replayLoot(readFixture('w14-sky-currency-loot.log'))

  // Held counts derive from the loot rows the SAME way production does (useProgress.logCounts):
  // every row counts EXCEPT disposition:'sold'.
  const log: Record<string, number> = {}
  for (const r of rows) {
    if (r.disposition === 'sold') continue
    const k = r.item.toLowerCase()
    log[k] = (log[k] ?? 0) + 1
  }

  // Sanity: the sold Belt/Bracelet contributed nothing to held.
  assert.equal(log['belt of concordance +1'] ?? 0, 0, 'sold Belt is not held')
  assert.equal(log['bracelet of exertion +1'] ?? 0, 0, 'sold Bracelet is not held')
  // Currency runes ARE held.
  assert.equal(log['wind rune caza'], 1, 'Caza held via currency')
  assert.equal(log['wind rune heda'], 2, 'Heda held x2 via currency')

  // Feed those held counts through the real reconcile() and confirm the quest that needs a
  // Wind Rune sees it satisfied. Every quest lists its rune as an item with count 1.
  const lootNames: Record<string, string> = {}
  for (const r of rows) lootNames[r.item.toLowerCase()] ??= r.item
  const { net } = reconcile({
    log,
    inv: {},
    lootNames,
    countSource: 'log',
    completedKeys: [],
    quests
  })

  // Caza is a required item on the Bard "Test of Pitch" quest (posky.json). Before Task #40 it
  // was never parsed (currency-only in this window), so it would have shown 0 held.
  assert.ok((net['wind rune caza'] ?? 0) >= 1, 'a currency-looted rune now satisfies its quest item')

  // The rune names in the window all exist as posky quest items (no silent name mismatch).
  const questItemNames = new Set(quests.flatMap((q) => q.items.map((i) => i.name.toLowerCase())))
  for (const name of ['Wind Rune Caza', 'Wind Rune Neza', 'Wind Rune Dena', 'Wind Rune Heda', 'Wind Rune Jaka']) {
    assert.ok(questItemNames.has(name.toLowerCase()), `${name} is a known Plane of Sky quest item`)
  }
})
