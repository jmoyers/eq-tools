// --- JS error capture harness (Task #13) ---
//
// Install process-level guards as early as possible so a crash during startup is
// logged instead of silently killing the app. In DEV we deliberately do NOT exit
// on uncaught errors: keeping the process alive lets watch-mode recover and keeps
// the window (and its ErrorBoundary) visible instead of leaving a blank shell.
//
// This is a SIDE-EFFECT module, imported for its import (index.ts pulls it in right after
// channel.ts/e2e.ts and before anything that does real work). That placement is the whole
// point: module bodies further down the import graph — the spell-DB load, the store
// migrations — run BEFORE index.ts's own body, so a guard installed there would be installed
// too late to catch them.

import { logError } from './errorLog'

process.on('uncaughtException', (err) => {
  logError('main:uncaughtException', err)
})
process.on('unhandledRejection', (reason) => {
  logError('main:unhandledRejection', reason)
})
