/**
 * Headless Electron integration test for VOICE ALERTS (docs/plans/voice-alerts.md, wave 2).
 *
 * WHY IT IS AN E2E SPEC AND NOT A UNIT TEST: every claim this wave makes is a SEAM, and the
 * pure halves are already pinned elsewhere (tests/voiceAlerts.test.mts for the plan/throttle/
 * voice-matching decisions, tests/speechText.test.mts for the text).  What only the real app
 * can show is that the pieces are actually WIRED:
 *   - the Preferences → Voice section mounts, states its OFF default, and its writes reach
 *     main's store (electron-store is main-owned; the panel's only proof is the round trip);
 *   - the editor's live preview resolves through `speechTextFor` with NO firing at all — the
 *     whole reason that function takes an optional firing;
 *   - a def saved with `audio:'speech'` makes the firing path reach the ENGINE SEAM, which
 *     crosses the dialog, the store, main, the player and lib/speech.
 *
 * IT ASSERTS THE SEAM, NEVER THE AUDIO. `lib/speech.ts` records every utterance on
 * `window.__eqSpeech` with an `uttered` flag and returns BEFORE touching any engine whenever
 * `window.eq.isE2E` is true. So this spec reads that ring — which gives it two independent
 * claims from one action: the seam was invoked (the record exists, with the right text) AND
 * the e2e channel stayed SILENT (`uttered === false`).
 *
 * THE SILENCE IS THE POINT, not a convenience. `npm run test:e2e` runs beside the user's live
 * game with no window ever shown (AGENTS.md); a headless test that spoke out loud would be the
 * most intrusive thing in this repo. That is asserted here explicitly, so it cannot regress
 * quietly.
 *
 * Run: `npm run test:e2e` (or `node --import tsx tests/e2e/voice-alerts.e2e.mts`).
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

const VOICE_PANEL = '[data-testid="pref-voice"]'
const ENABLE = '[data-testid="pref-voice-enabled"] input'

/** One utterance as `lib/speech.ts` recorded it. `uttered` is what proves the channel is mute. */
interface Spoken {
  text: string
  engine: string
  voiceId: string | null
  uttered: boolean
}

/** The engine seam's own ring. `[]` when nothing has ever asked to speak. */
function spoken(page: Page): Promise<Spoken[]> {
  return page.evaluate(
    () => (window as unknown as { __eqSpeech?: { spoken: Spoken[] } }).__eqSpeech?.spoken ?? []
  ) as Promise<Spoken[]>
}

/** The voice prefs as MAIN has them — the only honest read of "did that persist". */
function storedPrefs(page: Page): Promise<{ enabled: boolean; engine: string }> {
  return page.evaluate(() =>
    (window as unknown as { eq: { getVoicePrefs: () => Promise<{ enabled: boolean; engine: string }> } }).eq.getVoicePrefs()
  )
}

function textOf(page: Page, selector: string): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '',
    selector
  )
}

/** Pick a value out of a MUI Select (its popup renders `li[data-value=…]`). */
async function selectValue(page: Page, testid: string, value: string): Promise<void> {
  await page.click(`[data-testid="${testid}"]`)
  await page.waitForSelector(`li[data-value="${value}"]`, { timeout: 10_000 })
  await page.click(`li[data-value="${value}"]`)
  // MUI's menu animates out; clicking through it while it fades hits the backdrop.
  await sleep(400)
}

/** §2: the section exists, and it is OFF until asked for (decision D4). */
async function stepPanel(page: Page): Promise<boolean> {
  await page.click('[data-testid="nav-preferences"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="prefs-rail-voice"]', { timeout: 20_000 })
  await page.click('[data-testid="prefs-rail-voice"]')
  await page.waitForSelector(VOICE_PANEL, { timeout: 15_000 })
  if (!check('Preferences has a Voice section, reachable from the rail', (await countOf(page, VOICE_PANEL)) === 1)) {
    return false
  }
  const checked = await page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.checked ?? null,
    ENABLE
  )
  check('spoken alerts are OFF by default — an unasked-for feature never speaks', checked === false, String(checked))

  const before = await storedPrefs(page)
  check('…and main agrees: the stored prefs say disabled', before.enabled === false, JSON.stringify(before))

  // The controls that configure the tier are all present, off or not.
  for (const id of ['pref-voice-engine', 'pref-voice-picker', 'pref-voice-preview', 'pref-voice-rate', 'pref-voice-volume']) {
    check(`the Voice section offers ${id.replace('pref-voice-', '')}`, (await countOf(page, `[data-testid="${id}"]`)) === 1)
  }
  return true
}

/** Turning it on has to reach MAIN — the store is the source of truth, not this component. */
async function stepEnable(page: Page): Promise<void> {
  await page.click(ENABLE)
  await sleep(600)
  const after = await storedPrefs(page)
  check(
    'enabling spoken alerts persists through main’s store (not just local component state)',
    after.enabled === true,
    JSON.stringify(after)
  )
  check('…and the engine tier defaults to the free, zero-download one', after.engine === 'system', after.engine)
}

/** The ▶ preview speaks through the REAL seam — and, in this channel, silently. */
async function stepPreview(page: Page): Promise<void> {
  const before = (await spoken(page)).length
  await page.click('[data-testid="pref-voice-preview"]')
  await sleep(500)
  const all = await spoken(page)
  if (!check('the ▶ preview reaches the speech engine seam', all.length === before + 1, `${String(all.length - before)} utterance(s)`)) {
    return
  }
  const last = all[all.length - 1]
  check('…saying something, through the selected tier', last.text.length > 0 && last.engine === 'system', `${last.engine}: "${last.text}"`)
  check(
    'THE E2E CHANNEL NEVER UTTERS — the seam records and returns before any engine is touched',
    last.uttered === false,
    `uttered=${String(last.uttered)}`
  )
}

/**
 * §2 (W3): the DOWNLOADED tier states its price and its refusal, in the panel.
 *
 * The e2e channel declines to download (a throwaway userData would re-fetch ~120 MB every run),
 * which is exactly what makes this cheap AND worth asserting: clicking Download proves the button
 * reaches main, and the refusal proves the reason lands INLINE instead of vanishing into a
 * promise. The tier is put back to 'system' afterwards so the later steps see the default.
 */
async function stepKokoroInstall(page: Page): Promise<void> {
  await selectValue(page, 'pref-voice-engine', 'kokoro')
  check(
    'choosing the downloaded tier says plainly that it is not installed',
    (await countOf(page, '[data-testid="pref-voice-not-installed"]')) === 1
  )
  // `innerText` is the RENDERED text, and MUI Buttons uppercase it — match case-insensitively
  // rather than pinning a theme decision this spec has no opinion about.
  const label = (await textOf(page, '[data-testid="pref-voice-install"]')).replace(/\s+/g, ' ').trim()
  check(
    '…and offers the download, stating what it costs BEFORE the user pays it',
    /^download natural voice \(~\d+ MB\)$/i.test(label),
    label
  )

  await page.click('[data-testid="pref-voice-install"]')
  await page.waitForSelector('[data-testid="pref-voice-install-error"]', { timeout: 20_000 })
  const failure = (await textOf(page, '[data-testid="pref-voice-install-error"]')).replace(/\s+/g, ' ')
  check(
    'clicking it reaches main, and main’s refusal is rendered inline with its reason',
    failure.includes('disabled in e2e'),
    failure
  )
  await selectValue(page, 'pref-voice-engine', 'system')
}

/** The alert name the dialog is editing, read off its own title ("Edit alert — <name>"). */
async function editingName(page: Page): Promise<string> {
  const title = (await textOf(page, '[data-testid="alert-dialog"] .MuiDialogTitle-root')).replace(/\s+/g, ' ').trim()
  const dash = title.indexOf('—')
  return dash === -1 ? '' : title.slice(dash + 1).trim()
}

/**
 * §4: the editor's Speech block, on a REAL stored def — and the live preview, which resolves
 * with no firing at all (that is what `speechTextFor`'s optional firing exists for).
 */
async function stepEditor(page: Page): Promise<string> {
  await page.click('[data-testid="nav-alerts"]', { timeout: 60_000 })
  await page.waitForSelector('[data-testid="alert-row"]', { timeout: 30_000 })
  await page.click('[data-testid="alert-row"]:first-of-type [data-testid="alert-edit"]')
  await page.waitForSelector('[data-testid="alert-dialog"]', { timeout: 15_000 })
  const name = await editingName(page)
  check('the alert editor carries a Speech block', (await countOf(page, '[data-testid="alert-speech-block"]')) === 1)
  check(
    'the audio channel is a sound/speech/both choice, and the throttle opt-out is beside it',
    (await countOf(page, '[data-testid="alert-audio-action"]')) === 1 &&
      (await countOf(page, '[data-testid="alert-always-play"]')) === 1
  )

  await selectValue(page, 'alert-audio-action', 'speech')
  const preview = (await textOf(page, '[data-testid="alert-speech-preview"]')).replace(/\s+/g, ' ')
  check(
    'the mode preview resolves LIVE, before anything has fired — and defaults to the alert’s name',
    !!name && preview.includes(name),
    `${preview.slice(0, 80)} (editing “${name}”)`
  )
  check('the mode picker and the per-alert voice override are offered', (await countOf(page, '[data-testid="alert-speech-mode"]')) === 1 && (await countOf(page, '[data-testid="alert-speech-voice"]')) === 1)

  await page.click('[data-testid="alert-save"]')
  await page.waitForSelector('[data-testid="alert-dialog"]', { state: 'detached', timeout: 15_000 })
  await sleep(600)
  return name
}

/**
 * THE WIRING, end to end: a def stored with `audio:'speech'`, fired through the player's own
 * path (the list's Test button), reaches the engine seam saying the resolved text.
 */
async function stepFire(page: Page, name: string): Promise<void> {
  const before = (await spoken(page)).length
  await page.click('[data-testid="alert-row"]:first-of-type [data-testid="alert-test"]')
  await sleep(800)
  const all = await spoken(page)
  if (!check('test-firing a speech alert invokes the engine seam', all.length === before + 1, `${String(all.length - before)} utterance(s)`)) {
    return
  }
  const last = all[all.length - 1]
  check(
    '…saying exactly what `speechTextFor` resolved for that def',
    last.text === name,
    `spoke "${last.text}", expected "${name}"`
  )
  check('…and still without uttering a sound in this channel', last.uttered === false, `uttered=${String(last.uttered)}`)
}

async function main(): Promise<void> {
  buildIfStale()
  rmSync(USER_DATA, { recursive: true, force: true })

  console.log('launch: hidden Electron (EQ_E2E=1) against the real log — Voice alerts spec…')
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

    await page.waitForSelector('[data-testid="nav-preferences"]', { timeout: 60_000 })
    if (await stepPanel(page)) {
      await stepEnable(page)
      await stepPreview(page)
      await stepKokoroInstall(page)
      const name = await stepEditor(page)
      if (name) await stepFire(page, name)
      else note('no seeded alert to edit this run — the firing path is not asserted')
    }

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    if (failures.length) await dumpArtifacts(page, 'voice-alerts-FAIL')
  } finally {
    await app.close().catch(() => undefined)
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
