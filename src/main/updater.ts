// updater.ts — TRANSPARENT auto-update via electron-updater
// (Task #27; UX rework #55; the invisible-update rework is Task #60).
//
// GOAL (user's words): "transparent upgrades where you can click a button to
// restart to automatically use the new version. silent background download and
// install, transparently cleanly … they don't put the installer in your face
// over and over." That is the Discord / VS Code / Claude Code model, and on
// Windows it is achievable ONLY because of the installer shape we already ship
// (per-user one-click NSIS). See the research block below for why.
//
// SHAPE OF THE FLOW
//   1. Check on a lazy cadence (shared/update.ts: ~45s after launch, then every
//      4h +/- 25% jitter, exponential backoff on failure). Never a modal.
//   2. On `update-available` we start the download OURSELVES (autoDownload is
//      off — see "why autoDownload is off" below) into electron-updater's cache.
//   3. On `update-downloaded` the build is STAGED, not installed. The left-nav
//      chip lights up gold; a single 8s toast fires once. Nothing else happens.
//   4. Either the user clicks the chip -> `update:install` -> quitAndInstall,
//      or they never do and `autoInstallOnAppQuit` applies it silently the next
//      time they close the app. Both paths are UI-less.
//
// DEV GUARD: electron-updater throws ("app-update.yml not found") when the app
// is not packaged. We skip the machinery in that case (`npm run dev` stays
// quiet) but still answer the read/no-op IPCs so the UI renders identically.
//
// ===========================================================================
// RESEARCH (Task #60) — verified against the INSTALLED electron-updater@6.8.9
// and app-builder-lib sources in node_modules, not against the docs site. The
// published docs describe a newer API (`quitAndInstall(…, waitUntilNextLaunch)`,
// `autoInstallEvent`) that DOES NOT EXIST in 6.8.9
// (electron-updater/out/BaseUpdater.d.ts:9 declares only
// `quitAndInstall(isSilent?, isForceRunAfter?)`). Re-verify on upgrade.
//
// --- 1. Does an installer window EVER appear for us? -----------------------
// YES — but only on one code path, and we do not take it.
//
// electron-updater/out/NsisUpdater.js:101-149 builds the installer argv:
//     args = ["--updated"]
//     if (isSilent)        args.push("/S")
//     if (isForceRunAfter) args.push("--force-run")
//
// app-builder-lib/templates/nsis/installSection.nsh:14-33, inside `!ifdef
// ONE_CLICK` (which our `oneClick: true` defines — NsisTarget.js:380):
//     ${IfNot} ${Silent}
//       SpiderBanner::Show /MODERN /ICON …
//       SendMessage $0 ${WM_SETTEXT} 0 "STR:$(installing)"
//     ${endif}
// `${Silent}` is NSIS's own built-in, set by `/S`. So:
//
//   quitAndInstall()          -> `--updated --force-run`   VISIBLE installer
//                                (isSilent=false makes isForceRunAfter default
//                                to autoRunAppAfterInstall — BaseUpdater.js:13-27)
//   quitAndInstall(true,true) -> `--updated /S --force-run`  NO UI, relaunches
//   autoInstallOnAppQuit      -> `--updated /S`              NO UI, no relaunch
//                                (BaseUpdater.js:69-90, `this.install(true,false)`)
//
// => MITIGATION, and it is the whole ballgame: NEVER call bare quitAndInstall().
//    We call quitAndInstall(true, true). Both of our paths are UI-less.
//
// `--updated` is the second suppressor. allowOnlyOneInstallerInstance.nsh:50-79:
// if the app is still running, the installer shows a MessageBox — UNLESS
// ${isUpdated}, in which case it sleeps 1s and taskkills quietly. The process
// probe uses nsExec (windowless), so no console flash either.
// NOTE: the relaunched app receives `--updated` in process.argv
// (common.nsh:123-132) — our argv handling must tolerate it (it does; we read
// env, not flags).
//
// --- 2. Elevation: none, and structurally so ------------------------------
// `perMachine: false` means NsisTarget.js:412-419 never defines
// INSTALL_MODE_PER_ALL_USERS, so installer.nsi:19-21 compiles
// `RequestExecutionLevel user` — no UAC manifest exists in the exe at all.
// Separately NsisTarget.js:290-292 only writes `isAdminRightsRequired` into
// latest.yml `if (isPerMachine && …)`, so the flag is absent, DownloadedUpdate-
// Helper.js:61 records false, and NsisUpdater.js:126-130's elevate.exe branch is
// never taken. The ONLY residual elevation path is the spawn-failure fallback
// (NsisUpdater.js:131-147: UNKNOWN/EACCES -> elevate.exe -> UAC). This is why
// AGENTS.md says never flip perMachine — it would turn every update into a UAC
// prompt AND make oneClick installs elevate.
//
// --- 3. Staged vs installed ----------------------------------------------
// "Downloaded" means an exe is sitting in
// %LOCALAPPDATA%\<updaterCacheDirName>\pending\ next to update-info.json
// (AppUpdater.js:545-554 + AppAdapter.js:11-12; DownloadedUpdateHelper.js:30-65).
// The install dir is untouched until that exe is spawned. The staged file
// survives app restarts — which is what makes "ignore the chip forever" safe.
//
// --- 4. Differential/blockmap downloads ----------------------------------
// On by default; reuses blocks from %LOCALAPPDATA%\<cache>\installer.exe against
// the previous release's .blockmap (AppUpdater.js:643-712). Every failure mode
// (missing old release, size mismatch, blockmap version mismatch) is caught at
// AppUpdater.js:704-711 -> "fallback to full download". So a broken differential
// costs bandwidth, never correctness. GitHub forces one sequential Range request
// per op (GitHubProvider.js:14-17, "because GitHib uses S3").
//
// --- 5. GitHub feed cost + rate limiting ----------------------------------
// GitHubProvider deliberately AVOIDS api.github.com ("do not use API for GitHub
// to avoid limit" — GitHubProvider.js:158-175). One check = 3 plain github.com
// GETs: releases.atom, (only when allowPrerelease=false) releases/latest, and
// releases/download/<tag>/latest.yml. So the documented 60/hr unauthenticated
// API limit does not apply; undocumented abuse-detection limits do, which is
// exactly what the jittered multi-hour cadence is for. Asset downloads 302 to
// objects.githubusercontent.com and are CDN-cacheable (util.js:18-28 skips the
// no-cache query for GitHub).
//
// --- 6. The trap that bit the old code -----------------------------------
// (a) SETTING autoUpdater.channel SILENTLY FORCES allowDowngrade = true
//     (AppUpdater.js:44). We set `channel` on every launch, so downgrades were
//     enabled the whole time — a re-published/rolled-back release could have
//     walked an install BACKWARDS. `applyChannel` now resets it to false.
// (b) `update-downloaded` IS RE-EMITTED on every check that resolves to an
//     already-staged file (DownloadedUpdateHelper.js:33-52 -> BaseUpdater.js:
//     31-35 always calls dispatchUpdateDownloaded + addQuitHandler). Any UI that
//     fires on that event re-fires on every poll — that is precisely the
//     "installer in your face over and over" the user complained about. Ours is
//     state-driven, the toast dedupes per version, and we stop checking once
//     ready.
// (c) Re-validating a staged file RE-HASHES the whole installer (sha512,
//     DownloadedUpdateHelper.js:88-131) on every check. Another reason to stop
//     polling once ready, and to poll in hours not minutes.
// (d) checkForUpdatesAndNotify() pops a native OS toast (AppUpdater.js:286-313).
//     Never use it.
// (e) disableWebInstaller defaults to false and logs a nag on EVERY download
//     (NsisUpdater.js:44-46). We ship an NSIS target, so set it true.
// (f) A failed download retry calls removeFileIfAny -> emptyDir(pending)
//     (AppUpdater.js:609-616) — it DESTROYS a previously staged update. One more
//     reason the retry count is bounded rather than infinite.
//
// --- 7. What the "invisible" apps actually do ----------------------------
// Squirrel.Windows (Discord's lineage) makes the same two bets we do: per-user
// install under %LocalAppData% so there is no UAC, and apply-on-next-launch so
// the user never watches an installer. VS Code's cadence
// (abstractUpdateService.ts) is a first check 30s after startup then hourly;
// Chrome/Omaha wakes hourly and compares against a configured minimum period.
// Ours is deliberately lazier than all of them — see shared/update.ts.
// Failure modes they all share, and how we cover them: partial download (sha512
// + temp-file rename, then our bounded retry), version skew (our isStaleVersion
// guard + we never persist a 'ready' state across restarts), update loops (the
// bounded attempt counter; electron-updater's own quitAndInstallCalled latch is
// per-process and gives no cross-restart protection), rate limiting (jittered
// backoff).

import { app, ipcMain, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC } from '../shared/ipc'
import type { UpdateChannel, UpdateStatus } from '../shared/types'
import { MAX_DOWNLOAD_ATTEMPTS, isStaleVersion, nextCheckDelayMs } from '../shared/update'
import { getUpdateChannel, getUpdateLastCheckedAt, setUpdateLastCheckedAt } from './store'

const { autoUpdater } = electronUpdater

let timer: ReturnType<typeof setTimeout> | null = null

/** The last status pushed — the single source of truth behind `update:getStatus`. */
let lastStatus: UpdateStatus = { state: 'idle' }
/** Epoch millis of the last COMPLETED check (available / not-available / error). */
let lastCheckedAt: number | undefined
/** Checks that ended in an error since the last successful one — drives the backoff. */
let consecutiveFailures = 0
/** Automatic download attempts per version — the anti-loop guard (see below). */
const downloadAttempts = new Map<string, number>()
/** The version we asked electron-updater to download, while it is in flight. */
let downloading: string | null = null
/**
 * Set when we start a check, cleared by `checkDone` (the verdict) — it both stops
 * two checks overlapping and tells the `catch` in `runCheck` whether the 'error'
 * event already accounted for this failure, so one failure counts exactly once.
 */
let checkInFlight = false

/** Map our channel choice onto electron-updater's channel + prerelease settings. */
function applyChannel(channel: UpdateChannel): void {
  if (channel === 'main') {
    autoUpdater.channel = 'main'
    autoUpdater.allowPrerelease = true
  } else {
    autoUpdater.channel = 'latest'
    autoUpdater.allowPrerelease = false
  }
  // MUST come AFTER the channel assignment: `set channel()` silently forces
  // allowDowngrade = true (electron-updater/out/AppUpdater.js:44). Since we set
  // the channel on every launch, downgrades were quietly enabled — a
  // re-published or rolled-back release could walk an install BACKWARDS, which
  // with apply-on-quit would be an invisible downgrade. Never that.
  autoUpdater.allowDowngrade = false
}

/**
 * Initialize the auto-updater. `getMainWindow` is called lazily on each status
 * push so we always target the current window (it can be recreated). The update
 * machinery is skipped (and logged) when the app isn't packaged; the IPC surface
 * stays registered so the renderer never has to special-case dev.
 */
export function initUpdater(getMainWindow: () => BrowserWindow | null): void {
  // PERSISTED "last checked" (Task #60): read before anything else so the very
  // first status the renderer pulls already carries a truthful age. An
  // in-memory-only stamp read "never" for the first minute of every launch —
  // and forever for a user who quits before the first check.
  lastCheckedAt = getUpdateLastCheckedAt()
  lastStatus = lastCheckedAt ? { state: 'idle', checkedAt: lastCheckedAt } : { state: 'idle' }

  // Registered in dev too: Preferences shows the version + a (benign) status there.
  ipcMain.handle(IPC.getAppVersion, () => app.getVersion())
  ipcMain.handle(IPC.getUpdateStatus, () => lastStatus)

  if (!app.isPackaged) {
    // Say so in the status itself: without the flag the chip renders "not checked yet"
    // forever (dev never checks), which reads as a broken updater rather than an absent one.
    // No checkedAt — a stamp inherited from the store would claim a check this process
    // never made.
    lastStatus = { state: 'idle', disabled: true }
    ipcMain.handle(IPC.installUpdate, () => {})
    ipcMain.handle(IPC.checkForUpdates, () => lastStatus)
    console.log('[everquest-companion] Auto-update disabled (dev / not packaged).')
    return
  }

  const currentVersion = app.getVersion()

  /** Record + broadcast a status. `checkedAt` rides along on every push once known. */
  const push = (status: UpdateStatus): void => {
    lastStatus = lastCheckedAt ? { ...status, checkedAt: lastCheckedAt } : status
    const win = getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.onUpdateStatus, lastStatus)
  }

  /** A check finished (whatever the verdict) — stamp + PERSIST the time, then push. */
  const checkDone = (status: UpdateStatus): void => {
    lastCheckedAt = Date.now()
    checkInFlight = false
    try {
      setUpdateLastCheckedAt(lastCheckedAt)
    } catch {
      // A store write must never break the update flow; the in-memory stamp stands.
    }
    push(status)
  }

  // --- electron-updater configuration -------------------------------------
  //
  // WHY autoDownload IS OFF (it was on before Task #60): with autoDownload the
  // download starts inside checkForUpdates(), BEFORE our `update-available`
  // handler can veto it. We need that veto for two cases:
  //   (a) the anti-loop guard — a version whose download has already failed
  //       MAX_DOWNLOAD_ATTEMPTS times must stop being re-pulled every cycle;
  //   (b) the updated-away guard — never pull a build we already run.
  // Behaviour is otherwise identical: we call downloadUpdate() immediately, so
  // downloads are still fully automatic and silent.
  autoUpdater.autoDownload = false
  // THE load-bearing flag for "transparent": a staged update is applied when the
  // app quits, with no window, no prompt and no UAC (it spawns `--updated /S`).
  // Ignoring the chip forever still gets you updated.
  //
  // Caveat that shapes the flow below: the quit handler is registered from
  // executeDownload's `done` callback (BaseUpdater.js:28-37, :69-90), so it only
  // exists once a download RESOLVES IN THIS PROCESS. A build staged during a
  // previous session therefore needs this session's first check to re-resolve it
  // (which costs no network — it validates the cached file) before apply-on-quit
  // is armed. That is why we never persist a 'ready' state across restarts: the
  // startup check must be allowed to run and re-arm it. Also why a non-zero exit
  // code skips the install — a crash never installs anything.
  autoUpdater.autoInstallOnAppQuit = true
  // We ship an NSIS target, never the web installer. Left at its default (false)
  // electron-updater logs a deprecation nag on EVERY download
  // (NsisUpdater.js:44-46).
  autoUpdater.disableWebInstaller = true
  applyChannel(getUpdateChannel())

  autoUpdater.on('checking-for-update', () => push({ state: 'checking' }))

  autoUpdater.on('update-available', (info) => {
    const version: string | undefined = info?.version
    consecutiveFailures = 0 // the CHECK succeeded, whatever happens to the download
    // UPDATED-AWAY: the feed names a build we already are. Nothing to offer.
    if (isStaleVersion(version, currentVersion)) {
      checkDone({ state: 'idle' })
      return
    }
    checkDone({ state: 'available', version })

    const key = version ?? 'unknown'
    const attempts = downloadAttempts.get(key) ?? 0
    if (attempts >= MAX_DOWNLOAD_ATTEMPTS) {
      // ANTI-LOOP: a corrupt asset / a proxy that truncates would otherwise make
      // us re-download the same file every cycle forever. Stop pulling it
      // automatically and say so quietly (the chip renders errors as the muted
      // resting line; the text lives in Preferences). A MANUAL check resets this.
      push({
        state: 'error',
        version,
        message: `Download of v${key} failed ${attempts} times — paused. Use "Check for updates" to retry.`
      })
      return
    }
    downloadAttempts.set(key, attempts + 1)
    downloading = key
    // Rejections also surface as an 'error' event, which does the accounting —
    // swallow here so nothing becomes an unhandled rejection.
    void autoUpdater.downloadUpdate().catch(() => undefined)
  })

  autoUpdater.on('update-not-available', () => {
    consecutiveFailures = 0
    downloading = null
    checkDone({ state: 'idle' })
  })

  autoUpdater.on('download-progress', (p) =>
    // Carry the known version forward so the progress row can name the build.
    push({
      state: 'downloading',
      percent: Math.round(p?.percent ?? 0),
      version: downloading ?? lastStatus.version
    })
  )

  autoUpdater.on('update-downloaded', (info) => {
    const version: string | undefined = info?.version
    downloading = null
    if (version) downloadAttempts.delete(version)
    // Belt and braces: a staged build that isn't newer than us is not an offer.
    if (isStaleVersion(version, currentVersion)) {
      push({ state: 'idle' })
      return
    }
    // TERMINAL state. We stop checking from here (see `runCheck`): the download
    // is staged, apply-on-quit will use it, a further check would re-hash the
    // whole installer for nothing, and this very event would be RE-EMITTED
    // (research §6b) — which is how "restart to update" prompts turn into a nag
    // in other apps. Pushing an idempotent state instead of firing an event is
    // what makes re-emission harmless here.
    push({ state: 'ready', version })
  })

  autoUpdater.on('error', (err) => {
    // Every failure mode lands here: no network (ENOTFOUND/ETIMEDOUT), GitHub
    // 403 rate-limit or 5xx, a truncated/corrupt download, a checksum mismatch.
    // NONE of them are shown loudly — the chip keeps rendering "checked …" and
    // only Preferences carries the text. The backoff below stops us from
    // hammering a feed that is refusing us.
    consecutiveFailures++
    downloading = null
    checkDone({ state: 'error', message: err == null ? 'unknown error' : String(err.message ?? err) })
  })

  // renderer -> main: apply the downloaded update NOW.
  //
  // quitAndInstall(isSilent=TRUE, isForceRunAfter=TRUE) is NOT optional styling:
  // `/S` is the only thing standing between the user and a visible NSIS
  // SpiderBanner + INSTFILES window (research §1), and `--force-run` is what
  // relaunches us into the new build. Bare quitAndInstall() shows the installer.
  // The single-instance lock in index.ts makes the relaunch focus cleanly.
  //
  // Guarded on 'ready' because BaseUpdater latches `quitAndInstallCalled` on the
  // first call and ignores every later one — we get exactly one shot, so we do
  // not spend it on a stale click.
  ipcMain.handle(IPC.installUpdate, () => {
    if (lastStatus.state !== 'ready') return
    autoUpdater.quitAndInstall(true, true)
  })

  /**
   * Run one check. `manual` = the user pressed the button in Preferences: it
   * bypasses the "already ready" short-circuit's silence by returning the ready
   * status, and it RESETS the failure/attempt counters so an explicit retry
   * genuinely retries.
   */
  const runCheck = async (manual: boolean): Promise<UpdateStatus> => {
    if (manual) {
      consecutiveFailures = 0
      downloadAttempts.clear()
    }
    // A staged update is terminal — re-checking cannot improve on it, and the
    // cached download emits no fresh 'update-downloaded', so a check would only
    // reset the chip to "checking" and then to idle. Leave it be.
    if (lastStatus.state === 'ready') return lastStatus
    if (checkInFlight) return lastStatus
    checkInFlight = true
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      // checkForUpdates rejects AND emits 'error'. `checkDone` clears the flag,
      // so a still-set flag here means the event handler did NOT run and this
      // failure is uncounted — that way one failure counts exactly once.
      if (checkInFlight) {
        consecutiveFailures++
        checkDone({ state: 'error', message: String((err as Error)?.message ?? err) })
      }
    }
    checkInFlight = false
    return lastStatus
  }

  /** Self-rescheduling poll loop — a setInterval can't carry jitter or backoff. */
  const schedule = (phase: 'startup' | 'periodic'): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void runCheck(false).finally(() => schedule('periodic'))
    }, nextCheckDelayMs({ phase, consecutiveFailures }))
  }

  // renderer -> main: explicit "Check for updates".
  ipcMain.handle(IPC.checkForUpdates, async (): Promise<UpdateStatus> => {
    const res = await runCheck(true)
    // Re-anchor the background cadence off the manual check so we don't poll
    // again three seconds later.
    schedule('periodic')
    return res
  })

  schedule('startup')
  app.on('will-quit', () => {
    if (timer) clearTimeout(timer)
    timer = null
  })
}
