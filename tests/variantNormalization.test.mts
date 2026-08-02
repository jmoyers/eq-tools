// VARIANT NORMALIZATION + ALLOCATION TEST — W15 (Task #42): quest-item `+N` variant
// normalization and duplicate allocation across claw-requiring quests.
//
// METHODOLOGY (golden window, per goldenWindows.test.mts): a real log span was READ and
// extracted verbatim into tests/fixtures/w15-sphinx-claw-variant.log. The window contains
// BOTH real Sphinx Claw loots — the base `Sphinx Claw` (Aug 01 00:54:33) and the upgraded
// `Sphinx Claw +1` (22:55:00) — plus the real Paladin Test of Love turn-in to Dason
// Goldblade (Sphinx Claw + Golden Hilt + Wind Rune Geza, 01:46:43–51). It is replayed
// through the REAL parser + Loot/TurnIn modules and the PURE counting functions
// (itemCountKey, reconcile, computeQuestProgress) production uses — no UI.
//
// THE BUG: quest matching keyed items by exact lowercase, so a looted `Sphinx Claw +1`
// counted toward NOTHING (posky.json quests require "Sphinx Claw"). normalizeItemName()
// strips a trailing ` +N` at the COUNTING boundary only — display keeps the variant.
//
// What the window / units pin:
//   - normalizeItemName / itemCountKey strip a trailing ` +N` (end-only, word-bounded) and
//     leave everything else — no false positives.
//   - held counts fold `Sphinx Claw` + `Sphinx Claw +1` → 2 (the counting boundary).
//   - the offered-item turn-in comparison normalizes too (a `+N` offered line would still
//     satisfy a base quest requirement).
//   - ALLOCATION pool math across the TWO claw-requiring quests (Beastlord Test of Claw,
//     Paladin Test of Love): completing one consumes exactly one claw and leaves the other
//     quest's claw intact; never goes negative.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { LootModule } from '../src/main/modules/loot'
import { TurnInsModule } from '../src/main/modules/turnins'
import { reconcile } from '../src/renderer/src/features/inventory/reconcile'
import { questKey } from '../src/renderer/src/features/posky/keys'
import { normalizeItemName, itemCountKey } from '../src/renderer/src/lib/itemName'
import poskyRaw from '../src/renderer/src/data/eqlegends/posky.json' with { type: 'json' }
import type { PoskyQuest, LootEvent, TurnInEvent } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

function readFixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
}

/** Replay raw lines through the real parser + Loot & TurnIn modules. */
function replay(lines: string[]): { loot: LootEvent[]; turnIns: TurnInEvent[] } {
  const loot = new LootModule()
  const turn = new TurnInsModule()
  loot.reset()
  turn.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) {
      loot.onEvent(ev)
      turn.onEvent(ev)
    }
  }
  return { loot: loot.snapshot().state, turnIns: turn.snapshot().state }
}

/** Production's held-count derivation (useProgress.logCounts): every loot except 'sold',
 *  keyed by the normalized counting key. */
function heldCounts(rows: LootEvent[]): Record<string, number> {
  const c: Record<string, number> = {}
  for (const r of rows) {
    if (r.disposition === 'sold') continue
    const k = itemCountKey(r.item)
    c[k] = (c[k] ?? 0) + 1
  }
  return c
}

const quests = (poskyRaw as { quests: PoskyQuest[] }).quests

/** Mirror of computeQuestProgress's per-item clamp (have = min(need, net[countKey])).
 *  Reimplemented here to keep the test off the renderer-heavy useProgress module. */
function questItemHave(q: PoskyQuest, itemName: string, net: Record<string, number>): { have: number; need: number } {
  const it = q.items.find((i) => itemCountKey(i.name) === itemCountKey(itemName))!
  const need = it.count > 0 ? it.count : 1
  return { need, have: Math.min(need, net[itemCountKey(it.name)] ?? 0) }
}

// The two posky quests that require a Sphinx Claw (enumerated from posky.json).
const CLAW_QUESTS = quests.filter((q) =>
  q.items.some((it) => itemCountKey(it.name) === 'sphinx claw')
)

test('normalizeItemName strips a trailing +N only (no false positives)', () => {
  assert.equal(normalizeItemName('Sphinx Claw +1'), 'Sphinx Claw')
  assert.equal(normalizeItemName('Sphinx Claw'), 'Sphinx Claw')
  assert.equal(normalizeItemName('Belt of Concordance +1'), 'Belt of Concordance')
  assert.equal(normalizeItemName('Bloodstar Pendant +4'), 'Bloodstar Pendant')
  assert.equal(normalizeItemName('Staff of Elemental Mastery: Earth +2'), 'Staff of Elemental Mastery: Earth')
  // No false positives: names that merely contain a digit / plus mid-string are untouched.
  assert.equal(normalizeItemName('Wind Rune Geza'), 'Wind Rune Geza')
  assert.equal(normalizeItemName('Staff of Elemental Mastery: Earth'), 'Staff of Elemental Mastery: Earth')
  assert.equal(normalizeItemName('Symbol of Pinzarn'), 'Symbol of Pinzarn')
  assert.equal(normalizeItemName('+5 Ring'), '+5 Ring') // leading +N is not a suffix
  assert.equal(normalizeItemName('Sword +'), 'Sword +') // bare + with no digits
  assert.equal(normalizeItemName('Sword +1a'), 'Sword +1a') // digits not at end
  assert.equal(itemCountKey('Sphinx Claw +1'), 'sphinx claw')
})

test('posky.json has exactly two Sphinx Claw quests (enumeration)', () => {
  const names = CLAW_QUESTS.map((q) => q.name).sort()
  assert.deepEqual(names, ['Beastlord Test of Claw', 'Paladin Test of Love'])
})

test('W15: base Sphinx Claw and Sphinx Claw +1 fold to a held pool of 2', () => {
  const { loot, turnIns } = replay(readFixture('w15-sphinx-claw-variant.log'))

  // Both claws parse as ordinary kept loot (display keeps the +1).
  const claws = loot.filter((r) => normalizeItemName(r.item) === 'Sphinx Claw')
  assert.equal(claws.length, 2, 'two Sphinx Claw loots in the window (base + variant)')
  assert.ok(claws.some((r) => r.item === 'Sphinx Claw'), 'base variant present, display untouched')
  assert.ok(claws.some((r) => r.item === 'Sphinx Claw +1'), '+1 variant present, display untouched')

  const held = heldCounts(loot)
  assert.equal(held['sphinx claw'], 2, 'variant folds onto base at the counting boundary → 2 held')

  // The real turn-in (Sphinx Claw + Golden Hilt + Wind Rune Geza to Dason Goldblade) closed.
  assert.equal(turnIns.length, 1, 'one completed trade in the window')
  const t = turnIns[0]
  assert.equal(t.npc, 'Dason Goldblade')
  // Offered-item comparison normalizes: a `+N` offered line would still satisfy the base
  // requirement (defensive — real offered lines here carry no +N).
  const offered = new Set(t.items.map((i) => itemCountKey(i)))
  const paladin = CLAW_QUESTS.find((q) => q.name === 'Paladin Test of Love')!
  assert.ok(
    paladin.items.every((it) => offered.has(itemCountKey(it.name))),
    'the Paladin Test of Love turn-in matches on normalized keys'
  )
})

test('allocation (a): 2 held, both claw quests need 1 → both 1/1; complete one leaves the other 1/1', () => {
  const log = { 'sphinx claw': 2 }
  const lootNames = { 'sphinx claw': 'Sphinx Claw' }

  // Nothing completed: both quests display 1/1 (need=1, have=min(1, 2)=1).
  {
    const { net } = reconcile({ log, inv: {}, lootNames, countSource: 'log', completedKeys: [], quests })
    assert.equal(net['sphinx claw'], 2, 'no consumption yet → 2 available')
    for (const q of CLAW_QUESTS) {
      const claw = questItemHave(q, 'Sphinx Claw', net)
      assert.equal(claw.have, 1, `${q.name}: 1/1 held claw`)
      assert.equal(claw.need, 1)
    }
  }

  // Complete quest A (Beastlord Test of Claw) → consumes exactly 1; B still 1/1.
  {
    const a = CLAW_QUESTS.find((q) => q.name === 'Beastlord Test of Claw')!
    const b = CLAW_QUESTS.find((q) => q.name === 'Paladin Test of Love')!
    const { net, rows } = reconcile({
      log, inv: {}, lootNames, countSource: 'log', completedKeys: [questKey(a)], quests
    })
    const row = rows.find((r) => r.key === 'sphinx claw')!
    assert.equal(row.consumed, 1, 'completing one claw quest consumes exactly one claw')
    assert.deepEqual(row.consumedBy, [a.name], 'consumedBy names quest A')
    assert.equal(net['sphinx claw'], 1, '1 claw left for the other quest')
    const clawB = questItemHave(b, 'Sphinx Claw', net)
    assert.equal(clawB.have, 1, 'quest B still shows 1/1 after A consumed one claw')
  }
})

test('allocation (b): 1 held, 2 quests → both display 1/1; completing A leaves B at 0/1, never negative', () => {
  const log = { 'sphinx claw': 1 }
  const lootNames = { 'sphinx claw': 'Sphinx Claw' }
  const a = CLAW_QUESTS.find((q) => q.name === 'Beastlord Test of Claw')!
  const b = CLAW_QUESTS.find((q) => q.name === 'Paladin Test of Love')!

  // Known overstatement, left as-is: both quests display 1/1 off a single shared claw.
  {
    const { net } = reconcile({ log, inv: {}, lootNames, countSource: 'log', completedKeys: [], quests })
    for (const q of [a, b]) {
      assert.equal(questItemHave(q, 'Sphinx Claw', net).have, 1)
    }
  }

  // Complete A → consumption never drives net negative; B drops to 0/1.
  {
    const { net, rows } = reconcile({
      log, inv: {}, lootNames, countSource: 'log', completedKeys: [questKey(a)], quests
    })
    const row = rows.find((r) => r.key === 'sphinx claw')!
    assert.equal(row.net, 0, 'net floors at 0 (never negative)')
    assert.equal(net['sphinx claw'], 0)
    assert.equal(questItemHave(b, 'Sphinx Claw', net).have, 0, 'B is 0/1 once the lone claw is spent')
  }
})

test('allocation (c): variant mixing — 1 base loot + 1 +1 loot → held pool of 2 under normalization', () => {
  const { loot } = replay(readFixture('w15-sphinx-claw-variant.log'))
  const held = heldCounts(loot)
  const lootNames: Record<string, string> = {}
  for (const r of loot) {
    const k = itemCountKey(r.item)
    lootNames[k] ??= normalizeItemName(r.item)
  }
  const { net } = reconcile({ log: held, inv: {}, lootNames, countSource: 'log', completedKeys: [], quests })
  assert.equal(net['sphinx claw'], 2, 'base + variant → 2 held claws, both quests satisfiable')
})

test('reconcile folds a +N inventory-export entry onto its base (inv source)', () => {
  // Inventory export lists the variant; count source = inventory. It must pool with base.
  const { net, rows } = reconcile({
    log: {},
    inv: { 'sphinx claw': 1, 'sphinx claw +1': 1 },
    lootNames: {},
    countSource: 'inventory',
    completedKeys: [],
    quests
  })
  assert.equal(net['sphinx claw'], 2, 'inventory +1 variant folds onto base under normalization')
  const row = rows.find((r) => r.key === 'sphinx claw')!
  assert.equal(row.inv, 2, 'row reports the pooled inventory count')
})
