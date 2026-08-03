/**
 * Site screenshot harness — captures the project site's feature shots from the REAL app.
 *
 * WHY IT EXISTS: the marketing site (site/index.html) shows the app doing its job. Mockups rot
 * and lie; these PNGs are the actual renderer, driven against the user's actual EverQuest log,
 * so a shot can never claim a layout or a number the app doesn't produce. Re-run it whenever the
 * UI moves and the site's assets are refreshed wholesale.
 *
 * WHY IT NEVER TAKES THE SCREEN: same contract as tests/e2e/combat-dashboard.e2e.mts. The app is
 * launched with `EQ_E2E=1` (src/main/e2e.ts): no window is ever shown by the app itself, the
 * single-instance lock is skipped (so it runs beside the user's dev app) and `userData` lands in
 * a throwaway dir (src/main/channel.ts's 'e2e' channel), so the real store is untouched.
 * A hidden window does not reliably COMPOSITE, though, and a blank screenshot is worthless — so
 * this harness moves each window far OFF-SCREEN (x = -4000) and shows it there with
 * `showInactive()`, plus `setSkipTaskbar(true)` / `setFocusable(false)`. It composites, the user
 * (who is playing) never sees it, and focus is never taken. The move is VERIFIED after the fact:
 * if the OS put the window anywhere near the visible desktop it is hidden again immediately and
 * the run falls back to screenshotting the hidden window.
 *
 * It builds into `out-e2e/` with an ABSOLUTE `--outDir` (electron-vite resolves a relative one
 * against each section's own root and buries the renderer HTML in src/renderer/), so it can never
 * race the dev watcher's `out/`.
 *
 * Run: `npx tsx scripts/site-screens.mts`
 * Output: site/assets/shot-*.png
 */

import { _electron as electron, type ElectronApplication, type JSHandle, type Page } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, ROOT, buildIfStale, electronBinary, waitForTypecheck } from './site-build.mjs'

const ASSETS = join(ROOT, 'site', 'assets')
/**
 * Persistent (not per-run) throwaway userData: the shots want the boss portraits loaded, and the
 * permanent image cache lives under userData — reusing the dir means a re-run costs zero network.
 * It is still the 'e2e' channel, never the user's real store.
 */
const USER_DATA = join(tmpdir(), 'everquest-companion-site-screens')

/** A flattering, realistic desktop size. The window is frameless, so this IS the content size. */
const WIN = { width: 1280, height: 800 }
/** Far outside any plausible desktop, on the left where Windows never places a display. */
const OFFSCREEN = { x: -4000, y: 80 }
/** A full-log scan of a months-old live log takes a while. */
const HYDRATE_TIMEOUT_MS = 300_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── result bookkeeping ─────────────────────────────────────────────────────────────────

interface ShotResult {
  file: string
  ok: boolean
  bytes: number
  width: number
  height: number
  /** 'offscreen' = the window was composited off-screen; 'hidden' = hidden-window capture. */
  mode: string
  note: string
}
const results: ShotResult[] = []
const skipped: { file: string; why: string }[] = []

function log(msg: string): void {
  console.log(msg)
}


// ── off-screen compositing ─────────────────────────────────────────────────────────────

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The BrowserWindow surface this harness drives, declared STRUCTURALLY. scripts/ typechecks
 * under tsconfig.node.json, which has no `dom` lib, so pulling in electron's own types is not
 * an option — and an untyped handle would make every call below an `any`.
 */
interface ScreenshotWindow {
  setSkipTaskbar(skip: boolean): void
  setFocusable(focusable: boolean): void
  setBounds(bounds: Bounds): void
  showInactive(): void
  getBounds(): Bounds
  hide(): void
  isDestroyed(): boolean
}

/**
 * Move a window far off-screen, then show it there WITHOUT taking focus, so its contents
 * actually composite (a never-shown window may hand back a blank frame). Returns whether the
 * window is genuinely off-screen and visible; if the OS refused the position the window is
 * hidden again at once — the user is playing, and a stray app window on their game is the one
 * outcome this harness must never produce.
 */
/**
 * `browserWindow()` is a MAIN-process evaluate, and while the engine is folding a months-long log
 * the main process can be busy enough that the resulting promise is garbage-collected before it
 * settles ("Resulting promise was garbage collected"). Retry rather than lose the run.
 */
async function browserWindowOf(app: ElectronApplication, page: Page): Promise<JSHandle<ScreenshotWindow>> {
  let last: unknown
  for (let i = 0; i < 6; i++) {
    try {
      return await app.browserWindow(page)
    } catch (err) {
      last = err
      await sleep(2000)
    }
  }
  throw last
}

async function showOffscreen(
  win: JSHandle<ScreenshotWindow>,
  size: { width: number; height: number }
): Promise<boolean> {
  const target: Bounds = { ...OFFSCREEN, ...size }
  const got: Bounds = await win.evaluate((w, b) => {
    w.setSkipTaskbar(true)
    // WS_EX_NOACTIVATE: belt and braces on top of showInactive — this window can never be
    // activated by the OS, so nothing it does can pull the player out of the game.
    w.setFocusable(false)
    w.setBounds(b)
    w.showInactive()
    w.setBounds(b) // re-assert: some window managers re-place on first map
    return w.getBounds()
  }, target)
  // Anything not comfortably to the left of every real display is a failure.
  if (got.x > -1000) {
    await win.evaluate((w) => w.hide())
    log(`  off-screen show REFUSED (landed at x=${got.x}) — hidden again, falling back`)
    return false
  }
  return true
}

async function hideWindow(win: JSHandle<ScreenshotWindow>): Promise<void> {
  await win.evaluate((w) => {
    if (!w.isDestroyed()) w.hide()
  })
}

// ── capture ────────────────────────────────────────────────────────────────────────────

/** PNG IHDR: width/height are big-endian u32 at byte offsets 16 and 20. */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** One capture: where it lands, how the window was shown, and what the shot is meant to prove. */
interface ShotSpec {
  file: string
  /** 'offscreen' = the window was composited off-screen; 'hidden' = hidden-window capture. */
  mode: string
  note: string
  /** Keep the page's real transparency instead of matting it onto opaque white. */
  omitBackground?: boolean
}

async function shot(page: Page, spec: ShotSpec): Promise<void> {
  const { file, mode, note } = spec
  const path = join(ASSETS, file)
  try {
    await page.screenshot({ path, timeout: 30_000, omitBackground: spec.omitBackground })
    const { width, height } = pngSize(path)
    const bytes = statSync(path).size
    results.push({ file, ok: true, bytes, width, height, mode, note })
    log(`  shot ${file} — ${width}x${height}, ${(bytes / 1024).toFixed(0)}KB (${mode}) — ${note}`)
  } catch (err) {
    results.push({ file, ok: false, bytes: 0, width: 0, height: 0, mode, note: String(err) })
    log(`  shot ${file} FAILED — ${String(err)}`)
  }
}

// ── page helpers (no DOM types here: scripts/ typechecks under tsconfig.node.json, which has
//     no `dom` lib — so every in-page snippet is a STRING expression, never a typed callback.
//     That also sidesteps the tsx/esbuild `keepNames` __name wrapper that breaks evaluated
//     named functions.) ───────────────────────────────────────────────────────────────────

interface Snap {
  hydrating: boolean
  selectedId: string
  zone?: string
  selected: { kind: string; name: string; entities: unknown[]; outTotal: number } | null
  segments: { kind: string; id: string; name: string; total: number }[]
  zoneSessions: { id: string; total: number }[]
  recent: unknown[]
}

function snapshot(page: Page): Promise<Snap> {
  return page.evaluate<Snap>('window.eq.getCombatSnapshot({})')
}

function bodyText(page: Page): Promise<string> {
  return page.evaluate<string>('document.body.innerText || ""')
}

function count(page: Page, selector: string): Promise<number> {
  return page.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
}

/** Click the drawer's nav row by its label and let the view mount. */
async function goTab(page: Page, label: string, settleMs = 1500): Promise<void> {
  await page
    .locator(`.MuiDrawer-paper .MuiListItemButton-root:has-text("${label}")`)
    .first()
    .click()
  await sleep(settleMs)
}

/** Open the fight/zone selector, read the offered ids, close it again. */
async function selectorValues(page: Page): Promise<string[]> {
  await page.click('[data-testid="segment-select"]')
  await page.waitForSelector('li[data-value]', { timeout: 15_000 })
  const values = await page.evaluate<string[]>(
    '[...document.querySelectorAll("li[data-value]")].map(el => el.getAttribute("data-value") || "")'
  )
  await page.keyboard.press('Escape')
  await sleep(400)
  return values.filter((v) => v && v !== '__loadmore__' && v !== '__empty__')
}

interface Candidate {
  id: string
  name: string
  sources: number
  total: number
  timeline: boolean
}

/** What a given finalized fight would put on screen — used to pick the most SHOWABLE one. */
function probeSegment(page: Page, id: string): Promise<Candidate> {
  const expr = `window.eq.getCombatSnapshot({ selectedId: ${JSON.stringify(id)}, timeline: true })
    .then(s => ({
      id: ${JSON.stringify(id)},
      name: (s.selected && s.selected.name) || '',
      sources: (s.selected && s.selected.entities ? s.selected.entities.length : 0),
      total: (s.selected && s.selected.outTotal) || 0,
      timeline: !!(s.timeline && s.timeline.lanes && s.timeline.lanes.length)
    }))`
  return page.evaluate<Candidate>(expr)
}

// ── the run ────────────────────────────────────────────────────────────────────────────

async function captureCombatAndTimeline(page: Page, mode: string): Promise<void> {
  // Fight scope, Dashboard view — explicit, because the reused userData remembers the last run's.
  await page.click('[data-testid="scope-toggle"] button:nth-child(1)')
  await sleep(600)
  await page.click('[data-testid="view-toggle"] button:nth-child(1)')
  await sleep(600)

  // Pick the most SHOWABLE recent fight: most source rows, and one whose event ring still
  // exists so the Timeline shot lands on the same fight the dashboard shot shows.
  const listed = (await selectorValues(page)).filter((v) => v !== '__live__').slice(0, 14)
  const cands: Candidate[] = []
  for (const id of listed) {
    try {
      cands.push(await probeSegment(page, id))
    } catch {
      /* a fight that fell out of the cap — skip it */
    }
  }
  const withRing = cands.filter((c) => c.timeline && c.sources >= 2)
  const pool = withRing.length ? withRing : cands.filter((c) => c.sources >= 2)
  pool.sort((a, b) => b.sources - a.sources || b.total - a.total)
  const pick = pool[0]

  if (pick) {
    await page.click('[data-testid="segment-select"]')
    await page.click(`li[data-value="${pick.id}"]`, { timeout: 15_000 })
    await sleep(1500)
  }

  const rows = await count(page, '[data-testid="meter-row"]')
  const panels = await count(page, '[data-testid="dash-panel"]')
  await shot(page, {
    file: 'shot-combat.png',
    mode,
    note: `${panels} panels · ${rows} meter rows · fight "${pick?.name ?? 'live/last'}"`
  })

  // Timeline is a LENS over the same selection.
  await page.click('[data-testid="view-toggle"] button:nth-child(2)')
  await sleep(2000)
  const stillDash = await count(page, '[data-testid="combat-dashboard"]')
  const lanes = await count(page, 'svg text')
  await shot(page, {
    file: 'shot-timeline.png',
    mode,
    note: stillDash
      ? 'WARNING: fell back to the dashboard (no event ring for this selection)'
      : `timeline of "${pick?.name ?? 'live/last'}" · ${lanes} svg labels`
  })
  await page.click('[data-testid="view-toggle"] button:nth-child(1)')
  await sleep(600)
}

async function capturePosky(page: Page, mode: string): Promise<void> {
  await goTab(page, 'Plane of Sky', 2500)
  await page.waitForSelector('.MuiAccordion-root', { timeout: 30_000 })
  // Expand a quest that is genuinely IN PROGRESS — its summary says "N of M missing", so the
  // panel shows both green have-chips and outstanding need-chips (a completed quest shows
  // neither tension nor a reason for the tab to exist).
  const idx = await page.evaluate<number>(
    `[...document.querySelectorAll(".MuiAccordionSummary-root")]
       .findIndex(el => / of \\d+ missing/.test(el.innerText || ""))`
  )
  const target = idx >= 0 && idx < 4 ? idx : 0
  await page.locator('.MuiAccordionSummary-root').nth(target).click()
  await sleep(2000)
  const chips = await count(page, '.MuiAccordionDetails-root .MuiTableRow-root')
  await shot(page, { file: 'shot-posky.png', mode, note: `quest #${target + 1} expanded · ${chips} turn-in item rows` })
}

async function captureOverlay(app: ElectronApplication, page: Page, mode: string): Promise<void> {
  const before = new Set(app.windows().map((p) => p.url()))
  await page.evaluate<boolean>('window.eq.toggleOverlay("fight")')
  let ov: Page | undefined
  for (let i = 0; i < 40 && !ov; i++) {
    await sleep(500)
    ov = app.windows().find((p) => p.url().includes('overlay.html') && !before.has(p.url()))
  }
  if (!ov) {
    skipped.push({ file: 'shot-overlay.png', why: 'the overlay window never appeared' })
    return
  }
  const ovWin = await browserWindowOf(app, ov)
  // A touch larger than the 380x320 default so the meter shows a full source list rather than
  // three rows — still the real overlay, just not cramped.
  const ovMode = (await showOffscreen(ovWin, { width: 440, height: 340 })) ? mode : 'hidden'
  // Wait out "Reading log…" and let a snapshot land.
  for (let i = 0; i < 40; i++) {
    const t = await ov.evaluate<string>('document.body.innerText || ""')
    if (t && !t.includes('Reading log')) break
    await sleep(500)
  }
  await sleep(2500)
  const rows = await ov.evaluate<number>('document.querySelectorAll("div[title]").length')
  const head = (await ov.evaluate<string>('document.body.innerText || ""')).split('\n')[0] ?? ''
  // omitBackground keeps the overlay's real transparency (it is a transparent, always-on-top
  // window) instead of matting it onto opaque white.
  await shot(ov, {
    file: 'shot-overlay.png',
    mode: ovMode,
    note: `fight overlay · header "${head.trim()}" · ${rows} bars`,
    omitBackground: true
  })
  await hideWindow(ovWin)
  await page.evaluate<boolean>('window.eq.toggleOverlay("fight")')
  await sleep(800)
}

/**
 * Block until the startup replay hands off to the live tail. Nothing on screen is real until
 * then — every panel describes an hours-old moment as if it were live — and while that replay
 * runs the main process is busy enough that `browserWindow()` loses its promise to the GC, so
 * this must complete BEFORE anything touches the main process.
 */
async function waitForHydration(page: Page): Promise<Snap> {
  const t0 = Date.now()
  let snap = await snapshot(page)
  while (snap.hydrating && Date.now() - t0 < HYDRATE_TIMEOUT_MS) {
    await sleep(500)
    snap = await snapshot(page)
  }
  if (snap.hydrating) throw new Error('still hydrating — nothing worth shooting')
  log(`hydration: complete in ${Math.round((Date.now() - t0) / 1000)}s · zone ${snap.zone ?? '?'}`)
  return snap
}

async function captureBosses(page: Page, mode: string): Promise<void> {
  await goTab(page, 'Raid Targets', 2000)
  // Comfortable density = the portrait grid, which is what makes this tab worth a screenshot.
  await page.locator('button:has-text("Comfortable")').first().click()
  await sleep(1500)
  // The portraits stream through the eqimg:// cache on a cold userData — wait them out.
  for (let i = 0; i < 40; i++) {
    const pending = await page.evaluate<number>(
      '[...document.images].filter(im => !im.complete).length'
    )
    if (pending === 0) break
    await sleep(500)
  }
  await sleep(1500)
  const imgs = await page.evaluate<number>(
    '[...document.images].filter(im => im.naturalWidth > 0).length'
  )
  await shot(page, { file: 'shot-bosses.png', mode, note: `${imgs} boss portraits loaded` })
}

/** The run's verdict: every shot, every skip, and a non-zero exit if anything went wrong. */
function report(): void {
  log('')
  log('=== site/assets ===')
  for (const r of results) {
    log(
      `${r.ok ? 'ok  ' : 'FAIL'} ${r.file.padEnd(20)} ${`${r.width}x${r.height}`.padEnd(10)} ${`${(
        r.bytes / 1024
      ).toFixed(0)}KB`.padEnd(8)} ${r.mode.padEnd(9)} ${r.note}`
    )
  }
  for (const s of skipped) log(`SKIP ${s.file} — ${s.why}`)
  const bad = results.filter((r) => !r.ok).length + skipped.length
  if (bad) process.exitCode = 1
}

async function main(): Promise<void> {
  mkdirSync(ASSETS, { recursive: true })

  const typesOk = waitForTypecheck(log)
  if (typesOk || !existsSync(MAIN_ENTRY)) buildIfStale(log)
  else log('build: reusing the last good out-e2e/ (the tree does not typecheck right now)')

  log('launch: hidden Electron (EQ_E2E=1) against the real log…')
  const app: ElectronApplication = await electron.launch({
    executablePath: electronBinary(),
    args: [MAIN_ENTRY],
    cwd: ROOT,
    env: { ...process.env, EQ_E2E: '1', EQ_E2E_USER_DATA: USER_DATA, NODE_ENV: 'production' },
    timeout: 60_000
  })

  let mainWin: JSHandle<ScreenshotWindow> | null = null
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForSelector('[data-testid="segment-select"]', { timeout: 120_000 })

    // Hydration FIRST, and only then touch the main process (see waitForHydration).
    await waitForHydration(page)

    mainWin = await browserWindowOf(app, page)
    const shown = await showOffscreen(mainWin, WIN)
    const mode = shown ? 'offscreen' : 'hidden'
    log(`window: 1280x800 at x=${OFFSCREEN.x} — ${shown ? 'composited off-screen' : 'HIDDEN (fallback)'}`)
    // A few seconds of LIVE data on top of the replay, so the combat log has fresh lines.
    await sleep(6000)

    log('capture: Combat')
    await goTab(page, 'Combat', 2000)
    await captureCombatAndTimeline(page, mode)

    log('capture: Plane of Sky')
    if (typesOk) {
      await capturePosky(page, mode)
    } else {
      skipped.push({
        file: 'shot-posky.png',
        why: 'the tree never typechecked clean (a sibling agent is editing features/posky/**)'
      })
      log('  SKIPPED shot-posky.png — the posky feature does not typecheck right now')
    }

    log('capture: Loot')
    await goTab(page, 'Loot', 3500)
    await shot(page, { file: 'shot-loot.png', mode, note: `${await count(page, '.MuiTableRow-root')} loot rows` })

    log('capture: Alerts')
    await goTab(page, 'Alerts', 3000)
    await shot(page, { file: 'shot-alerts.png', mode, note: `${await count(page, '.MuiPaper-root')} cards` })

    log('capture: Raid Targets')
    await captureBosses(page, mode)

    log('capture: Leveling & AA')
    await goTab(page, 'Leveling', 3000)
    const levelText = (await bodyText(page)).split('\n').slice(0, 4).join(' · ')
    await shot(page, { file: 'shot-leveling.png', mode, note: levelText.slice(0, 90) })

    log('capture: floating overlay')
    // Back to Combat first: the overlay reads the same engine, and leaving the app on a combat
    // view keeps the whole session coherent.
    await goTab(page, 'Combat', 1500)
    await captureOverlay(app, page, mode)
  } finally {
    if (mainWin) await hideWindow(mainWin).catch(() => undefined)
    await app.close().catch(() => undefined)
  }

  report()
}

main().catch((err: unknown) => {
  console.error('site-screens: harness error —', err)
  process.exitCode = 1
})
