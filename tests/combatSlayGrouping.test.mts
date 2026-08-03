// Slay Undead is ONE ability, not four weapons.
//
// A Slay Undead proc is a normal weapon swing that carries the proc, so the taxonomy tags it
// 'slay' but the SKILL name stays the weapon verb. The renderer's flat level-2 list therefore
// grew a run of near-duplicate rows — "Melee · Slay Undead", "Backstab · Slay Undead",
// "Bash · Slay Undead" — that a player reads as one thing. `groupSlay` (renderer-side only;
// the engine's aggregation and the shared types are untouched) merges them into a single
// "Slay Undead" row that carries its per-weapon rows as `children` for the row's expansion.
//
// These are pure derivations over already-aggregated data, so the window here is synthetic:
// there is no log line to hand-read, only arithmetic (sums, an observed max ACROSS weapons, a
// min over LANDED hits only) and the invariant that grouping conserves every total.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flattenSkills, groupSlay, skillsForTarget } from '../src/renderer/src/features/combat/dashboardData'
import type { SkillView, SourceView, TimelineEvent, TimelineView } from '../src/shared/combat'

function skill(name: string, over: Partial<SkillView> = {}): SkillView {
  return { name, total: 0, pct: 0, hits: 0, crits: 0, max: 0, ...over }
}

/** Only `categories` is read by flattenSkills — the rest of SourceView is irrelevant here. */
function source(categories: SourceView['categories']): SourceView {
  return { categories } as unknown as SourceView
}

function cat(category: SourceView['categories'][number]['category'], skills: SkillView[]): SourceView['categories'][number] {
  const total = skills.reduce((n, s) => n + s.total, 0)
  return {
    category,
    total,
    pct: 100,
    hits: skills.reduce((n, s) => n + s.hits, 0),
    crits: 0,
    critPct: 0,
    max: Math.max(0, ...skills.map((s) => s.max)),
    resists: 0,
    resistPct: 0,
    skills
  }
}

test('flattenSkills collapses every slay skill into ONE "Slay Undead" row', () => {
  const e = source([
    cat('melee', [skill('Melee', { total: 5000, hits: 100, crits: 4, max: 120, min: 10, misses: 20 })]),
    cat('slay', [
      skill('Melee', { total: 3000, hits: 30, crits: 2, max: 300, min: 40, misses: 5 }),
      skill('Backstab', { total: 2000, hits: 10, crits: 1, max: 500, min: 60 }),
      skill('Bash', { total: 1000, hits: 8, crits: 0, max: 200, min: 25, misses: 3 })
    ]),
    cat('spell', [skill('Ancient Wrath', { total: 4000, hits: 5, crits: 0, max: 900, min: 700, resists: 2 })])
  ])

  const rows = flattenSkills(e)
  assert.equal(rows.filter((r) => r.category === 'slay').length, 1, 'exactly one slay row survives')

  const slay = rows.find((r) => r.category === 'slay')!
  assert.equal(slay.name, 'Slay Undead')
  assert.equal(slay.total, 6000)
  assert.equal(slay.hits, 48)
  assert.equal(slay.crits, 3)
  assert.equal(slay.misses, 8)
  // max/min span ALL weapons: the biggest proc anywhere, and the smallest LANDED one.
  assert.equal(slay.max, 500)
  assert.equal(slay.min, 25)
  assert.deepEqual(slay.children?.map((c) => c.name), ['Melee', 'Backstab', 'Bash'], 'children ranked by damage')

  // Conservation: grouping moves no damage, and no non-slay row is touched.
  const before = e.categories.flatMap((c) => c.skills).reduce((n, s) => n + s.total, 0)
  assert.equal(rows.reduce((n, r) => n + r.total, 0), before)
  assert.deepEqual(
    rows.filter((r) => r.category !== 'slay').map((r) => r.name),
    ['Melee', 'Ancient Wrath']
  )

  // pct is re-based on the NEW global max — the merged row is now the biggest bar.
  assert.equal(Math.max(...rows.map((r) => r.pct)), 100)
  assert.equal(slay.pct, 100)
})

test('a lone slay skill is left exactly as it is (a group of one is a wrapper around nothing)', () => {
  const e = source([
    cat('melee', [skill('Melee', { total: 5000, hits: 100, max: 120, min: 10 })]),
    cat('slay', [skill('Backstab', { total: 900, hits: 3, max: 400, min: 200 })])
  ])
  const rows = flattenSkills(e)
  const slay = rows.filter((r) => r.category === 'slay')
  assert.equal(slay.length, 1)
  assert.equal(slay[0].name, 'Backstab', 'keeps the weapon name — strictly more informative')
  assert.equal(slay[0].children, undefined, 'and gains no expansion')
})

test('groupSlay ignores a min of 0 (a resist/miss-only lane carries no amount)', () => {
  const rows = groupSlay([
    { ...skill('Melee', { total: 100, hits: 1, max: 100, min: 100 }), category: 'slay' },
    { ...skill('Kick', { total: 0, hits: 0, max: 0, misses: 4 }), category: 'slay' }
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].min, 100, 'the min never collapses to 0 on an all-avoided lane')
  assert.equal(rows[0].misses, 4)
})

test('the per-mob list groups slay the same way, over sample-scaled numbers', () => {
  const ev = (lane: string, category: TimelineEvent['category'], amount: number): TimelineEvent => ({
    t: 0,
    lane,
    category,
    amount,
    crit: false,
    kind: 'you',
    target: 'a decaying skeleton'
  })
  const events: TimelineEvent[] = [
    ev('Melee', 'melee', 50),
    ev('Melee', 'slay', 200),
    ev('Backstab', 'slay', 300),
    ev('Bash', 'slay', 100),
    { ...ev('Melee', 'slay', 0), outcome: 'miss' },
    // a different defender must not leak in
    { ...ev('Melee', 'slay', 999), target: 'a rat' }
  ]
  const tl: TimelineView = {
    id: 'e1',
    name: 'a decaying skeleton',
    durationMs: 10_000,
    lanes: [],
    events,
    stanceSpans: [],
    // downsampled 1-in-2 → every count/total is a scaled estimate; the group must sum the
    // SAME estimates its children display (the `~` chip explains the scaling to the user).
    downsampled: true,
    rawCount: events.length * 2,
    // The ring never overflowed here, so the true instant count IS the ring occupancy and
    // the only loss is the (unbiased) stride. See combatRingTruncation.test.mts for the
    // truncated case, where these two diverge.
    totalCount: events.length * 2,
    truncated: false
  }

  const detail = skillsForTarget(tl, 'a decaying skeleton')
  assert.ok(detail.estimated)
  const slay = detail.rows.filter((r) => r.category === 'slay')
  assert.equal(slay.length, 1)
  assert.equal(slay[0].name, 'Slay Undead')
  assert.equal(slay[0].total, 1200, '(200+300+100) × 2')
  assert.equal(slay[0].hits, 6)
  assert.equal(slay[0].misses, 2)
  assert.equal(slay[0].max, 300, 'observed max is never scaled')
  assert.equal(slay[0].min, 100)
  assert.equal(
    slay[0].children?.reduce((n, c) => n + c.total, 0),
    slay[0].total,
    'the group is exactly the sum of the rows it stands for'
  )
  assert.deepEqual(
    detail.rows.filter((r) => r.category !== 'slay').map((r) => r.name),
    ['Melee'],
    'plain melee stays its own row'
  )
})
