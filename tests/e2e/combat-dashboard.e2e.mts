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
 * source meter has rows, the DPS-over-time and Damage-by-mob cards exist, the selector is
 * backed by fights + zone sessions, and the combat log is a BOUNDED scrolling box.
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
  liveFallback: boolean
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

/** Visible text of the Combat view — cheap way to assert card titles exist. */
function combatText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText ?? '')
}

async function dumpArtifacts(page: Page, tag: string): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true })
  try {
    const html = await page.evaluate(() => {
      const view = document.querySelector('[data-testid="segment-select"]')?.closest('.MuiStack-root')
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

    // 5. The selector is backed by real history: fights + zone sessions.
    const fights = snap.segments.filter((s) => s.kind === 'fight').length
    check('the selector has finalized fights', fights >= 1, `${fights} fights`)
    check('the selector has zone sessions', snap.zoneSessions.length >= 1, `${snap.zoneSessions.length} sessions`)

    // 6. LIVE-with-no-open-fight falls back to the zone session, and SAYS so (Task #56).
    if (snap.liveFallback) {
      check('no fight open ⇒ the live ZONE session is shown', snap.selected?.kind === 'zone', `selectedId=${snap.selectedId}`)
      check('…and the body labels the fallback', (await countOf(page, '[data-testid="live-fallback"]')) === 1)
      check(
        '…never the empty "No combat yet" panel',
        dash !== null && (liveTotal === 0 || rows >= 1),
        `${Math.round(liveTotal)} dmg / ${rows} rows`
      )
    } else {
      note(`a fight is open (${snap.selected?.name ?? '?'}) — the live-fallback path is not exercised this run`)
      check('an open fight is the selection', snap.selected?.kind === 'fight')
    }

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

    // 10. Drive the SELECTOR for real and land on the newest finalized fight. History always
    //     carries damage (the engine drops 0-damage encounters), so this is the unconditional
    //     "the dashboard renders the log's data" assertion — independent of what the player
    //     happens to be doing right now.
    const newestFight = snap.segments.find((s) => s.kind === 'fight')
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
      check(
        '…and the live-fallback label is gone (an explicit pick is not the live view)',
        (await countOf(page, '[data-testid="live-fallback"]')) === 0
      )
      const dash3 = await rectOf(page, '[data-testid="combat-dashboard"]')
      check('…in a dashboard that still has height', !!dash3 && dash3.h >= 200, dash3 ? `${dash3.h}px` : 'absent')
    } else {
      check('the log has at least one finalized fight to select', false, 'no fights in history')
    }

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
