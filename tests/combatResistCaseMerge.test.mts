// Golden window: ONE MOB IS ONE ROW, WHATEVER EQ CAPITALIZED.
//
// THE REPORT (integrator-verified against the real log + the user's screenshot): the Combat
// dashboard's "Damage by mob" panel showed BOTH `a zol ghoul knight (230)` and
// `A zol ghoul knight (230)` — the same instance split into two rows, the capitalized one
// carrying nothing but a single resist.
//
// THE CAUSE is EQ's prose, not our keying. A mob whose name starts with a lowercase article is
// CAPITALIZED whenever the name opens a sentence, so one spawn is printed two ways:
//
//   mid-sentence      `You slash a zol ghoul knight for 19 points of damage.`
//   sentence-initial  `A zol ghoul knight resisted your Condemnation of Nife!`
//                     `A zol ghoul knight hits YOU for 17 points of damage.`
//
// Resist lines and incoming melee are ALWAYS sentence-initial; outgoing damage is always
// mid-sentence. `WorldModel.resolve()` adopted the LATEST raw sighting's casing as the
// instance display, so the display flip-flopped with every incoming swing and any timeline
// instant written while it happened to be sentence-cased froze the wrong string. Aggregate
// rows key by instanceId, so THEY merely relabelled; the per-mob timeline grouping keys by the
// RAW target string, so it SPLIT. The user saw the split; the aggregates hid it.
//
// THE FIX (src/main/combat/world.ts, adoptDisplay): a lowercase-initial sighting can only have
// come from mid-sentence, so it is the spawn's true name and always wins; a capital-initial
// sighting may be either the true name or sentence-casing, so it may only overwrite another
// capital-initial display. Proper names ("Kahaptra Z`Taj", players, summoned pets) have no
// lowercase variant, so they stay capital→capital latest-wins — untouched. Keying (idKey) is
// not involved at any point and was not changed.
//
// THE WINDOW — tests/fixtures/w34-resist-case-merge.log, raw log lines 1022491..1023067
// (Sun Aug 02 19:28:01 → 19:29:15), extracted by tests/extract-combat-fixtures.mjs through the
// shared scrub. Hand-read; the load-bearing beats:
//   19:28:01  `Auto attack is on.`, six seconds after the PREVIOUS zol knight was slain — so
//             the first damage here provably opens a fresh encounter and the window holds one.
//   19:28:01→ a continuous ghoul-knight grind: three `a zol ghoul knight` spawns (gens 1–3)
//             plus `an urd ghoul wizard`, all slain inside the span. Every outgoing damage
//             line is lowercase; every incoming melee line is sentence-capitalized — the
//             flip-flop runs for the whole 74 seconds.
//   19:28:52  `A zol ghoul knight resisted your Condemnation of Nife!` — THE reported tick.
//             The same knight is backstabbed for 177 one second later (19:28:53) and had taken
//             damage before it, so the resist and the damage are provably one instance.
//   19:29:15  the last knight is slain, loots, and the span ends on the buff-fade line after.
//
// REGRESSION TRIPWIRE: the pre-fix replay of this exact window produced fight total 8927 and
// per-target damage 2597 / 2577 / 2529 / 1224 — identical to the values asserted below. A
// resist carries no amount, so merging the ghost row moves zero points of damage; all it does
// is move ONE resist tick onto the row that owns it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { CombatEngine } from '../src/main/combat/engine'
import { WorldModel } from '../src/main/combat/world'
import { groupByTarget } from '../src/renderer/src/features/combat/dashboardData'
import type { SegmentSummary, TimelineView } from '../src/shared/combat'

// ── the parser half: the input really is two-cased ─────────────────────────────────────

test('the raw log hands us the SAME mob under two casings', () => {
  const hit = parseEvent('[Sun Aug 02 19:28:53 2026] You backstab a zol ghoul knight for 177 points of damage.', 0)
  const res = parseEvent('[Sun Aug 02 19:28:52 2026] A zol ghoul knight resisted your Condemnation of Nife!', 1)
  assert.ok(hit && res)
  assert.equal(hit.kind, 'damage')
  assert.equal(res.kind, 'resist')
  if (hit.kind !== 'damage' || res.kind !== 'resist') throw new Error('unreachable')
  // Mid-sentence keeps the spawn name; sentence-initial capitalizes it. Both are honest
  // parses — the parser must NOT normalize (law 2: names are dirty, display raw).
  assert.equal(hit.target, 'a zol ghoul knight')
  assert.equal(res.target, 'A zol ghoul knight')
  assert.notEqual(hit.target, res.target, 'the strings differ…')
  assert.equal(hit.target.toLowerCase(), res.target.toLowerCase(), '…only by case')
})

// ── the world-model half: the display rule itself ──────────────────────────────────────

test('WorldModel: sentence-casing can never overwrite a lowercase-article name', () => {
  const w = new WorldModel()
  // First sighting is mid-sentence (outgoing damage) → the true name is the display.
  const first = w.resolve('a zol ghoul knight', 1000)
  assert.equal(first.display, 'a zol ghoul knight')
  // The incoming-melee / resist form resolves to the SAME instance (idKey is unchanged)…
  const again = w.resolve('A zol ghoul knight', 2000)
  assert.equal(again.instanceId, first.instanceId, 'casing never forks an instance')
  // …and must NOT drag the display up-case. This is the assertion the bug failed.
  assert.equal(again.display, 'a zol ghoul knight')
  assert.equal(w.label(again), 'a zol ghoul knight')
  // Still pinned after the flip-flop runs a few more rounds.
  w.resolve('A zol ghoul knight', 3000)
  w.resolve('a zol ghoul knight', 4000)
  w.resolve('A zol ghoul knight', 5000)
  assert.equal(first.display, 'a zol ghoul knight')
})

test('WorldModel: a mob first seen sentence-initially converges on its true name, once', () => {
  const w = new WorldModel()
  // spawn() has no prior evidence to weigh, so the first sighting is taken verbatim.
  const inst = w.resolve('A zol ghoul knight', 1000)
  assert.equal(inst.display, 'A zol ghoul knight', 'first sighting wins by default')
  // The first mid-sentence sighting is proof of the real spawn name → it flips…
  assert.equal(w.resolve('a zol ghoul knight', 2000).display, 'a zol ghoul knight')
  // …and the settle is ONE-WAY: it never flips back.
  assert.equal(w.resolve('A zol ghoul knight', 3000).display, 'a zol ghoul knight')
})

test('WorldModel: proper names keep latest-wins — the guard is one-directional', () => {
  const w = new WorldModel()
  // A capital-initial name has no lowercase variant in EQ prose, so both sightings are
  // capital-initial and the newer one still wins (behavior deliberately unchanged).
  const inst = w.resolve('Kahaptra Z`Taj', 1000)
  assert.equal(inst.display, 'Kahaptra Z`Taj')
  assert.equal(w.resolve('KAHAPTRA Z`TAJ', 2000).display, 'KAHAPTRA Z`TAJ')
  // A different identity is never relabelled onto this instance.
  assert.notEqual(w.resolve('a zol ghoul knight', 3000).instanceId, inst.instanceId)
})

// ── the engine half: the golden window ────────────────────────────────────────────────

// Fixtures are COMMITTED (`.gitignore` negates `tests/fixtures/*.log`) — regenerate with
// `node tests/extract-combat-fixtures.mjs <path to eqlog_Primitive_freeport.txt>`.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const W34_PATH = join(FIXTURES, 'w34-resist-case-merge.log')
const W34 = existsSync(W34_PATH)
  ? readFileSync(W34_PATH, 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
  : []
const SKIP = W34.length === 0 && 'fixture not present'

function replay(lines: string[]): { eng: CombatEngine; lastTs: number } {
  const eng = new CombatEngine()
  eng.setPlayerName('Primitive')
  let seq = 0
  let lastTs = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    eng.ingestEvent(ev, false)
    lastTs = ev.ts
  }
  return { eng, lastTs }
}

/** Finalized fights, oldest → newest, observed well after the window (everything closed). */
function fights(eng: CombatEngine, lastTs: number): SegmentSummary[] {
  return eng.snapshot(lastTs + 120_000, {}).segments.filter((s) => s.kind === 'fight').reverse()
}

/** The timeline the dashboard's per-mob panel actually consumes, for one fight. */
function timeline(eng: CombatEngine, lastTs: number, id: string): TimelineView {
  const tl = eng.snapshot(lastTs + 120_000, { selectedId: id, timeline: true }).timeline
  assert.ok(tl, `fight ${id} has no timeline ring`)
  return tl
}

test('W34 ENGINE: the serialized timeline never names one mob two ways', { skip: SKIP }, () => {
  const { eng, lastTs } = replay(W34)
  const fs = fights(eng, lastTs)
  assert.ok(fs.length >= 1, 'the window holds at least one closed fight')

  for (const f of fs) {
    const tl = timeline(eng, lastTs, f.id)
    const targets = tl.events.map((e) => e.target).filter((t): t is string => !!t)
    const raw = new Set(targets)
    const folded = new Set(targets.map((t) => t.toLowerCase()))
    // THE ENGINE-LEVEL INVARIANT (identity, not a frozen count): if two distinct raw target
    // strings ever fold together under lowercasing, the world model emitted one instance under
    // two casings. Pre-fix this window emitted `a zol ghoul knight (3)` AND
    // `A zol ghoul knight (3)`, so raw was 5 and folded was 4.
    assert.equal(
      raw.size,
      folded.size,
      `${f.name}: case-only duplicate target names in the timeline — ${JSON.stringify([...raw].sort())}`
    )
  }
})

test('W34 ENGINE: the resisted knight is labelled with its true lowercase name', { skip: SKIP }, () => {
  const { eng, lastTs } = replay(W34)
  const fs = fights(eng, lastTs)
  const tl = timeline(eng, lastTs, fs[0].id)

  // The reported tick: our own fully-resisted spell (kind 'you'). Incoming resists target YOU
  // and are not what split the panel.
  const outgoing = tl.events.filter((e) => e.outcome === 'resist' && e.kind === 'you')
  assert.ok(outgoing.length >= 1, 'the window carries the reported outgoing resist')
  for (const r of outgoing) {
    assert.ok(r.target, 'an outgoing resist always names its defender')
    // The instance label the ENGINE wrote is the mid-sentence (true) spelling — never the
    // sentence-cased one the resist line itself carried.
    assert.match(r.target!, /^[a-z]/, `resist target "${r.target}" kept EQ's sentence casing`)
    // …and it is a resolvable instance label, not a raw echo of a name we never engaged.
    assert.match(r.target!, /^[^(]+( \(\d+\))?$/, `"${r.target}" is not an instance label`)
  }

  // The whole fight agrees: every outgoing instant names its mob the same way the log's
  // mid-sentence damage lines do.
  for (const e of tl.events) {
    if (e.kind === 'enemy' || !e.target) continue
    assert.match(e.target, /^[a-z]/, `outgoing instant target "${e.target}" is sentence-cased`)
  }

  // The fight's own name comes from the same labels, so it settles lowercase too.
  assert.match(fs[0].name, /^a zol ghoul knight/, 'the fight is named after the true spawn name')
})

test('W34 PANEL: the resist lands on the row that owns the damage', { skip: SKIP }, () => {
  const { eng, lastTs } = replay(W34)
  const fs = fights(eng, lastTs)
  const { rows, total, estimated } = groupByTarget(timeline(eng, lastTs, fs[0].id))
  assert.equal(estimated, false, 'the window is far under the serialization budget — exact numbers')

  // Renderer-level restatement of the same identity: no two rows fold together.
  assert.equal(
    new Set(rows.map((r) => r.target.toLowerCase())).size,
    rows.length,
    `case-only duplicate rows: ${JSON.stringify(rows.map((r) => r.target))}`
  )

  // THE USER-VISIBLE ASSERTION: the resist is not alone on a phantom row. Every row carrying a
  // resist also carries this fight's damage against that same mob.
  const resisted = rows.filter((r) => r.resists >= 1)
  assert.equal(resisted.length, 1, 'exactly one mob resisted us in this window')
  assert.ok(resisted[0].total > 0, `"${resisted[0].target}" carries a resist but no damage — a ghost row`)
  assert.ok(resisted[0].hits > 0, 'the resisted mob was also hit in this fight')
  assert.equal(resisted[0].resists, 1, 'the single Condemnation of Nife resist')

  // Damage is byte-identical to the pre-fix baseline: relabelling a resist moves no points.
  assert.equal(fs[0].total, 8927)
  assert.deepEqual(
    rows.map((r) => [r.target, r.total]),
    [
      ['a zol ghoul knight', 2597],
      ['a zol ghoul knight (3)', 2577],
      ['a zol ghoul knight (2)', 2529],
      ['an urd ghoul wizard', 1224]
    ]
  )
  assert.equal(rows.reduce((s, r) => s + r.total, 0), total, 'per-target damage reconstructs the panel total')
  assert.equal(total, fs[0].total, 'and the panel total is the fight total')
})
