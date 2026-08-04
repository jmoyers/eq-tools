/**
 * appHarness.mts — the PLUMBING behind tests/e2e/combat-dashboard.e2e.mts: the tiny assertion
 * harness, the out-e2e/ build gate, the page-measurement helpers, the two composite checkers
 * (header shape + 2x2 grid) and the failure-artifact dump.
 *
 * Split out of that file, which had grown past the 400-code-line factoring ceiling. Nothing
 * changed: every helper, threshold and comment is as it was, and the e2e entry point is still
 * combat-dashboard.e2e.mts (`npm run test:e2e`). Read that file's header first — it carries the
 * why (no window is ever shown, the real log is the input, assertions are identities).
 */

import type { Page } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ARTIFACTS = join(ROOT, 'tests', 'e2e', 'artifacts')
/**
 * Its OWN build output, never `out/`: the user keeps `npm run dev --watch` running, which
 * owns out/main + out/preload and rewrites them on every source edit. Building into out-e2e/
 * means the harness can never race that watcher (or leave a production bundle where the dev
 * app expects its own). The main bundle resolves preload/renderer relative to __dirname, so
 * an alternate root just works.
 */
const OUT_DIR = join(ROOT, 'out-e2e')
export const MAIN_ENTRY = join(OUT_DIR, 'main', 'index.js')
/**
 * Throwaway `userData` for the app under test — wiped per run, so every run starts fresh
 * (default view, no saved character, no overlays) and the real store is never opened.
 *
 * KEYED BY CHECKOUT, and that suffix is load-bearing. It used to be one fixed path in the OS
 * temp dir, which is a SINGLETON PER MACHINE, not per repo: a second checkout of this repo (a
 * `git worktree`, a CI runner with two jobs, two agents working in parallel) ran its specs
 * against the very same dir. That is not a slow test, it is a WRONG one — `firstRun()` wipes
 * this dir with `rmSync`, so a neighbour's fresh-install step deletes the store THIS spec is
 * mid-way through asserting about. The telemetry spec is where it surfaced, because it is the
 * only spec whose assertion spans two launches: launch 3 opted out, a neighbour wiped the dir,
 * and launch 4 read defaults back — "the answer SURVIVES a restart" failing against an app
 * that had persisted the answer perfectly.
 *
 * A hash of ROOT keeps every property the fixed path had — stable across runs of THIS checkout,
 * so runs still overwrite rather than litter temp — while making the collision impossible.
 */
export const USER_DATA = join(
  tmpdir(),
  `everquest-companion-e2e-userdata-${createHash('sha1').update(ROOT).digest('hex').slice(0, 10)}`
)

/** A full-log scan of a months-old live log takes a while; be generous, fail loudly. */
export const HYDRATE_TIMEOUT_MS = 300_000
/** How long to wait for the LIVE tail to classify a combat line before shrugging. */
export const LIVE_LINE_WAIT_MS = 45_000

// ── tiny assertion harness (node:test's runner buys us nothing here — one long session) ──

export const failures: string[] = []
export const notes: string[] = []

export function check(name: string, ok: boolean, detail = ''): boolean {
  if (ok) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
  return ok
}

export function note(msg: string): void {
  notes.push(msg)
  console.log(`  note ${msg}`)
}

/** The run's verdict: the notes, then every failure, then the exit code. */
export function reportRun(): void {
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

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── build (reuse out/ when it's newer than every source file) ──────────────────────────

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs)
  }
  return newest
}

export function buildIfStale(): void {
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

export function electronBinary(): string {
  return process.platform === 'win32'
    ? join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
}

// ── page helpers ───────────────────────────────────────────────────────────────────────

export interface Snap {
  hydrating: boolean
  selectedId: string
  zone?: string
  selected: { kind: string; name: string; entities: unknown[]; outTotal: number } | null
  segments: { kind: string; id: string; name: string; total: number }[]
  zoneSessions: { id: string; total: number }[]
  recent: unknown[]
}

export function snapshot(page: Page): Promise<Snap> {
  // The renderer's own bridge — the exact door useCombat uses, so we observe what it observes.
  return page.evaluate(
    () => (window as unknown as { eq: { getCombatSnapshot: (o: unknown) => Promise<Snap> } }).eq.getCombatSnapshot({})
  ) as Promise<Snap>
}

/** Bounding box of the first match, or null when the node isn't in the DOM. */
export function rectOf(page: Page, selector: string): Promise<{ w: number; h: number } | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height) }
  }, selector)
}

export function countOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => document.querySelectorAll(sel).length, selector)
}

/** The selector's closed-state text — the head row's label ("Current fight (live)" / "Last fight — …"). */
export function selectorText(page: Page): Promise<string> {
  return page.evaluate(
    () => (document.querySelector('[data-testid="segment-select"]') as HTMLElement | null)?.innerText ?? ''
  )
}

/**
 * Open the fight picker and LEAVE it open. The trigger keeps its `segment-select` id (the
 * popover it opens is a different component now — Task #61's FightPicker — but the control the
 * user clicks, and everything asserted about its closed text, is unchanged).
 */
export async function openPicker(page: Page): Promise<void> {
  await page.click('[data-testid="segment-select"]')
  await page.waitForSelector('[data-testid="fight-picker"]', { timeout: 15_000 })
  await page.waitForSelector('li[data-value]', { timeout: 15_000 })
}

export async function closePicker(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await sleep(400)
}

/**
 * Every SELECTABLE row's value, in list order. Housekeeping rows ('Load more…', the empty
 * placeholder, the "+N more" search footer) deliberately carry no `data-value`, so this reads
 * exactly the set of segments the list is offering.
 */
export function listedValues(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('li[data-value]')].map((el) => el.getAttribute('data-value') ?? '')
  )
}

/**
 * Open the picker, collect every selectable row's value, close it again — what this asserts is
 * which SCOPE's ids are offered.
 */
export async function openSelectorValues(page: Page): Promise<string[]> {
  await openPicker(page)
  const values = await listedValues(page)
  await closePicker(page)
  // The head row's '__live__' sentinel IS a segment row (it re-resolves to the current/last
  // fight); only the housekeeping rows are dropped (they carry no data-value at all today, so
  // this filter is belt-and-braces).
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
export function pageOverflow(page: Page): Promise<{ doc: number; content: number }> {
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
export function narrowPanelCheck(page: Page): Promise<{ cols: number; minH: number; scrolls: boolean }> {
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
   * Spread of the SUBJECT line's controls' vertical CENTERS (scope + selector + headline stat).
   * The controls have different heights (the selector is a two-line row, the toggle is a
   * single-line pill, the headline is a big number over a caption) and the row centers them, so
   * their top edges legitimately differ by ~10px — centers are what agree on one line. A real
   * wrap moves a control a whole row (≥30px).
   */
  subjectSpread: number
  /** Same measurement for the LENS line (view switch + direction filter). */
  lensSpread: number
  /**
   * How far the view switch's center sits BELOW the selector's. This is the whole point of the
   * redesign: two RANKS (what you're looking at, then how you're looking at it), not one flat
   * row of equal-weight controls. A collapse back to a single line drives this to ~0.
   */
  rankGap: number
  /** which of the header's controls are mounted right now */
  controls: string[]
  /** the headline stat's text ('' when no segment is selected and it isn't rendered) */
  headline: string
}

/** The header bar's box + whether its two ranks actually landed as two ranks. */
function headerInfo(page: Page): Promise<HeaderInfo | null> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="combat-header"]') as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    const ids = ['scope-toggle', 'segment-select', 'view-toggle', 'direction-toggle', 'headline-stat']
    const present = ids.filter((id) => document.querySelector(`[data-testid="${id}"]`))
    // NO named function bindings inside this callback: tsx/esbuild `keepNames` wraps
    // `const f = (…) => …` in a `__name` helper that lives in the NODE bundle, and Playwright
    // ships only the callback's source to the page — so the evaluated code throws
    // `__name is not defined`. Anonymous callbacks passed straight to .map/.filter are the one
    // shape that stays unwrapped, so the center/spread math is written with those.
    const centers = new Map(
      ids.map((id) => {
        const b = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect()
        return [id, b ? b.top + b.height / 2 : undefined] as const
      })
    )
    // LINE 1 (subject) = scope + selector + the right-edge headline stat. LINE 2 (lens) = the
    // view switch + the direction filter (present in dash view only). Absent ids simply drop
    // out — presence is asserted separately, this is purely "did the line stay one line".
    const spreads = [
      ['scope-toggle', 'segment-select', 'headline-stat'],
      ['view-toggle', 'direction-toggle']
    ].map((want) => {
      const cs = want.map((id) => centers.get(id)).filter((t): t is number => typeof t === 'number')
      return cs.length ? Math.round(Math.max(...cs) - Math.min(...cs)) : -1
    })
    const subjectSpread = spreads[0]
    const lensSpread = spreads[1]
    const selCenter = centers.get('segment-select')
    const viewCenter = centers.get('view-toggle')
    return {
      h: Math.round(r.height),
      w: Math.round(r.width),
      overflowX: Math.max(0, el.scrollWidth - el.clientWidth),
      subjectSpread,
      lensSpread,
      rankGap:
        typeof selCenter === 'number' && typeof viewCenter === 'number'
          ? Math.round(viewCenter - selCenter)
          : -1,
      controls: present,
      headline: (document.querySelector('[data-testid="headline-stat"]') as HTMLElement | null)?.innerText ?? ''
    }
  })
}

/** Is the view switch's Timeline button disabled right now? */
export function timelineDisabled(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // MUI renders a disabled ToggleButton as `<button disabled class="… Mui-disabled">`; accept
    // either signal so a styling-only change can't silently pass the assertion.
    const btn = document.querySelector('[data-testid="view-toggle"] button:nth-child(2)')
    return !!btn && (btn.matches('[disabled]') || btn.classList.contains('Mui-disabled'))
  })
}

/**
 * The HEADER assertions. It is the tab's subject line THEN its lens line: rank 1 says WHAT you
 * are looking at (Fight/Overall scope, which fight, and its headline dps), rank 2 says HOW
 * (Dashboard/Timeline, direction, combine-pets, passive state). What can regress here is SIZE
 * and WRAPPING: at the 900px minimum window there is only ~648px of content width, and the old
 * flat row of five equal-weight controls wrapped into a three-line block whose wrap point moved
 * with the fight name. The two-rank layout is asserted structurally — each line's controls must
 * agree on a center, AND the lens line must sit materially BELOW the subject line, so a
 * regression that flattens the bar back into one row fails even though nothing "wrapped".
 */
export async function checkHeader(page: Page, tag: string, expectDirection: boolean, maxH = 110): Promise<void> {
  const h = await headerInfo(page)
  if (!check(`[${tag}] the combat header is rendered`, h !== null)) return
  const info = h as HeaderInfo
  check(
    `[${tag}] the header stays a compact bar`,
    info.h >= 40 && info.h <= maxH,
    `${info.w}×${info.h}px (cap ${maxH}) · controls: ${info.controls.join(', ')}`
  )
  check(
    `[${tag}] nothing in the header is cut off horizontally`,
    info.overflowX === 0,
    `+${info.overflowX}px`
  )
  check(
    `[${tag}] the subject line (scope + selector + headline) stays one line`,
    info.subjectSpread >= 0 && info.subjectSpread <= 6,
    `center spread ${info.subjectSpread}px`
  )
  check(
    `[${tag}] the lens line (view switch${expectDirection ? ' + direction filter' : ''}) stays one line`,
    info.lensSpread >= 0 && info.lensSpread <= 6,
    `center spread ${info.lensSpread}px`
  )
  // The structural assertion: the lens sits on its OWN rank under the subject. Any plausible
  // two-rank bar puts these ≥20px apart; 10px is a floor that only a flattened/overlapping
  // layout can fail.
  check(
    `[${tag}] the view switch sits on a second rank BELOW the selector`,
    info.rankGap >= 10,
    `view center is ${info.rankGap}px below the selector's`
  )
  check(
    `[${tag}] the direction filter is ${expectDirection ? 'present' : 'hidden (timeline view)'}`,
    info.controls.includes('direction-toggle') === expectDirection,
    info.controls.join(', ')
  )
  // The headline stat is the subject line's payload — it renders only when a segment is
  // selected, and by the time any checkHeader runs the flow has already asserted a fight is
  // selected (step 5/6), so its absence here is a real regression, not a quiet log.
  check(
    `[${tag}] the selected segment's headline stat is present and states a rate`,
    info.controls.includes('headline-stat') && /dps/i.test(info.headline),
    info.headline.replace(/\s+/g, ' ').trim() || 'absent'
  )
}

/**
 * The 2x2 GRID assertions. The four dashboard panels (source meter, DPS over time, breakdown
 * preview, damage by mob) must be four EQUAL cells — equal width AND equal height — none
 * collapsed, none clipping its content, and the grid must never make the page scroll.
 * Run more than once per session (quiet log, busy log, explicit fight pick) because the whole
 * point is that panel CONTENT growth can't move the layout.
 */
export async function checkGrid(page: Page, tag: string): Promise<void> {
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

// ── chart hover (Task #64: the crosshair + shared ChartTooltip) ────────────────────────

const TOOLTIP = '[data-testid="chart-tooltip"]'
/**
 * The timeline's plot SVG. It carries no testid of its own and the Combat view is full of MUI
 * icon `<svg>`s, so it is identified by the clip path only it owns (`<clipPath id="tl-plot-clip">`,
 * CombatTimeline.tsx). Hovering anywhere inside it is inside the wrapper that owns the hover
 * listeners, which is what the assertions actually need.
 */
const TIMELINE_PLOT = 'svg:has(#tl-plot-clip)'
/** The DPS-over-time curve: the one STRETCHED (`preserveAspectRatio="none"`) svg in a panel. */
const DPS_CURVE = '[data-testid="dash-panel"] svg[preserveAspectRatio="none"]'

/**
 * Move the REAL pointer to a fractional offset inside `sel`'s box. Real, not synthetic, on
 * purpose: the renderer then sees a genuine `pointermove` carrying `ev.buttons === 0`, which is
 * the exact condition the hover/drag seam bails on — a hand-dispatched event would have to
 * assert `buttons` itself and would prove nothing about the seam.
 *
 * Fractions are taken over the element's VISIBLE box: these plots are drawn inside scroll boxes
 * and can extend past the window, and `page.mouse` speaks VIEWPORT coordinates — a point outside
 * the viewport hovers nothing at all.
 *
 * Returns false when the element is absent (or entirely offscreen). A missing chart is the
 * caller's decision — note it or fail it — never a thrown harness error, which would skip every
 * remaining check in the session.
 */
export async function hoverAt(page: Page, sel: string, fx: number, fy: number): Promise<boolean> {
  const pt = await page.evaluate((a) => {
    const r = document.querySelector(a.sel)?.getBoundingClientRect()
    if (!r) return null
    const x0 = Math.max(0, r.left)
    const y0 = Math.max(0, r.top)
    const w = Math.min(window.innerWidth - 1, r.right) - x0
    const h = Math.min(window.innerHeight - 1, r.bottom) - y0
    return w > 0 && h > 0 ? { x: x0 + w * a.fx, y: y0 + h * a.fy } : null
  }, { sel, fx, fy })
  if (!pt) return false
  await page.mouse.move(Math.round(pt.x), Math.round(pt.y))
  // The hover layer is rAF-coalesced and change-gated by design, so the DOM lands a frame or
  // two later — read it after, never on the same tick as the move.
  await sleep(150)
  return true
}

/** The shared cursor-following card's text (`lib/ChartTooltip.tsx`); '' when nothing is hovered. */
export function tooltipText(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector('[data-testid="chart-tooltip"]') as HTMLElement | null)?.innerText ?? '')
}

/** Park the pointer somewhere no chart is, and let the leave handler land. */
async function pointerAway(page: Page): Promise<void> {
  await page.mouse.move(2, 2)
  await sleep(250)
}

/**
 * The DRAG/HOVER SEAM, asserted rather than assumed: the timeline's drag-pan and its hover share
 * one surface and are owned by different modules, and the ONLY thing keeping them apart is that
 * the hover handler returns early while any button is held. So hold the button and move: a
 * tooltip appearing here is the regression.
 */
async function checkDragSeam(page: Page): Promise<void> {
  await hoverAt(page, TIMELINE_PLOT, 0.6, 0.5)
  await page.mouse.down()
  await hoverAt(page, TIMELINE_PLOT, 0.45, 0.5)
  const held = await countOf(page, TOOLTIP)
  await page.mouse.up()
  await pointerAway(page)
  check(
    'dragging the plot (button held) suppresses hover entirely — the drag/pan seam',
    held === 0,
    `${held} tooltip(s) mid-drag`
  )
}

/**
 * The DPS card's own hover. Whether the curve is drawn at all is log-dependent (a ringless or
 * damage-free selection renders a quiet note instead), so an absent curve is a NOTE — the same
 * convention the live-tail and freeze-window steps use. An absent hover LAYER is likewise noted
 * rather than failed: this assertion is re-run at wave close, and the timeline half above is
 * what pins the shared tooltip.
 */
async function checkDpsCardHover(page: Page): Promise<void> {
  if (!(await hoverAt(page, DPS_CURVE, 0.5, 0.5))) {
    note('the DPS-over-time curve is not drawn for this selection — its hover is not asserted this run')
    return
  }
  const shown = await countOf(page, TOOLTIP)
  if (shown === 0) {
    note('the DPS card renders no hover tooltip in this build — the curve’s hover layer is not present yet')
  } else {
    const text = (await tooltipText(page)).replace(/\s+/g, ' ').trim()
    check('hovering the DPS-over-time curve renders exactly one chart tooltip', shown === 1, `${shown}: ${text.slice(0, 70)}`)
  }
  await pointerAway(page)
}

/**
 * HOVER (Task #64), end to end on the real charts. Identities only, never today's numbers: the
 * tooltip's SHAPE (exactly one card, a rate in the app's own vocabulary, the honesty footer), its
 * lifecycle (it leaves with the pointer) and the seam that keeps it out of a drag's way.
 *
 * Enters the Timeline view itself and restores the Dashboard afterwards, so it can be dropped
 * anywhere in the flow that has a fight with an event ring selected.
 */
export async function checkChartHover(page: Page): Promise<void> {
  await page.click('[data-testid="view-toggle"] button:nth-child(2)')
  await sleep(900)
  const plot = await rectOf(page, TIMELINE_PLOT)
  if (!check('the timeline plot is mounted (hover needs a drawn chart)', plot !== null, plot ? `${plot.w}×${plot.h}px` : 'absent')) return
  await hoverAt(page, TIMELINE_PLOT, 0.6, 0.5)
  const shown = await countOf(page, TOOLTIP)
  const text = (await tooltipText(page)).replace(/\s+/g, ' ').trim()
  check('hovering the timeline plot renders exactly one chart tooltip', shown === 1, `${shown} tooltip(s)`)
  // The rate vocabulary is a repo law (AGENTS.md: '21.7k dps', the word after the number, NO
  // '/s' anywhere), and 'rolling' is the honesty footer that names the window the number came
  // from — a readout that lost it would be claiming an instantaneous rate the log can't support.
  check(
    '…reading a rolling dps rate in the app’s rate vocabulary (never "/s")',
    /\d+(\.\d+)?[kM]? dps/.test(text) && /rolling/i.test(text) && !text.includes('/s'),
    text.slice(0, 90) || 'no tooltip text'
  )
  await pointerAway(page)
  check('…and moving off the plot removes it', (await countOf(page, TOOLTIP)) === 0)
  await checkDragSeam(page)
  await page.click('[data-testid="view-toggle"] button:nth-child(1)')
  await sleep(900)
  await checkDpsCardHover(page)
}

/** Visible text of the Combat view — cheap way to assert card titles exist. */
export function combatText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText ?? '')
}

/**
 * Poll the Combat view until it names `needle`, or the deadline passes; returns whatever it
 * said last. Selecting a fight is asynchronous all the way through (click → IPC → snapshot →
 * render), so "did the pick land" is a wait, not a read.
 */
export async function waitForCombatText(page: Page, needle: string, timeoutMs = 10_000): Promise<string> {
  const t0 = Date.now()
  let shown = ''
  while (Date.now() - t0 < timeoutMs) {
    shown = await combatText(page)
    if (needle && shown.includes(needle)) break
    await sleep(300)
  }
  return shown
}

export async function dumpArtifacts(page: Page, tag: string): Promise<void> {
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
