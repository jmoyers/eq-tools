// SPELL-LINE INTELLIGENCE — the pure model behind rank-aware alert suggestions and the
// "you have levelled past this alert" upgrade offers (src/shared/spellLines.ts).
//
// Everything here is pure: no Electron, no fixtures, never skips. The one place it reaches
// outside itself is the parser-parity check — `spellLineKey` MUST equal the repo's existing
// `spellCanonKey`, or a line computed in the renderer would not match the key the parser and
// the buffs model use, and every join would silently miss.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spellCanonKey } from '../src/main/log/parseCommon'
import { loadSpellDb } from '../src/main/data/spellDb'
import {
  addRankAlongsideDef,
  buildSpellLine,
  detectRankUpgrades,
  parseSpellClassLevels,
  parseSpellRank,
  preferredRank,
  rankRecencyOrder,
  replaceRankInDef,
  spellLineKey,
  spellLineLevel,
  triggerSpells
} from '../src/shared/spellLines'
import type { AlertDef } from '../src/shared/types'

// Real display names taken verbatim from eqlog_Primitive_freeport.txt cast lines.
const REAL_CAST_NAMES = [
  'Mesmerization III',
  'Superior Healing II',
  'Shiftless Deeds IV',
  'Lay on Hands X',
  'Swift Like the Wind I',
  'Allure VI',
  'Clarity III',
  'Quickness',
  'Languid Pace'
]

test('L1 spellLineKey is byte-identical to the parser spellCanonKey', () => {
  // The whole join depends on this. Check the real cast names AND every name in the DB.
  for (const name of REAL_CAST_NAMES) {
    assert.equal(spellLineKey(name), spellCanonKey(name), name)
  }
  for (const s of loadSpellDb().spells) {
    assert.equal(spellLineKey(s.name), spellCanonKey(s.name), s.name)
  }
})

test('L2 parseSpellRank: suffix → ordinal, bare name → an implicit rank 1', () => {
  assert.deepEqual(parseSpellRank('Mesmerization III'), {
    base: 'Mesmerization',
    rank: 3,
    suffixed: true
  })
  assert.deepEqual(parseSpellRank('Lay on Hands X'), { base: 'Lay on Hands', rank: 10, suffixed: true })
  // A bare name IS rank 1 — "Clarity" precedes "Clarity II" — but is flagged unsuffixed so
  // nothing offers a rank-pinned alert on a name the log never spells with a rank.
  assert.deepEqual(parseSpellRank('Clarity'), { base: 'Clarity', rank: 1, suffixed: false })
  // "V" is a rank; a word merely ENDING in a numeral letter is not.
  assert.equal(parseSpellRank('Rune V').rank, 5)
  assert.equal(parseSpellRank('Shadow Vortex').suffixed, false)
})

test('L3 buildSpellLine unions DB + observed names, dedupes case-insensitively, sorts by rank', () => {
  const line = buildSpellLine(
    'clarity',
    ['Clarity', 'Clarity II', 'clarity ii', 'Clarity III'],
    { 'Clarity III': 5000, Clarity: 1000 }
  )
  assert.equal(line.base, 'Clarity')
  assert.deepEqual(
    line.ranks.map((r) => r.name),
    ['Clarity', 'Clarity II', 'Clarity III'],
    'deduped on the FIRST spelling seen, ascending by rank'
  )
  assert.deepEqual(
    line.ranks.map((r) => r.lastCastMs),
    [1000, null, 5000]
  )
  // The recency map is read case-insensitively — the wiki and the log disagree on case.
  const cased = buildSpellLine('clarity', ['Clarity II'], { 'clarity ii': 42 })
  assert.equal(cased.ranks[0].lastCastMs, 42)
})

test('L4 ranking favours the MOST RECENTLY CAST rank, not the highest', () => {
  const line = buildSpellLine('allure', ['Allure III', 'Allure IV', 'Allure VI'], {
    'Allure III': 100,
    'Allure VI': 50 // higher rank, cast LONGER ago
  })
  assert.equal(preferredRank(line.ranks)?.name, 'Allure III', 'recency beats rank')
  assert.deepEqual(
    rankRecencyOrder(line.ranks).map((r) => r.name),
    ['Allure III', 'Allure VI', 'Allure IV'],
    'cast ranks first (newest first), then never-cast ranks by descending rank'
  )
  // A line nobody has cast falls back to the highest known rank rather than to nothing.
  const unused = buildSpellLine('rune', ['Rune I', 'Rune V'], {})
  assert.equal(preferredRank(unused.ranks)?.name, 'Rune V')
  assert.equal(preferredRank([]), null)
})

test('L5 class levels parse out of the real DB classes strings', () => {
  const db = loadSpellDb()
  const yaulp = db.spells.find((s) => s.name === 'Yaulp')
  assert.ok(yaulp, 'Yaulp is in the committed DB')
  assert.deepEqual(parseSpellClassLevels(yaulp.classes), [
    { cls: 'CLR', level: 1 },
    { cls: 'PAL', level: 9 }
  ])
  // The two shapes the wiki uses for "no class" produce nothing rather than a guess.
  assert.deepEqual(parseSpellClassLevels('This spell is cast by NPCs only.'), [])
  assert.deepEqual(parseSpellClassLevels(undefined), [])
  // Both wiki spellings of the Shadow Knight canonicalize to SHD; a class named twice keeps
  // its LOWEST level (the earliest the line is available).
  assert.deepEqual(parseSpellClassLevels('* Shadowknight - Level 39 * Shadow Knight - Level 20'), [
    { cls: 'SHD', level: 20 }
  ])
})

test('L6 the level chip resolves, or says min — it never picks a class', () => {
  const levels = [
    { cls: 'CLR' as const, level: 1 },
    { cls: 'PAL' as const, level: 9 }
  ]
  // Exactly one of your resolved classes casts it → that class's level, unambiguous.
  assert.deepEqual(spellLineLevel(levels, ['PAL', 'WAR']), { level: 9, cls: 'PAL', ambiguous: false })
  // Several of them do → the minimum, flagged ambiguous (never "you are the Cleric").
  assert.deepEqual(spellLineLevel(levels, ['CLR', 'PAL']), { level: 1, ambiguous: true })
  // Loadout unknown → the minimum across every candidate class, flagged ambiguous.
  assert.deepEqual(spellLineLevel(levels, []), { level: 1, ambiguous: true })
  // The DB places the line in no class at all → nothing to say.
  assert.equal(spellLineLevel([], ['ENC']), null)
})

// ─────────────────────────────────────────────────────────────────────────────
// Upgrade offers.

function rankAlert(id: string, spell: string): AlertDef {
  return {
    id,
    name: `${spell} resisted`,
    enabled: true,
    trigger: { type: 'event', kind: 'resist', where: { caster: 'you', spell } },
    sound: { packId: 'alan-rickman', soundId: 'task-error-task-error-01' },
    volume: 0.4,
    cooldownMs: 7000
  }
}

test('U1 triggerSpells reads literal pins and deliberately ignores user regexes', () => {
  assert.deepEqual(triggerSpells(rankAlert('a', 'Allure IV').trigger), ['Allure IV'])
  // A /…/ matcher is a user-authored pattern; rewriting it would be guessing at intent.
  assert.deepEqual(
    triggerSpells({ type: 'event', kind: 'resist', where: { spell: '/allure/' } }),
    []
  )
  // Composites are walked, and non-event conditions contribute nothing.
  assert.deepEqual(
    triggerSpells({
      type: 'any',
      conditions: [
        { type: 'event', kind: 'castBegin', where: { spell: 'Rune II' } },
        { type: 'raw', regex: 'anything' }
      ]
    }),
    ['Rune II']
  )
})

test('U2 an offer appears only for a rank you have CAST above every covered rank', () => {
  const lines = [
    buildSpellLine('allure', ['Allure III', 'Allure IV', 'Allure VI'], {
      'Allure III': 100,
      'Allure VI': 900
    })
  ]
  const offers = detectRankUpgrades([rankAlert('a1', 'Allure III')], lines)
  assert.equal(offers.length, 1)
  assert.equal(offers[0].from, 'Allure III')
  assert.equal(offers[0].to, 'Allure VI')
  assert.deepEqual(offers[0].covered, ['Allure III'])

  // Allure IV exists in the line but was NEVER cast → never offered.
  const neverCast = detectRankUpgrades(
    [rankAlert('a1', 'Allure III')],
    [buildSpellLine('allure', ['Allure III', 'Allure IV'], { 'Allure III': 100 })]
  )
  assert.deepEqual(neverCast, [], 'a rank you have not cast is not an upgrade')

  // An alert on an UNSUFFIXED name can never go stale, so it is never an offer.
  assert.deepEqual(
    detectRankUpgrades([rankAlert('a2', 'Clarity')], [buildSpellLine('clarity', ['Clarity'], {})]),
    []
  )
})

test('U3 ALL defs in a line are considered — a covered rank is never re-offered', () => {
  // Owner amendment: with III and V already covered, only a cast rank ABOVE V is offered.
  const lines = [
    buildSpellLine('allure', ['Allure III', 'Allure V', 'Allure VI'], {
      'Allure V': 500,
      'Allure VI': 900
    })
  ]
  const offers = detectRankUpgrades([rankAlert('a1', 'Allure III'), rankAlert('a2', 'Allure V')], lines)
  assert.equal(offers.length, 1, 'ONE offer per line, never one per stale def')
  assert.equal(offers[0].to, 'Allure VI')
  assert.equal(offers[0].from, 'Allure V', 'Replace targets the HIGHEST covered rank')
  assert.equal(offers[0].alertId, 'a2')
  assert.deepEqual(offers[0].covered, ['Allure III', 'Allure V'])

  // Once VI is covered too, the line is settled — the strip goes quiet instead of nagging.
  const settled = detectRankUpgrades(
    [rankAlert('a1', 'Allure III'), rankAlert('a2', 'Allure V'), rankAlert('a3', 'Allure VI')],
    lines
  )
  assert.deepEqual(settled, [], 'converges — adding alongside ends the offer')
})

test('U4 Add alongside keeps the old alert; Replace re-points it. Both keep user choices', () => {
  const def = rankAlert('suggest:allure:resistRank:allure-iii', 'Allure III')

  const added = addRankAlongsideDef(def, 'Allure III', 'Allure VI')
  assert.notEqual(added.id, def.id, 'a NEW alert — the old one survives a loadout swap back')
  assert.deepEqual(triggerSpells(added.trigger), ['Allure VI'])
  assert.equal(added.name, 'Allure VI resisted', 'the rank inside the name moves with the trigger')
  assert.deepEqual(added.sound, def.sound, 'sound preserved (migrateAlertSounds semantics)')
  assert.equal(added.volume, def.volume)
  assert.equal(added.cooldownMs, def.cooldownMs)
  assert.equal(added.enabled, true)

  const replaced = replaceRankInDef(def, 'Allure III', 'Allure VI')
  assert.equal(replaced.id, def.id, 'Replace edits the SAME alert in place')
  assert.deepEqual(triggerSpells(replaced.trigger), ['Allure VI'])
  assert.deepEqual(replaced.sound, def.sound)
  assert.equal(replaced.cooldownMs, def.cooldownMs)

  // The original object is untouched — these are pure.
  assert.deepEqual(triggerSpells(def.trigger), ['Allure III'])

  // A composite's matching condition is re-pointed; the others are left alone.
  const composite: AlertDef = {
    ...def,
    id: 'c',
    trigger: {
      type: 'any',
      conditions: [
        { type: 'event', kind: 'castBegin', where: { spell: 'Allure III' } },
        { type: 'event', kind: 'resist', where: { spell: 'Mesmerization III' } }
      ]
    }
  }
  assert.deepEqual(triggerSpells(replaceRankInDef(composite, 'Allure III', 'Allure VI').trigger), [
    'Allure VI',
    'Mesmerization III'
  ])
})

test('U5 offer ids are stable and content-derived (the per-offer dismissal key)', () => {
  const lines = [buildSpellLine('allure', ['Allure III', 'Allure VI'], { 'Allure VI': 900 })]
  const a = detectRankUpgrades([rankAlert('a1', 'Allure III')], lines)[0]
  const b = detectRankUpgrades([rankAlert('a1', 'Allure III')], lines)[0]
  assert.equal(a.id, b.id)
  assert.equal(a.id, 'upgrade:allure:allure iii>allure vi')
})
