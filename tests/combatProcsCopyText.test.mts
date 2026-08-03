// COPY-OUT GOLDENS for the PROCS tab (rogue poisons, Task #64). Same law as
// combatCopyText.test.mts — the pasted text IS the spec, so every assertion is the exact
// string — and split into its own file only because the two together outgrow the factoring
// limit.
//
// What these pin, beyond layout:
//   - the rolling time-to-slow line ALWAYS states both halves of its denominator. "avg 3.8s
//     over 14 pulls" on its own would be a claim about 16 pulls that quietly deleted two.
//   - "not landed" and "no slow-capable coat was on" are DIFFERENT facts (dice vs loadout)
//     and neither may be printed as the other.
//   - the block carries NO `~` and no estimate footer: unlike the per-mob views, every number
//     in it is folded on ingest by the engine, not sampled from the timeline ring.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_WIDTH, formatProcsText, slowRollupText } from '../src/renderer/src/features/combat/copyText'
import type { SegmentView, SlowRollup } from '../src/shared/combat'

/** Every line of every block must fit the paste width. */
function fits(text: string): boolean {
  return text.split('\n').every((l) => l.length <= MAX_WIDTH)
}

/** A fight carrying every proc dimension at once, so one golden pins the whole block's shape. */
const SEG: SegmentView = {
  id: 'f1',
  kind: 'fight',
  name: 'a deadly black widow +2',
  durationSec: 83,
  active: false,
  activeSec: 70,
  outTotal: 45230,
  outDps: 545,
  activeDps: 646,
  entities: [],
  inTotal: 0,
  inDps: 0,
  incoming: [],
  enemyHealTotal: 0,
  incomingHealTotal: 0,
  incomingHealers: [],
  healing: { total: 0, restoredTotal: 0, absorbedTotal: 0 } as unknown as SegmentView['healing'],
  procs: {
    coatAtEngage: { poison: 'Neurotoxic Poison', sinceTs: 0 },
    combatAtEngage: [{ poison: 'Asp Venom', sinceTs: 0 }],
    slowExpected: true,
    coats: [{ poison: 'Paralytic Poison', tMs: 41_200 }],
    strikes: [
      { name: 'Asp Venom Strike / Cobra Venom Strike', count: 15, ambiguous: true },
      { name: 'Weakening Strike', count: 2 },
      { name: 'Befuddling Strike', count: 1 }
    ],
    strikeCount: 18,
    slowLands: 2,
    slowLandMs: 4_200,
    poisonDamage: [{ name: 'Asp Venom Strike', count: 15, total: 795 }],
    poisonDamageTotal: 795,
    dispels: [{ name: 'Cancel Magic / Phobocancel', count: 4, ambiguous: true }],
    dispelCount: 4,
    stanceSwitches: 1,
    invocationSwitches: 2
  }
}

/** A fight the poison model has NOTHING to say about — the degenerate case. */
const EMPTY_PROCS: SegmentView = {
  ...SEG,
  name: 'a vampire bat',
  durationSec: 7,
  procs: {
    combatAtEngage: [],
    slowExpected: false,
    coats: [],
    strikes: [],
    strikeCount: 0,
    slowLands: 0,
    poisonDamage: [],
    poisonDamageTotal: 0,
    dispels: [],
    dispelCount: 0,
    stanceSwitches: 0,
    invocationSwitches: 0
  }
}

/** The rolling time-to-slow, with a no-land pull in it — the case the wording must not hide. */
const SLOW: SlowRollup = {
  pulls: 16,
  landed: 14,
  noLand: 2,
  avgMs: 3_800,
  medianMs: 3_500,
  minMs: 1_100,
  maxMs: 9_400,
  window: 25
}


test('slowRollupText always states BOTH halves of the denominator', () => {
  // The average is over the pulls that LANDED; the ones that didn't are named, never folded
  // in as zero and never dropped. "avg 3.8s over 14 pulls" on its own would be a claim about
  // 16 pulls that quietly deleted two of them.
  assert.equal(slowRollupText(SLOW), 'avg 3.8s over 14 pulls · median 3.5s · 1.1s–9.4s · +2 no land')
  // Nothing has finished yet ⇒ nothing to say. Not "avg 0s".
  assert.equal(slowRollupText({ pulls: 0, landed: 0, noLand: 0, window: 25 }), null)
  // Qualifying pulls that ALL failed is a real, reportable result — and it is emphatically not
  // an average of zero.
  assert.equal(slowRollupText({ pulls: 3, landed: 0, noLand: 3, window: 25 }), 'slow never landed in 3 pulls')
  // A single sample has no spread to report, so median/range are suppressed rather than
  // printed as "median 4.2s · 4.2s–4.2s".
  assert.equal(
    slowRollupText({ pulls: 1, landed: 1, noLand: 0, avgMs: 4200, medianMs: 4200, minMs: 4200, maxMs: 4200, window: 25 }),
    'avg 4.2s over 1 pull'
  )
})

test('formatProcsText is the Procs tab, and carries no ~ (nothing in it is ring-derived)', () => {
  const text = formatProcsText(SEG, SLOW)
  assert.equal(
    text,
    [
      'Procs — a deadly black widow +2 · 1:23',
      'coat Neurotoxic Poison · venoms Asp Venom',
      'Slow landed at 4.2s (2 total)',
      'Rolling: avg 3.8s over 14 pulls · median 3.5s · 1.1s–9.4s · +2 no land',
      '',
      'Poison proc                                Count',
      'Asp Venom Strike / Cobra Venom Strike (?)     15',
      'Weakening Strike                               2',
      'Befuddling Strike                              1',
      '',
      'Poison damage     Hits  Total',
      'Asp Venom Strike    15    795',
      '',
      'Dispel landed               Count',
      'Cancel Magic / Phobocancel      4',
      'Dispel lines name no caster — any class or NPC can print them.',
      '',
      // The stat run WRAPS on a separator rather than clipping — dropping a stat would be an
      // edit, and letting the line run would hand the chat client the wrap point.
      '1 stance switch · 2 invocation switches',
      'coated Paralytic Poison @ 41.2s'
    ].join('\n')
  )
  assert.ok(fits(text), text)
  // The whole block is folded on ingest from the authoritative event stream, so unlike the
  // per-mob views it must never wear the estimate prefix or the APPROX footer.
  assert.ok(!text.includes('~'), text)
  assert.ok(!text.includes('estimated'), text)
})

test('formatProcsText tells "not landed" apart from "no slow poison was on"', () => {
  // A slow-capable coat was on and nothing landed — that is a fact about the dice.
  const notLanded = formatProcsText({
    ...SEG,
    procs: { ...SEG.procs, slowLandMs: undefined, slowLands: 0, strikes: [], strikeCount: 0, poisonDamage: [], poisonDamageTotal: 0, dispels: [], dispelCount: 0, coats: [], stanceSwitches: 0, invocationSwitches: 0 }
  })
  assert.ok(notLanded.includes('Slow: not landed (a slow-capable coat was on)'), notLanded)

  // No slow-capable coat — that is a fact about the loadout, and reporting it as "not landed"
  // would blame the dice for a choice. Mage Bane grants dispel + mana drain, never a slow.
  const noCoat = formatProcsText({
    ...SEG,
    procs: {
      ...SEG.procs,
      coatAtEngage: { poison: 'Mage Bane Poison', sinceTs: 0 },
      slowExpected: false,
      slowLandMs: undefined,
      slowLands: 0,
      strikes: [],
      strikeCount: 0,
      poisonDamage: [],
      poisonDamageTotal: 0,
      dispels: [],
      dispelCount: 0,
      coats: [],
      stanceSwitches: 0,
      invocationSwitches: 0
    }
  })
  assert.ok(noCoat.includes('Slow: no slow-capable coat was on for this fight'), noCoat)
  assert.ok(!noCoat.includes('not landed'), noCoat)

  // A fight with nothing poison-shaped at all says so once, rather than emitting empty tables.
  const bare = formatProcsText(EMPTY_PROCS)
  assert.equal(bare, ['Procs — a vampire bat · 0:07', 'No procs recorded in this segment.'].join('\n'))
})


test('the Procs block is not markdown either', () => {
  for (const b of [formatProcsText(SEG, SLOW), formatProcsText(EMPTY_PROCS)]) {
    assert.ok(!/[*_`|#]/.test(b), b)
    assert.ok(fits(b), b)
  }
})
