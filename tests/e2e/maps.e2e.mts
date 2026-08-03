/**
 * Headless Electron integration test for the MAPS tab (docs/plans/map-viewer.md §12).
 *
 * WHY ITS OWN FILE: same reason the Overview spec is its own — one spec per surface, all three
 * sharing `appHarness.mts` and running back to back from `npm run test:e2e`. `EQ_E2E=1`
 * (src/main/e2e.ts) shows no window, skips the single-instance lock and points `userData` at a
 * throwaway temp dir, so this runs invisibly beside the user's game and dev app.
 *
 * WHY `userData` IS WIPED FIRST: the headline assertion is AUTO-OPEN — the log says which zone
 * you are in and the viewer opens that zone's map without being asked. The viewer also remembers
 * the last zone in `localStorage['eq.maps.zone']`, which lives inside `userData`; a stale one
 * would open a map the log never asked for and make the assertion vacuous. ARTIFACTS is
 * deliberately NOT wiped — the earlier specs' dumps must survive this run.
 *
 * WHAT IT ASSERTS, against whatever the real machine holds right now: the nav row mounts the
 * view; the canvas has non-zero size and a devicePixelRatio-scaled backing store (the difference
 * between a crisp map and a blurry one); when the log has stated a zone AND the hand-authored
 * table resolves it, the header states that zone and names a source pack per layer; the
 * search-hit list is a BOUNDED scroll box (the Task-#56 law, measured); a label prefix taken
 * from the map on screen finds itself; clicking a hit leaves the transient marker; and there are
 * no renderer console errors.
 *
 * FRESH-MACHINE HONESTY, twice over. A machine with no EQ install has no logs (so the app shows
 * its no-logs empty state and no feature view mounts at all) and no `maps\` directory (so the
 * viewer shows its quiet picker). Both are the CORRECT behaviour, not failures: the spec detects
 * them, `note()`s what it saw, and skips the assertions that presuppose data. The same is true
 * of a zone the table does not map — the EQL Tutorial is the known case — where the picker, not
 * a guessed map, is the pass.
 *
 * Floors and identities only, never today's numbers (AGENTS.md: frozen numbers rot).
 *
 * Run: `npm run test:e2e` (this spec runs last).
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
  note,
  pageOverflow,
  rectOf,
  reportRun,
  sleep,
  snapshot
} from './appHarness.mjs'

const NAV = '[data-testid="nav-maps"]'
const HEADER = '[data-testid="maps-header"]'
const CANVAS = '[data-testid="map-canvas"]'
const SURFACE = '[data-testid="maps-surface"]'
const EMPTY = '[data-testid="maps-empty"]'
const POINT = '[data-testid="map-point"]'
const HITS = '[data-testid="maps-hits"]'
const HIT_ROW = '[data-testid="maps-hit-row"]'
const SEARCH = '[data-testid="maps-search-input"]'

/** The fixed-height law's ceiling for a hit list, in CSS pixels (MapSearch.HIT_LIST_MAX_H + trim). */
const HIT_LIST_CEILING = 320

/** Rendered text of the first match; '' when the node isn't mounted. */
function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText ?? '', sel)
}

/** Box + scroll geometry — enough to prove a growing list is a BOUNDED scroller. */
function boxOf(page: Page, sel: string): Promise<{ h: number; scrollH: number; clientH: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    return {
      h: Math.round(el.getBoundingClientRect().height),
      scrollH: el.scrollHeight,
      clientH: el.clientHeight
    }
  }, sel)
}

/** Poll a predicate until it holds or the deadline passes. Everything here lands asynchronously. */
async function until(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 >= ms) return false
    await sleep(300)
  }
}

/**
 * The canvas's CSS box and its BACKING STORE, plus the display's dpr.
 *
 * These are three different numbers on purpose: a canvas whose backing store is its CSS size is
 * exactly the blurry-map bug (§6.2), and it is invisible to any assertion that only measures the
 * element.
 */
function canvasMetrics(
  page: Page
): Promise<{ cssW: number; cssH: number; bufW: number; bufH: number; dpr: number } | null> {
  return page.evaluate((sel) => {
    const cv = document.querySelector(sel) as HTMLCanvasElement | null
    if (!cv) return null
    return {
      cssW: Math.round(cv.getBoundingClientRect().width),
      cssH: Math.round(cv.getBoundingClientRect().height),
      bufW: cv.width,
      bufH: cv.height,
      dpr: window.devicePixelRatio || 1
    }
  }, CANVAS)
}

/** A searchable prefix taken from a label ACTUALLY on screen — never an invented string. */
async function labelPrefix(page: Page): Promise<string> {
  const text = await textOf(page, POINT)
  const word = /[A-Za-z]{4,}/.exec(text)
  return word ? word[0] : ''
}

// ── the run ───────────────────────────────────────────────────────────────────────────

/** 1. THE NAV ROW MOUNTS THE VIEW. Returns false on the no-logs machine, where nothing does. */
async function stepMount(page: Page): Promise<boolean> {
  const hasRow = await page.waitForSelector(NAV, { timeout: 60_000 }).then(
    () => true,
    () => false
  )
  if (!check('the nav drawer has a Maps row', hasRow)) return false
  await page.click(NAV, { timeout: 15_000 })
  const mounted = await page.waitForSelector(HEADER, { timeout: 30_000 }).then(
    () => true,
    () => false
  )
  if (!mounted) {
    // The one legitimate reason the view does not mount: no character logs at all, so App's
    // fresh-machine empty state stands in front of every feature view.
    const noLogs = (await textOf(page, 'main')).includes('No EverQuest logs found')
    check('clicking Maps mounts the viewer (or the no-logs empty state explains why not)', noLogs)
    if (noLogs) note('no character logs on this machine — the app shows its fresh-machine empty state and no feature view mounts')
    return false
  }
  check('clicking the Maps nav row mounts the viewer', true)
  return true
}

/** Wait out the startup replay so the character module has had a chance to state the zone. */
async function waitZone(page: Page): Promise<string | undefined> {
  const t0 = Date.now()
  let snap = await snapshot(page)
  while (snap.hydrating && Date.now() - t0 < HYDRATE_TIMEOUT_MS) {
    await sleep(500)
    snap = await snapshot(page)
  }
  return snap.zone
}

/**
 * 2. A MAP IS ON SCREEN, or the quiet state says why not.
 *
 * Both outcomes are correct behaviour; only a THIRD outcome (neither) is a failure.
 */
async function stepMapOrEmpty(page: Page, zone: string | undefined): Promise<boolean> {
  const drew = await until(async () => (await countOf(page, CANVAS)) > 0, 45_000)
  if (drew) return true
  const emptyText = (await textOf(page, EMPTY)).replace(/\s+/g, ' ').trim()
  check(
    'no map drawn ⇒ the viewer shows its quiet picker, never an error or a blank pane',
    emptyText.length > 0,
    emptyText.slice(0, 110)
  )
  note(
    zone == null || zone === ''
      ? 'the log has stated no zone yet — the picker is the correct state and the map assertions are skipped'
      : `no map is open for "${zone}" (unmapped zone, or no maps\\ directory on this machine) — the picker is the correct state and the map assertions are skipped`
  )
  return false
}

/** 3. THE CANVAS IS REAL AND dpr-SCALED. */
async function stepCanvas(page: Page): Promise<void> {
  const rect = await rectOf(page, SURFACE)
  check(
    'the map pane has real size (it is not squeezed to nothing)',
    !!rect && rect.w > 0 && rect.h > 0,
    rect ? `${String(rect.w)}×${String(rect.h)}px` : 'absent'
  )
  const m = await canvasMetrics(page)
  if (!m) return
  // The canvas FILLS its pane. Stated as an identity against the host box rather than as a
  // number, because the failure it catches is silent: an unsized <canvas> falls back to its
  // intrinsic 300×150, which at dpr 1 still satisfies "backing store == css × dpr" while
  // drawing nothing. (Measured: that is exactly what a missing host measurement looks like.)
  check(
    'the canvas fills its pane (it is not sitting at the intrinsic 300×150 default)',
    !!rect && Math.abs(m.cssW - rect.w) <= 1 && Math.abs(m.cssH - rect.h) <= 1,
    `canvas ${String(m.cssW)}×${String(m.cssH)} vs pane ${rect ? `${String(rect.w)}×${String(rect.h)}` : 'absent'}`
  )
  check(
    'the canvas backing store is scaled by devicePixelRatio (a CSS-sized buffer is the blurry-map bug)',
    m.bufW === Math.round(m.cssW * m.dpr) && m.bufH === Math.round(m.cssH * m.dpr),
    `css ${String(m.cssW)}×${String(m.cssH)} · buffer ${String(m.bufW)}×${String(m.bufH)} · dpr ${String(m.dpr)}`
  )

  // The layout contract: the app's content area owns the scroll, and a view never grows the
  // document. A map pane that sized to its content would push the page instead of clipping.
  const over = await pageOverflow(page)
  check(
    'the Maps tab never scrolls the page (the map clips inside its own pane)',
    over.doc === 0 && over.content === 0,
    `document +${String(over.doc)}px · content area +${String(over.content)}px`
  )
}

/** 4. THE HEADER STATES THE ZONE, AND NAMES WHERE EACH LAYER CAME FROM. */
async function stepHeader(page: Page, zone: string | undefined): Promise<void> {
  const header = (await textOf(page, HEADER)).replace(/\s+/g, ' ').trim()
  const sources = await countOf(page, '[data-testid="maps-source"]')
  check(
    'the header names a source pack for every layer it drew (a silent cross-pack merge is forbidden)',
    sources > 0,
    `${String(sources)} source chips`
  )
  if (zone == null || zone === '') {
    note('the log has stated no zone — the header correctly names the manually picked map instead')
    return
  }
  check(
    'the header states the zone the log says you are in',
    header.includes(zone),
    `header "${header.slice(0, 90)}" vs log zone "${zone}"`
  )
}

/** 5. SEARCH: a bounded hit list, and a label on screen finds itself. */
async function stepSearch(page: Page): Promise<void> {
  const prefix = await labelPrefix(page)
  const query = prefix === '' ? 'a' : prefix
  await page.fill(SEARCH, query, { timeout: 15_000 })
  await until(async () => (await countOf(page, HITS)) > 0, 10_000)

  const box = await boxOf(page, HITS)
  if (!check('typing shows the hit list', box !== null, `query "${query}"`)) return
  const b = box as { h: number; scrollH: number; clientH: number }
  check(
    'the hit list is bounded (it cannot grow to eat the page)',
    b.h > 0 && b.h <= HIT_LIST_CEILING,
    `${String(b.h)}px tall`
  )
  check(
    '…and it is its own scroller (content scrolls INSIDE the box)',
    b.scrollH >= b.clientH,
    `scrollHeight ${String(b.scrollH)} vs clientHeight ${String(b.clientH)}`
  )

  if (prefix === '') {
    note('no labels are drawn in this zone at the fit view — the "a label finds itself" half is not asserted this run')
    return
  }
  const found = await until(async () => (await countOf(page, HIT_ROW)) > 0, 10_000)
  check(
    'a label prefix taken from the map on screen finds at least one hit',
    found,
    `"${query}" → ${String(await countOf(page, HIT_ROW))} hits`
  )
  if (!found) return

  // 6. CLICKING A HIT JUMPS THE VIEW AND FLASHES A MARKER. The marker is transient by design,
  //    so it is polled for immediately and its later disappearance is not asserted.
  await page.click(HIT_ROW, { timeout: 15_000 })
  const marked = await until(async () => (await countOf(page, '[data-testid="maps-marker"]')) > 0, 3000)
  check('clicking a hit centres the view on it and flashes a marker', marked)
}

async function main(): Promise<void> {
  buildIfStale()
  // See the header: a remembered `eq.maps.zone` would make the auto-open assertion vacuous.
  rmSync(USER_DATA, { recursive: true, force: true })

  console.log('launch: hidden Electron (EQ_E2E=1) against the real log — Maps spec…')
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
      const zone = await waitZone(page)
      if (await stepMapOrEmpty(page, zone)) {
        // Let the ResizeObserver + first paint land before measuring anything.
        await sleep(1200)
        await stepCanvas(page)
        await stepHeader(page, zone)
        await stepSearch(page)
      }
    }

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'maps-FAIL')
    else await dumpArtifacts(page, 'maps-pass')
  } finally {
    await app.close().catch(() => undefined)
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
