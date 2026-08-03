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
 * wander into the zone aggregate), the header holds its two-rank shape (subject line, then
 * lens line) with the Timeline view offered only when the selection actually has an event
 * ring, and the combat log is a BOUNDED scrolling box.
 * Assertions are identities/floors — never "today's numbers" (AGENTS.md: frozen numbers rot).
 *
 * On any failure: the relevant DOM + a screenshot land in tests/e2e/artifacts/ (gitignored).
 *
 * Run: `npm run test:e2e`
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { rmSync } from 'node:fs'
import {
  ARTIFACTS,
  HYDRATE_TIMEOUT_MS,
  LIVE_LINE_WAIT_MS,
  MAIN_ENTRY,
  ROOT,
  USER_DATA,
  buildIfStale,
  check,
  checkChartHover,
  checkGrid,
  checkHeader,
  closePicker,
  combatText,
  countOf,
  dumpArtifacts,
  electronBinary,
  failures,
  listedValues,
  narrowPanelCheck,
  note,
  openPicker,
  openSelectorValues,
  pageOverflow,
  rectOf,
  reportRun,
  selectorText,
  sleep,
  snapshot,
  timelineDisabled,
  waitForCombatText,
  type Snap
} from './appHarness.mjs'

// ── the run, one step per numbered section ─────────────────────────────────────────────
//
// The steps are functions purely so the session isn't one 470-line body: the order, the
// assertions, the thresholds and the comments are exactly as they were, and the state a later
// step needs is THREADED through parameters and return values instead of shared locals.

/** What steps 2-3 measured, which step 6 re-states. */
interface DashboardShape {
  dash: { w: number; h: number } | null
  rows: number
  liveTotal: number
}

async function stepHydration(page: Page): Promise<Snap> {
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
  return snap
}

async function stepDashboardShape(page: Page, snap: Snap): Promise<DashboardShape> {
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

  // 4c. THE HEADER: one compact bar of two RANKS (subject line, then lens line), not a
  //     wrapped toolbar dump.
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
  return { dash, rows, liveTotal }
}

async function stepScopeAndSelector(page: Page, snapIn: Snap, shape: DashboardShape): Promise<Snap> {
  const { dash, rows, liveTotal } = shape
  let snap = snapIn
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
  // The CLOSED trigger states the subject only — label + timing. The dps rate moved to the
  // headline stat at the right edge of the same line, and printing the number twice on one
  // line was exactly the noise the redesign removed. Scope this to the trigger's own text:
  // the headline is a SIBLING inside the header, so a page-wide search would always find
  // "dps" and assert nothing at all.
  const triggerText = await selectorText(page)
  check(
    'the closed selector states the subject only — no dps rate (the headline owns it)',
    !/dps/i.test(triggerText),
    triggerText.replace(/\s+/g, ' ').trim().slice(0, 80) || 'empty'
  )
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

  // 6c. TIMELINE AVAILABILITY. The timeline is drawn from a per-encounter EVENT RING, and a
  //     zone aggregate deliberately keeps none (AGENTS.md law 7: finalized zone sessions are
  //     frozen totals + timing, NO per-event rings — that's what keeps a full-log history
  //     under a megabyte). So in Overall scope there is nothing to draw, and the honest UI is
  //     a DISABLED Timeline button, not a button that leads to an empty pane. Same rule
  //     covers old fights whose rings have been evicted (≤60 retained).
  check(
    'in Overall scope the Timeline view is disabled (a zone aggregate keeps no event ring)',
    await timelineDisabled(page)
  )
  await page.click('[data-testid="scope-toggle"] button:nth-child(1)')
  await sleep(800)
  check(
    '…and back in Fight scope the Timeline view is selectable again (the live/last fight has its ring)',
    !(await timelineDisabled(page))
  )
  snap = await snapshot(page)
  return snap
}

async function stepCombatLogAndRegression(page: Page, snapIn: Snap): Promise<Snap> {
  let snap = snapIn
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

  // 9c. AUTO-FALLBACK. The view is a LENS over the selection, and the selection can lose its
  //     timeline underneath you — switching scope to Overall is the everyday way to do it
  //     (step 6c: no event ring for a zone aggregate). The old behaviour left you staring at a
  //     dead "No timeline for this selection" pane you had to escape by hand. The contract now
  //     is that the view falls back to Dashboard on its own, so that empty pane is
  //     UNREACHABLE — assert both halves: the dashboard comes back, and that copy appears
  //     nowhere on the page.
  await page.click('[data-testid="view-toggle"] button:nth-child(2)')
  await sleep(800)
  check(
    'the Timeline view is entered from the Fight scope',
    (await countOf(page, '[data-testid="combat-dashboard"]')) === 0
  )
  await page.click('[data-testid="scope-toggle"] button:nth-child(2)')
  await sleep(800)
  check(
    'losing the timeline mid-view falls back to the Dashboard automatically',
    (await countOf(page, '[data-testid="combat-dashboard"]')) === 1
  )
  check(
    '…so the empty "No timeline for this selection" pane is never reachable',
    !(await combatText(page)).toLowerCase().includes('no timeline for this selection')
  )
  // Restore the state the remaining steps document as their starting point: Fight scope,
  // Dashboard view. (The fallback already put the view back; the scope is ours to undo.)
  await page.click('[data-testid="scope-toggle"] button:nth-child(1)')
  await sleep(800)
  check(
    '…and returning to the Fight scope leaves the Dashboard mounted',
    (await countOf(page, '[data-testid="combat-dashboard"]')) === 1
  )
  return snap
}

async function stepPickAFight(page: Page, snap: Snap): Promise<void> {
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
    await openPicker(page)
    await page.click(`li[data-value="${newestFight.id}"]`, { timeout: 15_000 })
    // Verify from the DOM, not from our own snapshot call: `getCombatSnapshot({})` resolves
    // OUR (live) selection, not the renderer's — only the rendered view knows what's picked.
    const shown = await waitForCombatText(page, newestFight.name)
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
}

async function stepFrozenList(page: Page): Promise<void> {
  // 10b. FROZEN WHILE OPEN (Task #61, the churn fix). The snapshot ticks ~4x/sec while the
  //      user is fighting, and every tick rebuilds the option rows: a fight finalizes, the head
  //      row relabels itself from "Current fight (live)" to "Last fight — …", the old head drops
  //      into the history under its own id, and every row below shifts down one. That is what
  //      "it gets all confused as it's switching" was. The contract now is that the OPEN list is
  //      a snapshot taken at open time — no reorder, no insert, no removal — so what is under
  //      your pointer stays under your pointer.
  //
  //      This can only PROVE anything while the log is actually moving (a quiet log churns
  //      nothing, so an unchanged list is vacuous), hence: assert when busy, note when quiet —
  //      the same convention step 8 uses for the live tail.
  await openPicker(page)
  const frozenBefore = await listedValues(page)
  const churnA = await snapshot(page)
  await sleep(3000)
  const frozenAfter = await listedValues(page)
  const churnB = await snapshot(page)
  // "Busy" = the engine's own view of the world moved underneath the open list: a fight is
  // open, the fight count changed, or the selected segment's damage grew.
  const busy =
    !!churnB.segments.find((s) => s.kind === 'current') ||
    churnA.segments.length !== churnB.segments.length ||
    (churnA.selected?.outTotal ?? 0) !== (churnB.selected?.outTotal ?? 0)
  const sameList =
    frozenBefore.length === frozenAfter.length && frozenBefore.every((v, i) => v === frozenAfter[i])
  if (busy) {
    check(
      'the OPEN fight list is frozen — 3s of live ticks change neither its rows nor their order',
      sameList,
      `${frozenBefore.length} rows → ${frozenAfter.length} rows${sameList ? '' : ` (was ${frozenBefore.slice(0, 4).join(',')} · now ${frozenAfter.slice(0, 4).join(',')})`}`
    )
  } else {
    note(
      `the log was quiet across the 3s freeze window (${frozenBefore.length} rows, unchanged) — nothing could have churned, so the freeze is not asserted this run`
    )
  }
  await closePicker(page)
}

async function stepSearch(page: Page, snap: Snap): Promise<void> {
  // 10c. SEARCH (Task #61). The snapshot only carries the newest `maxSegments` fights, so
  //      "look up my fights from earlier this week" used to mean paging "Load more" repeatedly.
  //      A non-empty query goes to the engine's ALL-TIME corpus instead. Query a name we KNOW
  //      is in the log (pulled from the snapshot), assert the row surfaces, and select it.
  const searchable = snap.segments.find((s) => s.kind === 'fight' && s.name && s.total > 0)
  if (searchable) {
    // A multi-mob pull's name ends in a '+N' (sometimes '+N others') suffix — that is the
    // fight's SHAPE, not something a user would type at a search box, so it comes off. The
    // twin disambiguator ('(177)') deliberately stays: it is part of the mob's name here.
    const q = searchable.name.replace(/\s*\+\s*\d+(\s+others?)?\s*$/i, '').trim()
    await openPicker(page)
    await page.fill('[data-testid="fight-search"]', q)
    // debounce (120ms) + one IPC round-trip over the whole corpus (~0.3ms of scoring).
    await sleep(1200)
    const hits = await listedValues(page)
    check(`searching the fight history for "${q}" returns hits`, hits.length >= 1, `${hits.length} rows`)
    if (hits.length >= 1) {
      // Ranking is score desc then RECENCY desc, and this fight is one of the newest in the
      // log, so it should be on the first page of its own name's matches.
      check(
        '…including the fight the query was taken from',
        hits.includes(searchable.id),
        `${searchable.id} in ${hits.slice(0, 4).join(', ')}${hits.length > 4 ? ', …' : ''}`
      )
      const pick = hits.includes(searchable.id) ? searchable.id : hits[0]
      // Read the row's own name rather than trusting the snapshot's: whichever row we end up
      // clicking, the dashboard must then show THAT fight.
      const pickName = await page.evaluate((v) => {
        const el = document.querySelector(`li[data-value="${v}"]`) as HTMLElement | null
        return (el?.innerText ?? '').split('\n')[0].trim()
      }, pick)
      await page.click(`li[data-value="${pick}"]`, { timeout: 15_000 })
      const searchShown = await waitForCombatText(page, pickName)
      check(
        'selecting a search hit renders that fight',
        !!pickName && searchShown.includes(pickName),
        pickName || 'row had no name'
      )
      check(
        '…and its dashboard renders source rows',
        (await countOf(page, '[data-testid="meter-row"]')) >= 1,
        `${await countOf(page, '[data-testid="meter-row"]')} rows`
      )
      // The picker closed on selection, and clearing the query must restore the browse list.
      check('…and the picker closed on selection', (await countOf(page, '[data-testid="fight-picker"]')) === 0)
    } else {
      await closePicker(page)
    }
    // A query that matches nothing is a quiet empty state, never an error or a full list.
    await openPicker(page)
    await page.fill('[data-testid="fight-search"]', 'zzzzqqq no such mob zzzz')
    await sleep(1200)
    const misses = await listedValues(page)
    check('a query that matches nothing lists nothing (it never falls back to the full list)', misses.length === 0, `${misses.length} rows`)
    await closePicker(page)
    await checkGrid(page, 'after search')
  } else {
    note('no finalized fight with damage in the snapshot — the search assertions need one')
  }
}

async function stepResponsive(app: ElectronApplication, page: Page): Promise<void> {
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
  // 720px is BELOW the app's 900px minimum window: the lens line is explicitly allowed to
  // wrap once down here (flexWrap is its overflow strategy), so the height cap admits one
  // extra row. At and above the minimum the two-line cap (110px) stays the law.
  await checkHeader(page, 'narrow (720)', true, 150)
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
}

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

    let snap = await stepHydration(page)
    const shape = await stepDashboardShape(page, snap)
    snap = await stepScopeAndSelector(page, snap, shape)
    snap = await stepCombatLogAndRegression(page, snap)
    await stepPickAFight(page, snap)
    await stepFrozenList(page)
    await stepSearch(page, snap)
    await stepResponsive(app, page)
    // 13. HOVER on the real charts (crosshair + shared tooltip + the drag seam) — see the
    //     harness, which owns the steps: this file is at its factoring ceiling.
    await checkChartHover(page)

    check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

    if (failures.length) await dumpArtifacts(page, 'combat-dashboard-FAIL')
    else await dumpArtifacts(page, 'combat-dashboard-pass')
  } finally {
    await app.close().catch(() => undefined)
  }

  reportRun()
}

main().catch((err: unknown) => {
  console.error('e2e: harness error —', err)
  process.exitCode = 1
})
