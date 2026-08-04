// The PURE half of performance profiling (src/shared/perf.ts) — docs/plans/perf-profiling.md.
//
// Everything asserted here decides what a number MEANS, which is why it is pinned in a unit test
// rather than eyeballed in the HUD:
//
//   * AGGREGATION. Chromium's process-type strings are not the words the UI uses, and
//     `workingSetSize` is KILOBYTES. Both conversions are one-way doors: get either wrong and the
//     chip is confidently, quietly incorrect forever.
//   * LAG. p95 is NEAREST-RANK on purpose — an interpolated percentile invents a millisecond
//     figure that was never observed. And "0 ms" must be distinguishable from "not measured",
//     which is what `samples` is for.
//   * SEVERITY. The chip's colour is a claim about the machine, so the two thresholds are pinned
//     at their exact boundaries.
//   * PHASE ACCOUNTING. A duplicate or out-of-order mark is a TYPED REFUSAL, never a NaN — the
//     plan's P7 requirement, and the reason a wiring mistake shows up as one log line instead of
//     as an empty bar chart nobody can explain.
//
// No Electron, no Node APIs, never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONCURRENT_PHASES,
  DEFAULT_PERF_HUD_PREFS,
  LAG_ALERT_MAX_MS,
  LAG_WARN_P95_MS,
  PERF_PROCESS_TYPES,
  PERF_RING_SIZE,
  STARTUP_BLOCK_THRESHOLD_MS,
  STARTUP_PHASES,
  addMark,
  aggregateMetrics,
  buildProfile,
  describeMarkError,
  foldBlockSamples,
  formatChip,
  formatCpu,
  formatMemory,
  formatMs,
  lagSeverity,
  lagStats,
  normalizePerfHudPrefs,
  parseStartupProfile,
  percentile,
  perfProcessType,
  pushSample,
  sparklinePoints,
  totalsOf,
  type PerfHudSample,
  type StartupMark,
  type StartupPhase
} from '../src/shared/perf'

// ------------------------------------------------------------------ per-process aggregation

/** One `app.getAppMetrics()` row, in Electron's own units: percent CPU, KILOBYTES of memory. */
const metric = (type: string, cpu: number, memoryKb: number): {
  type: string
  cpu: { percentCPUUsage: number }
  memory: { workingSetSize: number }
} => ({ type, cpu: { percentCPUUsage: cpu }, memory: { workingSetSize: memoryKb } })

test('Chromium process types map onto the words the HUD actually shows', () => {
  // MEASURED, not guessed: the main process reports as 'Browser' and every renderer (main
  // window + each overlay) as 'Tab'. Anything unknown lands in 'other' — memory that exists must
  // appear somewhere, or the total is a lie.
  assert.equal(perfProcessType('Browser'), 'main')
  assert.equal(perfProcessType('Tab'), 'renderer')
  assert.equal(perfProcessType('GPU'), 'gpu')
  assert.equal(perfProcessType('Utility'), 'utility')
  for (const unknown of ['Zygote', 'Sandbox helper', 'Pepper Plugin', '', 'renderer']) {
    assert.equal(perfProcessType(unknown), 'other', `${unknown} must not be dropped`)
  }
})

test('metrics fold per TYPE, summing CPU and converting KB to MB', () => {
  const rows = aggregateMetrics([
    metric('Browser', 4.5, 120_000),
    metric('Tab', 8.25, 200_000),
    metric('Tab', 1.25, 100_000),
    metric('GPU', 2, 51_200)
  ])
  const byType = new Map(rows.map((r) => [r.type, r]))

  assert.equal(byType.get('main')?.cpuPercent, 4.5)
  assert.equal(byType.get('main')?.memoryMb, 117) // 120000 KB / 1024
  // Two renderers are ONE row with a count — the popover says "renderer ×2", not two rows that
  // shuffle position whenever an overlay opens.
  assert.equal(byType.get('renderer')?.count, 2)
  assert.equal(byType.get('renderer')?.cpuPercent, 9.5)
  assert.equal(byType.get('renderer')?.memoryMb, 293)
  assert.equal(byType.get('gpu')?.memoryMb, 50)

  // Every type gets a row, always, in a fixed order: a table whose height changes when a GPU
  // process comes and goes reads as a bug.
  assert.deepEqual(rows.map((r) => r.type), [...PERF_PROCESS_TYPES])
  assert.equal(byType.get('utility')?.count, 0)
})

test('a metrics row missing either half contributes zero, never NaN', () => {
  // These come from a C++ boundary and a process that is going away can report half a row.
  const rows = aggregateMetrics([
    { type: 'Browser' },
    { type: 'Tab', cpu: {} },
    { type: 'Tab', memory: { workingSetSize: Number.NaN } }
  ])
  for (const row of rows) {
    assert.ok(Number.isFinite(row.cpuPercent), `${row.type} cpu is finite`)
    assert.ok(Number.isFinite(row.memoryMb), `${row.type} memory is finite`)
  }
  assert.equal(totalsOf(rows).cpuPercent, 0)
  assert.equal(totalsOf(rows).memoryMb, 0)
})

test('the chip totals are summed from the SAME rows the popover renders', () => {
  // The one property that keeps the chip and the popover from ever disagreeing.
  const rows = aggregateMetrics([metric('Browser', 3, 102_400), metric('Tab', 7, 204_800)])
  const totals = totalsOf(rows)
  assert.equal(totals.cpuPercent, 10)
  assert.equal(totals.memoryMb, rows.reduce((n, r) => n + r.memoryMb, 0))
  assert.equal(totals.memoryMb, 300)
  assert.deepEqual(aggregateMetrics([]).map((r) => r.count), PERF_PROCESS_TYPES.map(() => 0))
  assert.deepEqual(totalsOf([]), { cpuPercent: 0, memoryMb: 0 })
})

// -------------------------------------------------------------------------- lag + severity

test('percentiles are NEAREST-RANK — every answer is a value that was observed', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(percentile(values, 95), 10)
  assert.equal(percentile(values, 50), 5)
  assert.equal(percentile(values, 100), 10)
  assert.equal(percentile(values, 0), 1)
  // Interpolation would answer 9.55 for p95 of this set — a lag figure nothing ever measured.
  assert.ok(values.includes(percentile(values, 95)))
  assert.equal(percentile([], 95), 0)
})

test('lag stats never produce NaN, and 0 ms is distinguishable from "not measured"', () => {
  const empty = lagStats([])
  assert.deepEqual(empty, { samples: 0, p95Ms: 0, maxMs: 0 })
  // …and THAT is why severity reads `samples`: an unmeasured window is not a calm one.
  assert.equal(lagSeverity(empty), 'normal')

  const stats = lagStats([2, 1, 300, 4, Number.NaN, -5])
  assert.equal(stats.samples, 5, 'NaN is dropped; a negative drift is clamped, not discarded')
  assert.equal(stats.maxMs, 300)
  assert.ok(Number.isFinite(stats.p95Ms))
  assert.equal(lagStats([-1, -2]).maxMs, 0)
})

test('the chip colours on lag alone, at exactly the documented thresholds', () => {
  const at = (p95: number, max: number): ReturnType<typeof lagSeverity> =>
    lagSeverity({ samples: 4, p95Ms: p95, maxMs: max })

  assert.equal(at(0, 0), 'normal')
  assert.equal(at(LAG_WARN_P95_MS - 1, 60), 'normal')
  assert.equal(at(LAG_WARN_P95_MS, 60), 'warn', 'p95 ≥ 50 ms is the warn boundary')
  assert.equal(at(10, LAG_ALERT_MAX_MS), 'alert', 'one 200 ms stall is a visible freeze')
  assert.equal(at(LAG_WARN_P95_MS, LAG_ALERT_MAX_MS), 'alert', 'alert wins over warn')
  // CPU is NOT an input. A full-log replay pins a core and is not a malfunction; colouring that
  // red would train the user to ignore the chip exactly when it finally means something.
  assert.equal(at(0, 0), lagSeverity({ samples: 1, p95Ms: 0, maxMs: 0 }))
})

// ------------------------------------------------------------------------------- the ring

const sample = (cpu: number, longtasks = 0): PerfHudSample => ({
  ts: 1_000 + cpu,
  cpuPercent: cpu,
  memoryMb: 400,
  byType: [],
  lag: { samples: 4, p95Ms: 1, maxMs: 2 },
  longtasks
})

test('the sample ring holds two minutes and drops the OLDEST, never mutating its input', () => {
  let ring: PerfHudSample[] = []
  for (let i = 0; i < PERF_RING_SIZE + 10; i++) ring = pushSample(ring, sample(i))
  assert.equal(ring.length, PERF_RING_SIZE)
  assert.equal(ring[0]?.cpuPercent, 10, 'the ten oldest samples left, not the ten newest')
  assert.equal(ring[ring.length - 1]?.cpuPercent, PERF_RING_SIZE + 9)

  const before = [sample(1)]
  const after = pushSample(before, sample(2))
  assert.equal(before.length, 1, 'input untouched')
  assert.equal(after.length, 2)
  assert.deepEqual(pushSample(before, sample(2), 0), [])
})

// ------------------------------------------------------------------------------ formatting

test('the chip reads `CPU 12% · 480 MB`, and memory turns over into GB', () => {
  assert.equal(formatChip({ cpuPercent: 12.4, memoryMb: 480 }), 'CPU 12% · 480 MB')
  assert.equal(formatCpu(0), '0%')
  assert.equal(formatCpu(-3), '0%', 'a negative CPU reading is not a negative number on screen')
  assert.equal(formatMemory(1024), '1 GB')
  assert.equal(formatMemory(1536), '1.5 GB')
  assert.equal(formatMemory(Number.NaN), '0 MB')
  assert.equal(formatMs(8), '8 ms')
  assert.equal(formatMs(1240), '1.24 s')
  assert.equal(formatMs(-5), '0 ms')
})

test('the sparkline is a polyline over a ZERO baseline, and a flat series stays flat', () => {
  const points = sparklinePoints([0, 50, 100], 100, 10).split(' ')
  assert.equal(points.length, 3)
  assert.equal(points[0], '0,10', 'oldest at the left, zero at the bottom')
  assert.equal(points[2], '100,0', 'the peak touches the top')
  // Auto-scaling to the series MINIMUM would draw 11% → 12% as a cliff. The baseline is 0.
  const flat = sparklinePoints([12, 12, 12], 100, 10).split(' ')
  assert.equal(new Set(flat.map((p) => p.split(',')[1])).size, 1, 'a flat series is a flat line')
  assert.equal(sparklinePoints([], 100, 10), '')
  assert.equal(sparklinePoints([1, 2], 0, 10), '')
  assert.equal(sparklinePoints([5], 100, 10), '0,0', 'a single sample is a single point')
})

// -------------------------------------------------------------------------- phase accounting

/** Mark the whole chain, 100 ms apart, in the app's real boot order. */
function fullChain(): StartupMark[] {
  let marks: StartupMark[] = []
  STARTUP_PHASES.forEach((phase, i) => {
    const result = addMark(marks, phase, (i + 1) * 100)
    assert.ok(result.ok, `${phase} must be accepted`)
    marks = result.marks
  })
  return marks
}

test('the phase order is the order this app actually boots', () => {
  // The store and the spell DB are loaded during module EVALUATION, before Electron's `ready` —
  // so `appReady` cannot come first without inventing two zero-length phases and hiding their
  // real cost. The plan guessed otherwise; the tree is the authority (perf.ts documents it).
  assert.ok(STARTUP_PHASES.indexOf('storeLoaded') < STARTUP_PHASES.indexOf('appReady'))
  assert.ok(STARTUP_PHASES.indexOf('dataLoaded') < STARTUP_PHASES.indexOf('appReady'))
  assert.equal(new Set(STARTUP_PHASES).size, STARTUP_PHASES.length, 'no phase appears twice')
  // …and the last two are the pair that legitimately races, so nothing after them is ordered
  // against a coin toss.
  assert.deepEqual(STARTUP_PHASES.slice(-2), [...CONCURRENT_PHASES])
})

test('a DUPLICATE mark is a typed refusal that leaves the marks it already had', () => {
  const once = addMark([], 'storeLoaded', 10)
  assert.ok(once.ok)
  const twice = addMark(once.marks, 'storeLoaded', 20)
  assert.equal(twice.ok, false)
  assert.ok(!twice.ok && twice.error.code === 'duplicate')
  assert.deepEqual(twice.marks, once.marks, 'the refusal never damages what was measured')
  assert.match(describeMarkError({ code: 'duplicate', phase: 'storeLoaded' }), /twice/)
})

test('an OUT-OF-ORDER mark is refused rather than folded into a negative duration', () => {
  const marks = fullChain()
  const late = addMark(marks, 'appReady', 5_000)
  assert.equal(late.ok, false)
  assert.ok(!late.ok && late.error.code === 'duplicate', 'already marked ⇒ duplicate wins')

  const partial = addMark([], 'windowCreated', 100)
  assert.ok(partial.ok)
  const backwards = addMark(partial.marks, 'storeLoaded', 200)
  assert.equal(backwards.ok, false)
  assert.ok(!backwards.ok && backwards.error.code === 'out-of-order')
  assert.match(describeMarkError({ code: 'out-of-order', phase: 'storeLoaded', after: 'windowCreated' }), /arrived after/)
})

test('the two phases that RACE may arrive either way round, and both launches are complete', () => {
  // The window loads its renderer while the historical scan is still folding (that is what the
  // `hydrating` state exists to say). So on a months-old log the interface is drawn long before
  // the replay ends, and on a machine with NO log the replay ends before the window has painted.
  // Both are ordinary launches; an opinion about their order would make one of them a bug report.
  const upTo = (): StartupMark[] => {
    let marks: StartupMark[] = []
    for (const [i, phase] of STARTUP_PHASES.slice(0, 6).entries()) {
      const result = addMark(marks, phase, (i + 1) * 10)
      assert.ok(result.ok)
      marks = result.marks
    }
    return marks
  }
  for (const pair of [['replayDone', 'rendererHydrated'], ['rendererHydrated', 'replayDone']] as const) {
    let marks = upTo()
    for (const [i, phase] of pair.entries()) {
      const result = addMark(marks, phase, 100 + i * 10)
      assert.ok(result.ok, `${phase} after ${String(pair[0])} must be accepted`)
      marks = result.marks
    }
    const profile = buildProfile(marks, { startedAt: 1, version: '' })
    assert.equal(profile.complete, true, `${pair.join(' → ')} is a complete launch`)
    // Chronological, not enum order: the profile reads as the launch actually happened.
    assert.deepEqual(profile.phases.slice(-2).map((p) => p.phase), [...pair])
    assert.ok(profile.phases.every((p) => p.durationMs >= 0))
  }
})

test('a mark whose CLOCK went backwards is refused too — the invariant is asserted, not hoped', () => {
  const first = addMark([], 'storeLoaded', 500)
  assert.ok(first.ok)
  const back = addMark(first.marks, 'dataLoaded', 100)
  assert.equal(back.ok, false)
  assert.ok(!back.ok && back.error.code === 'time-went-backwards')
  assert.match(
    describeMarkError({ code: 'time-went-backwards', phase: 'dataLoaded', atMs: 100, previousMs: 500 }),
    /precedes/
  )
})

test('durations are consecutive differences and SUM to the total, with nothing NaN', () => {
  const profile = buildProfile(fullChain(), {
    startedAt: 1_700_000_000_000,
    version: '0.2.0',
    eventsReplayed: 1_148_223
  })
  assert.equal(profile.phases.length, STARTUP_PHASES.length)
  assert.equal(profile.complete, true)
  assert.equal(profile.totalMs, STARTUP_PHASES.length * 100)
  assert.equal(profile.eventsReplayed, 1_148_223)

  const summed = profile.phases.reduce((n, p) => n + p.durationMs, 0)
  assert.equal(summed, profile.totalMs, 'the phases account for the whole launch, exactly')
  assert.equal(profile.phases[0]?.durationMs, 100, 'the first phase is measured from process start')
  for (const p of profile.phases) {
    assert.ok(Number.isFinite(p.durationMs) && p.durationMs >= 0, `${p.phase} duration is sane`)
  }
})

test('a launch that never finished still produces an honest, incomplete profile', () => {
  const partial = addMark([], 'storeLoaded', 42)
  assert.ok(partial.ok)
  const profile = buildProfile(partial.marks, { startedAt: 1, version: '' })
  assert.equal(profile.complete, false)
  assert.equal(profile.totalMs, 42)
  assert.equal(profile.eventsReplayed, undefined, 'a count nobody measured is absent, never 0')

  const nothing = buildProfile([], { startedAt: 1, version: '' })
  assert.deepEqual(nothing.phases, [])
  assert.equal(nothing.totalMs, 0)
  assert.equal(nothing.complete, false)
})

// -------------------------------------------------------------------- the startup block probe

test('the startup block probe reports a worst stall and a count, and distinguishes 0 from unmeasured', () => {
  // The threshold is deliberately the SAME number the HUD calls "warn" — one vocabulary, so a
  // startup that would have coloured the chip is a startup that reports blocks.
  assert.equal(STARTUP_BLOCK_THRESHOLD_MS, LAG_WARN_P95_MS)

  assert.deepEqual(foldBlockSamples([2, 51, 7, 300, 49.6]), {
    samples: 5,
    maxBlockMs: 300,
    blocksOver50Ms: 2
  })
  // AT the threshold counts (a boundary asserted, not assumed), just under it does not.
  assert.equal(foldBlockSamples([50]).blocksOver50Ms, 1)
  assert.equal(foldBlockSamples([49.999]).blocksOver50Ms, 0)
  // A window that held no ticks says so: 0 ms here means "nothing was measured", which is not
  // the same claim as "the launch never blocked".
  assert.deepEqual(foldBlockSamples([]), { samples: 0, maxBlockMs: 0, blocksOver50Ms: 0 })
  // Scheduling noise and a C++ boundary both exist: negatives clamp, junk is dropped.
  assert.deepEqual(foldBlockSamples([-5, NaN, Infinity, 12]), { samples: 2, maxBlockMs: 12, blocksOver50Ms: 0 })
})

test('a launch that measured its blocking states it in the profile; one that did not omits it', () => {
  const block = { samples: 17, maxBlockMs: 9, blocksOver50Ms: 0 }
  const measured = buildProfile(fullChain(), { startedAt: 1, version: '', block })
  assert.deepEqual(measured.block, block)
  // Absent, never a fabricated zero — the same rule `eventsReplayed` follows.
  assert.equal(buildProfile(fullChain(), { startedAt: 1, version: '' }).block, undefined)

  // Read back off disk: all three fields or none. A half-parsed probe result would invite a
  // conclusion from a number the file never stated.
  const onDisk = { ...measured, block: { samples: 3, maxBlockMs: 'soon' } }
  assert.equal(parseStartupProfile(JSON.parse(JSON.stringify(onDisk)) as unknown)?.block, undefined)
  // …and a profile written by a build that predates the probe still parses (the field is optional).
  const legacy = JSON.parse(JSON.stringify(measured)) as Record<string, unknown>
  delete legacy.block
  assert.equal(parseStartupProfile(legacy)?.phases.length, STARTUP_PHASES.length)
})

test('a profile round-trips through JSON, and anything else parses to null', () => {
  const profile = buildProfile(fullChain(), {
    startedAt: 5,
    version: '9.9.9',
    eventsReplayed: 7,
    block: { samples: 12, maxBlockMs: 31, blocksOver50Ms: 0 }
  })
  const parsed = parseStartupProfile(JSON.parse(JSON.stringify(profile)) as unknown)
  assert.deepEqual(parsed, profile)
  // A phase name this build does not know is dropped, not guessed at.
  const foreign = parseStartupProfile({ phases: [{ phase: 'warpDrive', atMs: 1, durationMs: 1 }] })
  assert.equal(foreign, null)
  for (const junk of [null, 42, 'nonsense', [], {}, { phases: 'soon' }, { phases: [] }]) {
    assert.equal(parseStartupProfile(junk), null, `${JSON.stringify(junk)} ⇒ no last startup`)
  }
})

// --------------------------------------------------------------------------------- the pref

test('the HUD is OFF by default, and a malformed pref block lands on the default', () => {
  // Off is the policy: the switch is the only thing that creates the sampler or the lag probe.
  assert.deepEqual(DEFAULT_PERF_HUD_PREFS, { enabled: false })
  assert.deepEqual(normalizePerfHudPrefs({ enabled: true }), { enabled: true })
  for (const junk of [null, 42, 'nonsense', [], { enabled: 'yes' }, undefined, { nested: true }]) {
    assert.deepEqual(normalizePerfHudPrefs(junk), DEFAULT_PERF_HUD_PREFS, `${JSON.stringify(junk)} ⇒ off`)
  }
})

test('every phase the enum lists can actually be marked, and nothing else can', () => {
  // The closed set is what makes the accounting total-able. A phase outside it cannot be
  // constructed at a call site, so this asserts the runtime half of that promise.
  const phases: readonly StartupPhase[] = STARTUP_PHASES
  assert.equal(phases.length, 8)
  assert.deepEqual(fullChain().map((m) => m.phase), [...STARTUP_PHASES])
})
