import { app } from 'electron'
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { E2E } from './e2e'
// Console-only sinks. `logError` is deliberately NOT used in this module (it writes into the
// userData dir this module is still deciding); these three just forward to `console.*`
// verbatim, resolve nothing, and have no module-scope side effects — so importing them here
// cannot disturb the first-import law that puts channel.ts ahead of electron-store.
import { logConsoleError, logInfo } from './errorLog'

/**
 * CHANNEL ISOLATION (Task #58) — the FIRST module index.ts imports.
 *
 * Three builds of this app can be alive on one machine at the same time: the installed
 * release, the `npm run dev` watcher, and a headless `npm run test:e2e` run. They used to
 * share ONE `userData` dir (`%APPDATA%\eq-tools`), which meant they shared the store, the
 * learned message overlay, errors.log, the soundpacks dir — and, because Electron's
 * single-instance lock lives IN `userData`, they also fought over the lock: launching the
 * installed app while the dev app ran just focused the dev window.
 *
 * So `userData` is chosen here, per channel, BEFORE anything else runs (electron-store is
 * constructed at module scope, and `errorLogPath()`/soundpacks/caches all resolve through
 * `app.getPath('userData')` — nothing in the codebase hardcodes a path, so redirecting the
 * root redirects every consumer):
 *
 *   prod (app.isPackaged)  → %APPDATA%\everquest-companion
 *   dev  (!isPackaged)     → %APPDATA%\everquest-companion-dev
 *   e2e  (EQ_E2E=1)        → a throwaway temp dir (wiped per run by the harness)
 *
 * Distinct dirs ⇒ distinct single-instance locks (Chromium's ProcessSingleton keys its
 * lockfile + message window off the user-data dir), so dev and the installed app now run
 * side by side. Verified empirically: two Electron processes with different `userData`
 * both win `requestSingleInstanceLock()`; with the same dir the second one loses.
 *
 * ONE-TIME SEED (both non-e2e channels): the pre-rename dir `%APPDATA%\eq-tools` holds the
 * user's real state. The first launch on a channel whose dir does not exist yet COPIES an
 * allowlist of state out of it (never a move — the old dir is left untouched as a backup).
 * The allowlist is deliberate: Chromium's Cache/GPUCache/Local Storage/lockfile are
 * regenerable noise and a stale lockfile is actively harmful.
 */

export type AppChannel = 'prod' | 'dev' | 'e2e'

/** userData dir names, relative to `app.getPath('appData')` (%APPDATA% on Windows). */
const PROD_DIR_NAME = 'everquest-companion'
const DEV_DIR_NAME = 'everquest-companion-dev'
/** Pre-rename shared dir (product was "eq-tools"); source of the one-time seed. */
const LEGACY_DIR_NAME = 'eq-tools'

/** electron-store file base name → `<userData>/everquest-companion-progress.json`. */
export const STORE_NAME = 'everquest-companion-progress'
const LEGACY_STORE_FILE = 'eq-tools-progress.json'

/**
 * State worth carrying across a rename, in copy order. Everything else in a userData dir
 * (Cache, GPUCache, Code Cache, Local/Session Storage, Preferences, lockfile, errors.log)
 * is regenerated on first launch and is intentionally NOT copied.
 */
const SEED_ENTRIES = [
  LEGACY_STORE_FILE, // → `${STORE_NAME}.json` (renamed with the product)
  'message-overlay.json', // learned cast-message overlay (expensive to relearn)
  'item-knowledge-cache.json', // wiki item cache (incl. negative caching)
  'registry-cache.json', // sound-pack registry index
  'soundpacks' // installed packs, incl. the provisioned alan-rickman default
]

/** Marker written into a seeded dir: what came from where, and when. */
const SEED_STAMP = 'migrated-from.json'

export const CHANNEL: AppChannel = E2E ? 'e2e' : app.isPackaged ? 'prod' : 'dev'

/**
 * Copy the allowlisted state from `legacy` into `target`, exactly once (guard: `target`
 * must not exist yet — we create it here, and Electron would otherwise create it at ready).
 * Best-effort: a failure logs and startup continues with an empty dir rather than dying.
 * Returns the entries actually copied (empty ⇒ nothing to do).
 */
function seedFromLegacy(target: string, legacy: string): string[] {
  if (legacy === target || !existsSync(legacy) || existsSync(target)) return []
  const copied: string[] = []
  try {
    mkdirSync(target, { recursive: true })
    for (const entry of SEED_ENTRIES) {
      const src = join(legacy, entry)
      if (!existsSync(src)) continue
      const destName = entry === LEGACY_STORE_FILE ? `${STORE_NAME}.json` : entry
      cpSync(src, join(target, destName), { recursive: true })
      copied.push(destName)
    }
    writeFileSync(
      join(target, SEED_STAMP),
      JSON.stringify({ from: legacy, at: new Date().toISOString(), copied }, null, 2)
    )
  } catch (err) {
    // errorLog.ts's FILE sink can't be used here (it resolves userData, which we're still
    // deciding) — only its console passthrough.
    logConsoleError(`[everquest-companion] userData seed from ${legacy} failed:`, err)
  }
  return copied
}

/** Resolve this channel's userData dir, seeding it from the legacy dir on first launch. */
function resolveUserData(): string {
  if (E2E) {
    // The harness passes EQ_E2E_USER_DATA (a fixed path it wipes per run, so runs don't
    // litter temp); a bare `EQ_E2E=1` launch gets its own throwaway dir. No seeding ever —
    // a test run must start from nothing and can never read the user's real state.
    const given = process.env.EQ_E2E_USER_DATA
    if (given) {
      mkdirSync(given, { recursive: true })
      return given
    }
    return mkdtempSync(join(tmpdir(), 'everquest-companion-e2e-'))
  }
  const base = app.getPath('appData')
  const target = join(base, CHANNEL === 'prod' ? PROD_DIR_NAME : DEV_DIR_NAME)
  const copied = seedFromLegacy(target, join(base, LEGACY_DIR_NAME))
  if (copied.length > 0) {
    logInfo(
      `[everquest-companion] First launch on the '${CHANNEL}' channel: copied ${copied.length} state entries from ${LEGACY_DIR_NAME}\\ → ${target} (${copied.join(', ')}). The old dir is left untouched as a backup.`
    )
  }
  return target
}

/** This process's userData dir. Set before electron-store (or anything else) reads it. */
export const USER_DATA = resolveUserData()

app.setPath('userData', USER_DATA)
logInfo(`[everquest-companion] channel=${CHANNEL} userData=${USER_DATA}`)
