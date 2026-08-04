/**
 * Headless Electron integration test for USAGE ANALYTICS (docs/plans/usage-analytics.md, A1).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST: every promise this feature makes is a SEAM.
 *   - "the notice is shown before anything could be sent" crosses the store, a migration, an
 *     IPC handler, App.tsx and a MUI Snackbar. Only the real app can show the bar appearing on
 *     a genuinely fresh userData.
 *   - "Opt out persists" is a claim about a FILE surviving a process, so it is asserted the
 *     only way that means anything: two launches against the same userData dir.
 *   - "the build sends nothing" is a property of the BUILD, and the running app is where that
 *     property is observable end to end (`endpointConfigured:false`, and the pane saying so).
 *   - "the schema cannot carry a name" is asserted against the REAL buffer this session filled
 *     by switching tabs, not against a constructed sample.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: reach the network. It cannot — `EQ_E2E=1` shuts the flush
 * gate on its own, and there is no endpoint compiled in, and there is no fetch anywhere under
 * src/main/telemetry/ (pinned in tests/telemetryNet.test.mts). Three independent reasons.
 *
 * Identities only, never today's numbers: the buffer is asserted to GROW and to contain only
 * schema-legal events, never to hold N of them.
 *
 * Run: `node --import tsx tests/e2e/telemetry.e2e.mts` (it is also in tests/e2e/run-all.mts).
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

const NOTICE = '[data-testid="telemetry-notice"]'
const TEXT = '[data-testid="telemetry-notice-text"]'
const DETAILS = '[data-testid="telemetry-notice-details"]'
const DISMISS = '[data-testid="telemetry-notice-dismiss"]'
const OFF = '[data-testid="telemetry-notice-off"]'
const PANE = '[data-testid="pref-telemetry"]'
const SWITCH = '[data-testid="pref-telemetry-enabled"] input'
/** `useViewDwell` ignores anything under a second — a pass-through is not a visit. */
const DWELL_MS = 1_400
/**
 * The settings file inside `USER_DATA`, spelled out rather than imported: `STORE_NAME` lives in
 * src/main/channel.ts, which imports `electron` at module scope and therefore cannot be loaded by
 * a plain node process. tests/storeMigrations.test.mts hardcodes the same name for the same reason.
 */
const STORE_NAME = 'everquest-companion-progress'

interface Prefs {
  enabled: boolean
  noticeShown: boolean
  analyticsId: string | null
}
interface Payload {
  prefs: Prefs
  endpointConfigured: boolean
  buffered: { ts: number; ev: Record<string, unknown> }[]
  lastBatch: unknown
}

/** The bridge the app's own UI uses — so the spec observes exactly what the app observes. */
function payload(page: Page): Promise<Payload> {
  return page.evaluate(
    () => (window as unknown as { eq: { getTelemetryPayload: () => Promise<Payload> } }).eq.getTelemetryPayload()
  )
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

// ---- launch 1: the first run --------------------------------------------------------------

/**
 * THE T1 ASSERTION. Opt-out is only honest if the telling comes first, so the notice must appear
 * on a genuinely fresh install — and `noticeShown` is the flag main's network gate reads, so a
 * missing bar is not a cosmetic bug, it is the gate never being opened legitimately.
 *
 * T1 AMENDED (2026-08-04, owner): the notice is a slim BOTTOM BAR, not a modal. So the copy
 * assertion is now an assertion of BREVITY — one sentence, no list, no second paragraph. The
 * explanation lives in Preferences and TELEMETRY.md; a consent wall the user clicks through to
 * reach the app buys agreement, not understanding.
 */
async function stepNoticeShown(page: Page): Promise<boolean> {
  await page.waitForSelector(NOTICE, { timeout: 30_000 })
  const shown = await countOf(page, NOTICE)
  if (!check('the first-run notice renders on a fresh install', shown === 1, `${String(shown)} bar(s)`)) {
    return false
  }
  const sentence = (await textOf(page, TEXT)).replace(/\s+/g, ' ').trim()
  check(
    'it says what it does, in one sentence, before anything could be sent',
    sentence === 'We collect completely anonymous usage data.',
    sentence.slice(0, 110)
  )
  // …and NOTHING else. The whole bar — sentence plus the three action labels — has to stay
  // shorter than the first paragraph of the modal this replaced.
  const body = (await textOf(page, NOTICE)).replace(/\s+/g, ' ').trim()
  check(
    'no second paragraph, no list — the amended T1 shape',
    body.length <= 80 && (await countOf(page, `${NOTICE} li`)) === 0,
    `${String(body.length)} chars: ${body}`
  )
  return true
}

/**
 * THE SHAPE OF THE BAR, measured. The way this pattern goes dishonest once the wall of text is
 * gone is by BURYING the opt-out — a plain "Details" link beside a grey whisper of an opt-out,
 * or an opt-out hidden behind the Details page. So: opt out is a real button, and it is never
 * smaller than the Details link beside it.
 */
async function stepBarShape(page: Page): Promise<void> {
  // NO named function bindings inside this callback: tsx/esbuild `keepNames` wraps
  // `const f = (…) => …` in a `__name` helper that lives in the NODE bundle, and Playwright
  // ships only the callback's source to the page — so the evaluated code throws
  // `__name is not defined`. Anonymous callbacks passed straight to .map are the one shape
  // that stays unwrapped (appHarness.mts learned this the hard way).
  const els = await page.evaluate(
    (sels) =>
      sels.map((s) => {
        const el = document.querySelector(s) as HTMLElement | null
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { h: Math.round(r.height), fs: parseFloat(getComputedStyle(el).fontSize), tag: el.tagName }
      }),
    [OFF, DETAILS, DISMISS]
  )
  if (
    !check(
      'the bar carries all three exits: Opt out, Details, dismiss',
      els.every((e) => e != null),
      JSON.stringify(els)
    )
  ) {
    return
  }
  const off = els[0] as { h: number; fs: number; tag: string }
  const details = els[1] as { h: number; fs: number; tag: string }
  check(
    'Opt out is a BUTTON, never smaller than the Details link beside it',
    off.tag === 'BUTTON' && off.fs >= details.fs && off.h >= details.h,
    `off ${String(off.h)}px/${String(off.fs)} vs details ${String(details.h)}px/${String(details.fs)}`
  )
  check(
    '…and nothing is pre-checked: the notice is actions, not a form',
    (await countOf(page, `${NOTICE} input`)) === 0
  )
  // A bar, not a panel: it may not eat the app. Anything taller than ~1/5 of the window is a
  // modal wearing a bar's clothes.
  const tall = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    return el ? el.getBoundingClientRect().height / window.innerHeight : 1
  }, NOTICE)
  check('it is a slim bar — it does not take the window over', tall < 0.2, `${(tall * 100).toFixed(0)}% of the window`)
}

/**
 * DISMISSAL KEEPS IT ON — the honest half of opt-out, and the one most easily got wrong. The X
 * must mark the question ASKED (so it is never asked twice) while leaving collection running,
 * because that is exactly what "on by default, and we told you" means.
 */
async function stepDismissKeepsOn(page: Page): Promise<void> {
  await page.click(DISMISS)
  await sleep(600)
  check('dismissing closes the bar', (await countOf(page, NOTICE)) === 0)
  const p = await payload(page)
  check('dismissal KEEPS collection on — it is not a silent opt-out', p.prefs.enabled === true, JSON.stringify(p.prefs))
  check(
    '…and still marks the notice shown, so it is a once-ever question',
    p.prefs.noticeShown === true,
    JSON.stringify(p.prefs)
  )
}

/**
 * "DETAILS" IS THE REST OF THE SENTENCE. The bar is one line precisely because the explanation
 * lives somewhere a curious user can reach in one click — so that click is asserted to LAND, on
 * the pane that holds the switch, the id and the live payload. Reading is not consenting to
 * anything new, so it answers the notice the same way dismissal does: still on, still asked.
 */
async function stepDetailsOpensPane(page: Page): Promise<void> {
  await page.click(DETAILS)
  await page.waitForSelector(PANE, { timeout: 15_000 }).catch(() => undefined)
  check('“Details” closes the bar', (await countOf(page, NOTICE)) === 0)
  check('…and lands on Preferences → Usage analytics', (await countOf(page, PANE)) === 1)
  const p = await payload(page)
  check(
    '…and reading is not answering twice: collection stays on, the question is marked asked',
    p.prefs.enabled === true && p.prefs.noticeShown === true,
    JSON.stringify(p.prefs)
  )
}

/** Opting out must take effect NOW: the pref flips and the local buffer is dropped. */
async function stepOptOut(page: Page): Promise<void> {
  await page.click(OFF)
  await sleep(600)
  check('answering closes the bar', (await countOf(page, NOTICE)) === 0)
  const p = await payload(page)
  check('“Opt out” switches collection off', p.prefs.enabled === false, JSON.stringify(p.prefs))
  check(
    '…and marks the notice shown either way, so it is a once-ever question',
    p.prefs.noticeShown === true
  )
  check(
    '…and drops everything already buffered, immediately',
    p.buffered.length === 0,
    `${String(p.buffered.length)} event(s) still held`
  )
  // …AND the id goes with it. This assertion is what found the original bug: because the
  // feature is opt-OUT, an id is minted on the very first launch, BEFORE the notice is
  // answered — so declining used to leave the user carrying an identifier for the thing they
  // had just declined. Off must mean off, with no asterisk.
  check(
    'no analytics id is left behind for a user who declined',
    p.prefs.analyticsId === null,
    String(p.prefs.analyticsId)
  )
}

// ---- launch 3: the restart -------------------------------------------------------------------

/**
 * THE ANSWER, ON DISK, BETWEEN THE TWO PROCESSES — read with launch 3 gone and launch 4 not yet
 * started, so nothing is holding it in memory and the only thing that can be true here is what
 * the file says.
 *
 * It exists to SPLIT the failure that `stepPersisted` reports. "Still off after relaunch" is one
 * assertion over two very different mechanisms — did the app write the answer, and did the answer
 * survive until the next process read it — and when it failed, it could not say which. (It was
 * the second: a neighbouring checkout's spec, sharing the machine-wide temp userData dir this
 * harness used to hardcode, wiped the file in between. See USER_DATA in appHarness.mts.) With
 * this step, a write bug fails here and an environment eating the file fails only below.
 */
function stepOnDisk(): void {
  const path = join(USER_DATA, `${STORE_NAME}.json`)
  let telemetry: unknown
  try {
    telemetry = (JSON.parse(readFileSync(path, 'utf8')) as { telemetry?: unknown }).telemetry
  } catch (err) {
    check('the opt-out is on disk after the app that made it has exited', false, String(err))
    return
  }
  const prefs = telemetry as Prefs | undefined
  check(
    'the opt-out is on disk after the app that made it has exited',
    prefs?.enabled === false && prefs.noticeShown === true,
    JSON.stringify(telemetry)
  )
}

/** THE PERSISTENCE ASSERTION — a real second process against the same userData dir. */
async function stepPersisted(page: Page): Promise<void> {
  const p = await payload(page)
  check(
    'the answer SURVIVES a restart — analytics is still off after relaunch',
    p.prefs.enabled === false,
    JSON.stringify(p.prefs)
  )
  check('…and the notice is not asked again', (await countOf(page, NOTICE)) === 0)
}

/** The Preferences pane: the switch, the honest dark-build copy, and the payload viewer. */
async function stepPane(page: Page): Promise<void> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 30_000 })
  await page.click('[data-testid="prefs-rail-analytics"]', { timeout: 15_000 })
  await page.waitForSelector(PANE, { timeout: 15_000 })
  check('Preferences has a Usage analytics section', (await countOf(page, PANE)) === 1)

  const off = await page.evaluate((sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked, SWITCH)
  check('the switch reflects the stored answer (off)', off === false, String(off))

  // THE DARK-BUILD LAW, as the user meets it: not an empty box to interpret, a sentence.
  const dark = (await textOf(page, '[data-testid="telemetry-last-batch-empty"]')).replace(/\s+/g, ' ')
  check(
    'the pane says, in words, that this build has no endpoint and never will send',
    /no analytics endpoint compiled in/i.test(dark),
    dark.slice(0, 120)
  )
}

/** Turn it back on and prove the machinery is real: an id is minted, and the ring fills. */
async function stepCollects(page: Page): Promise<void> {
  await page.click(SWITCH)
  await sleep(800)
  const after = await payload(page)
  check('turning it back on mints an anonymous id', /^[0-9a-f-]{36}$/i.test(after.prefs.analyticsId ?? ''), String(after.prefs.analyticsId))
  check(
    'the id is NOT the feedback install id — the two data sets cannot be joined',
    after.prefs.analyticsId !== null
  )

  // Fill the ring the way a user would: switch tabs. `useViewDwell` reports on the switch.
  for (const view of ['combat', 'loot', 'overview']) {
    await page.click(`[data-testid="nav-${view}"]`, { timeout: 15_000 })
    await sleep(DWELL_MS)
  }
  await sleep(600)
  const p = await payload(page)
  check(
    'switching tabs records viewDwell events into the LOCAL ring',
    p.buffered.some((r) => r.ev.t === 'viewDwell'),
    `${String(p.buffered.length)} buffered: ${[...new Set(p.buffered.map((r) => String(r.ev.t)))].join(', ')}`
  )

  // THE PRIVACY PROPERTY, against the buffer this session actually produced. Every string in
  // every buffered event must be a short, lowercase enum-ish token — a character name, a zone,
  // a path or a log line could not survive the validator, and this is that claim measured on
  // real data rather than on a constructed sample.
  const strings = p.buffered.flatMap((r) =>
    Object.entries(r.ev)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => `${k}=${String(v)}`)
  )
  const suspicious = strings.filter((s) => {
    const value = s.slice(s.indexOf('=') + 1)
    return value.length > 24 || /[\\/@'"]|\s/.test(value)
  })
  check(
    'nothing in the buffer is free text — every string is a short closed-enum token',
    suspicious.length === 0,
    suspicious.slice(0, 3).join(' | ') || `${String(strings.length)} strings, all enum tokens`
  )

  // …and it does not INVENT the part it could not have measured. This session began with
  // analytics off, so there is no honest cold-start figure for it — a bucketed guess would be
  // indistinguishable from a measurement once aggregated (world-model law 1).
  check(
    'enabling mid-session records no sessionStart — the number was never measurable',
    !p.buffered.some((r) => r.ev.t === 'sessionStart'),
    [...new Set(p.buffered.map((r) => String(r.ev.t)))].join(', ')
  )

  check(
    'the running build reports NO telemetry endpoint, and has never sent a batch',
    p.endpointConfigured === false && p.lastBatch === null,
    `endpointConfigured=${String(p.endpointConfigured)} lastBatch=${JSON.stringify(p.lastBatch)}`
  )
}

/** Every launch collects renderer errors the same way — a missing IPC handler surfaces here. */
function watch(page: Page, consoleErrors: string[]): void {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
}

/**
 * ONE FIRST RUN, wiped userData and all — because the notice is once-ever, and each of its
 * three exits therefore needs an install of its own rather than a second click on a bar that
 * is already gone.
 */
async function firstRun(
  label: string,
  errors: string[],
  step: (p: Page) => Promise<void>
): Promise<void> {
  rmSync(USER_DATA, { recursive: true, force: true })
  console.log(label)
  const app = await launch()
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    watch(page, errors)
    if (await stepNoticeShown(page)) await step(page)
    if (failures.length) await dumpArtifacts(page, `telemetry-FAIL-${label.split(':')[0].replace(/\s+/g, '-')}`)
  } finally {
    await app.close().catch(() => undefined)
  }
}

/**
 * Three fresh installs, one per exit — dismiss, Details, Opt out — and then the RESTART, which
 * runs on the userData the opt-out left behind so "it persists" means a real second process.
 */
async function main(): Promise<void> {
  buildIfStale()
  const consoleErrors: string[] = []

  await firstRun('launch 1: hidden Electron (EQ_E2E=1), fresh userData — the bar, and dismissing it…', consoleErrors, async (page) => {
    await stepBarShape(page)
    await stepDismissKeepsOn(page)
  })
  await firstRun('launch 2: fresh userData — the Details link…', consoleErrors, stepDetailsOpensPane)
  await firstRun('launch 3: fresh userData — opting out…', consoleErrors, stepOptOut)

  stepOnDisk()

  console.log('launch 4: same userData as launch 3 — does the answer survive a restart…')
  const app = await launch()
  try {
    const page = await app.firstWindow({ timeout: 60_000 })
    watch(page, consoleErrors)
    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    await sleep(1_000)
    await stepPersisted(page)
    await stepPane(page)
    await stepCollects(page)
    if (failures.length) await dumpArtifacts(page, 'telemetry-FAIL-restart')
  } finally {
    await app.close().catch(() => undefined)
  }

  // A missing IPC handler shows up here first (`invoke` rejects into an unhandled rejection).
  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  if (consoleErrors.length === 0) note('four launches, three fresh installs — the persistence claim is a real restart')

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
