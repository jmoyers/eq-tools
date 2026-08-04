/**
 * Headless Electron integration test for the IN-APP FEEDBACK dialog (Task #65).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST: everything this feature promises is a SEAM.
 *   - "the dialog opens from the nav" crosses App.tsx state, a portal, and MUI's Dialog;
 *   - "Send is gated by the shared validator" crosses the renderer, `src/shared/feedback.ts`
 *     and (later) the ingest Lambda — the whole point is that one function decides for all
 *     three, and only the real app can show that the button and the message agree;
 *   - "the preview shows what would be sent" crosses IPC into the main process, which opens
 *     the REAL, live, growing EverQuest log READ-ONLY, windows it, scrubs it and gzips it.
 *     No fixture can prove that path works against the file that actually exists today.
 *   - "this build cannot send" is a property of the BUILD (`FEEDBACK_API_URL === ''`), which is
 *     exactly the state every build is in until wave F2 deploys the stack.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: submit anything. `EQ_E2E=1` hard-guards `submitFeedback`
 * (§4.5) and this build has no endpoint anyway — the harness must never touch the network or
 * create a row. So Send is asserted as a GATE, never pressed to completion.
 *
 * ON THE SEND BUTTON STAYING DISABLED: in a dark build (`endpointConfigured: false`) Send is
 * disabled no matter how good the draft is, which is the honest thing for a build that cannot
 * send. That means the button alone cannot show the validator flipping, so the validator gate is
 * asserted where it actually speaks: the description field's helper text carries `validateDraft`'s
 * own message while the draft is short, and stops carrying it the moment the draft is valid.
 *
 * Identities only, never today's numbers: the preview is asserted to STATE counts in the app's
 * own vocabulary and to span a window, never to hold N lines.
 *
 * Run: `npm run test:e2e` (or `node --import tsx tests/e2e/feedback.e2e.mts`).
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { rmSync } from 'node:fs'
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

const DIALOG = '[data-testid="feedback-dialog"]'
const DESCRIPTION = '[data-testid="feedback-description"]'
/** MUI's multiline TextField renders a SECOND, aria-hidden textarea purely to measure rows. */
const DESCRIPTION_INPUT = `${DESCRIPTION} textarea:not([aria-hidden="true"])`
const SEND = '[data-testid="feedback-send"]'
const PREVIEW = '[data-testid="feedback-preview"]'
const PREVIEW_META = '[data-testid="feedback-preview-meta"]'
/** How long main may take to tail + window + scrub + gzip a slice of the real log. */
const SLICE_WAIT_MS = 30_000

function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    selector
  )
}

/** MUI renders a disabled Button as `<button disabled class="… Mui-disabled">`; accept either,
 *  so a styling-only change cannot silently pass the assertion. `null` = not in the DOM. */
function disabledState(page: Page, selector: string): Promise<boolean | null> {
  return page.evaluate((sel) => {
    const btn = document.querySelector(sel)
    if (!btn) return null
    return btn.matches('[disabled]') || btn.classList.contains('Mui-disabled')
  }, selector)
}

/** Type into the description field, replacing whatever is there. */
async function setDescription(page: Page, text: string): Promise<void> {
  await page.fill(DESCRIPTION_INPUT, text)
  // The gate is derived state, not an effect, but MUI's helper text re-renders on the next
  // frame — read it after, never on the same tick as the keystroke.
  await sleep(250)
}

/**
 * THE STRIP, asserted against a real running app.
 *
 * The dev-only feedback-TRIAGE tab (`src/renderer/src/features/triage/**`) is gated on the
 * compile-time `__EQ_DEV_TOOLS__` define, which `electron-vite build` sets to `false`. This
 * harness builds exactly that way (`buildIfStale` → `electron-vite build --outDir=out-e2e`), so
 * this run is production-shaped and the nav row must NOT exist. If it appears here, it appears
 * in the installer — and the installer would be shipping a button aimed at the owner's backlog.
 *
 * Absence is asserted on the DOM, not on the bundle: the grep-for-a-marker proof lives beside
 * the build, and this proves the user-visible consequence.
 */
async function stepTriageStripped(page: Page): Promise<void> {
  check(
    'the dev-only Triage tab is STRIPPED from a production-shaped build (no nav row)',
    (await countOf(page, '[data-testid="nav-triage"]')) === 0
  )
  // …and the bridge method the tab would call is a door with nothing behind it. It is still on
  // the preload (channel names are not secrets), but the handler is registered only when
  // `!app.isPackaged && !E2E`, so under EQ_E2E=1 an invoke must reject.
  const reachable = await page.evaluate(async () => {
    const call = (window as unknown as { eq: Record<string, unknown> }).eq.triageOps
    if (typeof call !== 'function') return false
    try {
      await (call as () => Promise<unknown>)()
      return true
    } catch {
      return false
    }
  })
  check(
    '…and its IPC handlers are not registered in this build either',
    reachable === false,
    `triage:ops ${reachable ? 'ANSWERED' : 'rejected, as designed'}`
  )
}

/** The dialog opens from the drawer's footer row, which is an ACTION, not a view. */
async function stepOpen(page: Page): Promise<boolean> {
  await page.click('[data-testid="nav-feedback"]', { timeout: 60_000 })
  await page.waitForSelector(DIALOG, { timeout: 15_000 })
  const open = await countOf(page, DIALOG)
  return check('the feedback dialog opens from the nav drawer footer', open === 1, `${String(open)} dialog(s)`)
}

/**
 * The build-honesty state. Every build before wave F2 has `FEEDBACK_API_URL === ''`, so this is
 * the state the user actually sees today — and it must SAY so rather than letting Send fail.
 */
async function stepDarkBuild(page: Page): Promise<void> {
  const shown = await countOf(page, '[data-testid="feedback-unavailable"]')
  if (shown === 0) {
    note('this build reports an ingest endpoint — the dark-build state is not asserted this run')
    return
  }
  const text = (await textOf(page, '[data-testid="feedback-unavailable"]')).replace(/\s+/g, ' ')
  check(
    'a build with no endpoint says so, in the dialog, before anything is typed',
    /isn’t available in this build|is not available in this build/.test(text),
    text.slice(0, 100)
  )
  check(
    '…and Send stays disabled in that build, however good the draft is',
    (await disabledState(page, SEND)) === true
  )
}

/**
 * The VALIDATOR GATE. `validateDraft` (src/shared/feedback.ts) is the one function the dialog,
 * the main process and the ingest Lambda all run, so its complaint is what the field shows.
 */
async function stepValidatorGate(page: Page): Promise<void> {
  check('Send starts disabled — an empty report is not sendable', (await disabledState(page, SEND)) === true)

  await setDescription(page, 'too short')
  const short = (await textOf(page, DESCRIPTION)).replace(/\s+/g, ' ')
  check(
    'a too-short description is refused by the SHARED validator, in its own words',
    /at least \d+ characters/i.test(short),
    short.slice(0, 110)
  )
  check('…and Send is still disabled', (await disabledState(page, SEND)) === true)

  await setDescription(page, 'The overlay meter goes blank right after I zone into Plane of Sky.')
  const good = (await textOf(page, DESCRIPTION)).replace(/\s+/g, ' ')
  check(
    'a valid description clears the validator’s complaint (the gate is the validator, not a length guess)',
    !/at least \d+ characters/i.test(good) && /\d+ \/ \d+/.test(good),
    good.slice(0, 110)
  )
}

/** Wait for main to hand back a slice for the live log; '' when it never did. */
async function waitForPreviewMeta(page: Page): Promise<string> {
  const t0 = Date.now()
  while (Date.now() - t0 < SLICE_WAIT_MS) {
    const shown = await countOf(page, PREVIEW_META)
    if (shown > 0) return (await textOf(page, PREVIEW_META)).replace(/\s+/g, ' ')
    if ((await countOf(page, '[data-testid="feedback-preview-empty"]')) > 0) return ''
    await sleep(500)
  }
  return ''
}

/**
 * The log attachment. A bug report ticks it BY DEFAULT and shows the slice EXPANDED — a log
 * slice you have to go looking for is not one you have read.
 */
async function stepAttachAndPreview(page: Page): Promise<void> {
  await page.click('[data-testid="feedback-type-bug"]')
  await sleep(400)

  const checked = await page.evaluate(
    () =>
      (document.querySelector('[data-testid="feedback-attach-log"] input') as HTMLInputElement | null)
        ?.checked ?? null
  )
  check('choosing Bug report ticks "attach my log" by default', checked === true, String(checked))

  const disclosure = (await textOf(page, DIALOG)).replace(/\s+/g, ' ')
  check(
    'the dialog states what survives the scrub, in plain language, before you send',
    disclosure.includes('Chat, tells, group and /who lines are removed'),
    disclosure.includes('Chat, tells') ? 'present' : 'the §5.3 disclosure is missing'
  )

  const meta = await waitForPreviewMeta(page)
  if (!meta) {
    note('main built no slice for the live log this run (no character log, or an empty window) — the preview counts are not asserted')
    return
  }
  // State, never process: lines · span · removed · compressed size. Counts are identities
  // (a real number in the app's own units), never today's totals.
  check(
    'the preview states the slice as COUNTS: lines, the window it spans, what was removed, and its compressed size',
    /[\d,]+ lines/.test(meta) &&
      /\d{1,2}:\d{2}.\d{1,2}:\d{2}/.test(meta) &&
      /[\d,]+ lines removed/.test(meta) &&
      /\d+(\.\d+)? (KB|MB) compressed/.test(meta),
    meta.slice(0, 120)
  )

  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) return null
    const style = getComputedStyle(el)
    return {
      h: Math.round(el.getBoundingClientRect().height),
      scrolls: style.overflowY === 'auto' || style.overflowY === 'scroll',
      rows: el.querySelectorAll('div').length
    }
  }, PREVIEW)
  if (!check('the preview box is rendered', box !== null)) return
  const b = box as { h: number; scrolls: boolean; rows: number }
  // AGENTS.md UI law: a growing list lives in a FIXED-height scroll box. A preview that sized
  // itself to 5,000 lines would push the dialog's own actions off the screen.
  check(
    'the preview is a FIXED-height box that scrolls its own content',
    b.h > 0 && b.h <= 320 && b.scrolls,
    `${String(b.h)}px · overflow ${b.scrolls ? 'auto' : 'visible'}`
  )
  // Windowed through lib/useWindowedRows: only the visible slice is mounted, so a 5,000-line
  // preview costs a screenful of nodes, not 5,000.
  check(
    '…and it is windowed, not fully mounted',
    b.rows > 0 && b.rows < 200,
    `${String(b.rows)} mounted row nodes`
  )
  check('"Save a copy…" is offered — the escape hatch that makes the preview honest', (await countOf(page, '[data-testid="feedback-save-copy"]')) === 1)
}

async function main(): Promise<void> {
  buildIfStale()
  rmSync(USER_DATA, { recursive: true, force: true })

  console.log('launch: hidden Electron (EQ_E2E=1) against the real log — Feedback spec…')
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

    await page.waitForSelector('[data-testid="nav-feedback"]', { timeout: 60_000 })
    await stepTriageStripped(page)
    if (await stepOpen(page)) {
      await stepDarkBuild(page)
      await stepValidatorGate(page)
      await stepAttachAndPreview(page)
    }

    // A missing IPC handler shows up here first (`invoke` rejects into an unhandled rejection),
    // so a clean console is part of what "the dialog works" means.
    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'feedback-FAIL')
  } finally {
    await app.close().catch(() => undefined)
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
