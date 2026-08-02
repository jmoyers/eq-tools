import { app } from 'electron'
import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Headless integration-test mode (`EQ_E2E=1`), used by `npm run test:e2e`.
 *
 * The user plays EQ while the app runs, so an integration test must never take the
 * screen. This flag makes exactly three behavior changes in `index.ts` — every window
 * stays hidden (`show:false` + no `show()`/`showInactive()` call), the single-instance
 * lock is skipped (so the test instance doesn't quit against the running dev app), and
 * the background sound-pack provisioning (network) is suppressed. Everything else — the
 * real log scan, the engine, every IPC channel, the renderer bundle — runs untouched, so
 * the test asserts against production behavior.
 *
 * Module-level side effect (kept here, imported FIRST by index.ts): re-point `userData`
 * at a fresh temp dir BEFORE electron-store is constructed at import time, so a test run
 * can never read or clobber the user's real store / errors.log. Zero footprint when the
 * env var is absent.
 */
export const E2E = process.env['EQ_E2E'] === '1'

if (E2E) {
  // The harness passes EQ_E2E_USER_DATA (a fixed path it wipes per run, so runs don't litter
  // temp); a bare `EQ_E2E=1` launch gets its own throwaway dir.
  const given = process.env['EQ_E2E_USER_DATA']
  let dir: string
  if (given) {
    mkdirSync(given, { recursive: true })
    dir = given
  } else {
    dir = mkdtempSync(join(tmpdir(), 'eq-tools-e2e-'))
  }
  app.setPath('userData', dir)
  console.log(`[eq-tools] E2E mode: hidden windows, fresh userData → ${dir}`)
}
