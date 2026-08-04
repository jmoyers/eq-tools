/**
 * Headless Electron integration test for PERFORMANCE PROFILING (docs/plans/perf-profiling.md, P7).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST: every claim this feature makes is a SEAM.
 *   - "the chip is absent by default" is a claim about a fresh install's store, an IPC handler,
 *     a push channel that stays silent, and a component that renders null. Only the real app
 *     can show that nothing appears.
 *   - "it appears once you enable it" crosses the Preferences pane, a store write, a sampler
 *     that must START in the same call (not on the next launch), `app.getAppMetrics()`, and a
 *     push. A mocked version of that would be asserting the mock.
 *   - "the popover renders NUMBERS" is the whole point of a HUD, and the numbers come from
 *     Electron's own metrics — there is nowhere else to get them.
 *   - "every launch leaves a startup profile with monotonic phases" is a claim about a FILE
 *     written by a real boot, so it is read off disk, from the userData dir this run used.
 *
 * Identities only, never today's numbers: memory is asserted to be positive and phases to be
 * ordered, never to equal a figure that depends on the machine this ran on.
 *
 * Run: `node --import tsx tests/e2e/perf.e2e.mts` (it is also in tests/e2e/run-all.mts).
 * Never run it beside another spec — they share the userData singleton.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAIN_ENTRY,
  ROOT,
  USER_DATA,
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  electronBinary,
  failures,
  note,
  reportRun,
  sleep
} from './appHarness.mjs'

const CHIP = '[data-testid="perf-chip"]'
const POPOVER = '[data-testid="perf-popover"]'
const PANE = '[data-testid="pref-perf"]'
const SWITCH = '[data-testid="pref-perf-enabled"] input'
const BREAKDOWN = '[data-testid="perf-startup"]'
/** The sampler pushes every 2 s and emits one immediately on start; be generous anyway. */
const SAMPLE_WAIT_MS = 6_000
/** A full historical scan of a months-old live log takes seconds; be generous, fail loudly. */
const REPLAY_WAIT_MS = 300_000

/**
 * The strictly-sequential head of the boot, asserted as a LIST: a profile whose phases arrived
 * in a different order would still be "monotonic" by timestamp alone, so the order is checked
 * as well as the timestamps.
 */
const SEQUENTIAL_PHASES = [
  'storeLoaded',
  'dataLoaded',
  'appReady',
  'protocols',
  'windowCreated',
  'tailAttached'
]
/** …and the tail, which RACES: the window paints while the historical scan is still folding, so
 *  either of these can land first depending on how much log there is. */
const CONCURRENT_PHASES = ['replayDone', 'rendererHydrated']

interface Phase {
  phase: string
  atMs: number
  durationMs: number
}
interface BlockStats {
  samples: number
  maxBlockMs: number
  blocksOver50Ms: number
}
interface Profile {
  startedAt: number
  version: string
  phases: Phase[]
  totalMs: number
  eventsReplayed?: number
  block?: BlockStats
  complete: boolean
}

function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    selector
  )
}

function launch(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronBinary(),
    args: [MAIN_ENTRY],
    cwd: ROOT,
    env: { ...process.env, EQ_E2E: '1', EQ_E2E_USER_DATA: USER_DATA, NODE_ENV: 'production' },
    timeout: 60_000
  })
}

/**
 * Answer the analytics first-run notice, which a FRESH userData always shows (usage-analytics
 * T1) and which sits over the whole window until it is answered. "Turn it off" keeps this run
 * quiet — nothing about performance depends on analytics, and a spec should not leave a second
 * feature collecting in the background while it measures a third.
 */
async function dismissFirstRunNotice(page: Page): Promise<void> {
  const notice = '[data-testid="telemetry-notice"]'
  await page.waitForSelector(notice, { timeout: 30_000 }).catch(() => undefined)
  if ((await countOf(page, notice)) === 0) return
  await page.click('[data-testid="telemetry-notice-off"]')
  await sleep(600)
  check('the analytics first-run notice can be answered out of the way', (await countOf(page, notice)) === 0)
}

/** THE DEFAULT-OFF ASSERTION. The HUD costs a metrics poll and a 500 ms probe; a user who never
 *  asked for one must not be paying for it, and must not see it either. */
async function stepAbsentByDefault(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await sleep(1_500)
  check(
    'the performance chip is absent on a fresh install — the HUD is opt-in',
    (await countOf(page, CHIP)) === 0
  )
  const prefs = await page.evaluate(() =>
    (window as unknown as { eq: { getPerfPrefs: () => Promise<{ enabled: boolean }> } }).eq.getPerfPrefs()
  )
  check('…and the stored switch says so', prefs.enabled === false, JSON.stringify(prefs))
}

/** Enabling from Preferences must take effect NOW: the sampler starts in the same call. */
async function stepEnable(page: Page): Promise<boolean> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 30_000 })
  await page.click('[data-testid="prefs-rail-performance"]', { timeout: 15_000 })
  await page.waitForSelector(PANE, { timeout: 15_000 })
  check('Preferences has a Performance section', (await countOf(page, PANE)) === 1)

  const before = await page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked,
    SWITCH
  )
  check('the switch reflects the stored answer (off)', before === false, String(before))

  await page.click(SWITCH)
  try {
    await page.waitForSelector(CHIP, { timeout: SAMPLE_WAIT_MS })
  } catch {
    // fall through to the check below, which reports it as a failure with the DOM dumped
  }
  return check(
    'enabling it puts the live chip in the title bar, without a relaunch',
    (await countOf(page, CHIP)) === 1
  )
}

/** The chip's own text is the compact contract: `CPU 12% · 480 MB`. */
async function stepChipReadsNumbers(page: Page): Promise<void> {
  const text = (await textOf(page, CHIP)).replace(/\s+/g, ' ').trim()
  check(
    'the chip states CPU% and memory in the app’s own vocabulary',
    /CPU\s+\d+%/.test(text) && /\d+(\.\d+)?\s*(MB|GB)/.test(text),
    text || 'no chip text'
  )
}

/** The popover: the per-process table, the lag figures the colour came from, and the sparkline. */
async function stepPopover(page: Page): Promise<void> {
  await page.click(CHIP)
  await page.waitForSelector(POPOVER, { timeout: 15_000 })
  const text = (await textOf(page, POPOVER)).replace(/\s+/g, ' ').trim()

  check(
    'the popover breaks the total down by process type, with real numbers',
    /\bmain\b/.test(text) && /\brenderer\b/.test(text) && /\d+%/.test(text) && /\d+\s*(MB|GB)/.test(text),
    text.slice(0, 160)
  )
  check(
    '…states how far behind the event loop is running (the figure the colour comes from)',
    /event loop/i.test(text) && /(\d+\s*(ms|s)|not measured yet)/.test(text),
    text.slice(0, 160)
  )
  check('…counts the renderer’s own long tasks', /long tasks/i.test(text))
  check(
    '…and draws the last two minutes as a sparkline with a real path',
    (await page.evaluate(
      () =>
        (document.querySelector('[data-testid="perf-sparkline"] polyline') as SVGPolylineElement | null)
          ?.getAttribute('points')?.length ?? 0
    )) > 0
  )
  await page.keyboard.press('Escape')
  await sleep(400)
}

/**
 * Wait for the historical replay to finish. `hydrating` is the combat engine's own answer to
 * exactly that question (it stays true until `setLive()`, which is the statement immediately after
 * the scan returns), so this asks the app rather than sleeping at it.
 */
async function waitForReplay(page: Page): Promise<boolean> {
  const deadline = Date.now() + REPLAY_WAIT_MS
  while (Date.now() < deadline) {
    const snap = await page
      .evaluate(() =>
        (
          window as unknown as { eq: { getCombatSnapshot: (o: unknown) => Promise<{ hydrating: boolean }> } }
        ).eq.getCombatSnapshot({})
      )
      .catch(() => null)
    if (snap && !snap.hydrating) return true
    await sleep(500)
  }
  return false
}

/** The startup breakdown in Preferences — the half that is recorded whether the HUD is on or not. */
async function stepStartupPane(page: Page): Promise<void> {
  // The pane reads the profile SO FAR, ONCE, when it mounts — and on a real log the historical
  // replay is still folding ten seconds into a launch. So "names every phase" is a claim about the
  // pane's VOCABULARY that can only be made after the last phase has landed AND the pane has been
  // mounted since. Wait for the replay, then remount by leaving the tab and coming back. Before
  // this the assertion passed on the strength of the replay beating the spec's own click sequence,
  // which is luck rather than a test — and chunked replay's ~7% throughput cost was enough to run
  // it out (measured: the pane showed 7 of 8 phases, twice in a row).
  check('the historical replay finishes within the spec’s patience', await waitForReplay(page))
  await page.click('[data-testid="nav-overview"]', { timeout: 30_000 })
  await sleep(400)
  await page.click('[data-testid="nav-preferences"]', { timeout: 30_000 })
  await page.click('[data-testid="prefs-rail-performance"]', { timeout: 15_000 })
  await page.waitForSelector(BREAKDOWN, { timeout: 15_000 })
  const text = (await textOf(page, BREAKDOWN)).replace(/\s+/g, ' ').trim()
  check(
    'Preferences shows the last startup as a per-phase breakdown with a total',
    /Last startup:/.test(text) && /(\d+(\.\d+)?\s*(ms|s))/.test(text),
    text.slice(0, 140)
  )
  check(
    '…names every phase of the boot it describes',
    /Settings loaded/.test(text) && /Log history replayed/.test(text) && /Interface drawn/.test(text),
    text.slice(0, 200)
  )
}

/** THE FILE. Written on every launch, HUD or no HUD — this is the "the launch you wish you had
 *  profiled is the one that already happened" promise, asserted against real bytes. */
function stepProfileFile(): void {
  const path = join(USER_DATA, 'perf-startup.json')
  let profile: Profile | null = null
  try {
    profile = JSON.parse(readFileSync(path, 'utf8')) as Profile
  } catch (err) {
    check('every launch writes <userData>/perf-startup.json', false, String(err))
    return
  }
  if (!check('every launch writes <userData>/perf-startup.json', profile.phases.length > 0)) return

  const names = profile.phases.map((p) => p.phase)
  check(
    'it records the sequential half of the boot, in order',
    JSON.stringify(names.slice(0, SEQUENTIAL_PHASES.length)) === JSON.stringify(SEQUENTIAL_PHASES),
    names.join(' → ')
  )
  check(
    '…and both of the phases that race, in whichever order this launch produced',
    [...names.slice(SEQUENTIAL_PHASES.length)].sort().join(',') === [...CONCURRENT_PHASES].sort().join(','),
    names.slice(SEQUENTIAL_PHASES.length).join(' → ')
  )
  const marks = profile.phases.map((p) => p.atMs)
  check(
    'the phase marks are MONOTONIC — no phase lands before the one it follows',
    marks.every((at, i) => i === 0 || at >= (marks[i - 1] ?? 0)),
    marks.map((m) => Math.round(m)).join(', ')
  )
  const summed = profile.phases.reduce((n, p) => n + p.durationMs, 0)
  check(
    'the durations account for the whole launch, exactly (nothing is NaN or negative)',
    profile.phases.every((p) => Number.isFinite(p.durationMs) && p.durationMs >= 0) &&
      Math.abs(summed - profile.totalMs) < 1,
    `Σ ${String(Math.round(summed))}ms vs total ${String(Math.round(profile.totalMs))}ms`
  )
  check('…and states the launch it describes', profile.complete && profile.startedAt > 0, JSON.stringify({ complete: profile.complete, startedAt: profile.startedAt }))
  check(
    'the replay states how many events it folded, beside how long it took',
    typeof profile.eventsReplayed === 'number' && profile.eventsReplayed >= 0,
    `${String(profile.eventsReplayed)} events`
  )
  stepBlockProbe(profile.block)
}

/**
 * THE ALWAYS-ON BLOCK PROBE (docs/plans/chunked-replay.md §2), asserted additively beside the
 * phases it shares a file with. Unlike the HUD's probe this one is not opt-in and has no switch to
 * forget, so its absence from a real boot IS the regression. Identities only: how blocked this
 * particular machine got is not something a spec can assert — the bench (`npm run bench:replay`)
 * owns that budget, against a known log, on one machine.
 */
function stepBlockProbe(block: BlockStats | undefined): void {
  const ok = check(
    'the launch also states how blocked the main loop got — the always-on startup probe',
    block !== undefined && block.samples > 0,
    block ? `${String(block.samples)} probe ticks` : 'absent'
  )
  if (!ok || !block) return
  const sane =
    Number.isFinite(block.maxBlockMs) && block.maxBlockMs >= 0 && Number.isInteger(block.blocksOver50Ms)
  check(
    '…as a worst single stall and a count of the ones past the HUD’s own warn threshold',
    sane && block.blocksOver50Ms >= 0 && block.blocksOver50Ms <= block.samples,
    `max ${String(block.maxBlockMs)}ms · ${String(block.blocksOver50Ms)}/${String(block.samples)} over 50ms`
  )
}

async function main(): Promise<void> {
  buildIfStale()
  // A genuinely fresh install: "absent by default" is only meaningful on one.
  rmSync(USER_DATA, { recursive: true, force: true })

  console.log('launch: hidden Electron (EQ_E2E=1), fresh userData — Performance spec…')
  const app: ElectronApplication = await launch()
  let page: Page | null = null
  const consoleErrors: string[] = []
  try {
    page = await app.firstWindow({ timeout: 60_000 })
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    await dismissFirstRunNotice(page)
    await stepAbsentByDefault(page)
    if (await stepEnable(page)) {
      await stepChipReadsNumbers(page)
      await stepPopover(page)
    }
    await stepStartupPane(page)
    if (failures.length) await dumpArtifacts(page, 'perf-FAIL')
  } finally {
    await app.close().catch(() => undefined)
  }

  // Read the file AFTER the app has quit: the profile is written when the last phase lands, and
  // a quit-time flush covers a launch that never got there.
  stepProfileFile()

  // A missing IPC handler shows up here first (`invoke` rejects into an unhandled rejection).
  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  if (consoleErrors.length === 0) {
    note('the chip, the popover and the startup file all came from one real boot of the app')
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
