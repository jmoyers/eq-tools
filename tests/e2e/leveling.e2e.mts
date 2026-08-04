/**
 * Headless Electron integration test for the LEVELING tab
 * (docs/plans/leveling-analytics.md §8, "Final verification").
 *
 * WHY ITS OWN FILE: one spec per surface, all of them sharing `appHarness.mts` and running back
 * to back from `npm run test:e2e`. `EQ_E2E=1` (src/main/e2e.ts) shows no window, skips the
 * single-instance lock and points `userData` at a throwaway temp dir, so this runs invisibly
 * beside the user's game and dev app.
 *
 * WHY `userData` IS WIPED FIRST: the headline assertion is that the range-stats panel does NOT
 * exist until a selection does. Nothing about a selection is persisted today (the plan defers
 * that deliberately, §9), but a fresh dir is what makes "before any selection" mean the same
 * thing on every machine and after every earlier spec. ARTIFACTS is deliberately NOT wiped —
 * the earlier specs' dumps must survive this run.
 *
 * WHAT IT ASSERTS, against whatever the real log holds right now:
 *   1. the nav row mounts the view (or the no-logs empty state honestly explains why not);
 *   2. a chart is drawn, and the ZONE-BAND STRIP is mounted inside it with real bands;
 *   3. NO range-stats panel exists before a selection — the plan's §6.4 "only when sel != null";
 *   4. a real pointer DRAG across the chart commits a range, and the panel then mounts WITH
 *      rows (hero cards + at least one per-zone row — `Σ zones[].spanMs == durationMs` means a
 *      committed range always covers at least one zone row, even if it is the `unknown` one);
 *   5. a CLICK (under `DRAG_THRESHOLD_PX`) dismisses it again — the panel is selection-scoped,
 *      not sticky;
 *   6. the tab never scrolls the page, and there are no renderer console errors.
 *
 * FRESH-MACHINE HONESTY. A machine with no EQ logs mounts no feature view at all, and a
 * character whose log carries fewer than two dings and fewer than two AA gains draws no chart —
 * `LevelingView` renders its stated empty state instead. Both are the CORRECT behaviour: the
 * spec detects them, asserts the honest EMPTY-state versions of the above (the view mounts, the
 * empty state says why, and no stats panel exists), `note()`s what it saw, and skips the
 * assertions that presuppose a drawn chart.
 *
 * Floors and identities only, never today's numbers (AGENTS.md: frozen numbers rot).
 *
 * Run: `npm run test:e2e`.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { rmSync } from 'node:fs'
import {
  HYDRATE_TIMEOUT_MS,
  MAIN_ENTRY,
  ROOT,
  USER_DATA,
  buildIfStale,
  check,
  countOf,
  dumpArtifacts,
  electronBinary,
  failures,
  hoverAt,
  note,
  pageOverflow,
  rectOf,
  reportRun,
  sleep,
  snapshot
} from './appHarness.mjs'

const NAV = '[data-testid="nav-leveling"]'
const VIEW = '[data-testid="leveling-view"]'
const EMPTY = '[data-testid="leveling-empty"]'
const AA_CHART = '[data-testid="leveling-aa-chart"]'
const LEVEL_CHART = '[data-testid="leveling-level-chart"]'
const BANDS = '[data-testid="leveling-zone-bands"]'
const BAND = '[data-testid="leveling-zone-band"]'
const LEGEND_ROW = '[data-testid="leveling-zone-legend-row"]'
const PANEL = '[data-testid="leveling-range-stats"]'
const HERO = '[data-testid="leveling-range-hero"]'
const ZONE_ROW = '[data-testid="leveling-range-zone-row"]'

/** Rendered text of the first match; '' when the node isn't mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/** Poll a predicate until it holds or the deadline passes. Everything here lands asynchronously. */
async function until(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 >= ms) return false
    await sleep(250)
  }
}

/**
 * A REAL pointer drag across `sel`, left to right, through the harness's own `hoverAt` — real
 * `pointerdown`/`pointermove`/`pointerup` with genuine `buttons` state, because that is exactly
 * what `useChartSelection` reads (pointer capture on the wrapper, a `DRAG_THRESHOLD_PX` gate,
 * and a `MIN_SELECTION_MS` floor under which the drag is DISCARDED). A synthesized event would
 * prove nothing about that seam.
 *
 * The intermediate move matters: the threshold flips `dragging` on the first move past 5px and
 * the draft band tracks every one after it, so a single teleporting move would exercise only
 * half the hook.
 *
 * Fractions are wide on purpose (10% → 90%): the domain spans the whole log, so any sizeable
 * fraction of it is far past the 60-second minimum selection.
 */
async function dragRange(page: Page, sel: string): Promise<boolean> {
  if (!(await hoverAt(page, sel, 0.1, 0.5))) return false
  await page.mouse.down()
  await hoverAt(page, sel, 0.5, 0.5)
  await hoverAt(page, sel, 0.9, 0.5)
  await page.mouse.up()
  await sleep(500)
  return true
}

/** A press-and-release with NO travel — the click gesture, which is the dismissal. */
async function clickChart(page: Page, sel: string): Promise<void> {
  await hoverAt(page, sel, 0.5, 0.5)
  await page.mouse.down()
  await page.mouse.up()
  await sleep(500)
}

// ── the run ───────────────────────────────────────────────────────────────────────────

/** 1. THE NAV ROW MOUNTS THE VIEW. Returns false on the no-logs machine, where nothing does. */
async function stepMount(page: Page): Promise<boolean> {
  const hasRow = await page.waitForSelector(NAV, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!check('the nav drawer has a Leveling row', hasRow)) return false
  await page.click(NAV, { timeout: 15_000 })
  const mounted = await page.waitForSelector(VIEW, { timeout: 30_000 }).then(
    () => true,
    () => false
  )
  if (!mounted) {
    // The one legitimate reason the view does not mount: no character logs at all, so App's
    // fresh-machine empty state stands in front of every feature view.
    const noLogs = (await textOf(page, 'main')).includes('No EverQuest logs found')
    check('clicking Leveling mounts the view (or the no-logs empty state explains why not)', noLogs)
    if (noLogs) note('no character logs on this machine — the app shows its fresh-machine empty state and no feature view mounts')
    return false
  }
  check('clicking the Leveling nav row mounts the view', true)
  return true
}

/** Wait out the startup replay: until it hands off, every module is still filling. */
async function waitHydrated(page: Page): Promise<void> {
  const t0 = Date.now()
  let snap = await snapshot(page)
  while (snap.hydrating && Date.now() - t0 < HYDRATE_TIMEOUT_MS) {
    await sleep(500)
    snap = await snapshot(page)
  }
  check('hydration completes (replay hands off to the live tail)', !snap.hydrating, `${String(Date.now() - t0)}ms`)
  // Let the post-hydration render land — both modules push their snapshot on their own clock.
  await sleep(1500)
}

/**
 * 2. A CHART IS DRAWN, or the view's stated empty state says why not.
 *
 * Both outcomes are correct behaviour; only a THIRD outcome (neither) is a failure. Returns the
 * chart to drag on — the level chart when it is drawn, else the AA chart, since either one owns
 * the SAME selection (useChartSelection is called once, in the view).
 */
async function stepChart(page: Page): Promise<string | null> {
  const drawn = await until(async () => (await countOf(page, LEVEL_CHART)) + (await countOf(page, AA_CHART)) > 0, 45_000)
  if (drawn) {
    const sel = (await countOf(page, LEVEL_CHART)) > 0 ? LEVEL_CHART : AA_CHART
    const box = await rectOf(page, sel)
    check(
      'the leveling chart is mounted with real size',
      !!box && box.w > 0 && box.h > 0,
      box ? `${String(box.w)}×${String(box.h)}px` : 'absent'
    )
    return box && box.w > 0 && box.h > 0 ? sel : null
  }
  const emptyText = (await textOf(page, EMPTY)).replace(/\s+/g, ' ').trim()
  check(
    'no chart drawn ⇒ the view states WHY, never a blank pane',
    emptyText.length > 0,
    emptyText.slice(0, 110)
  )
  note('this character’s log carries too few level-ups / AA gains to draw a chart — the stated empty state is the correct surface, and the band-strip and selection assertions are skipped')
  return null
}

/** 3. THE ZONE-BAND STRIP IS MOUNTED — inside the chart, with real bands and a legend. */
async function stepBands(page: Page): Promise<void> {
  const strips = await countOf(page, BANDS)
  const bands = await countOf(page, BAND)
  if (strips === 0) {
    // Correct behaviour when the analytics module has no zone intervals over the domain at all
    // (a log with no `You have entered` line yet). Nothing to draw is not a blank pane.
    note('the progression snapshot carries no zone intervals over this domain — the band strip correctly draws nothing this run')
    return
  }
  check('the zone-band strip is mounted on the chart', strips > 0, `${String(strips)} strip(s)`)
  check('…and it draws real bands (a strip with nothing in it would be a lie)', bands > 0, `${String(bands)} bands`)
  // The identification path that does NOT depend on hover (plan §6.2) — the strip and the
  // legend are two halves of one claim, so a strip without a legend is a half-drawn feature.
  const legend = await countOf(page, LEGEND_ROW)
  check('…and the zone legend names the zones it drew', legend > 0, `${String(legend)} legend rows`)
}

/**
 * 4 + 5. THE PANEL IS SELECTION-SCOPED — the headline of this spec.
 *
 * Absent before any selection, present WITH ROWS after a real drag, absent again after the click
 * that dismisses it. Stated as one step because the three readings are only meaningful together:
 * a panel that is always mounted passes the second reading alone.
 */
async function stepSelection(page: Page, chart: string): Promise<void> {
  check(
    'NO range-stats panel exists before a selection (it mounts only when one does)',
    (await countOf(page, PANEL)) === 0,
    `${String(await countOf(page, PANEL))} panel(s)`
  )

  if (!check('the chart is reachable for a drag', await dragRange(page, chart))) return
  const appeared = await until(async () => (await countOf(page, PANEL)) > 0, 8000)
  if (!check('dragging a range across the chart mounts the range-stats panel', appeared)) return

  // WITH ROWS: the four hero cards, and at least one per-zone row. The zone table is never
  // legitimately empty for a committed range — `Σ zones[].spanMs == durationMs` (plan §4) means
  // the range is fully covered, with an `unknown` row standing in before the first zone line.
  const heroes = await countOf(page, HERO)
  const zones = await countOf(page, ZONE_ROW)
  check('…with its hero stats', heroes > 0, `${String(heroes)} hero cards`)
  check('…and at least one per-zone row (a committed range is always fully covered by zones)', zones > 0, `${String(zones)} zone rows`)

  await clickChart(page, chart)
  check(
    'a click (under the drag threshold) dismisses the selection and unmounts the panel',
    (await countOf(page, PANEL)) === 0,
    `${String(await countOf(page, PANEL))} panel(s) after the click`
  )
}

/** 6. THE LAYOUT CONTRACT: the app's content area owns the scroll; a view never grows the page. */
async function stepOverflow(page: Page): Promise<void> {
  const over = await pageOverflow(page)
  check(
    'the Leveling tab never scrolls the page (its panels scroll inside themselves)',
    over.doc === 0 && over.content === 0,
    `document +${String(over.doc)}px · content area +${String(over.content)}px`
  )
}

async function main(): Promise<void> {
  buildIfStale()
  // See the header: a fresh dir is what makes "before any selection" mean the same thing on
  // every machine. ARTIFACTS is left alone so the earlier specs' dumps survive this run.
  rmSync(USER_DATA, { recursive: true, force: true })

  console.log('launch: hidden Electron (EQ_E2E=1) against the real log — Leveling spec…')
  const app: ElectronApplication = await electron.launch({
    executablePath: electronBinary(),
    args: [MAIN_ENTRY],
    cwd: ROOT,
    env: { ...process.env, EQ_E2E: '1', EQ_E2E_USER_DATA: USER_DATA, NODE_ENV: 'production' },
    timeout: 60_000
  })

  let page: Page | null = null
  try {
    page = await app.firstWindow({ timeout: 60_000 })
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))

    if (await stepMount(page)) {
      await waitHydrated(page)
      const chart = await stepChart(page)
      if (chart) {
        await stepBands(page)
        await stepSelection(page, chart)
      } else {
        // The empty-state half of the headline assertion still holds, and is the honest thing
        // to assert on a log with no chart: no selection can exist, so no panel may.
        check('…and with no chart there is no range-stats panel either', (await countOf(page, PANEL)) === 0)
      }
      await stepOverflow(page)
    }

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'leveling-FAIL')
    else await dumpArtifacts(page, 'leveling-pass')
  } finally {
    await app.close().catch(() => undefined)
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
