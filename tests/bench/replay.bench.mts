/**
 * ============================================================================
 * replay.bench.mts — what the startup replay COSTS, measured on a real boot.
 * ============================================================================
 *
 * `npm run bench:replay` (docs/plans/chunked-replay.md §3). It is spec-shaped rather than a unit
 * test, and it is deliberately NOT in tests/e2e/run-all.mts: it boots the whole app against a
 * ~100 MB log, takes the better part of a minute, and its verdict depends on how busy the machine
 * running it is. A gate like that in CI would be a coin flip; a ledger like this on one developer's
 * machine is the before/after evidence a performance change lives or dies by.
 *
 * WHAT IT MEASURES, and why each number is here:
 *   replayMs         the `replayDone` phase — how long the historical fold took.
 *   eventsReplayed   how many events that was. "6 s" means something very different for 40k
 *                    events than for 1.2M, which is why the profile states both.
 *   eventsPerSec     the two above, divided. THE throughput figure, and the one chunking spends.
 *   maxBlockMs       the worst single main-loop stall between appReady and replayDone, from the
 *                    always-on probe (plan §2). THE invariant: chunking exists to bound this.
 *   blocksOver50Ms   how many stalls crossed the same threshold the perf HUD calls "warn".
 *
 * THE INPUT. A bench that reads a different log each run measures the log, not the code. So:
 *   1. `tests/bench/fixtures/Logs/eqlog_*.txt` — the STANDARD fixture, if you have put one there.
 *      (Gitignored: a comparable bench log is ~100 MB of one person's real game log, which is
 *      exactly what the scrub law and the public-repo rule exist to keep out of git. Copy one in
 *      by hand; the path is the contract, not the bytes.)
 *   2. otherwise the machine's own EQ log, discovered exactly as the app discovers it — and the
 *      output SAYS SO, because numbers from a log that grows every evening are comparable with
 *      yesterday's run on this machine and with nothing else.
 * Either way the ledger line records the log's name and byte size, so a run whose input moved is
 * visible rather than mysterious.
 *
 * THE LEDGER. One JSON line per run appended to `.bench/replay.jsonl` (gitignored) — local,
 * accumulating, and the thing you actually diff when the next pipeline change lands.
 *
 * THE BUDGETS are constants below, each with its rationale. A human edits them deliberately;
 * nothing here ever ratchets them automatically, because a budget that moves itself is a budget
 * that has stopped saying anything.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { MAIN_ENTRY, ROOT, buildIfStale, electronBinary, sleep } from '../e2e/appHarness.mjs'
import { discoverEqRoot, fixedDrives, registryInstallCandidates, rootHasLogs } from '../../src/main/log/discovery'
import { parseStartupProfile, type StartupProfile } from '../../src/shared/perf'

// ------------------------------------------------------------------------------- the budgets

/**
 * THE CHUNKING INVARIANT (plan §1): no main-loop block over 50 ms during replay. Same number the
 * perf HUD already calls "warn" — one threshold, one vocabulary. Before chunking this bench
 * FAILED here, loudly and on purpose; that failure is the whole reason the change exists.
 */
const MAX_BLOCK_MS_BUDGET = 50

/**
 * THE THROUGHPUT FLOOR (plan §3): 0.5× the pre-chunking rate measured on this machine.
 *
 * MEASURED, not guessed. The UNCHUNKED baseline run — the first line in .bench/replay.jsonl,
 * recorded 2026-08-04 before replaySlicer.ts existed — folded 1,240,019 events in 8,640 ms =
 * 143,521 events/sec against the 96 MB eqlog_Primitive_freeport.txt. Half of that is 71,760/s,
 * stated here as a round 70,000 a human can hold.
 *
 * Cooperative scheduling is not free — a clock read per line and a `setImmediate` per slice — and
 * spending some throughput to stop blocking the main process is the entire trade this change
 * makes. Spending HALF of it would be a different, worse trade, and a regression that quietly
 * doubled the replay would pass every other check in this repo.
 */
const EVENTS_PER_SEC_FLOOR = 70_000

// --------------------------------------------------------------------------------- the input

/** The standard fixture root, shaped like an EQ install (`<root>/Logs/eqlog_<Char>_<server>.txt`). */
const FIXTURE_ROOT = join(ROOT, 'tests', 'bench', 'fixtures')
/** Its OWN userData, never the e2e harness's: this must be runnable beside anything else. */
const BENCH_USER_DATA = join(tmpdir(), 'everquest-companion-bench-userdata')
const LEDGER_DIR = join(ROOT, '.bench')
const LEDGER = join(LEDGER_DIR, 'replay.jsonl')
/** A 100 MB log takes seconds to fold on a good machine and much longer on a loaded one. */
const REPLAY_TIMEOUT_MS = 300_000

type InputSource = 'fixture' | 'machine'

interface BenchInput {
  source: InputSource
  /** Set as EQ_INSTALL_DIR when we are pinning the app to the fixture; undefined = let it discover. */
  installDir?: string
  /** The log we EXPECT it to read, for the note. The authoritative answer comes from the app. */
  logPath?: string
}

function newestLogIn(logsDir: string): string | undefined {
  if (!existsSync(logsDir)) return undefined
  const logs = readdirSync(logsDir)
    .filter((f) => /^eqlog_.+\.txt$/i.test(f))
    .map((f) => join(logsDir, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return logs[0]?.p
}

/** Fixture first, the machine's own log second. Never invents an input it cannot name. */
function resolveInput(): BenchInput {
  const fixtureLog = newestLogIn(join(FIXTURE_ROOT, 'Logs'))
  if (fixtureLog) return { source: 'fixture', installDir: FIXTURE_ROOT, logPath: fixtureLog }
  // The app's OWN discovery order, so the bench and the app never disagree about which log this is.
  const root = discoverEqRoot({
    hasLogs: rootHasLogs,
    extraCandidates: () => registryInstallCandidates(),
    fixedDrives
  })
  return { source: 'machine', ...(root ? { logPath: newestLogIn(join(root, 'Logs')) } : {}) }
}

// ------------------------------------------------------------------------------- the boot

function launch(input: BenchInput): Promise<ElectronApplication> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EQ_E2E: '1',
    EQ_E2E_USER_DATA: BENCH_USER_DATA,
    NODE_ENV: 'production'
  }
  if (input.installDir) env.EQ_INSTALL_DIR = input.installDir
  else delete env.EQ_INSTALL_DIR
  return electron.launch({
    executablePath: electronBinary(),
    args: [MAIN_ENTRY],
    cwd: ROOT,
    env,
    timeout: 60_000
  })
}

interface CharacterRefLite {
  name: string
  server: string
  logPath: string
}

/** Which log the app actually tailed — asked of the app, not inferred. Null until the scan ends. */
function activeCharacter(page: Page): Promise<CharacterRefLite | null> {
  return page.evaluate(() =>
    (
      window as unknown as { eq: { getCharacter: () => Promise<CharacterRefLite | null> } }
    ).eq.getCharacter()
  ) as Promise<CharacterRefLite | null>
}

/**
 * Wait for the launch to leave a COMPLETE profile behind. The file is written when the last phase
 * lands, so its appearance is the signal that both the replay and the renderer's mount are done —
 * there is nothing to poll inside the app for, and nothing to guess at with a sleep.
 */
async function waitForProfile(): Promise<StartupProfile | null> {
  const path = join(BENCH_USER_DATA, 'perf-startup.json')
  const deadline = Date.now() + REPLAY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const profile = parseStartupProfile(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (profile?.complete) return profile
    } catch {
      // not written yet (or half-written — it is renamed into place, but be forgiving anyway)
    }
    await sleep(500)
  }
  return null
}

// ------------------------------------------------------------------------------- the readout

interface BenchRun {
  ts: string
  version: string
  source: InputSource
  log: string
  logBytes: number
  totalMs: number
  replayMs: number
  eventsReplayed: number
  eventsPerSec: number
  maxBlockMs: number | null
  blocksOver50Ms: number | null
  blockSamples: number
  phases: Record<string, number>
}

/** What the ledger says the input WAS, so a run whose log moved is visible rather than mysterious. */
function describeLog(logPath: string | undefined): { log: string; logBytes: number } {
  if (!logPath || !existsSync(logPath)) return { log: logPath ? basename(logPath) : 'unknown', logBytes: 0 }
  return { log: basename(logPath), logBytes: statSync(logPath).size }
}

function foldRun(profile: StartupProfile, input: BenchInput, logPath: string | undefined): BenchRun {
  const phases: Record<string, number> = {}
  for (const p of profile.phases) phases[p.phase] = Math.round(p.durationMs)
  const replayMs = phases.replayDone ?? 0
  const events = profile.eventsReplayed ?? 0
  const block = profile.block
  return {
    ts: new Date().toISOString(),
    version: profile.version,
    source: input.source,
    ...describeLog(logPath),
    totalMs: Math.round(profile.totalMs),
    replayMs,
    eventsReplayed: events,
    eventsPerSec: replayMs > 0 ? Math.round((events / replayMs) * 1000) : 0,
    maxBlockMs: block ? block.maxBlockMs : null,
    blocksOver50Ms: block ? block.blocksOver50Ms : null,
    blockSamples: block ? block.samples : 0,
    phases
  }
}

const num = (n: number): string => n.toLocaleString('en-US')

function printTable(run: BenchRun): void {
  const rows: [string, string][] = [
    ['log', `${run.log} (${num(Math.round(run.logBytes / 1_048_576))} MB, ${run.source})`],
    ['startup total', `${num(run.totalMs)} ms`],
    ['replay', `${num(run.replayMs)} ms`],
    ['events replayed', num(run.eventsReplayed)],
    ['events/sec', `${num(run.eventsPerSec)}  (floor ${num(EVENTS_PER_SEC_FLOOR)})`],
    [
      'max block',
      run.maxBlockMs === null
        ? 'not measured (the probe held no ticks)'
        : `${num(run.maxBlockMs)} ms  (budget ${String(MAX_BLOCK_MS_BUDGET)} ms, ${String(run.blockSamples)} probe ticks)`
    ],
    ['blocks over 50 ms', run.blocksOver50Ms === null ? 'not measured' : num(run.blocksOver50Ms)]
  ]
  console.log('')
  for (const [label, value] of rows) console.log(`  ${label.padEnd(18)} ${value}`)
  console.log('')
  console.log(`  phases: ${Object.entries(run.phases).map(([k, v]) => `${k} ${num(v)}ms`).join(' · ')}`)
  console.log('')
}

/** Append the run to the local ledger BEFORE asserting anything: a failing run is exactly the one
 *  whose numbers you want to keep. */
function record(run: BenchRun): void {
  mkdirSync(LEDGER_DIR, { recursive: true })
  appendFileSync(LEDGER, `${JSON.stringify(run)}\n`, 'utf8')
  console.log(`  ledger: .bench/replay.jsonl (+1 line, ${String(readFileSync(LEDGER, 'utf8').trim().split('\n').length)} total)`)
}

function assertBudgets(run: BenchRun): number {
  const failures: string[] = []
  if (run.maxBlockMs === null) {
    failures.push('the startup block probe recorded no samples — maxBlockMs cannot be asserted')
  } else if (run.maxBlockMs > MAX_BLOCK_MS_BUDGET) {
    failures.push(
      `maxBlockMs ${num(run.maxBlockMs)} ms exceeds the ${String(MAX_BLOCK_MS_BUDGET)} ms chunking invariant`
    )
  }
  if (run.eventsPerSec < EVENTS_PER_SEC_FLOOR) {
    failures.push(
      `events/sec ${num(run.eventsPerSec)} is under the ${num(EVENTS_PER_SEC_FLOOR)} floor (0.5× the pre-chunking baseline)`
    )
  }
  if (failures.length === 0) {
    console.log('  bench: both budgets met')
    return 0
  }
  console.log(`  bench: FAILED (${String(failures.length)})`)
  for (const f of failures) console.log(`    - ${f}`)
  return 1
}

// ------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const input = resolveInput()
  if (input.source === 'fixture') {
    console.log(`bench: standard fixture — ${input.logPath ?? '?'}`)
  } else {
    console.log('bench: NO fixture at tests/bench/fixtures/Logs — falling back to this machine’s own EQ log.')
    console.log('bench: NOTE — numbers from a live, growing log are comparable with earlier runs on THIS')
    console.log('bench:        machine and with nothing else. Do not quote them against another machine.')
  }
  if (!input.logPath) {
    console.error('bench: no EQ log found at all — nothing to replay. (Put one under tests/bench/fixtures/Logs/.)')
    process.exitCode = 1
    return
  }

  buildIfStale()
  rmSync(BENCH_USER_DATA, { recursive: true, force: true })

  console.log(`launch: hidden Electron (EQ_E2E=1), fresh userData — replaying ${basename(input.logPath)}…`)
  const t0 = Date.now()
  const app = await launch(input)
  let tailed: CharacterRefLite | null = null
  let profile: StartupProfile | null = null
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    profile = await waitForProfile()
    tailed = await activeCharacter(page).catch(() => null)
  } finally {
    await app.close().catch(() => undefined)
  }
  console.log(`  boot: ${String(Math.round((Date.now() - t0) / 1000))}s wall clock (launch → profile → close)`)

  if (!profile) {
    console.error(`bench: the launch never wrote a complete perf-startup.json within ${String(REPLAY_TIMEOUT_MS / 1000)}s`)
    process.exitCode = 1
    return
  }

  const run = foldRun(profile, input, tailed?.logPath ?? input.logPath)
  printTable(run)
  record(run)
  process.exitCode = assertBudgets(run)
}

main().catch((err: unknown) => {
  console.error('bench: harness error —', err)
  process.exitCode = 1
})
