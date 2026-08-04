// ============================================================================
// replayChunking.test.mts — the chunked startup replay (docs/plans/chunked-replay.md §4).
// ============================================================================
//
// Two claims are tested here, and they are the two the change lives or dies by.
//
// EQUIVALENCE. Chunking interleaves event-loop turns into the SAME sequential fold, so the event
// stream must be BYTE-IDENTICAL to the unchunked one — same events, same order, same seq numbers,
// same `live:false`, same `endOffset`. The oracle is the repo's own golden fixtures (proc, combat,
// leveling and the rest), concatenated into one log and folded twice: once with `unchunkedSlicer()`
// (the control — exactly the code path that existed before replaySlicer.ts) and once with a slicer
// that yields after EVERY SINGLE EVENT, which is the most aggressive interleaving the design can
// ever produce. A downstream module (BuffsModule — the one fold that is Electron-free and stateful
// enough to notice) is run over both streams as a second opinion: if the events are identical the
// modules cannot disagree, and this asserts that rather than assuming it.
//
// THE LIVE HANDOFF. The plan's rule: "replay drains to EOF, then the tail goes live; a line may
// never be folded twice or skipped." This app has no buffer-then-drain — the scan freezes EOF at
// `stat()` time and returns the byte offset of the last COMPLETE line it consumed, and session.ts
// starts the Tailer at exactly that offset. So the test appends to the log FROM INSIDE A YIELD
// (the slicer's `yieldTo` seam makes that a deterministic mid-scan write rather than a race) and
// proves the appended bytes are untouched by the scan and picked up whole from `endOffset`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogBus } from '../src/main/log/bus'
import { scanLog } from '../src/main/log/scanHistory'
import { REPLAY_SLICE_MS, createSlicer, unchunkedSlicer } from '../src/main/log/replaySlicer'
import { BuffsModule } from '../src/main/modules/buffs'
import { FIXTURES } from './harness.mjs'
import type { LogEvent } from '../src/shared/logEvents'

// ------------------------------------------------------------------------------- the slicer

test('the slice budget is honoured against a FAKE clock — a budget you can only test by waiting is untested', async () => {
  let clock = 0
  let yields = 0
  const slicer = createSlicer({
    budgetMs: 12,
    now: () => clock,
    yieldTo: async () => {
      yields += 1
      // A yield is not free and is not instant: charge it, so the next slice cannot silently
      // inherit the time the event loop spent serving everybody else.
      clock += 100
      await Promise.resolve()
    }
  })

  // Eleven 1 ms events fit inside a 12 ms budget; the twelfth crosses it.
  for (let i = 0; i < 11; i++) {
    clock += 1
    assert.equal(slicer.expired(), false, `event ${String(i)} is still inside the budget`)
  }
  clock += 1
  assert.equal(slicer.expired(), true, 'at the budget, the slice is over')
  await slicer.yield()
  assert.equal(yields, 1)
  assert.equal(slicer.slices, 1)
  // The new slice is measured from AFTER the yield returned (clock 112), not from before it.
  clock += 11
  assert.equal(slicer.expired(), false, 'the next slice gets its own full budget')
  clock += 1
  assert.equal(slicer.expired(), true)
})

test('a single MONSTER event still yields after it — the budget is never skipped, only overshot', async () => {
  // The check happens after an event is folded, which is the only place it can happen: an event is
  // not divisible. So the contract is "one event may overshoot, and the very next thing that
  // happens is a yield" — never "the overshoot swallows the yield and folding continues".
  let clock = 0
  let yields = 0
  const slicer = createSlicer({
    budgetMs: REPLAY_SLICE_MS,
    now: () => clock,
    yieldTo: () => {
      yields += 1
      return Promise.resolve()
    }
  })
  clock += 5_000 // one pathological line
  assert.equal(slicer.expired(), true, 'an event far past the budget leaves the slice expired')
  await slicer.yield()
  assert.equal(yields, 1, 'and the yield happens — the overshoot does not cancel it')
  assert.equal(slicer.expired(), false, 'the overshoot is not carried into the next slice as debt')
})

test('the UNCHUNKED control never yields, however long the fold runs', () => {
  // The control arm has to be genuinely inert or the equivalence test below compares two chunked
  // folds and proves nothing. An infinite budget is never `<=` any clock reading, so no amount of
  // simulated (or real) time expires it.
  let clock = 0
  const faked = createSlicer({ budgetMs: Number.POSITIVE_INFINITY, now: () => clock })
  const real = unchunkedSlicer()
  for (let i = 0; i < 1_000; i++) {
    clock += 1_000_000
    assert.equal(faked.expired(), false)
    assert.equal(real.expired(), false)
  }
  assert.equal(faked.slices, 0)
  assert.equal(real.slices, 0)
})

// --------------------------------------------------------------------------- the fold, twice

/** Every committed golden fixture, concatenated — the proc / combat / leveling windows and the
 *  rest, in one deterministic order, so both arms fold exactly the same bytes. */
function goldenCorpus(): string {
  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.log'))
    .sort()
  assert.ok(names.length > 10, `expected the committed fixtures to be present (found ${String(names.length)})`)
  return names.map((n) => readFileSync(join(FIXTURES, n), 'utf8').replace(/\r?\n?$/, '\n')).join('')
}

interface Folded {
  /** Every event the bus saw, as JSON — the byte-for-byte comparison subject. */
  events: string[]
  live: boolean[]
  endOffset: number
  seq: number
  /** A downstream module's final state, as a second opinion on "the modules cannot disagree". */
  buffs: string
}

async function fold(logPath: string, budgetMs: number | 'unchunked'): Promise<Folded> {
  const bus = new LogBus()
  const events: string[] = []
  const live: boolean[] = []
  const mod = new BuffsModule()
  mod.reset()
  bus.subscribe((ev: LogEvent, isLive: boolean) => {
    events.push(JSON.stringify(ev))
    live.push(isLive)
    mod.onEvent(ev, isLive)
  })
  const slicer = budgetMs === 'unchunked' ? unchunkedSlicer() : createSlicer({ budgetMs })
  const res = await scanLog(logPath, bus, 0, { slicer })
  return {
    events,
    live,
    endOffset: res.endOffset,
    seq: res.seq,
    // `overlay.updatedAt` is dropped, and it is the ONE field that is: the message-overlay miner
    // stamps it with `new Date()` when the SNAPSHOT is taken (messageOverlay.ts), so it says when
    // this test read the module, not what the module folded. Two unchunked folds disagree about it
    // too. Everything else — every active, every mined duration, every learned message — is
    // compared exactly, and this fold-order-sensitive module is the point of the exercise.
    buffs: JSON.stringify(mod.snapshot().state, (key, value: unknown) =>
      key === 'updatedAt' ? undefined : value
    )
  }
}

test('CHUNKED AND UNCHUNKED FOLDS ARE BYTE-IDENTICAL over the golden fixtures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-chunk-'))
  const logPath = join(dir, 'eqlog_Corpus_bench.txt')
  try {
    writeFileSync(logPath, goldenCorpus(), 'utf8')

    const control = await fold(logPath, 'unchunked')
    assert.ok(control.events.length > 1_000, `the corpus should fold thousands of events (${String(control.events.length)})`)

    // budget 0 ⇒ a yield after EVERY event: the most interleaving this design can ever produce.
    // REPLAY_SLICE_MS is what production actually runs, and is checked beside it.
    for (const budget of [0, REPLAY_SLICE_MS]) {
      const chunked = await fold(logPath, budget)
      assert.equal(chunked.events.length, control.events.length, `budget ${String(budget)}ms: same event count`)
      assert.equal(
        chunked.events.join('\n'),
        control.events.join('\n'),
        `budget ${String(budget)}ms: the event stream is identical, event for event and field for field`
      )
      assert.deepEqual(chunked.live, control.live, `budget ${String(budget)}ms: every event is still live:false`)
      assert.equal(chunked.endOffset, control.endOffset, `budget ${String(budget)}ms: same byte handoff point`)
      assert.equal(chunked.seq, control.seq, `budget ${String(budget)}ms: same monotonic seq`)
      assert.equal(chunked.buffs, control.buffs, `budget ${String(budget)}ms: the module folded to the same state`)
    }
    assert.equal(control.live.every((l) => l === false), true, 'the historical scan is live:false throughout')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------------------------- the live handoff (EOF)

const LINE = (n: number): string => `[Mon Aug 04 12:00:${String(n % 60).padStart(2, '0')} 2026] You have become better at Testing! (${String(n)})`

test('the scan drains to a FROZEN EOF: a line appended mid-scan is neither folded twice nor skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-handoff-'))
  const logPath = join(dir, 'eqlog_Handoff_bench.txt')
  try {
    // 400 complete lines, then a TRAILING PARTIAL with no newline — the shape a live log always
    // has, because the game is mid-write.
    const complete = Array.from({ length: 400 }, (_, i) => `${LINE(i)}\n`).join('')
    const partial = LINE(400) // no '\n'
    writeFileSync(logPath, complete + partial, 'utf8')
    const frozenBytes = Buffer.byteLength(complete + partial, 'utf8')

    // Append DURING the scan, from inside the first yield — deterministic, not a race.
    let appended = false
    const appendOnFirstYield = async (): Promise<void> => {
      if (!appended) {
        appended = true
        appendFileSync(logPath, `\n${LINE(401)}\n${LINE(402)}\n`, 'utf8')
      }
      await Promise.resolve()
    }

    const bus = new LogBus()
    const seen: string[] = []
    bus.subscribe((ev) => seen.push(ev.raw))
    const res = await scanLog(logPath, bus, 0, {
      slicer: createSlicer({ budgetMs: 0, yieldTo: appendOnFirstYield })
    })

    assert.equal(appended, true, 'the mid-scan append actually happened (the slicer yielded)')
    assert.equal(seen.length, 400, 'exactly the 400 COMPLETE lines that existed when EOF was frozen')
    assert.equal(seen[0], LINE(0))
    assert.equal(seen[399], LINE(399))
    assert.equal(
      res.endOffset,
      Buffer.byteLength(complete, 'utf8'),
      'endOffset stops at the last complete line — the trailing partial is left for the tailer'
    )
    assert.ok(res.endOffset < frozenBytes, 'and it is short of the frozen EOF by exactly the partial line')

    // THE HANDOFF, replayed the way session.ts does it: the tailer starts at endOffset. Every byte
    // of the file from there on is unread — the completed partial line and both appended lines,
    // each exactly once, and nothing the scan already folded.
    const tail = readFileSync(logPath, 'utf8').slice(res.endOffset)
    const tailLines = tail.split('\n').filter((l) => l.length > 0)
    assert.deepEqual(tailLines, [LINE(400), LINE(401), LINE(402)], 'the tail picks up exactly where the scan stopped')
    const all = [...seen, ...tailLines]
    assert.equal(new Set(all).size, all.length, 'no line is folded twice across the seam')
    assert.equal(all.length, 403, 'and none is skipped: 400 replayed + 3 tailed = every line in the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty or missing log yields nothing and hands the tailer offset 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eqc-empty-'))
  try {
    const empty = join(dir, 'eqlog_Empty_bench.txt')
    writeFileSync(empty, '', 'utf8')
    const bus = new LogBus()
    let count = 0
    bus.subscribe(() => (count += 1))
    assert.deepEqual(await scanLog(empty, bus, 0, { slicer: createSlicer({ budgetMs: 0 }) }), {
      endOffset: 0,
      seq: 0
    })
    assert.deepEqual(await scanLog(join(dir, 'nope.txt'), bus, 7), { endOffset: 0, seq: 7 })
    assert.equal(count, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
