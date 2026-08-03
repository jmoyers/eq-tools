// TASK #64 — mobsInZone: the join between the RAW zone the log printed and the committed mob
// catalog's `zones` field. Pure string folding + a sort, so this suite is pure too: no Electron,
// no fixtures, NEVER skips.
//
// Two halves. The first drives a hand-authored catalog so each fold rule and the sort order are
// pinned in isolation. The second drives the REAL committed catalog with VERBATIM zone strings
// from the live log (`grep -oaE "You have entered [^.]*\."`, 2026-08-03) — that is where the
// rules came from, and a scrape that renamed a zone should fail here rather than silently show
// an empty roster in the app.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MobEntry } from '../src/shared/types'
// RELATIVE, not `@shared/…`-style: these are VALUE imports and the alias only exists inside the
// vite build (mobSearch.ts:33 documents the same constraint for the same reason).
import { mobsInZone, zoneKey } from '../src/renderer/src/features/mobs/mobZone'
import mobsJson from '../src/renderer/src/data/eqlegends/mobs.json'

/** A minimal catalog row — only the fields mobsInZone reads. */
function entry(page: string, name: string, level: string | undefined, zones: string[]): MobEntry {
  return level === undefined ? { page, name, zones } : { page, name, level, zones }
}

const CATALOG: MobEntry[] = [
  entry('p1', 'a gust of wind', '53', ['Plane of Sky']),
  entry('p2', 'A blade storm', '59-61', ['Plane of Sky']),
  entry('p3', 'a presence', '50', ['Plane of Sky']),
  entry('p4', 'a mystery', undefined, ['Plane of Sky']),
  entry('p5', 'an unconsiderable thing', 'You can’t consider that.', ['Plane of Sky']),
  entry('p6', 'a froglok', '30', ['Innothule Swamp']),
  entry('p7', 'a bandit', '9-12', ['Eastern Karana', 'Lake Rathe'])
]

// =============================================================================
// 1. THE FOLD
// =============================================================================

test('mobsInZone: exact zone match', () => {
  const rows = mobsInZone('Innothule Swamp', CATALOG)
  assert.deepEqual(rows.map((r) => r.page), ['p6'])
})

test('mobsInZone: case and whitespace fold', () => {
  assert.deepEqual(mobsInZone('  innothule   SWAMP  ', CATALOG).map((r) => r.page), ['p6'])
})

test('mobsInZone: leading article folds on both sides', () => {
  // Log says "The Plane of Sky"; the catalog says "Plane of Sky". Both directions must work,
  // because the catalog itself carries both spellings ("The Feerrott" 40 rows / "Feerrott" 1).
  assert.equal(mobsInZone('The Plane of Sky', CATALOG).length, 5)
  assert.equal(zoneKey('The Feerrott'), zoneKey('Feerrott'))
  assert.equal(zoneKey('the oasis of marr'), 'oasis of marr')
})

test('mobsInZone: instance tier + Solo/Group noise is stripped', () => {
  for (const raw of [
    'The Plane of Sky (Awakened)',
    'The Plane of Sky 1 (Awakened)',
    'The Plane of Sky 2 (Adaptive)',
    'The Plane of Sky 3 (Fused)',
    'The Plane of Sky 4 (Refined)',
    'The Plane of Sky - Solo',
    'The Plane of Sky - Solo 4 (Refined)',
    'The Plane of Sky - Group 2'
  ]) {
    assert.equal(mobsInZone(raw, CATALOG).length, 5, raw)
  }
})

test('zoneKey: separator punctuation collapses', () => {
  // Log "Neriak - Commons" vs catalog "Neriak Commons" is the real case this exists for.
  assert.equal(zoneKey('Neriak - Commons'), zoneKey('Neriak Commons'))
  assert.equal(zoneKey('Cazic-Thule'), zoneKey('Cazic Thule'))
})

test('mobsInZone: no match returns []', () => {
  assert.deepEqual(mobsInZone('Kael Drakkel', CATALOG), [])
  // A zone we have not learned yet (fresh log) matches nothing, never everything.
  assert.deepEqual(mobsInZone('', CATALOG), [])
  assert.deepEqual(mobsInZone('   ', CATALOG), [])
})

test('mobsInZone: a multi-zone row matches any of its zones', () => {
  assert.deepEqual(mobsInZone('Lake Rathe', CATALOG).map((r) => r.page), ['p7'])
  assert.deepEqual(mobsInZone('Eastern Karana', CATALOG).map((r) => r.page), ['p7'])
})

// =============================================================================
// 2. THE SORT
// =============================================================================

test('mobsInZone: level ascending, unknown level last, name tiebreak', () => {
  const rows = mobsInZone('Plane of Sky', CATALOG)
  assert.deepEqual(rows.map((r) => r.name), [
    'a presence', //            50
    'a gust of wind', //        53
    'A blade storm', //         59-61 → sorts on the low end, 59
    'a mystery', //             no level at all
    'an unconsiderable thing' //  level text with no digits — same unknown bucket, name tiebreak
  ])
})

test('mobsInZone: name tiebreak is case-insensitive', () => {
  const tie: MobEntry[] = [
    entry('t2', 'b thing', '10', ['Nowhere']),
    entry('t1', 'A thing', '10', ['Nowhere'])
  ]
  assert.deepEqual(mobsInZone('Nowhere', tie).map((r) => r.page), ['t1', 't2'])
})

test('mobsInZone: does not mutate the caller’s catalog order', () => {
  const before = CATALOG.map((r) => r.page)
  mobsInZone('Plane of Sky', CATALOG)
  assert.deepEqual(CATALOG.map((r) => r.page), before)
})

// =============================================================================
// 3. THE REAL CATALOG, driven by VERBATIM live-log zone strings
// =============================================================================

const REAL: MobEntry[] = (mobsJson as unknown as { mobs: MobEntry[] }).mobs

test('real catalog: live-log zone strings resolve to a roster', () => {
  // Every one of these is a line the real log actually printed. The counts are FLOORS, not
  // equalities (AGENTS.md "frozen numbers rot" — a future scrape only adds pages).
  const cases: [string, number][] = [
    ['Innothule Swamp', 40],
    ['The Oasis of Marr', 30], //          article fold
    ['The Northern Desert of Ro', 20], //  article fold
    ['The Plane of Sky', 60], //           article fold
    ['The Plane of Sky 1 (Awakened)', 60], // + tier ordinal
    ['Najena 4 (Refined)', 30], //         tier ordinal, no article
    ['East Freeport', 100],
    ['Neriak - Commons', 80] //            separator collapse
  ]
  for (const [zone, floor] of cases) {
    assert.ok(mobsInZone(zone, REAL).length >= floor, `${zone} → ${mobsInZone(zone, REAL).length}`)
  }
})

test('real catalog: an instance is the same roster as its base zone', () => {
  const base = mobsInZone('The Plane of Sky', REAL).map((r) => r.page)
  for (const raw of ['The Plane of Sky 1 (Awakened)', 'The Plane of Sky - Solo 4 (Refined)']) {
    assert.deepEqual(mobsInZone(raw, REAL).map((r) => r.page), base, raw)
  }
})

test('real catalog: an unknown place returns [] rather than guessing', () => {
  // A zone whose two sources genuinely use different NAMES (log "The Ruins of Old Guk" vs the
  // catalog's "Lower Guk"/"Upper Guk"). The honest answer is the empty state — this pins that we
  // never widen the fold into fuzzy zone matching.
  assert.deepEqual(mobsInZone('Definitely Not A Zone', REAL), [])
})
