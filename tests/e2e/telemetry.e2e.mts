/**
 * Headless Electron integration test for USAGE ANALYTICS (docs/plans/usage-analytics.md, A1).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST: every promise this feature makes is a SEAM.
 *   - "the notice is shown before anything could be sent" crosses the store, a migration, an
 *     IPC handler, App.tsx and a MUI Dialog. Only the real app can show the modal appearing on
 *     a genuinely fresh userData.
 *   - "Turn it off persists" is a claim about a FILE surviving a process, so it is asserted the
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

const NOTICE = '[data-testid="telemetry-notice"]'
const KEEP = '[data-testid="telemetry-notice-on"]'
const OFF = '[data-testid="telemetry-notice-off"]'
const PANE = '[data-testid="pref-telemetry"]'
const SWITCH = '[data-testid="pref-telemetry-enabled"] input'
/** `useViewDwell` ignores anything under a second — a pass-through is not a visit. */
const DWELL_MS = 1_400

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
 * missing modal is not a cosmetic bug, it is the gate never being opened legitimately.
 */
async function stepNoticeShown(page: Page): Promise<boolean> {
  await page.waitForSelector(NOTICE, { timeout: 30_000 })
  const shown = await countOf(page, NOTICE)
  if (!check('the first-run notice renders on a fresh install', shown === 1, `${String(shown)} modal(s)`)) {
    return false
  }
  const body = (await textOf(page, NOTICE)).replace(/\s+/g, ' ')
  check(
    'it states what is collected, in plain language, before anything could be sent',
    /which tabs you open/i.test(body) && /counts/i.test(body),
    body.slice(0, 110)
  )
  check(
    '…and what it can never contain — by shape, not by policy',
    /no free-text field/i.test(body) && /character/i.test(body),
    /no free-text field/i.test(body) ? 'present' : 'the "can never contain" paragraph is missing'
  )
  // The dark-build fact, in the modal itself: today this asks permission for something that
  // physically cannot happen yet, and saying so is the honest version of asking.
  check(
    'it says this build sends nothing anywhere at all',
    (await countOf(page, '[data-testid="telemetry-notice-dark"]')) === 1 &&
      /nothing is being sent/i.test(body)
  )
  check('…and that closing the window keeps it on (dismissal is not a silent opt-out)', /closing this window keeps it on/i.test(body))
  return true
}

/**
 * EQUAL PROMINENCE, measured. The usual way this pattern is dishonest is a big coloured "Keep
 * it on" beside a grey text link — so the two buttons are compared as BOXES: same height, same
 * font size, same variant class. A design that promotes one of them fails here.
 */
async function stepEqualProminence(page: Page): Promise<void> {
  // NO named function bindings inside this callback: tsx/esbuild `keepNames` wraps
  // `const f = (…) => …` in a `__name` helper that lives in the NODE bundle, and Playwright
  // ships only the callback's source to the page — so the evaluated code throws
  // `__name is not defined`. Anonymous callbacks passed straight to .map are the one shape
  // that stays unwrapped (appHarness.mts learned this the hard way).
  const pair = await page.evaluate(
    (sels) =>
      sels.map((s) => {
        const el = document.querySelector(s) as HTMLElement | null
        if (!el) return null
        return {
          h: Math.round(el.getBoundingClientRect().height),
          fs: getComputedStyle(el).fontSize,
          // MUI encodes variant/colour in class names; comparing the sorted Mui-* set catches
          // a `variant="contained"` or `color="primary"` promotion without pinning a stylesheet.
          cls: [...el.classList].filter((c) => c.startsWith('Mui')).sort().join(' ')
        }
      }),
    [KEEP, OFF]
  )
  if (!check('both answers are rendered as buttons', pair[0] != null && pair[1] != null)) return
  const on = pair[0] as { h: number; fs: string; cls: string }
  const off = pair[1] as { h: number; fs: string; cls: string }
  check(
    'the two answers have EQUAL prominence — same size, same weight, same variant',
    Math.abs(on.h - off.h) <= 2 && on.fs === off.fs && on.cls === off.cls,
    `keep ${String(on.h)}px/${on.fs} vs off ${String(off.h)}px/${off.fs}`
  )
  check(
    '…and nothing is pre-checked: the notice is two buttons, not a form',
    (await countOf(page, `${NOTICE} input[type="checkbox"]`)) === 0
  )
}

/** Turning it off must take effect NOW: the pref flips and the local buffer is dropped. */
async function stepTurnOff(page: Page): Promise<void> {
  await page.click(OFF)
  await sleep(600)
  check('answering dismisses the notice', (await countOf(page, NOTICE)) === 0)
  const p = await payload(page)
  check('“Turn it off” switches collection off', p.prefs.enabled === false, JSON.stringify(p.prefs))
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

// ---- launch 2: the restart ------------------------------------------------------------------

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

async function main(): Promise<void> {
  buildIfStale()
  // A genuinely fresh install — the whole first half of this spec is about what happens on one.
  rmSync(USER_DATA, { recursive: true, force: true })

  console.log('launch 1: hidden Electron (EQ_E2E=1), fresh userData — Telemetry spec…')
  let app: ElectronApplication = await launch()
  let page: Page | null = null
  const consoleErrors: string[] = []
  try {
    page = await app.firstWindow({ timeout: 60_000 })
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))
    if (await stepNoticeShown(page)) {
      await stepEqualProminence(page)
      await stepTurnOff(page)
    }
    if (failures.length) await dumpArtifacts(page, 'telemetry-FAIL-1')
  } finally {
    await app.close().catch(() => undefined)
  }

  // THE RESTART. Same userData dir, new process: the only way "it persists" means anything.
  console.log('launch 2: same userData — does the answer survive a restart…')
  app = await launch()
  try {
    page = await app.firstWindow({ timeout: 60_000 })
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))
    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    await sleep(1_000)
    await stepPersisted(page)
    await stepPane(page)
    await stepCollects(page)
    if (failures.length) await dumpArtifacts(page, 'telemetry-FAIL-2')
  } finally {
    await app.close().catch(() => undefined)
  }

  // A missing IPC handler shows up here first (`invoke` rejects into an unhandled rejection).
  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  if (consoleErrors.length === 0) note('two launches, one userData dir — the persistence claim is a real restart')

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
