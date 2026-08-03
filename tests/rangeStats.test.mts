// PURE UNIT TESTS for shared/progressionStats.rangeStats — the edge cases a real log window
// cannot reach cheaply, driven by SYNTHETIC snapshots.
//
// The golden windows (tests/progressionWindows.test.mts) pin the arithmetic against the user's
// actual log. These pin the SHAPE of the answer at the boundaries: an empty selection, a
// selection that lives entirely inside one silence, a selection that reaches below the
// retention floor, one that spans no time at all, one sample, and the optional class-combo
// seam. Everything here is a hand-built snapshot with round numbers, so a failure names the
// rule that broke rather than a fixture that drifted.
//
// Imported RELATIVELY (../src/shared/...): node tests run through tsx with no `@shared` alias
// — that alias only exists for the renderer bundle (electron.vite.config.ts resolve.alias).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IDLE_GAP_MS, rangeStats, type ComboInterval, type ComboSource } from '../src/shared/progressionStats'
import type { ProgressionSnap } from '../src/shared/progressionTypes'

const MIN = 60_000
const HOUR = 60 * MIN
/** An arbitrary, readable epoch anchor — nothing here depends on the wall clock. */
const T0 = Date.parse('Sat Aug 01 12:00:00 2026')

function emptySnap(): ProgressionSnap {
  return {
    expTs: [], expPct: [], expFlag: [],
    killTs: [], killZone: [], killCredit: [],
    witnessTs: [], recentKills: [], lootTs: [],
    zoneStart: [], zoneEnd: [], zoneName: [],
    levelTs: [], levelValue: [], aaGainTs: [], aaGainAmount: [],
    lastTs: 0, windowStart: 0, dropped: 0
  }
}

/** Add a stated exp sample (pct as a percentage, e.g. 2.5) at `ts`. */
function addExp(snap: ProgressionSnap, ts: number, pct: number | null, party = false): void {
  snap.expTs.push(ts)
  snap.expPct.push(pct ?? -1)
  snap.expFlag.push((pct === null ? 1 : 0) | (party ? 2 : 0))
  snap.lastTs = Math.max(snap.lastTs, ts)
}

/** Add a credited kill (`pet` ⇒ credit 1) at `ts`, attributed to the open zone. */
function addKill(snap: ProgressionSnap, ts: number, pet = false): void {
  snap.killTs.push(ts)
  snap.killZone.push(snap.zoneStart.length - 1)
  snap.killCredit.push(pet ? 1 : 0)
  snap.lastTs = Math.max(snap.lastTs, ts)
}

/** Open a zone interval at `ts`, closing whichever one was open. */
function addZone(snap: ProgressionSnap, ts: number, name: string): void {
  const n = snap.zoneStart.length
  if (n > 0) snap.zoneEnd[n - 1] = ts
  snap.zoneStart.push(ts)
  snap.zoneEnd.push(0)
  snap.zoneName.push(name)
  snap.lastTs = Math.max(snap.lastTs, ts)
}

test('an EMPTY range (no samples anywhere) is all zeros, not NaN and not a fake rate', () => {
  const r = rangeStats({ snap: emptySnap(), range: { t0: T0, t1: T0 + HOUR } })
  assert.equal(r.durationMs, HOUR)
  assert.equal(r.kills, 0)
  assert.equal(r.expSamples, 0)
  assert.equal(r.levelEquiv, 0)
  assert.deepEqual(r.levelUps, [])
  assert.deepEqual(r.levelRuns, [])
  assert.equal(r.aaGained, 0)
  // No zone line was ever seen, so the whole hour is the `unknown` remainder — which is what
  // keeps Σ span == duration true even with no data at all.
  assert.deepEqual(r.zones.map((z) => z.zone), ['unknown'])
  assert.equal(r.zones[0].spanMs, HOUR)
  // An hour of pure silence with no activity on either side is idle by the stated rule.
  assert.equal(r.idleGaps, 1)
  assert.equal(r.idleMs, HOUR)
  assert.equal(r.activeMs, 0)
  assert.equal(r.levelsPerHourActive, null, 'no active time ⇒ no rate, never 0')
  assert.equal(r.killsPerHourActive, null)
})

test('a ZERO-DURATION range spans nothing and counts nothing', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  addExp(snap, T0 + MIN, 2)
  addKill(snap, T0 + MIN)
  const r = rangeStats({ snap, range: { t0: T0 + MIN, t1: T0 + MIN } })
  assert.equal(r.durationMs, 0)
  assert.equal(r.activeMs, 0)
  assert.equal(r.idleMs, 0)
  assert.equal(r.idleGaps, 0)
  assert.equal(r.kills, 0, 'a half-open [t,t) range contains nothing, not the sample at t')
  assert.equal(r.expSamples, 0)
  assert.deepEqual(r.zones, [], 'no span ⇒ no rows')
  assert.equal(r.levelsPerHourWall, null)
  assert.equal(r.killsPerHourActive, null)
})

test('an INVERTED range is normalized to zero length rather than producing negative time', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  const r = rangeStats({ snap, range: { t0: T0 + HOUR, t1: T0 } })
  assert.equal(r.durationMs, 0)
  assert.ok(r.activeMs >= 0 && r.idleMs >= 0)
})

test('a range entirely INSIDE one idle gap is 100% idle — the gap straddles both edges', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  // Activity at 12:00 and again at 22:00. Nothing in between.
  addKill(snap, T0)
  addExp(snap, T0, 1)
  addKill(snap, T0 + 10 * HOUR)
  addExp(snap, T0 + 10 * HOUR, 1)

  const r = rangeStats({ snap, range: { t0: T0 + 3 * HOUR, t1: T0 + 4 * HOUR } })
  assert.equal(r.durationMs, HOUR)
  assert.equal(r.idleMs, HOUR, 'the bracketing samples are pulled in, so the gap is measured')
  assert.equal(r.activeMs, 0)
  assert.equal(r.idleGaps, 1)
  assert.equal(r.kills, 0)
  assert.equal(r.zones[0].idleMs, HOUR, 'and it lands on the zone you were standing in')
  assert.equal(r.zones[0].spanMs, HOUR)
})

test('a gap is measured WHOLE, never `gap - threshold`, and a sub-threshold gap is not idle', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  addKill(snap, T0)
  // 6 minutes of silence — over the 5-minute classifier.
  addKill(snap, T0 + 6 * MIN)
  // then 4 minutes — under it.
  addKill(snap, T0 + 10 * MIN)

  const r = rangeStats({ snap, range: { t0: T0, t1: T0 + 10 * MIN } })
  assert.equal(r.durationMs, 10 * MIN)
  assert.equal(r.idleGaps, 1, 'only the 6-minute silence qualifies')
  assert.equal(r.idleMs, 6 * MIN, 'the WHOLE gap, not 6m - 5m')
  assert.equal(r.activeMs, 4 * MIN)
  assert.equal(r.idleThresholdMs, IDLE_GAP_MS)
})

test('an idle gap is SPLIT at the zone boundaries it crosses, so per-zone idle sums exactly', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  addKill(snap, T0)
  // Zone out 20 minutes into the silence…
  addZone(snap, T0 + 20 * MIN, 'The Feerrott')
  // …and the next activity is another 40 minutes later.
  addKill(snap, T0 + 60 * MIN)

  const r = rangeStats({ snap, range: { t0: T0, t1: T0 + 60 * MIN } })
  assert.equal(r.idleGaps, 1, 'one silence, crossing a zone line')
  assert.equal(r.idleMs, 60 * MIN)
  assert.deepEqual(
    r.zones.map((z) => [z.zone, z.spanMs, z.idleMs]),
    [['Befallen', 20 * MIN, 20 * MIN], ['The Feerrott', 40 * MIN, 40 * MIN]]
  )
  assert.equal(r.zones.reduce((n, z) => n + z.idleMs, 0), r.idleMs)
  assert.equal(r.zones.reduce((n, z) => n + z.spanMs, 0), r.durationMs)
})

test('a SINGLE sample: one kill, one stated exp line, one zone', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  addKill(snap, T0 + MIN)
  addExp(snap, T0 + MIN, 2.5)
  const r = rangeStats({ snap, range: { t0: T0, t1: T0 + 2 * MIN } })
  assert.equal(r.kills, 1)
  assert.equal(r.killsSelf, 1)
  assert.equal(r.killsPet, 0)
  assert.equal(r.expSamples, 1)
  assert.equal(r.levelEquiv, 0.025, '2.5% of a level bar')
  assert.equal(r.idleGaps, 0, 'two minutes is not a silence')
  assert.equal(r.activeMs, 2 * MIN)
  assert.equal(r.zones.length, 1)
  assert.equal(r.zones[0].kills, 1)
  assert.equal(r.levelsPerHourActive, 0.025 / (2 / 60))
})

test('UNSTATED exp is never 0%: it counts as a sample, adds nothing, and nulls the levels rate', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  addExp(snap, T0 + MIN, null)
  addExp(snap, T0 + 2 * MIN, null, true)
  addKill(snap, T0 + MIN)
  const r = rangeStats({ snap, range: { t0: T0, t1: T0 + 3 * MIN } })
  assert.equal(r.expSamples, 2)
  assert.equal(r.expUnstated, 2)
  assert.equal(r.expParty, 1)
  assert.equal(r.levelEquiv, 0)
  assert.equal(r.levelsPerHourActive, null, 'unknown is not zero')
  assert.equal(r.levelsPerHourWall, null)
  assert.equal(r.zones[0].levelsPerHourActive, null)
  assert.ok(r.killsPerHourActive !== null, 'kills stay knowable — the two facts are independent')
})

test('a MIX of stated and unstated exp still reports a rate (a floor), with the gap labeled', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  addExp(snap, T0 + MIN, 5)
  addExp(snap, T0 + 2 * MIN, null)
  const r = rangeStats({ snap, range: { t0: T0, t1: T0 + 3 * MIN } })
  assert.equal(r.expSamples, 2)
  assert.equal(r.expUnstated, 1)
  assert.equal(r.levelEquiv, 0.05)
  assert.notEqual(r.levelsPerHourActive, null, 'one stated sample is enough to measure with')
})

test('CLIPPED is exactly "the range reaches below the retention floor"', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  addKill(snap, T0 + MIN)
  // Nothing has aged out yet: windowStart 0 means "no floor", so nothing is ever clipped —
  // a selection that merely predates the log is not the same as one whose data was dropped.
  assert.equal(rangeStats({ snap, range: { t0: T0 - HOUR, t1: T0 + HOUR } }).clipped, false)

  snap.windowStart = T0
  snap.dropped = 12
  assert.equal(rangeStats({ snap, range: { t0: T0 - 1, t1: T0 + HOUR } }).clipped, true)
  assert.equal(rangeStats({ snap, range: { t0: T0, t1: T0 + HOUR } }).clipped, false, 'exactly at the floor is fine')
})

test('level runs: a REGRESSION opens a new run, and a run never descends', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  for (const [i, level] of [10, 11, 12, 4, 5, 6].entries()) {
    snap.levelTs.push(T0 + i * MIN)
    snap.levelValue.push(level)
    snap.lastTs = T0 + i * MIN
  }
  const r = rangeStats({ snap, range: { t0: T0, t1: T0 + 10 * MIN } })
  assert.deepEqual(r.levelUps.map((l) => l.level), [10, 11, 12, 4, 5, 6])
  assert.deepEqual(
    r.levelRuns.map((run) => [run.fromLevel, run.toLevel]),
    [[10, 12], [4, 6]]
  )
  assert.equal(r.levelRuns[0].endTs, T0 + 2 * MIN)
  assert.equal(r.levelRuns[1].startTs, T0 + 3 * MIN, 'the new run opens at the first post-drop ding')
  for (const run of r.levelRuns) assert.ok(run.toLevel >= run.fromLevel)
})

test('the COMBO seam is optional: absent ⇒ [], present ⇒ verbatim, and queried exactly once', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  addKill(snap, T0 + MIN)

  // Absent is a first-class state, not an error — the panel says "not stated in this range".
  assert.deepEqual(rangeStats({ snap, range: { t0: T0, t1: T0 + HOUR } }).combos, [])

  const intervals: ComboInterval[] = [
    { startTs: T0, endTs: T0 + HOUR, classes: ['PAL', 'MNK', 'ENC'], inferred: true }
  ]
  let intervalCalls = 0
  let atCalls = 0
  const combo: ComboSource = {
    comboAt: () => {
      atCalls++
      return intervals[0]
    },
    intervalsIn: (a, b) => {
      intervalCalls++
      assert.equal(a, T0)
      assert.equal(b, T0 + HOUR)
      return intervals
    }
  }
  const r = rangeStats({ snap, range: { t0: T0, t1: T0 + HOUR }, combo })
  assert.equal(intervalCalls, 1, 'called EXACTLY once')
  assert.equal(atCalls, 0, 'rangeStats never reaches for comboAt — zero inference')
  assert.equal(r.combos, intervals, 'stored verbatim: no merging, no gap-filling, no copying')
  assert.equal(r.combos[0].inferred, true, 'the source owns its own confidence flag')

  // An empty result is the same first-class "not stated" answer.
  const quiet: ComboSource = { comboAt: () => null, intervalsIn: () => [] }
  assert.deepEqual(rangeStats({ snap, range: { t0: T0, t1: T0 + HOUR }, combo: quiet }).combos, [])
})

test('the Σ-identities hold across a busy multi-zone range with pets, party exp and witnesses', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  for (let i = 0; i < 5; i++) {
    addKill(snap, T0 + i * MIN, i % 2 === 1)
    addExp(snap, T0 + i * MIN, 1.5, i === 4)
  }
  snap.witnessTs.push(T0 + 30_000, T0 + 90_000)
  addZone(snap, T0 + 30 * MIN, 'The Feerrott')
  for (let i = 0; i < 3; i++) {
    addKill(snap, T0 + (31 + i) * MIN)
    addExp(snap, T0 + (31 + i) * MIN, null)
  }
  snap.lootTs.push(T0 + 32 * MIN)
  snap.aaGainTs.push(T0 + 33 * MIN)
  snap.aaGainAmount.push(3)

  const r = rangeStats({ snap, range: { t0: T0, t1: T0 + 40 * MIN } })
  assert.equal(r.zones.reduce((n, z) => n + z.spanMs, 0), r.durationMs)
  assert.equal(r.zones.reduce((n, z) => n + z.kills, 0), r.kills)
  assert.equal(r.zones.reduce((n, z) => n + z.expSamples, 0), r.expSamples)
  assert.equal(r.zones.reduce((n, z) => n + z.idleMs, 0), r.idleMs)
  assert.equal(r.activeMs + r.idleMs, r.durationMs)
  assert.equal(r.killsSelf + r.killsPet, r.kills)
  assert.equal(r.kills, 8)
  assert.equal(r.killsPet, 2)
  assert.equal(r.killsWitnessed, 2, 'witnessed kills are counted but never folded into `kills`')
  assert.equal(r.expParty, 1)
  assert.equal(r.expUnstated, 3)
  assert.equal(r.aaGained, 3)
  assert.equal(r.aaGainEvents, 1)
  // Befallen's row keeps only its own five kills; The Feerrott's three land in its own row.
  assert.deepEqual(r.zones.map((z) => [z.zone, z.kills]), [['Befallen', 5], ['The Feerrott', 3]])
})

test('zone rows are keyed case-INSENSITIVELY but display the first-seen RAW name', () => {
  const snap = emptySnap()
  addZone(snap, T0, 'Befallen')
  addKill(snap, T0 + MIN)
  addZone(snap, T0 + 2 * MIN, 'The Feerrott')
  addZone(snap, T0 + 3 * MIN, 'BEFALLEN')
  addKill(snap, T0 + 4 * MIN)
  const r = rangeStats({ snap, range: { t0: T0, t1: T0 + 5 * MIN } })
  assert.deepEqual(r.zones.map((z) => z.zone), ['Befallen', 'The Feerrott'])
  assert.equal(r.zones[0].visits, 2, 'both casings are the same zone')
  assert.equal(r.zones[0].kills, 2)
})
