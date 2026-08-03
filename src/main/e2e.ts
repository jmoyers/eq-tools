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
 * The fourth behavior — `userData` pointed at a fresh temp dir before electron-store is
 * constructed, so a run can never read or clobber the user's real store / errors.log —
 * now lives in `channel.ts`, which owns that decision for all three channels (prod / dev
 * / e2e). This module is a pure flag: zero side effects, zero footprint when the env var
 * is absent, and safe to import from anywhere.
 */
export const E2E = process.env['EQ_E2E'] === '1'
