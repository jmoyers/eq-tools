// GOLDEN-WINDOW TESTS FOR THE RECENT-KILLS RING AND ITS EXPERIENCE JOIN.
//
// A sibling of progressionWindows.test.mts (same fixtures, same replay methodology) rather than
// more of it: that file is at the measured 400-code-line factoring ceiling, and this is its own
// subject — WHAT you killed and what it paid, as opposed to the range statistics.
//
// THE DIRECTION OF THE JOIN WAS MEASURED, NOT ASSUMED — and the feature brief had it BACKWARDS
// ("a credited kill takes the NEXT experience line"). FULL-LOG SWEEP (read-only, 1.11M lines):
// 4909 experience lines, 5988 slain lines; for 4887 of the 4909 the nearest slain line is the one
// AFTER it, with a timestamp gap of 0 s (4856×) or 1 s (25×). The experience line PRECEDES its
// kill line — always, and essentially always in the same second. Not one experience line in the
// whole log follows its kill inside 4 s.
//
// So the join looks BACK: a kill claims the most recent unclaimed experience line within
// KILL_EXP_JOIN_MS before it, and claiming CONSUMES the line so it can never be attributed twice.
// Every expectation below is read off the fixture in that order.
//
//   WL45  the join in eleven rows, including a kill that paid NOTHING and a bound-pet kill.
//   WL43  at the cap: the line joins and states no size — a different unknown from "no line".
//   WL44  party experience, joined and labeled.
// Plus synthesized edge cases for the rule itself, the drop-oldest ring, the renderer's delta
// merge, and a full-log tripwire that is a FLOOR (the live log grows; frozen counts rot).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { parseEvent } from '../src/main/log/parser'
import { EpochDetector } from '../src/main/log/epochDetector'
import {
  KILL_EXP_JOIN_MS,
  ProgressionModule,
  RECENT_KILL_CAP
} from '../src/main/modules/progression'
import {
  EMPTY_PROGRESSION,
  applyProgressionDelta
} from '../src/renderer/src/features/leveling/progressionDelta'
import type { ProgressionKill, ProgressionSnap } from '../src/shared/progressionTypes'
import { readFixture } from './harness.mts'

const LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'

const T = (stamp: string): number => Date.parse(stamp)

/** Replay raw lines through the real parser + ProgressionModule (see progressionWindows). */
function replayModule(lines: string[], withEpoch: boolean): ProgressionModule {
  const mod = new ProgressionModule()
  mod.reset()
  const epoch = new EpochDetector()
  epoch.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (!ev) continue
    mod.onEvent(ev, false)
    if (withEpoch) {
      const epochEv = epoch.observe(ev)
      if (epochEv) mod.onEvent(epochEv, false)
    }
  }
  return mod
}

/**
 * Every ring row a replay ever APPENDED, uncapped. During a silent replay nothing flushes, so
 * the module's pending delta still holds the whole run — which is how a 690-kill fixture can be
 * measured row for row against a 50-row ring without weakening the cap.
 */
function allKillRows(lines: string[], withEpoch = false): ProgressionKill[] {
  return replayModule(lines, withEpoch).flushDelta()?.delta.recentKills ?? []
}

/** `hh:mm:ss | name` — the readable shape a golden row assertion is written in. */
function rowKey(r: ProgressionKill): string {
  return `${new Date(r.ts).toLocaleTimeString('en-US', { hour12: false })} | ${r.name}`
}

/**
 * The ring is a DUPLICATE VIEW of the credited-kill columns, so its structural contract is
 * exactly that: its rows are the TAIL of `killTs`/`killCredit`, row for row. If that ever drifts
 * the card is showing a different past from the numbers beside it. It also pins the two
 * DIFFERENT unknowns apart — no experience line at all vs a line that stated no size — neither
 * of which may ever carry a number (law 1).
 */
function assertRingWellFormed(snap: ProgressionSnap): void {
  const ring = snap.recentKills
  assert.ok(ring.length <= RECENT_KILL_CAP, `ring holds ${ring.length}, cap ${RECENT_KILL_CAP}`)
  assert.equal(ring.length, Math.min(snap.killTs.length, RECENT_KILL_CAP), 'one row per credited kill')
  assert.deepEqual(ring.map((r) => r.ts), snap.killTs.slice(-ring.length), 'the ring IS the kill tail')
  assert.deepEqual(ring.map((r) => r.credit), snap.killCredit.slice(-ring.length), 'same credit, row for row')
  for (const r of ring) {
    assert.ok(r.name.length > 0, 'a row always names what died')
    if (r.expFlag === undefined) assert.equal(r.expPct, undefined, 'no exp line ⇒ no percentage')
    else if ((r.expFlag & 1) !== 0) assert.equal(r.expPct, undefined, 'unstated ⇒ no percentage')
    else assert.ok(r.expPct !== undefined && r.expPct > 0, 'a stated percentage is always positive')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WL45 — hand-read from tests/fixtures/wl45-kill-credit.log:
//   16:29:44  `You gain experience! (1.888%)` then `You have slain a fire giant warrior!`
//   16:41:23  `You have slain King Tranix pet!` with NO experience line anywhere near it — the
//             pet corpse paid nothing, and the row must say so rather than show 0%.
//   16:43:21  `You gain experience! (2.127%)` then `King Tranix has been slain by Garab!` —
//             a BOUND-PET kill, and the experience is still yours.
test('WL45 exp join: every credited kill carries the exp line that PRECEDED it, or none', () => {
  const rows = allKillRows(readFixture('wl45-kill-credit.log'))

  assert.deepEqual(
    rows.map((r) => [rowKey(r), r.credit, r.expPct ?? null]),
    [
      ['16:29:44 | a fire giant warrior', 0, 1.888],
      ['16:33:43 | a fire giant warrior', 0, 1.966],
      ['16:36:59 | a fire giant wizard', 0, 1.888],
      // THE NO-EXP KILL. Nothing joined, so nothing is stated — not 0%, and not the 2.127% that
      // arrives two minutes later for a different corpse.
      ['16:41:23 | King Tranix pet', 0, null],
      ['16:43:21 | King Tranix', 1, 2.127],
      ['16:44:16 | a fire giant warrior', 0, 1.65],
      ['16:47:55 | A fire giant warrior', 1, 1.888],
      ['16:50:16 | Warlord Skarlon', 0, 2.209],
      ['16:53:37 | a fire giant warrior', 0, 2.046],
      ['16:55:42 | a fire giant warrior', 0, 1.765],
      ['16:56:38 | A fire giant warrior', 1, 1.966]
    ]
  )
  const noExp = rows.find((r) => r.name === 'King Tranix pet')!
  assert.equal(noExp.expFlag, undefined, 'no experience line at all — a different unknown from "unstated"')
  assert.equal(noExp.expPct, undefined)

  // NAMES ARE RAW (law 2). The same mob appears as `a fire giant warrior` (You-have-slain lines,
  // mid-sentence) and `A fire giant warrior` (slain-by lines, sentence-start); the ring displays
  // what the line said and canonicalizes nothing.
  assert.ok(rows.some((r) => r.name === 'a fire giant warrior'))
  assert.ok(rows.some((r) => r.name === 'A fire giant warrior'))
  for (const r of rows) assert.equal(r.zone, "Nagafen's Lair - Solo", 'one zone, RAW, on every row')

  const snap = replayModule(readFixture('wl45-kill-credit.log'), false).snapshot().state
  assert.equal(rows.length, snap.killTs.length, 'the ring cannot disagree with the kill column')
  assertRingWellFormed(snap)
})

// WL43 — AT THE CAP. All 21 experience lines state no percentage and 19 credited kills sit in the
// window, so every joined row wears flag bit 1: experience WAS paid and the game stated no size
// for it. That is not the same fact as "no experience line", and the two must not collapse.
test('WL43 exp join at the cap: the line joins, and states nothing — never 0%', () => {
  const rows = allKillRows(readFixture('wl43-capped-no-pct.log'))

  assert.equal(rows.length, 19, 'one row per credited kill')
  for (const r of rows) {
    assert.equal(r.expFlag, 1, 'an experience line DID join, and it stated no percentage')
    assert.equal(r.expPct, undefined, 'unknown is never a number')
  }
  // The first ten kills happen before the window's first zone line, so their zone is the empty
  // string — the ring's "unknown, never fabricated", matching the -1 the killZone column carries.
  assert.equal(rows[0].zone, '')
  assert.equal(rows.filter((r) => r.zone === '').length, 10)
  assert.equal(rows[rows.length - 1].zone, "Nagafen's Lair - Solo 2 (Adaptive)")
})

// WL44 — PARTY EXPERIENCE. `You gain party experience!` precedes its kill line exactly like the
// solo shape, so a party-paid kill joins the same way and carries bit 2. All 18 in this fixture
// are ALSO at the cap (bit 1), which is why the flag is 3: the two facts are independent.
test('WL44 exp join: a party-experience line joins its kill and is labeled as party', () => {
  const rows = allKillRows(readFixture('wl44-swap-boundary.log'))
  const party = rows.filter((r) => ((r.expFlag ?? 0) & 2) !== 0)

  assert.equal(party.length, 18, 'every party line in the span that had a kill to attach to')
  assert.deepEqual(
    party.slice(0, 4).map((r) => [rowKey(r), r.credit, r.expFlag]),
    [
      ['18:57:01 | A fire giant warrior', 1, 3],
      ['19:00:23 | A fire giant warrior', 1, 3],
      ['19:01:16 | A fire giant warrior', 1, 3],
      // `You gain party experience!` then `You have slain King Tranix!` — a group-mate paid, YOU
      // landed the blow. Party is a property of the EXPERIENCE, not of the credit.
      ['19:02:16 | King Tranix', 0, 3]
    ]
  )
  for (const r of party) assert.equal(r.expPct, undefined, 'these are at the cap too — nothing stated')

  // THE MEASURED JOIN RATE on this fixture: 665 of 690 credited kills found an experience line.
  // The shortfall is REAL (grey kills pay nothing), which is why the join is a correlation and
  // never an identity.
  assert.equal(rows.length, 690)
  assert.equal(rows.filter((r) => r.expFlag !== undefined).length, 665)
})

// ─────────────────────────────────────────────────────────────────────────────
// THE JOIN RULE ITSELF, driven with synthesized events so each clause is isolated. The fixtures
// prove the rule matches the real log; this proves what the rule DOES at its edges.
test('exp join: one line, one kill — consumed, never double-attributed, never reached forward', () => {
  const mod = new ProgressionModule()
  mod.reset()
  const base = T('Sat Aug 01 00:00:00 2026')
  let seq = 0
  const exp = (dt: number, pct?: number, party = false): void => {
    mod.onEvent({ kind: 'expGain', seq: seq++, ts: base + dt, raw: '', party, pct }, false)
  }
  const kill = (dt: number, name: string): void => {
    mod.onEvent({ kind: 'death', seq: seq++, ts: base + dt, raw: '', name, bySelf: true }, false)
  }

  mod.onEvent({ kind: 'zone', seq: seq++, ts: base, raw: '', zone: 'Befallen' }, false)
  exp(1000, 2.5) // claimed by the kill on the same second
  kill(1000, 'a skeleton')
  kill(1100, 'a decayed skeleton') // the line is GONE — one line pays one kill
  exp(5000, 1.25)
  kill(9000, 'a bone golem') // 4s later: outside the window, so nothing joins
  kill(20_000, 'a ghoul') // the experience line arrives AFTER this kill…
  exp(20_500, 3.75) // …and is never reached backwards in time
  kill(30_000, 'a shade')
  exp(30_000, 0.5, true) // a party line, but it too lands after its kill line here

  const snap = mod.snapshot().state
  assert.deepEqual(
    snap.recentKills.map((r) => [r.name, r.expPct ?? null, r.expFlag ?? null]),
    [
      ['a skeleton', 2.5, 0],
      ['a decayed skeleton', null, null],
      ['a bone golem', null, null],
      ['a ghoul', null, null],
      ['a shade', null, null]
    ]
  )
  for (const r of snap.recentKills) assert.equal(r.zone, 'Befallen')
  // The columns are untouched by any of it: five kills, four experience samples.
  assert.equal(snap.killTs.length, 5)
  assert.equal(snap.expTs.length, 4)
  assert.equal(snap.dropped, 0, 'the ring is not a capped COLUMN and never moves `dropped`')

  // The window is a real boundary, not a fudge: exactly KILL_EXP_JOIN_MS still joins.
  const edge = new ProgressionModule()
  edge.reset()
  edge.onEvent({ kind: 'expGain', seq: 0, ts: base, raw: '', party: false, pct: 9 }, false)
  edge.onEvent(
    { kind: 'death', seq: 1, ts: base + KILL_EXP_JOIN_MS, raw: '', name: 'a rat', bySelf: true },
    false
  )
  assert.equal(edge.snapshot().state.recentKills[0].expPct, 9)
})

// A WITNESSED kill consumes the line it follows without recording a row. Otherwise a group-mate's
// party experience would sit unclaimed and be handed to YOUR next kill seconds later.
test('exp join: a witnessed kill consumes its own experience line and records nothing', () => {
  const mod = new ProgressionModule()
  mod.reset()
  const base = T('Sat Aug 01 00:00:00 2026')
  mod.onEvent({ kind: 'expGain', seq: 0, ts: base, raw: '', party: true, pct: 1.5 }, false)
  // Somebody else's killing blow — never bound as a pet here, so it is witnessed.
  mod.onEvent(
    { kind: 'death', seq: 1, ts: base, raw: '', name: 'a griffon', bySelf: false, killer: 'Dranix' },
    false
  )
  mod.onEvent({ kind: 'death', seq: 2, ts: base + 500, raw: '', name: 'a griffawn', bySelf: true }, false)

  const snap = mod.snapshot().state
  assert.equal(snap.witnessTs.length, 1)
  assert.deepEqual(snap.recentKills.map((r) => [r.name, r.expPct ?? null]), [['a griffawn', null]])
})

// ─────────────────────────────────────────────────────────────────────────────
// THE RING is drop-oldest by COUNT, and its churn is invisible to the columns' retention floor —
// a 50-row display feed drops on almost every kill, and `dropped`/`windowStart` are the honest
// label for the CAPPED COLUMNS going partial. Conflating them would fire that warning forever.
test('recent kills: the ring keeps the newest RECENT_KILL_CAP and never moves `dropped`', () => {
  const mod = new ProgressionModule()
  mod.reset()
  const base = T('Sat Aug 01 00:00:00 2026')
  const n = RECENT_KILL_CAP * 3
  for (let i = 0; i < n; i++) {
    mod.onEvent(
      { kind: 'death', seq: i, ts: base + i * 1000, raw: '', name: `mob ${String(i)}`, bySelf: true },
      false
    )
  }
  const snap = mod.snapshot().state

  assert.equal(snap.recentKills.length, RECENT_KILL_CAP, 'exactly the cap — no TRIM_BATCH slack')
  assert.equal(snap.recentKills[0].name, `mob ${String(n - RECENT_KILL_CAP)}`, 'oldest-first drop')
  assert.equal(snap.recentKills[RECENT_KILL_CAP - 1].name, `mob ${String(n - 1)}`, 'the newest is kept')
  assert.equal(snap.killTs.length, n, 'the COLUMN kept every one of them (nowhere near its cap)')
  assert.equal(snap.dropped, 0, 'a display ring aging out is not the record going partial')
  assert.equal(snap.windowStart, 0, 'and it never raises the retention floor')

  const out = mod.flushDelta()!
  assert.equal(out.delta.recentKills.length, n, 'every row was appended')
  assert.equal(out.delta.recentKillsDrop, n - RECENT_KILL_CAP, 'and the front-drop accounts for the rest')
  assert.equal(out.delta.dropFront.kill, 0, 'the ring drop never leaks into the column bookkeeping')
})

// The renderer half of the contract: a consumer that starts from a snapshot and rides deltas must
// end up holding EXACTLY what main holds. The ring merges by the same append-then-splice rule as
// the columns but with its own count, which is the one part of `applyProgressionDelta` that could
// silently drift out of step with the rest of the delta.
test('applyProgressionDelta: replaying flushes reproduces main’s ring row for row', () => {
  const mod = new ProgressionModule()
  mod.reset()
  const base = T('Sat Aug 01 00:00:00 2026')
  let held = EMPTY_PROGRESSION
  let seq = 0
  mod.onEvent({ kind: 'zone', seq: seq++, ts: base, raw: '', zone: 'Befallen' }, false)

  // Flush at IRREGULAR intervals so a drop lands mid-flush as well as on a boundary — exactly the
  // interleaving the append-then-splice order exists to reproduce.
  for (let i = 0; i < RECENT_KILL_CAP * 4; i++) {
    const ts = base + (i + 1) * 1000
    if (i % 3 === 0) mod.onEvent({ kind: 'expGain', seq: seq++, ts, raw: '', party: false, pct: 1.5 }, false)
    mod.onEvent({ kind: 'death', seq: seq++, ts, raw: '', name: `mob ${String(i)}`, bySelf: true }, false)
    if (i % 7 === 3) {
      const mid = mod.flushDelta()
      if (mid) held = applyProgressionDelta(held, mid.delta)
    }
  }
  const last = mod.flushDelta()
  if (last) held = applyProgressionDelta(held, last.delta)

  const truth = mod.snapshot().state
  assert.equal(held.recentKills.length, RECENT_KILL_CAP)
  assert.deepEqual(held.recentKills, truth.recentKills, 'the consumer holds main’s ring exactly')
  // The columns it rides beside are unaffected by the ring's own bookkeeping.
  assert.deepEqual(held.killTs, truth.killTs)
  assert.deepEqual(held.expTs, truth.expTs)
  assert.equal(held.dropped, truth.dropped)
})

// OFFLINE INTERVALS ride the same delta. The simplest capped group in the snapshot — a derived
// `offlineGap` arrives with BOTH edges stated, so unlike a zone band it never needs an in-place
// close — but a column the consumer merges wrongly would silently hand the renderer a logout at
// the wrong instant, and every rate that divides by online wall would follow it.
test('applyProgressionDelta: offline intervals arrive whole, in order, across flushes', () => {
  const mod = new ProgressionModule()
  mod.reset()
  const base = T('Sat Aug 01 00:00:00 2026')
  let held = EMPTY_PROGRESSION
  let seq = 0
  mod.onEvent({ kind: 'zone', seq: seq++, ts: base, raw: '', zone: 'Befallen' }, false)
  for (let i = 0; i < 5; i++) {
    const at = base + i * 4 * 3_600_000
    // The gap as sessionDetector states it: out at `fromTs`, back at the Welcome (`toTs`).
    mod.onEvent(
      { kind: 'offlineGap', seq: seq++, ts: at + 3_600_000, raw: '', fromTs: at, toTs: at + 3_600_000, camped: i % 2 === 0 },
      false
    )
    // Flush between some of them so the consumer merges across a boundary, not in one gulp.
    if (i % 2 === 1) {
      const mid = mod.flushDelta()
      if (mid) held = applyProgressionDelta(held, mid.delta)
    }
  }
  const last = mod.flushDelta()
  if (last) held = applyProgressionDelta(held, last.delta)

  const truth = mod.snapshot().state
  assert.equal(truth.offlineStart.length, 5)
  assert.deepEqual(held.offlineStart, truth.offlineStart)
  assert.deepEqual(held.offlineEnd, truth.offlineEnd)
  assert.deepEqual(held.offlineCamped, truth.offlineCamped, 'the camp evidence rides with its interval')
  assert.deepEqual(held.offlineCamped, [1, 0, 1, 0, 1])
  assert.equal(truth.dropped, 0, 'five logouts are nowhere near the cap')
  // A zero-length or inverted gap is not evidence of anything and is never stored.
  mod.onEvent({ kind: 'offlineGap', seq: seq++, ts: base, raw: '', fromTs: base, toTs: base, camped: false }, false)
  assert.equal(mod.snapshot().state.offlineStart.length, 5)
})

// ─────────────────────────────────────────────────────────────────────────────
// FULL-LOG TRIPWIRE — FLOORS AND IDENTITIES ONLY (the log is live and grows). Skipped in CI.
test('full-log: the join holds at scale and the ring never disagrees with the kill column', {
  skip: !existsSync(LOG)
}, () => {
  const lines = readFileSync(LOG, 'utf8').split(/\r?\n/)
  const snap = replayModule(lines, true).snapshot().state
  assertRingWellFormed(snap)

  // MEASURED at 4017 of 4195 credited kills (95.8%). A FLOOR, so it survives play: the shortfall
  // is real (grey kills pay nothing), and a regression that flipped the join's DIRECTION would
  // collapse this number to roughly zero rather than nudge it.
  const rows = allKillRows(lines, true)
  assert.equal(rows.length, snap.killTs.length, 'one ring row was appended per credited kill')
  const joined = rows.filter((k) => k.expFlag !== undefined).length
  assert.ok(joined / rows.length > 0.9, `join rate ${joined}/${rows.length}`)
  assert.ok(rows.some((k) => k.expFlag === undefined), 'and some kills genuinely paid nothing')
  assert.ok(rows.some((k) => ((k.expFlag ?? 0) & 2) !== 0), 'party experience is joined and labeled')
  assert.ok(rows.some((k) => k.credit === 1), 'bound-pet kills reach the ring too')
  assert.ok(rows.some((k) => (k.expFlag ?? 0) === 0), 'and most of them state a real percentage')
})
