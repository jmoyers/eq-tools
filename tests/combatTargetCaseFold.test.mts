// Task #59 (renderer half): ONE MOB IS ONE ROW, WHATEVER EQ CAPITALIZED IT.
//
// THE REPORT (integrator-verified against the real log): the "Damage by mob" panel showed a
// zol ghoul knight twice — the real row, plus a second row reading "0 · 0%" with a single
// resist on it. EQ writes a mob's article-led name capitalized at SENTENCE START
// ("A zol ghoul knight resisted your Smite!") and lowercase mid-sentence ("You slash a zol
// ghoul knight for 118 points of damage."), so the SAME spawn reaches the timeline ring under
// two spellings. The panel keyed by the raw `target` string, so the two spellings ranked as
// two mobs.
//
// The engine now keeps an instance's display casing stable, but that fix CANNOT retire this
// one: ring events are immutable once written, and a fight whose FIRST sighting of a mob is a
// sentence-initial line (a pull that opens on a resist, exactly as reported) stamps the
// capitalized string into the ring before any mid-sentence line exists to correct it. The
// renderer must therefore fold case-variants itself.
//
// SYNTHETIC (generated, not extracted from any log) — these are pure functions over a
// TimelineView, so a hand-built view states the case far more precisely than a log window
// could. It is deliberately ordered the way the reported fight was: the CAPITALIZED sighting
// comes FIRST, so a fold that simply kept the first-seen spelling would still show the user
// "A zol ghoul knight".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupByTarget, skillsForTarget } from '../src/renderer/src/features/combat/dashboardData'
import type { DamageCategory, TimelineEvent, TimelineView } from '../src/shared/combat'

/** The reported spawn, as the damage lines spell it (mid-sentence: the mob's TRUE name). */
const MOB = 'a zol ghoul knight (230)'
/** The same spawn, as EQ spells it at the start of a sentence. */
const MOB_CAPS = 'A zol ghoul knight (230)'
/** A genuinely different spawn of the same kind — the fold must never swallow it. */
const TWIN = 'a zol ghoul knight (229)'
/** A proper-named mob: its capital is its NAME, not a sentence artifact. */
const NAMED = 'The Hand of Veeshan'

function ev(
  target: string,
  amount: number,
  opts: { lane?: string; category?: DamageCategory; outcome?: 'hit' | 'miss' | 'resist'; t?: number } = {}
): TimelineEvent {
  return {
    t: opts.t ?? 0,
    lane: opts.lane ?? 'Melee',
    category: opts.category ?? 'melee',
    amount,
    crit: false,
    kind: 'you',
    outcome: opts.outcome ?? 'hit',
    target
  }
}

/** A resist tick in the spell's own lane (law 8 — first-class, damage-free). */
function resist(target: string, lane = 'Smite', t = 0): TimelineEvent {
  return ev(target, 0, { lane, category: 'spell', outcome: 'resist', t })
}

/**
 * The fight: the pull OPENS on a sentence-initial resist, so the capitalized spelling is the
 * first thing the ring ever holds for this mob. Folded, the knight is worth
 * 100 + 200 + 300 + 50 = 650 over 4 hits, with 1 resist and 1 miss.
 */
const EVENTS: TimelineEvent[] = [
  resist(MOB_CAPS, 'Smite', 0), // ← the first sighting, and it is capitalized
  ev(MOB_CAPS, 0, { outcome: 'miss', t: 500 }),
  ev(MOB, 100, { t: 1_000 }),
  ev(MOB, 200, { t: 2_000 }),
  ev(MOB, 300, { lane: 'Smite', category: 'spell', t: 3_000 }),
  ev(MOB_CAPS, 50, { t: 4_000 }), // a later sentence-initial line, mid-fight
  ev(TWIN, 400, { t: 5_000 }),
  ev(NAMED, 500, { t: 6_000 })
]

const TL: TimelineView = {
  id: 'e1',
  name: MOB,
  durationMs: 7_000,
  lanes: [],
  events: EVENTS,
  stanceSpans: [],
  downsampled: false,
  rawCount: EVENTS.length,
  totalCount: EVENTS.length,
  truncated: false
}

test('per-mob rows fold case-variants of ONE spawn into ONE row', () => {
  const { rows, total, estimated } = groupByTarget(TL)
  assert.equal(estimated, false, 'a hand-built exact view claims nothing')

  // THE ASSERTION THE BUG FAILED: three mobs were fought, so three rows — not four.
  assert.equal(rows.length, 3, 'the two spellings are one mob')
  assert.ok(
    !rows.some((r) => r.target === MOB_CAPS),
    'the sentence-initial spelling must never surface as its own row'
  )

  const knight = rows.find((r) => r.target === MOB)
  assert.ok(knight, `the folded row is labelled with the mid-sentence name (${MOB})`)
  assert.equal(knight.total, 650, 'damage from both spellings sums onto the one row')
  assert.equal(knight.hits, 4)
  assert.equal(knight.resists, 1, 'the opening resist counts on the mob that resisted')
  assert.equal(knight.misses, 1)

  // The lone-resist ghost the user saw is gone: no 0-damage row survives at all here.
  assert.ok(rows.every((r) => r.total > 0), 'no "0 · 0%" phantom')
  assert.equal(total, 1550, '650 + 400 + 500 — the fold moves damage between rows, never out')
})

test('the fold is by NAME, not by shape: a real twin and a proper name are untouched', () => {
  const { rows } = groupByTarget(TL)
  const targets = rows.map((r) => r.target).sort()
  assert.deepEqual(targets, [MOB, TWIN, NAMED].sort(), 'exactly the three spawns, spelled as fought')

  // (229) differs from (230) by its INSTANCE, not its casing — folding by lowercase key must
  // still tell them apart.
  const twin = rows.find((r) => r.target === TWIN)
  assert.ok(twin)
  assert.equal(twin.total, 400, 'the twin keeps its own damage')

  // "The Hand of Veeshan" was only ever seen capitalized; that IS its name. Nothing to prefer,
  // so nothing is lowercased — the fold relabels only when it has seen a lowercase variant.
  assert.ok(rows.some((r) => r.target === NAMED), 'a proper name keeps its capital')
})

test('the folded row still ranks honestly — pct and share are identities, not constants', () => {
  const { rows, total } = groupByTarget(TL)
  assert.equal(
    rows.reduce((s, r) => s + r.total, 0),
    total,
    'per-mob damage reconstructs the panel total'
  )
  const shares = rows.reduce((s, r) => s + r.share, 0)
  assert.ok(Math.abs(shares - 100) < 1e-9, 'shares are a partition of the outgoing total')
  const max = Math.max(...rows.map((r) => r.total))
  assert.equal(rows[0].total, max, 'sorted damage-desc')
  assert.equal(rows[0].pct, 100, 'the biggest bar fills the row')
  for (const r of rows) assert.ok(Math.abs(r.pct - (r.total / max) * 100) < 1e-9)
  for (const r of rows) assert.ok(Math.abs(r.share - (r.total / total) * 100) < 1e-9)
})

test('drilling the folded row returns the UNION of both spellings', () => {
  const detail = skillsForTarget(TL, MOB)
  assert.equal(detail.total, 650, 'the drill total matches the row it was opened from')
  assert.equal(detail.hits, 4)
  assert.equal(detail.resists, 1)
  assert.equal(detail.misses, 1)

  const byLane = new Map(detail.rows.map((r) => [r.name, r]))
  const melee = byLane.get('Melee')
  assert.ok(melee, 'the melee lane survives the fold')
  assert.equal(melee.total, 350, '100 + 200 + 50 — the capitalized swing is in there')
  assert.equal(melee.hits, 3)
  assert.equal(melee.misses, 1)
  assert.equal(melee.max, 200)
  assert.equal(melee.min, 50, 'min over LANDED amounts — the miss tick carries no amount')

  const smite = byLane.get('Smite')
  assert.ok(smite, 'the resisted lane is a lane of its own (law 8)')
  assert.equal(smite.total, 300)
  assert.equal(smite.hits, 1)
  assert.equal(smite.resists, 1, 'the sentence-initial resist reaches the mob it belongs to')
})

test('the drill is case-insensitive from EITHER spelling', () => {
  // A persisted drill (overlays.<kind>.drill) can hold whichever spelling was on screen when
  // the user clicked; both must resolve to the same mob.
  const fromLower = skillsForTarget(TL, MOB)
  const fromUpper = skillsForTarget(TL, MOB_CAPS)
  assert.deepEqual(fromUpper.rows, fromLower.rows)
  assert.equal(fromUpper.total, fromLower.total)
  assert.equal(fromUpper.resists, fromLower.resists)

  // …and it still isolates ONE mob: the twin's 400 never leaks in.
  assert.equal(skillsForTarget(TL, TWIN).total, 400)
  assert.equal(skillsForTarget(TL, NAMED).total, 500)
})

test('an unknown-target instant still gets its own visible row', () => {
  const tl: TimelineView = {
    ...TL,
    events: [...EVENTS, { ...ev(MOB, 25, { t: 6_500 }), target: undefined }]
  }
  const { rows } = groupByTarget(tl)
  assert.equal(rows.length, 4)
  const unknown = rows.find((r) => r.target === 'unknown target')
  assert.ok(unknown, 'the unnamed-defender fallback is kept visible, not folded away')
  assert.equal(unknown.total, 25)
  assert.equal(skillsForTarget(tl, 'unknown target').total, 25)
})
