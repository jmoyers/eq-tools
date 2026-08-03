// DRILL-AWARE readers for the combat e2e.
//
// The Combat dashboard now OPENS on your damage breakdown (owner direction, 2026-08-03: the
// game is mostly played solo, so a two-row source meter is a lid on the only list worth
// reading), so the level-1 SOURCE rows are one click up rather than on screen. Every assertion
// in the spec that counts `meter-row` is about "the meter renders the sources it has" — an
// assertion about the DATA, not about which level happens to be open — so it reads the count
// through here, which un-drills first.
//
// It lives in its own module rather than in the spec or in appHarness.mts because both of those
// files sit within a handful of lines of the repo's max-lines budget, and a helper is not worth
// spending a refactor wave's worth of budget in someone else's file.

import type { Page } from 'playwright-core'

const BACK = '[data-testid="drill-back"]'
const ROW = '[data-testid="meter-row"]'

/**
 * Un-drill (idempotent — a click on a crumb that isn't there is a no-op, not a failure) and
 * return the level-1 source-row count. Clicking Back is also the live check that un-drilling
 * still works: if it stopped working, the row count goes to 0 and the spec says so.
 *
 * Bounded on purpose: there are exactly two levels, so ONE click is enough and a Back that
 * doesn't close the crumb must surface as a failed row count, never as a hung run.
 */
export async function meterRows(page: Page): Promise<number> {
  if ((await page.$$(BACK)).length > 0) {
    await page.click(BACK, { timeout: 5_000 }).catch(() => undefined)
    await page.waitForSelector(BACK, { state: 'detached', timeout: 5_000 }).catch(() => undefined)
  }
  return (await page.$$(ROW)).length
}
