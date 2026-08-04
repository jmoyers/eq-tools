/**
 * Headless Electron integration test for COPY-TO-CLIPBOARD (the combat panels' copy affordance).
 *
 * WHY IT EXISTS: the copy buttons did nothing. They called `navigator.clipboard.writeText`,
 * which Chromium gates on the 'clipboard-sanitized-write' permission — and this app denies EVERY
 * web permission wholesale (`hardenSession`, src/main/windows.ts), deliberately and permanently.
 * So every click rejected with `NotAllowedError: Write permission denied.` and nothing ever
 * reached the clipboard, while the UI showed no error a user could see. The copy now goes
 * through main (`clipboard:write` → Electron's `clipboard` module, which is not a web API and
 * consults no permission).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST: what broke was the SEAM between a real Chromium
 * renderer and a real permission policy. Every layer was individually correct — the serializer
 * produced the right text, the API call was well-formed, the policy did exactly what it says —
 * and nothing short of driving the real app and reading the real OS clipboard could see it. The
 * only honest proof is: click the button a user clicks, then ask the main process what the
 * clipboard now holds.
 *
 * WHY ITS OWN FILE: one spec per surface (like the Overview and Maps specs), all sharing
 * `appHarness.mts` and running back to back from `npm run test:e2e`. `EQ_E2E=1` (src/main/e2e.ts)
 * shows no window, skips the single-instance lock and points `userData` at a throwaway temp dir,
 * so this runs invisibly beside the user's game and dev app.
 *
 * IT PUTS THE USER'S CLIPBOARD BACK. This is the machine's REAL clipboard and the user may be
 * mid-copy, so the prior text is read first and restored afterwards — but only when there WAS
 * text: restoring '' would clear an image or a file the clipboard is holding in a format
 * `readText` cannot see.
 *
 * Identities only, never today's numbers: the assertion is that the clipboard stopped holding
 * the sentinel and now holds the panel's own serialization — a subject line ending in the
 * fight's ` · m:ss` duration (`copyTable.subjectLine`), followed by more lines.
 *
 * Run: `npm run test:e2e`
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
  reportRun,
  sleep,
  snapshot
} from './appHarness.mjs'

/** The copy affordance in a combat panel header (combatShared.tsx `CopyButton`). */
const BTN = '[data-testid="copy-view"]'
/** How long to wait for a panel with something to copy after hydration finishes. */
const COPYABLE_WAIT_MS = 30_000

/**
 * Read — and optionally first WRITE — the OS clipboard from the MAIN process, the only side of
 * the app that can see it.
 *
 * Retried because `electronApplication.evaluate`'s result handle can be garbage-collected while
 * main is busy inside the full-log scan ("Resulting promise was garbage collected"). That is a
 * harness artifact of the CDP bridge, not a product failure, and retrying is how the harness
 * stays honest about which one it is: a real failure fails all four times.
 */
async function mainClipboard(app: ElectronApplication, write?: string): Promise<string> {
  let last: unknown
  for (let i = 0; i < 4; i++) {
    try {
      return await app.evaluate(({ clipboard }, w: string | undefined): string => {
        if (w !== undefined) clipboard.writeText(w)
        return clipboard.readText()
      }, write)
    } catch (err) {
      last = err
      await sleep(1500)
    }
  }
  throw last
}

/** Wait out the startup replay; false when it never finished (nothing below can be asserted). */
async function waitHydrated(page: Page): Promise<boolean> {
  const t0 = Date.now()
  let snap = await snapshot(page)
  while (snap.hydrating && Date.now() - t0 < HYDRATE_TIMEOUT_MS) {
    await sleep(500)
    snap = await snapshot(page)
  }
  return check('hydration completes (replay hands off to the live tail)', !snap.hydrating, `${Date.now() - t0}ms`)
}

/**
 * Wait for a panel that HAS something to copy. A copy button is rendered only where there are
 * rows to serialize, so a freshly-zoned/quiet selection legitimately has none — that is a note,
 * not a failure (the same convention the live-tail steps use).
 */
async function waitForCopyButton(page: Page): Promise<number> {
  const t0 = Date.now()
  let n = 0
  while (Date.now() - t0 < COPYABLE_WAIT_MS) {
    n = await countOf(page, BTN)
    if (n > 0) return n
    await sleep(500)
  }
  return n
}

async function stepCopy(app: ElectronApplication, page: Page): Promise<void> {
  const buttons = await waitForCopyButton(page)
  if (buttons === 0) {
    note('no panel on screen has rows to copy right now — the clipboard round-trip is not asserted this run')
    return
  }
  // The user's own clipboard, so it can go back exactly as it was.
  const userText = await mainClipboard(app)
  // A sentinel, so "the clipboard already happened to hold the right thing" cannot pass.
  const sentinel = `e2e-nothing-was-copied-${String(Date.now())}`
  await mainClipboard(app, sentinel)

  await page.click(BTN)
  await sleep(500)
  // Read the icon FIRST: the copied state is deliberately transient (~1.5s), and the clipboard
  // round-trip below can outlive it.
  const checks = await countOf(page, `${BTN} [data-testid="CheckIcon"]`)
  const after = await mainClipboard(app)
  if (userText) await mainClipboard(app, userText)

  const first = after.split('\n')[0] ?? ''
  check(
    'clicking Copy actually puts the view on the OS clipboard',
    after !== sentinel && after.length > 0,
    after === sentinel
      ? 'the clipboard still holds the sentinel — the click wrote nothing'
      : `${String(after.length)} chars from ${String(buttons)} copy affordance(s) on screen`
  )
  check(
    '…and what landed there is the panel’s own serialization (subject line · duration, then rows)',
    / · \d+:\d{2}$/.test(first) && after.includes('\n'),
    first.slice(0, 80) || 'empty'
  )
  // The user-visible half of the same fact: the icon flashes to a checkmark for ~1.5s (MUI's
  // icons carry their own `data-testid`, so the swap is observable). It is driven by main's
  // reply, so a refused write leaves the copy icon in place — a failed copy must never look
  // like a successful one.
  check(
    '…and the button flips to its copied state (the checkmark tracks what main actually wrote)',
    checks === 1,
    `${String(checks)} checkmark(s) among ${String(buttons)} copy affordance(s)`
  )
}

async function main(): Promise<void> {
  buildIfStale()
  rmSync(USER_DATA, { recursive: true, force: true })

  console.log('launch: hidden Electron (EQ_E2E=1) against the real log — Copy spec…')
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

    // A fresh userData opens on Overview; the copy affordances live in Combat.
    await page.click('[data-testid="nav-combat"]', { timeout: 60_000 })
    await page.waitForSelector('[data-testid="segment-select"]', { timeout: 60_000 })
    if (await waitHydrated(page)) {
      await sleep(1500)
      await stepCopy(app, page)
    }

    // The old failure mode logged '[everquest-companion:error] copy failed' from the renderer —
    // so a clean console is part of what "the copy works" means here.
    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'copy-FAIL')
  } finally {
    await app.close().catch(() => undefined)
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
