/**
 * Headless Electron integration test for the Combat dashboard (Task #56).
 *
 * WHY IT EXISTS: unit tests replay fixtures through the engine, but the bug that motivated
 * this harness ("the Combat tab is JUST a scrolling combat log") was invisible to them — it
 * lived in the RENDERED LAYOUT, downstream of a perfectly correct snapshot. This drives the
 * REAL app end to end (real main process, real full-log scan of the user's live log, real
 * renderer bundle) and asserts what the user actually sees.
 *
 * WHY IT NEVER TAKES THE SCREEN: the app is launched with `EQ_E2E=1` (see src/main/e2e.ts),
 * which (a) never calls show()/showInactive() on ANY window — the main window is already
 * created with `show:false`, so it is created, laid out and rendered offscreen but never
 * mapped or focused; (b) skips the single-instance lock so this instance runs happily beside
 * the user's dev app instead of quitting; (c) selects the 'e2e' channel in src/main/channel.ts,
 * which points `userData` at a throwaway temp dir (never seeded from the user's state) so the
 * real store / errors.log are untouched. The user can keep playing while this runs.
 * Layout still happens in a hidden window, which is exactly what we measure.
 *
 * WHAT IT ASSERTS: hydration completes (replay → live tail), then, against whatever the real
 * log contains right now: the dashboard is present AND HAS HEIGHT (the regression), the
 * source meter has rows, the DPS-over-time and Damage-by-mob cards exist, the Fight/Overall
 * SCOPE filters the selector to exactly one scope's rows (Task #60 — a fight meter must never
 * wander into the zone aggregate), and the combat log is a BOUNDED scrolling box.
 * Assertions are identities/floors — never "today's numbers" (AGENTS.md: frozen numbers rot).
 *
 * On any failure: the relevant DOM + a screenshot land in tests/e2e/artifacts/ (gitignored).
 *
 * Run: `npm run test:e2e`
 */

import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ARTIFACTS = join(ROOT, 'tests', 'e2e', 'artifacts')
/**
 * Its OWN build output, never `out/`: the user keeps `npm run dev --watch` running, which
 * owns out/main + out/preload and rewrites them on every source edit. Building into out-e2e/
 * means the harness can never race that watcher (or leave a production bundle where the dev
 * app expects its own). The main bundle resolves preload/renderer relative to __dirname, so
 * an alternate root just works.
 */
const OUT_DIR = join(ROOT, 'out-e2e')
const MAIN_ENTRY = join(OUT_DIR, 'main', 'index.js')
/** Throwaway `userData` for the app under test — wiped per run, so every run starts fresh
 *  (default view, no saved character, no overlays) and the real store is never opened. */
const USER_DATA = join(tmpdir(), 'everquest-companion-e2e-userdata')

/** A full-log scan of a months-old live log takes a while; be generous, fail loudly. */
const HYDRATE_TIMEOUT_MS = 300_000
/** How long to wait for the LIVE tail to classify a combat line before shrugging. */
const LIVE_LINE_WAIT_MS = 45_000

// ── tiny assertion harness (node:test's runner buys us nothing here — one long session) ──

const failures: string[] = []
const notes: string[] = []

function check(name: string, ok: boolean, detail = ''): boolean {
  if (ok) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
  return ok
}

function note(msg: string): void {
  notes.push(msg)
  console.log(`  note ${msg}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── build (reuse out/ when it's newer than every source file) ──────────────────────────

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs)
  }
  return newest
}

function buildIfStale(): void {
  let outMs = 0
  try {
    outMs = statSync(MAIN_ENTRY).mtimeMs
  } catch {
    outMs = 0
  }
  const srcMs = Math.max(
    newestMtime(join(ROOT, 'src')),
    statSync(join(ROOT, 'electron.vite.config.ts')).mtimeMs
  )
  if (outMs > srcMs) {
    console.log(`build: ${OUT_DIR}/ is fresh — reusing it`)
    return
  }
  console.log(`build: electron-vite build --outDir=${OUT_DIR} (it is stale)…`)
  // ABSOLUTE outDir on purpose: electron-vite resolves a relative --outDir against each
  // section's own `root`, and the renderer's root is src/renderer — a relative 'out-e2e'
  // silently emits the HTML into src/renderer/out-e2e/ and the app then loads a 404.
  const res = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'),
      'build',
      `--outDir=${OUT_DIR.replace(/\\/g, '/')}`
    ],
    { cwd: ROOT, stdio: 'inherit' }
  )
  if (res.status !== 0) throw new Error(`electron-vite build failed (exit ${res.status})`)
}

function electronBinary(): string {
  return process.platform === 'win32'
    ? join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
}

// ── page helpers ───────────────────────────────────────────────────────────────────────

interface Snap {
  hydrating: boolean
  selectedId: string
  zone?: string
  selected: { kind: string; name: string; entities: unknown[]; outTotal: number } | null
  segments: Array<{ kind: string; id: string; name: string; total: number }>
  zoneSessions: Array<{ id: string; total: number }>
  recent: unknown[]
}

function snapshot(page: Page): Promise<Snap> {
  // The renderer's own bridge — the exact door useCombat uses, so we observe what it observes.
  return page.evaluate(
    () => (window as unknown as { eq: { getCombatSnapshot: (o: unknown) => Promise<Snap> } }).eq.getCombatSnapshot({})
  ) as Promise<Snap>
}

/** Bounding box of the first match, or null when the node isn't in the DOM. */
function rectOf(page: Page, selector: string): Promise<{ w: number; h: number } | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }, selector)
}

function countOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector)
}

/** The selector's closed-state text — the head row's label ("Current fight (live)" / "Last fight — …"). */
function selectorText(page: Page): Promise<string> {
  return page.evaluate(
    () => (document.querySelector('[data-testid="segment-select"]') as HTMLElement | null)?.innerText ?? ''
  )
}

/**
 * Open the segment dropdown, collect every selectable row's value, close it again.
 * Housekeeping rows ('Load more', the empty placeholder) are not segments and are dropped —
 * what this asserts is which SCOPE's ids are offered.
 */
async function openSelectorValues(page: Page): Promise<string[]> {
  await page.click('[data-testid="segment-select"]')
  await page.waitForSelector('li[data-value]', { timeout: 15_000 })
  const values = await page.evaluate(() =>
    [...document.querySelectorAll('li[data-value]')].map((el) => el.getAttribute('data-value') ?? '')
  )
  await page.keyboard.press('Escape')
  await sleep(400)
  // The head row's '__live__' sentinel IS a segment row (it re-resolves to the current/last
  // fight); only the housekeeping rows are dropped.
  return values.filter((v) => v && v !== '__loadmore__' && v !== '__empty__')
}

interface PanelRect {
  w: number
  h: number
  x: number
  y: number
  /** Does this panel's own body overflow its box WITHOUT a scroller? (content would be clipped) */
  clipped: boolean
}

/** Every dashboard panel's box, in DOM order (meter, DPS, breakdown, mobs). */
function panelRects(page: Page): Promise<PanelRect[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="dash-panel"]')].map((el) => {
      const r = el.getBoundingClientRect()
      // The panel's body is the last element child (header Stack is first). A `fill` panel must
      // scroll it internally, so overflowing content is only OK when the box is a scroller.
      const body = el.lastElementChild as HTMLElement | null
      const style = body ? getComputedStyle(body) : null
      const scrolls = !!style && (style.overflowY === 'auto' || style.overflowY === 'scroll')
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: Math.round(r.x),
        y: Math.round(r.y),
        clipped: !!body && body.scrollHeight > body.clientHeight + 1 && !scrolls
      }
    })
  )
}

/** How far the app's scrolling content area overflows its viewport box (0 = no page scroll). */
function pageOverflow(page: Page): Promise<{ doc: number; content: number }> {
  return page.evaluate(() => {
    const content = document.querySelector('main')?.firstElementChild as HTMLElement | null
    return {
      doc: Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight),
      // -1 = the content area wasn't found; that's a FAIL, not a silent pass.
      content: content ? Math.max(0, content.scrollHeight - content.clientHeight) : -1
    }
  })
}

/** Same measurement, for the single-column (narrow) layout. */
function narrowPanelCheck(page: Page): Promise<{ cols: number; minH: number; scrolls: boolean }> {
  return page.evaluate(() => {
    const p = [...document.querySelectorAll('[data-testid="dash-panel"]')].map((el) => el.getBoundingClientRect())
    const grid = document.querySelector('[data-testid="combat-dashboard"]') as HTMLElement | null
    return {
      cols: new Set(p.map((r) => Math.round(r.x))).size,
      minH: p.length ? Math.round(Math.min(...p.map((r) => r.height))) : 0,
      scrolls: !!grid && grid.scrollHeight > grid.clientHeight + 1 && getComputedStyle(grid).overflowY === 'auto'
    }
  })
}

interface HeaderInfo {
  h: number
  w: number
  /** how far the header's own content overflows it horizontally (0 = nothing is cut off) */
  overflowX: number
  /**
   * Spread of the primary-line controls' vertical CENTERS. The controls have different
   * heights (the selector is a two-line row, the toggles are single-line pills) and the row
   * centers them, so their top edges legitimately differ by ~10px — centers are what agree
   * on one line. A real wrap moves a control a whole row (≥30px).
   */
  primarySpread: number
  /** which of the header's controls are mounted right now */
  controls: string[]
}

/** The header bar's box + whether its primary line actually stayed one line. */
function headerInfo(page: Page): Promise<HeaderInfo | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="combat-header"]') as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    const ids = ['scope-toggle', 'segment-select', 'view-toggle', 'direction-toggle']
    const present = ids.filter((id) => document.querySelector(`[data-testid="${id}"]`))
    // The primary line is scope + selector + view switch; if the bar ever wraps under pressure,
    // their centers stop agreeing. (The direction filter lives on the second line by design.)
    const tops = ['scope-toggle', 'segment-select', 'view-toggle']
      .map((id) => {
        const r = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()
        return r ? r.top + r.height / 2 : undefined
      })
      .filter((t): t is number => typeof t === 'number')
    return {
      h: Math.round(r.height),
      w: Math.round(r.width),
      overflowX: Math.max(0, el.scrollWidth - el.clientWidth),
      primarySpread: tops.length ? Math.round(Math.max(...tops) - Math.min(...tops)) : -1,
      controls: present
    }
  })
}

/**
 * The HEADER assertions. It is the tab's subject line — the fight/zone you're looking at, the
 * view switch, and (on a quiet second line) the direction filter plus passive state. What can
 * regress here is SIZE and WRAPPING: at the 900px minimum window there is only ~648px of
 * content width, and the old flat row of five equal-weight controls wrapped into a
 * three-line block whose wrap point moved with the fight name.
 */
async function checkHeader(page: Page, tag: string, expectDirection: boolean): Promise<void> {
  const h = await headerInfo(page)
  if (!check(`[${tag}] the combat header is rendered`, h !== null)) return
  const info = h as HeaderInfo
  check(
    `[${tag}] the header stays a compact two-line bar`,
    info.h >= 40 && info.h <= 110,
    `${info.w}×${info.h}px · controls: ${info.controls.join(', ')}`
  )
  check(
    `[${tag}] nothing in the header is cut off horizontally`,
    info.overflowX === 0,
    `+${info.overflowX}px`
  )
  check(
    `[${tag}] scope + selector + view switch share one line (no wrapping mess)`,
    info.primarySpread >= 0 && info.primarySpread <= 6,
    `center spread ${info.primarySpread}px`
  )
  check(
    `[${tag}] the direction filter is ${expectDirection ? 'present' : 'hidden (timeline view)'}`,
    info.controls.includes('direction-toggle') === expectDirection,
    info.controls.join(', ')
  )
}

/**
 * The 2x2 GRID assertions. The four dashboard panels (source meter, DPS over time, breakdown
 * preview, damage by mob) must be four EQUAL cells — equal width AND equal height — none
 * collapsed, none clipping its content, and the grid must never make the page scroll.
 * Run more than once per session (quiet log, busy log, explicit fight pick) because the whole
 * point is that panel CONTENT growth can't move the layout.
 */
async function checkGrid(page: Page, tag: string): Promise<void> {
  const p = await panelRects(page)
  const dims = p.map((r) => `${r.w}×${r.h}`).join(', ')
  if (!check(`[${tag}] the dashboard is a 2x2 grid of four panels`, p.length === 4, `${p.length} panels: ${dims}`)) return

  const ws = p.map((r) => r.w)
  const hs = p.map((r) => r.h)
  const spread = (v: number[]): number => Math.max(...v) - Math.min(...v)
  // 1fr tracks are exactly equal; allow a couple of px for sub-pixel rounding + borders.
  const TOL = 4

  check(`[${tag}] all four panels have equal width`, spread(ws) <= TOL, `${ws.join(' / ')} px (spread ${spread(ws)})`)
  check(`[${tag}] all four panels have equal height`, spread(hs) <= TOL, `${hs.join(' / ')} px (spread ${spread(hs)})`)
  check(`[${tag}] no panel is collapsed to nothing`, Math.min(...hs) >= 80 && Math.min(...ws) >= 80, dims)

  // Two distinct columns and two distinct rows — a 4x1 or 1x4 with equal cells would otherwise
  // sneak past the equality checks above.
  const cols = new Set(p.map((r) => r.x))
  const rows = new Set(p.map((r) => r.y))
  check(`[${tag}] the panels sit in 2 columns × 2 rows`, cols.size === 2 && rows.size === 2, `x=${[...cols].join(',')} y=${[...rows].join(',')}`)

  const clipped = p.filter((r) => r.clipped).length
  check(`[${tag}] every panel scrolls its own content (nothing is clipped)`, clipped === 0, `${clipped} clipping`)

  const over = await pageOverflow(page)
  check(
    `[${tag}] the view does not scroll the page (the grid never grows it)`,
    over.doc === 0 && over.content === 0,
    `document +${over.doc}px · content area +${over.content}px`
  )
}

/** Visible text of the Combat view — cheap way to assert card titles exist. */
function combatText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText ?? '')
}

async function dumpArtifacts(page: Page, tag: string): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true })
  try {
    const html = await page.evaluate(() => {
      // The whole Combat view (header bar + dashboard + log), not just the selector's row —
      // the header is now its own bar, so its nearest Stack would dump only one line of it.
      const view = document.querySelector('[data-testid="combat-header"]')?.parentElement
      return (view ?? document.body).outerHTML
    })
    writeFileSync(join(ARTIFACTS, `${tag}.html`), html, 'utf8')
    console.log(`artifact: tests/e2e/artifacts/${tag}.html`)
  } catch (err) {
    console.log(`artifact: DOM dump failed — ${String(err)}`)
  }
  try {
    // A hidden window still composites through CDP; if a given platform refuses, we say so
    // rather than failing the run over missing evidence.
    await page.screenshot({ path: join(ARTIFACTS, `${tag}.png`), timeout: 20_000 })
    console.log(`artifact: tests/e2e/artifacts/${tag}.png`)
  } catch (err) {
    console.log(`artifact: screenshot unavailable — ${String(err)}`)
  }
}

// ── the run ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  buildIfStale()
  rmSync(ARTIFACTS, { recursive: true, force: true })
  rmSync(USER_DATA, { recursive: true, force: true })

  console.log('launch: hidden Electron (EQ_E2E=1) against the real log…')
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

    // The Combat tab is the default view and a fresh userData means no saved view.
    await page.waitForSelector('[data-testid="segment-select"]', { timeout: 60_000 })

    // 1. Hydration: replay → live tail. The UI must be in its quiet loading state until then.
    const t0 = Date.now()
    let sawHydratingUi = false
    let snap = await snapshot(page)
    while (snap.hydrating && Date.now() - t0 < HYDRATE_TIMEOUT_MS) {
      if (!sawHydratingUi) sawHydratingUi = (await countOf(page, '[data-testid="combat-hydrating"]')) > 0
      await sleep(500)
      snap = await snapshot(page)
    }
    const hydrateMs = Date.now() - t0
    if (!check('hydration completes (replay hands off to the live tail)', !snap.hydrating, `${hydrateMs}ms`)) {
      throw new Error('still hydrating — nothing below can be asserted')
    }
    check(
      'while hydrating the dashboard shows the quiet loading state, not a fake-live meter',
      sawHydratingUi || hydrateMs < 1500,
      sawHydratingUi ? 'saw [combat-hydrating]' : `replay finished in ${hydrateMs}ms (too fast to observe)`
    )
    // Let the post-hydration render + one activity nudge land.
    await sleep(1500)
    snap = await snapshot(page)

    // 2. The dashboard exists AND OCCUPIES REAL SPACE. `h` is the regression assertion: the
    //    dashboard used to be squeezed to 0px by the unbounded combat-log card below it.
    const dash = await rectOf(page, '[data-testid="combat-dashboard"]')
    check('the dashboard is rendered (not the empty "No combat yet" state)', dash !== null)
    check(
      'the dashboard has real height (it is not squeezed to nothing)',
      !!dash && dash.h >= 200,
      dash ? `${dash.w}×${dash.h}px` : 'absent'
    )

    // 3. The meter renders the data it has. NOT "there is always damage": a player who just
    //    zoned has an empty live zone session, and rendering nothing is then the honest answer
    //    (AGENTS.md — assert identities, never today's numbers). The identity is
    //    "damage ⇒ rows"; the unconditional row check happens in step 10 against HISTORY,
    //    which always has damage.
    const rows = await countOf(page, '[data-testid="meter-row"]')
    const liveTotal = snap.selected?.outTotal ?? 0
    if (liveTotal > 0) {
      check('the live selection renders its sources', rows >= 1, `${snap.selected!.name}: ${Math.round(liveTotal)} dmg, ${rows} rows`)
    } else {
      note(`the live selection (${snap.selected?.name ?? 'none'}) has no damage yet — freshly zoned/quiet`)
    }

    // 4. The event-derived cards are mounted (they render a quiet note when the selection has
    //    no per-event ring — the CARD is what must always be there).
    // Card titles are uppercased by CSS, and innerText reports the TRANSFORMED text — match
    // case-insensitively so the assertion tracks the copy, not the styling.
    const text = (await combatText(page)).toLowerCase()
    check('the "DPS over time" card is present', text.includes('dps over time'))
    check('the "Damage by mob" card is present', text.includes('damage by mob'))

    // 4b. THE LAYOUT: four EQUAL panels in a 2x2 grid. The rail layout this replaced gave the
    //     source meter a 1.5x-wide column and squeezed the other three into a narrow strip.
    await checkGrid(page, 'quiet')

    // 4c. THE HEADER: one compact bar, not a wrapped toolbar dump.
    await checkHeader(page, 'quiet', true)
    // Passive state: the two combat-modifier slots are numbered ("1: berserker"), never the
    // old "stance:"/"inv:" category words. Either slot may be absent (never observed yet).
    // textContent, not innerText: the slot is a flex row of two spans, so innerText would put a
    // newline between the number and the value.
    const slots = await page.evaluate(() =>
      [1, 2].map((n) =>
        (document.querySelector(`[data-testid="stance-slot-${n}"]`)?.textContent ?? '').replace(/\s+/g, ' ').trim()
      )
    )
    if (slots.some((s) => s)) {
      check(
        'the combat-modifier slots read "<n>: <value>", not the old category jargon',
        // a slot that exists must be "1: something" / "2: something", and neither may say
        // "stance:" or "inv:" any more.
        // (textContent has no separator between the two spans, so the space is optional)
        slots.every((s, i) => !s || new RegExp(`^${i + 1}:\\s*\\S`).test(s)) &&
          !slots.some((s) => /stance:|inv:/i.test(s)),
        slots.filter(Boolean).join(' · ')
      )
    } else {
      note('no stance/invocation observed yet — the modifier slots are correctly absent')
    }

    // 5. The selector is backed by real history: fights + zone sessions.
    const fights = snap.segments.filter((s) => s.kind === 'fight').length
    check('the selector has finalized fights', fights >= 1, `${fights} fights`)
    check('the selector has zone sessions', snap.zoneSessions.length >= 1, `${snap.zoneSessions.length} sessions`)

    // 6. SCOPE (Task #60): Fight vs Overall is an explicit user choice, never an automatic
    //    switch. The default scope is Fight, and it must show a FIGHT whether or not one is
    //    currently open — the old behaviour swapped the body to the zone aggregate between
    //    pulls (the `liveFallback` caption, now removed).
    check('the scope toggle is present (Fight | Overall)', (await countOf(page, '[data-testid="scope-toggle"] button')) === 2)
    check(
      'the Fight scope never shows the zone aggregate — with or without an open fight',
      snap.selected === null || snap.selected.kind === 'fight',
      `selectedId=${snap.selectedId} kind=${snap.selected?.kind ?? 'none'}`
    )
    const openFight = snap.segments.find((s) => s.kind === 'current')
    if (openFight) {
      note(`a fight is open (${openFight.name}) — the head row reads "Current fight (live)"`)
    } else {
      note('no fight is open — the head row must read "Last fight — …", not "live"')
      const headText = await selectorText(page)
      check('…and the selector says so instead of claiming live', /Last fight/.test(headText), headText.slice(0, 80))
    }
    check(
      '…never the empty "No combat yet" panel while the log has fights',
      dash !== null && (liveTotal === 0 || rows >= 1),
      `${Math.round(liveTotal)} dmg / ${rows} rows`
    )

    // 6b. THE FILTER: opening the selector in Fight scope must list fights ONLY. A zone session
    //     appearing here is how the meter used to wander into the overall aggregate.
    const fightMenu = await openSelectorValues(page)
    check(
      'the Fight-scope dropdown excludes zone sessions',
      fightMenu.length > 0 && !fightMenu.some((v) => v === 'zone' || /^zs\d+$/.test(v)),
      `${fightMenu.length} rows: ${fightMenu.slice(0, 4).join(', ')}`
    )
    // …and Overall lists zone sessions ONLY (no fight ids).
    await page.click('[data-testid="scope-toggle"] button:nth-child(2)')
    await sleep(800)
    const overallMenu = await openSelectorValues(page)
    check(
      'the Overall-scope dropdown lists only zone sessions',
      overallMenu.length > 0 && overallMenu.every((v) => v === 'zone' || /^zs\d+$/.test(v)),
      `${overallMenu.length} rows: ${overallMenu.slice(0, 4).join(', ')}`
    )
    await page.click('[data-testid="scope-toggle"] button:nth-child(1)')
    await sleep(800)
    snap = await snapshot(page)

    // 7. The combat log is a BOUNDED scrolling box (this is what ate the dashboard).
    const log = await rectOf(page, '[data-testid="combat-log"]')
    check('the combat log is rendered', log !== null)
    check(
      'the combat log is bounded (it cannot grow to eat the page)',
      !!log && log.h > 0 && log.h <= 260,
      log ? `${log.h}px tall` : 'absent'
    )

    // 8. The live tail is feeding the classification ring. The user is PLAYING while this runs,
    //    so combat lines normally appear within seconds; a quiet stretch (zoning, AFK, sitting
    //    in a bank) is not a product defect, so it is reported as a note, not a failure.
    //    We wait for a BATCH of lines because the original defect only bit once the ring had
    //    grown — the whole point is to re-measure the layout with a busy log.
    const tLines = Date.now()
    while (snap.recent.length < 25 && Date.now() - tLines < LIVE_LINE_WAIT_MS) {
      await sleep(1000)
      snap = await snapshot(page)
    }
    if (snap.recent.length > 0) {
      const lines = await countOf(page, '[data-testid="combat-log"] > div')
      check('the combat log has lines from the live tail', lines >= 1, `${snap.recent.length} in ring / ${lines} rendered`)
    } else {
      note(`no combat lines in ${Math.round(LIVE_LINE_WAIT_MS / 1000)}s of live tailing — log is quiet right now`)
    }

    // 9. THE REGRESSION, re-measured with a busy log: a growing combat log must never squeeze
    //    the dashboard out of existence. This is the exact failure the user reported.
    const dash2 = await rectOf(page, '[data-testid="combat-dashboard"]')
    const log2 = await rectOf(page, '[data-testid="combat-log"]')
    check(
      'the dashboard keeps its height with a busy combat log',
      !!dash2 && dash2.h >= 200,
      `${snap.recent.length} log lines · dashboard ${dash2 ? `${dash2.h}px` : 'absent'} · log ${
        log2 ? `${log2.h}px` : 'absent'
      }`
    )
    // …and the 2x2 grid is still exactly that: growing panel content scrolls INSIDE its cell.
    await checkGrid(page, 'busy log')

    // 9b. The VIEW switch drives Dashboard ↔ Timeline, and the direction filter (which only
    //     filters the dashboard's meter) goes with it.
    await page.click('[data-testid="view-toggle"] button:nth-child(2)')
    await sleep(800)
    await checkHeader(page, 'timeline view', false)
    check(
      'switching to Timeline unmounts the dashboard grid',
      (await countOf(page, '[data-testid="combat-dashboard"]')) === 0
    )
    await page.click('[data-testid="view-toggle"] button:nth-child(1)')
    await sleep(800)
    check('…and switching back restores the dashboard', (await countOf(page, '[data-testid="combat-dashboard"]')) === 1)

    // 10. Drive the SELECTOR for real and land on a finalized fight. History always carries
    //     damage (the engine drops 0-damage encounters), so this is the unconditional "the
    //     dashboard renders the log's data" assertion — independent of what the player happens
    //     to be doing right now.
    //     NOTE: the fight scope's HEAD row is the current-or-last fight under the '__live__'
    //     sentinel, so between pulls the newest finalized fight is not listed under its own id.
    //     Pick from what the dropdown actually offers.
    const listed = await openSelectorValues(page)
    const pickId = listed.find((v) => v !== '__live__')
    const newestFight = snap.segments.find((s) => s.id === pickId)
    if (newestFight) {
      await page.click('[data-testid="segment-select"]')
      await page.click(`li[data-value="${newestFight.id}"]`, { timeout: 15_000 })
      // Verify from the DOM, not from our own snapshot call: `getCombatSnapshot({})` resolves
      // OUR (live) selection, not the renderer's — only the rendered view knows what's picked.
      const tPick = Date.now()
      let shown = ''
      while (Date.now() - tPick < 10_000) {
        shown = await combatText(page)
        if (shown.includes(newestFight.name)) break
        await sleep(300)
      }
      const fightRows = await countOf(page, '[data-testid="meter-row"]')
      check('picking a fight in the selector selects it', shown.includes(newestFight.name), newestFight.name)
      check(
        '…and its dashboard renders source rows',
        fightRows >= 1,
        `${fightRows} rows · ${Math.round(newestFight.total)} dmg in that fight`
      )
      // The zone-fallback caption is gone for good (Task #60) — there is no auto-switch left
      // that could need one, in ANY selection.
      check(
        '…and no zone-fallback caption exists anywhere (the auto-switch is gone)',
        (await countOf(page, '[data-testid="live-fallback"]')) === 0
      )
      const dash3 = await rectOf(page, '[data-testid="combat-dashboard"]')
      check('…in a dashboard that still has height', !!dash3 && dash3.h >= 200, dash3 ? `${dash3.h}px` : 'absent')
      // A finalized fight is the DENSEST case (full source list, full mob list, full ring).
      await checkGrid(page, 'picked fight')
    } else {
      check(
        'the Fight-scope dropdown offers at least one finalized fight to select',
        false,
        `listed: ${listed.join(', ') || 'none'}`
      )
    }

    // 11. FIRST, the narrowest window a USER can actually make: the main window's
    //     `minWidth: 900` (src/main/index.ts). The 2x2 must survive it intact — that is the
    //     real-world worst case, and it is also exactly MUI's `md` boundary, so the
    //     single-column branch below can only be reached by lifting the minimum.
    const win = await app.browserWindow(page)
    const wide = await win.evaluate((w) => w.getBounds())
    await win.evaluate((w, b) => w.setBounds({ ...b, width: 900 }), wide)
    await sleep(1200)
    await checkGrid(page, 'min window width (900)')
    await checkHeader(page, 'min window width (900)', true)

    // 12. RESPONSIVE: below md the grid collapses to ONE column of comfortably tall panels and
    //     the REGION scrolls (the page still must not). Unreachable through the UI today
    //     (minWidth 900 === the md breakpoint), so the test lifts the minimum to exercise the
    //     CSS — if the window minimum or the drawer ever changes, this path is already correct.
    await win.evaluate((w, b) => {
      w.setMinimumSize(400, 400)
      w.setBounds({ ...b, width: 720 })
    }, wide)
    await sleep(1200)
    const narrow = await narrowPanelCheck(page)
    check('narrow: the grid collapses to a single column', narrow.cols === 1, `${narrow.cols} column(s)`)
    check('narrow: each stacked panel keeps a usable height', narrow.minH >= 250, `shortest ${narrow.minH}px`)
    check('narrow: the dashboard REGION is the scroller', narrow.scrolls, `region scrolls=${narrow.scrolls}`)
    await checkHeader(page, 'narrow (720)', true)
    const narrowOver = await pageOverflow(page)
    check(
      'narrow: …and the PAGE still does not scroll',
      narrowOver.doc === 0 && narrowOver.content === 0,
      `document +${narrowOver.doc}px · content +${narrowOver.content}px`
    )
    // Back to the wide layout — and it must come back as a clean 2x2.
    await win.evaluate((w, b) => {
      w.setMinimumSize(900, 600)
      w.setBounds(b)
    }, wide)
    await sleep(1200)
    await checkGrid(page, 'restored wide')
    await checkHeader(page, 'restored wide', true)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'combat-dashboard-FAIL')
    else await dumpArtifacts(page, 'combat-dashboard-pass')
  } finally {
    await app.close().catch(() => undefined)
  }

  console.log('')
  for (const n of notes) console.log(`note: ${n}`)
  if (failures.length) {
    console.log(`\nFAILED (${failures.length}):`)
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
  } else {
    console.log('e2e: all checks passed')
  }
}

main().catch((err) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
