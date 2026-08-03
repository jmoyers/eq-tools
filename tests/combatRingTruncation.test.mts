// PROACTIVE HONESTY (world-model law 1 — anything inferred/partial is LABELED): the
// per-encounter timeline ring is capped DROP-OLDEST at TIMELINE_CAP (8,000). Before this
// change, once it overflowed:
//
//   - `TimelineView.rawCount` reported the RING LENGTH, so the timeline footer and the
//     dashboard's `~ N of M events` chip quoted the ring's own CAPACITY as if it were the
//     size of the fight ("2000 of 8000") — the count of instants the fight actually
//     produced was gone;
//   - every event-derived panel (DPS curve, Damage by mob, the per-mob flat skill rows)
//     therefore reported the retained TAIL of the fight as though it were the whole fight,
//     with no `~` and no explainer. A silent understatement.
//
// This is NOT a live bug: the busiest fight in the real log peaks at 5,259 instants, well
// under the cap (see AGENTS.md law 8), so drop-oldest has never engaged on real data — the
// last test here asserts exactly that on a real committed window. Everything above it is
// therefore driven by SYNTHETIC, MACHINE-GENERATED combat lines (`burst()` below): a
// uniform stream of identical 100-damage swings, deliberately not claiming to be a real
// log. That is the only way to reach the cap, and identical amounts make the arithmetic
// truth of the aggregate ("N events × 100") checkable by hand.
//
// THE SIGNAL: `Encounter.eventsTotal`, ONE integer per encounter bumped in pushTimeline,
// surfaced as `TimelineView.totalCount` (true instant count) + `truncated`
// (`totalCount > rawCount`). `rawCount` keeps its old meaning — the ring occupancy — because
// it is the population the uniform stride samples and therefore the only honest denominator
// for `sampleScale`. Scaling by `totalCount` instead would extrapolate the DISCARDED prefix
// from the retained tail, i.e. invent damage; truncation is a lower bound, not an estimate,
// and it is labeled with the same `~` + chip as downsampling rather than a new vocabulary.
//
// TRIPWIRE: the ring is display metadata. No damage total, count or attribution may move
// when it overflows, and asking for a timeline (which walks the ring) may not perturb the
// aggregate at all — asserted byte-for-byte below.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import {
  approxNote,
  groupByTarget,
  isApproximate,
  sampleScale,
  skillsForTarget
} from '../src/renderer/src/features/combat/dashboardData'
import type { CombatSnapshot, TimelineEvent, TimelineView } from '../src/shared/combat'

// Mirrors of the engine-private constants (src/main/combat/engine.ts). Kept as named
// locals so a future bump reads as one edit here, not as six mystery numbers below.
const RING_CAP = 8_000
const SERIALIZE_BUDGET = 2_000

const MOB = 'a deadly black widow'
const HIT = 100
/** Instants per synthetic second — dense enough to reach the cap in ~3 log minutes. */
const PER_SEC = 50

/** `[Sun Aug 02 16:50:57 2026]`-style stamp. The weekday is ignored by parseEqTimestamp. */
function stamp(sec: number): string {
  const d = new Date(Date.UTC(2026, 7, 2, 16, 0, 0) + sec * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `[Sun Aug ${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(
    d.getUTCSeconds()
  )} 2026]`
}

/**
 * SYNTHETIC (generated, not extracted from any log): `n` identical outgoing melee hits on
 * one mob, PER_SEC per second so the encounter never idles closed. Every swing lands for
 * exactly HIT, so the fight's true total is `n * HIT` by construction.
 */
function burst(n: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(`${stamp(Math.floor(i / PER_SEC))} You slash ${MOB} for ${HIT} points of damage.`)
  }
  return lines
}

/** Replay lines into a fresh engine. `timelineEvery` also pulls a TIMELINE snapshot every
 *  N lines, which walks the (overflowing) ring — used to prove that is side-effect-free. */
function replay(lines: string[], timelineEvery = 0): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
    if (timelineEvery > 0 && seq % timelineEvery === 0) eng.snapshot(lastTs, { timeline: true })
  }
  return { eng, lastTs }
}

/** The live fight's timeline — what the dashboard panels consume. */
function timelineOf(eng: CombatEngine, now: number): TimelineView {
  const tl = eng.snapshot(now, { timeline: true }).timeline
  assert.ok(tl, 'the open fight must carry a timeline ring')
  return tl
}

/** The one outgoing source row (You) of the live fight. */
function outSource(snap: CombatSnapshot): { total: number; hits: number } {
  const you = snap.selected?.entities.find((e) => e.kind === 'you')
  assert.ok(you, 'the synthetic burst is all your own swings')
  return { total: you.total, hits: you.hits }
}

// ── the signal ────────────────────────────────────────────────────────────────────────

test('SYNTHETIC burst past the ring cap: truncation is DECLARED, with the true count', () => {
  const n = 9_000 // > RING_CAP, so drop-oldest engages for 1,000 instants
  const { eng, lastTs } = replay(burst(n))
  const tl = timelineOf(eng, lastTs)

  assert.equal(tl.totalCount, n, 'totalCount is every instant the fight ever recorded')
  assert.equal(tl.rawCount, RING_CAP, 'rawCount stays the RING occupancy (the sampling population)')
  assert.equal(tl.truncated, true, 'drop-oldest engaged → the loss is declared, not silent')
  assert.ok(tl.totalCount > tl.rawCount, 'the two counts diverge exactly when the ring overflows')

  // Both losses stack here (the cap is above the serialization budget, so a truncated ring
  // is always downsampled too): stride 4 over 8,000 retained instants.
  assert.equal(tl.downsampled, true)
  assert.equal(tl.events.length, SERIALIZE_BUDGET)
  assert.equal(sampleScale(tl), RING_CAP / SERIALIZE_BUDGET, 'scale is ring ÷ kept — never total ÷ kept')
})

test('an UNDER-cap fight declares no truncation and the two counts agree', () => {
  const n = 7_000 // < RING_CAP: downsampled, but nothing dropped
  const { eng, lastTs } = replay(burst(n))
  const tl = timelineOf(eng, lastTs)

  assert.equal(tl.truncated, false)
  assert.equal(tl.totalCount, n)
  assert.equal(tl.rawCount, n, 'no overflow → the ring IS the fight')
  assert.equal(tl.downsampled, true, 'still over the serialization budget — the other, unbiased loss')
})

// ── the tripwire: aggregates are independent of the ring ──────────────────────────────

test('TRIPWIRE: overflowing the ring moves no damage, count or attribution', () => {
  const n = 9_000
  const { eng, lastTs } = replay(burst(n))
  const snap = eng.snapshot(lastTs, {})
  const you = outSource(snap)

  // The meter counts every swing — including the 1,000 whose ring records were evicted.
  assert.equal(you.total, n * HIT, 'the aggregate is the WHOLE fight, not the retained window')
  assert.equal(you.hits, n)
  assert.equal(snap.selected?.outTotal, n * HIT)

  // The per-source taxonomy tripwire from AGENTS.md law 8 still holds under truncation.
  const src = snap.selected?.entities.find((e) => e.kind === 'you')
  assert.ok(src)
  assert.equal(src.categories.reduce((s, c) => s + c.total, 0), src.total, 'Σ category.total == source.total')
  assert.equal(src.skills.reduce((s, k) => s + k.total, 0), src.total)

  // Linearity across the cap boundary: 2,000 more swings than the under-cap run means
  // exactly 2,000 × HIT more damage. Nothing is lost where the ring starts dropping.
  const under = replay(burst(7_000))
  const underYou = outSource(under.eng.snapshot(under.lastTs, {}))
  assert.equal(you.total - underYou.total, 2_000 * HIT)
  assert.equal(you.hits - underYou.hits, 2_000)
})

test('TRIPWIRE: asking for a timeline is byte-identical to never asking', () => {
  const n = 9_000
  const lines = burst(n)
  // A: plain replay, aggregate read once at the end.
  const a = replay(lines)
  const plain = JSON.stringify(a.eng.snapshot(a.lastTs, {}).selected)
  // B: same replay, but a TIMELINE snapshot is pulled every 500 lines — buildTimeline walks
  // (and downsamples) an overflowing ring hundreds of times mid-fight.
  const b = replay(lines, 500)
  const walked = JSON.stringify(b.eng.snapshot(b.lastTs, {}).selected)
  assert.equal(walked, plain, 'building timelines must not perturb the aggregate by one byte')

  // And the aggregate is identical whether or not the same snapshot call serializes a ring.
  const withTl = JSON.stringify(b.eng.snapshot(b.lastTs, { timeline: true }).selected)
  assert.equal(withTl, plain)

  // Repeated builds are stable: the counters are read-only to buildTimeline.
  const t1 = timelineOf(b.eng, b.lastTs)
  const t2 = timelineOf(b.eng, b.lastTs)
  assert.deepEqual(
    [t1.totalCount, t1.rawCount, t1.truncated, t1.events.length],
    [t2.totalCount, t2.rawCount, t2.truncated, t2.events.length]
  )
  assert.equal(t1.totalCount, n)
})

// ── the renderer half: every derived number is labeled ────────────────────────────────

test('the event-derived panels UNDERSTATE a truncated fight — so they must be labeled', () => {
  const n = 9_000
  const { eng, lastTs } = replay(burst(n))
  const tl = timelineOf(eng, lastTs)
  const truth = n * HIT

  const mobs = groupByTarget(tl)
  assert.equal(mobs.estimated, true, 'the per-mob panel wears `~`')
  assert.equal(mobs.rows.length, 1)
  // Scaled back up over the RING only: 2,000 kept × stride 4 × HIT = the retained window.
  assert.equal(mobs.total, RING_CAP * HIT)
  assert.ok(mobs.total < truth, 'it is a LOWER BOUND on the fight — never extrapolated to the truth')
  assert.equal(mobs.rows[0].hits, RING_CAP)

  const detail = skillsForTarget(tl, mobs.rows[0].target)
  assert.equal(detail.estimated, true, 'the flat per-mob skill rows wear `~` too')
  assert.equal(detail.total, RING_CAP * HIT)
  assert.equal(detail.rows.length, 1)
  assert.equal(detail.rows[0].max, HIT, 'an observed max is never scaled (lower bound, both losses)')

  // THE CHIP: it quotes the fight's TRUE instant count, not the ring's capacity, and knows
  // which loss to explain. Pre-fix this read "2000 of 8000".
  assert.deepEqual(approxNote(tl), {
    shown: SERIALIZE_BUDGET,
    of: n,
    downsampled: true,
    truncated: true
  })
})

test('truncation alone (no downsampling) still labels — the predicate is the LOSS, not the scale', () => {
  // A hand-built view for the config where the ring cap sits at or below the serialization
  // budget: nothing was sampled away (scale 1), but the oldest instants are still gone.
  const ev = (amount: number): TimelineEvent => ({
    t: 0,
    lane: 'Melee',
    category: 'melee',
    amount,
    crit: false,
    kind: 'you',
    target: MOB
  })
  const tl: TimelineView = {
    id: 'e1',
    name: MOB,
    durationMs: 10_000,
    lanes: [],
    events: [ev(100), ev(200)],
    stanceSpans: [],
    downsampled: false,
    rawCount: 2,
    totalCount: 10,
    truncated: true
  }
  assert.equal(isApproximate(tl), true)
  assert.equal(sampleScale(tl), 1, 'no stride to undo — and the dropped 8 are NOT extrapolated')
  const mobs = groupByTarget(tl)
  assert.equal(mobs.estimated, true, 'labeled even though nothing was scaled')
  assert.equal(mobs.total, 300, 'the honest sum of what we still hold — a lower bound')
  assert.equal(skillsForTarget(tl, MOB).estimated, true)
  assert.deepEqual(approxNote(tl), { shown: 2, of: 10, downsampled: false, truncated: true })
})

test('an exact timeline claims nothing: no note, no `~`', () => {
  const { eng, lastTs } = replay(burst(120))
  const tl = timelineOf(eng, lastTs)
  assert.equal(tl.truncated, false)
  assert.equal(tl.downsampled, false)
  assert.equal(tl.totalCount, tl.rawCount)
  assert.equal(tl.events.length, 120)
  assert.equal(isApproximate(tl), false)
  assert.equal(approxNote(tl), null)
  assert.equal(groupByTarget(tl).total, 120 * HIT, 'exact ring → exact panel numbers')
})

// ── real data: the signal does not fire on any fight this log has ever seen ────────────

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const W25_PATH = join(FIXTURES, 'w25-per-mob-miss-ghosts.log')
const W25 = existsSync(W25_PATH)
  ? readFileSync(W25_PATH, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
  : []
const SKIP = W25.length === 0 && 'fixture not present'

test('W25 (REAL window): no real fight truncates — the flag never fires spuriously', { skip: SKIP }, () => {
  const { eng, lastTs } = replay(W25)
  const now = lastTs + 120_000
  const fights = eng.snapshot(now, {}).segments.filter((s) => s.kind === 'fight')
  assert.ok(fights.length > 0)
  for (const f of fights) {
    const tl = eng.snapshot(now, { selectedId: f.id, timeline: true }).timeline
    assert.ok(tl, `fight ${f.id} kept its ring`)
    assert.equal(tl.truncated, false, `${f.name} is nowhere near the ${RING_CAP} cap`)
    assert.equal(tl.totalCount, tl.rawCount, 'nothing dropped → the counts agree')
    assert.equal(tl.events.length, tl.totalCount, 'and it is under the serialization budget')
    assert.equal(approxNote(tl), null, 'so the panels claim exactness — and are exact')
  }
})
