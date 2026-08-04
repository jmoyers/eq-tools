// ============================================================================
// index.ts — the main process's COMPOSITION ROOT.
// ============================================================================
//
// Everything this file does is ORDERING. The pieces themselves live next door:
//
//   channel.ts     which `userData` dir this process gets (prod / dev / e2e) + the one-time
//                  state seed. FIRST import, always.
//   crashGuards.ts process-level uncaught-error capture. Second, so it covers every module
//                  body that follows.
//   pipeline.ts    the log-derived world: LogBus, module registry (+ REGISTRATION ORDER),
//                  combat engine, epoch detector, spell DB.
//   session.ts     the active character's lifetime: scan → live tail, heartbeat, inventory
//                  watch, EQ-dir changes.
//   windows.ts     every BrowserWindow (main + overlays) and the Electron-side trust boundary.
//   ipc/           the IPC surface, one module per domain.
//
// What remains here is the sequence those pieces must be assembled in, and the app lifecycle
// that drives it. Three orderings are load-bearing and are called out at their call sites:
// the first-import law, the epoch subscription being the LAST bus subscriber, and
// `registerSchemesAsPrivileged` running at module scope (before `ready`).

// FIRST import on purpose: channel.ts picks this process's `userData` dir (prod / dev /
// e2e — Task #58) and runs the one-time state seed, before electron-store is constructed
// (module-level) further down this import list.
import { CHANNEL, USER_DATA } from './channel'
// SECOND on purpose: installs the uncaughtException/unhandledRejection sinks before any
// module body below can throw. See crashGuards.ts.
import './crashGuards'
import { E2E } from './e2e'
import { app, BrowserWindow, protocol, session } from 'electron'
import { IPC } from '../shared/ipc'
import { errorLogPath, logError, logInfo } from './errorLog'
import { saveUserOverlay } from './data/overlayPersistence'
import { registerAppSchemes } from './appSchemes'
import { installImageCacheProtocol } from './imageCache'
import { installSpeechCacheProtocol } from './speech/cache'
import { registerIpc } from './ipc'
import { bus, buffsModule, epoch, sessionDetector } from './pipeline'
import { initPresenceEffects, stopPresenceEffects } from './presenceEffects'
import { provisionDefaultPacks } from './provisionPacks'
import { getActiveCharacter, startTailing, stopSession } from './session'
import { getOverlayConfig } from './store'
import { initUpdater } from './updater'
import {
  createMainWindow,
  createOverlayWindow,
  getMainWindow,
  hardenSession,
  hardenWebContents,
  sendToMain
} from './windows'
import { OVERLAY_KINDS } from '../shared/types'

// --- custom schemes: the permanent image cache (eqimg://) and the speech cache (eqspeech://) ---
// Scheme privileges MUST be declared before the app's `ready` event, so this runs at module
// scope; each handler itself is installed in whenReady below. Electron permits exactly ONE
// registerSchemesAsPrivileged call, which is why both schemes go through appSchemes.ts.
registerAppSchemes(protocol)

// Epoch detection subscription (Task #49; launch-anchored in Task #50). Runs LAST — after
// pipeline.ts's registry + combat subscriptions, which is why it is added here rather than
// there — so it observes each event after the modules/combat have folded it, then at the
// first at/after-launch event queues a derived `epoch` event via emitDerived; the bus
// delivers that to EVERY listener (registry modules + combat) after the primary event
// finishes — the modules reset their live folded state on it. Ignore the derived epoch event
// itself here (the detector already ignores it internally too) so no feedback loop is
// possible, matching the buffs→buffExpired contract.
bus.subscribe((ev, live) => {
  if (ev.kind === 'epoch') return
  const epochEv = epoch.observe(ev)
  if (epochEv) {
    logInfo(
      `[everquest-companion] Character epoch boundary detected at ${new Date(epochEv.ts).toISOString()} (official launch): resetting character-scoped modules. Everything before this belongs to a prior same-name character wiped at launch (see epochDetector.ts).`
    )
    bus.emitDerived(epochEv, live)
    // A LIVE wipe (rare — deleting + recreating your character while the app tails) shrinks
    // every module's state, but module deltas are append/merge-only (a shrink can't be
    // expressed as a delta), so the renderer would keep the stale pre-epoch rows. Re-send
    // onCharacter so every useModule view RE-HYDRATES from the (now post-epoch) snapshots —
    // the same full-rebuild path a character switch uses. Deferred to a microtask so the
    // derived epoch event finishes draining to the modules (they reset) BEFORE the renderer
    // re-fetches their snapshots. During a rescan (live:false) the post-scan onCharacter send
    // in tailCharacter already covers this, so we only do it live.
    if (live) queueMicrotask(() => sendToMain(IPC.onCharacter, getActiveCharacter()))
  }
})

// Offline-gap subscription (login/logout). Same position and same contract as the epoch
// subscription above and for the same reason: it must observe each event only after the
// modules and the combat engine have folded it, then hand its synthesized `offlineGap` back
// through emitDerived so the bus delivers it once the primary `sessionStart` has finished
// reaching everyone. Unlike the epoch, this fires repeatedly (15 times over the real log's
// 19 logins), so it does NOT force a renderer re-hydrate — modules fold a gap as an ordinary
// event and express the result through their normal deltas. The detector filters derived
// kinds itself; the guard here mirrors the epoch subscription so the no-feedback-loop
// contract is visible at the call site rather than only inside the class.
bus.subscribe((ev, live) => {
  if (ev.kind === 'offlineGap') return
  const gap = sessionDetector.observe(ev)
  if (gap) bus.emitDerived(gap, live)
})

// ---------------------------------------------------------------------------------------
// DEV-ONLY: the feedback-triage IPC surface (src/main/triage/**).
// ---------------------------------------------------------------------------------------
//
// This is the operator's window onto the feedback backlog — the same Aurora DSQL rows and S3
// slices `scripts/triage-feedback.mts` reads, over the same IAM door. It exists in the DEV app
// and nowhere else, and there are THREE independent reasons a shipped build cannot reach it:
//
//   1. THIS GATE. `app.isPackaged` is false only in a dev run; `E2E` excludes the headless
//      harness, which builds production-shaped and must stay off the network. The import is
//      DYNAMIC, so a packaged build never even evaluates the module.
//   2. THE DEPENDENCIES. That module reaches `pg` and `@aws-sdk/*` — devDependencies, which
//      electron-builder never packages. A build with this gate patched out still could not
//      resolve them. The property is structural, not a runtime check.
//   3. THE CREDENTIALS. Auth is an IAM token derived locally from the LAUNCHING SHELL's AWS
//      profile (AWS_PROFILE, default 'eqc'). There is no password to leak, and a shell without
//      the owner's credentials gets IAM denials on the first statement.
//
// Failure to load is logged and startup continues: a dev tool must never be able to take the
// app down. `closeDevTriage` is the teardown — a live DSQL socket would otherwise hold the
// process open, the same hang the CLI's `finally` exists for.
let closeDevTriage: (() => Promise<void>) | null = null

function registerDevTriageIpc(): void {
  if (app.isPackaged || E2E) return
  void import('./triage/ipc')
    .then(({ registerTriageIpc }) => {
      closeDevTriage = registerTriageIpc()
      logInfo('[everquest-companion] Dev triage IPC registered (dev build only, AWS profile auth).')
    })
    .catch((err: unknown) => logError('main:triage', err))
}

// Single-instance lock (Task #23): a second launch (e.g. re-running the installed
// app, or an auto-update restart) must not spin up a second window tailing the same
// log. If we don't get the lock, quit immediately; the primary instance receives a
// `second-instance` event and focuses/restores its existing window instead.
// The lock is PER CHANNEL, for free: Chromium keys it off the user-data dir, which
// channel.ts has already made distinct per channel — so the installed app and the dev
// app each hold their own lock and run side by side (Task #58).
// E2E: skip the lock entirely (never request it), so a headless test instance can run
// alongside the user's dev app instead of quitting — and can't steal its focus either.
const gotSingleInstanceLock = E2E || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    logInfo(
      `[everquest-companion] Channel '${CHANNEL}' — userData ${USER_DATA}, error log ${errorLogPath()}`
    )
    registerIpc()
    registerDevTriageIpc()
    // Trust boundary, installed BEFORE the first window exists: the catch-all fires for every
    // webContents this process will ever create (main window, each overlay, anything a future
    // feature adds), which is the only placement that can't be forgotten later.
    app.on('web-contents-created', (_e, wc) => hardenWebContents(wc))
    // Permissions are a SESSION property; every window here uses the default session (no
    // custom `partition` anywhere — the same fact that lets one eqimg:// handler serve them all).
    hardenSession(session.defaultSession)
    // Serve `eqimg://item/<id>` from <userData>/image-cache BEFORE any window loads a page
    // that can reference an item icon. One handler on the default session covers the main
    // window and every overlay (none of them use a custom partition).
    installImageCacheProtocol(protocol, {
      userData: USER_DATA,
      onError: (msg, err) => logError('main:imageCache', { message: msg, err })
    })
    // …and `eqspeech://<hash>` from <userData>/speech-cache, beside it and for the same
    // reason: one read-only handler on the default session serves every window. It NEVER
    // synthesizes and never touches the network — only `speech:say` can cause a synthesis
    // (see speech/cache.ts).
    installSpeechCacheProtocol(protocol, {
      userData: USER_DATA,
      onError: (msg, err) => logError('main:speechCache', { message: msg, err })
    })
    createMainWindow()
    void startTailing()
    // Self-provision the shipped voice packs (Task #39): a CI-built installer ships
    // WITHOUT the gitignored peon/sc_marine packs, so a fresh install's seeded
    // charm-break alert would reference a missing sound. Download any missing default
    // pack in the background (non-blocking, silent — errors go to errors.log and retry
    // next launch). On success, tell the renderer the pack set changed so it re-lists +
    // invalidates its sound caches and the sound becomes usable live.
    // E2E: skip (fresh temp userData ⇒ it would re-download every pack, off-network noise).
    if (!E2E) {
      void provisionDefaultPacks()
        .then((n) => {
          if (n > 0) sendToMain(IPC.onSoundPacksChanged)
        })
        .catch((err: unknown) => logError('main:provisionPacks', err))
    }
    // Auto-update (Task #27): checks GitHub Releases on the selected channel;
    // no-ops in dev. getMainWindow is lazy so status pushes hit the live window.
    initUpdater(getMainWindow)

    // Restore any floating overlay (Task #52; per-kind in Task #54) that was open when the app
    // last quit. Deferred so the main window's did-finish-load sends its initial state first.
    for (const kind of OVERLAY_KINDS) {
      if (getOverlayConfig(kind).open) createOverlayWindow(kind)
    }

    // Presence-driven features (overlay auto-hide + the cursor ring). LAST, because both act on
    // windows that must already exist. Costs one store read when both are off — which is the
    // default install: `presenceNeeded()` decides whether the watcher child is spawned at all.
    initPresenceEffects()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
}

app.on('window-all-closed', () => {
  stopSession()
  // Kill the presence watcher child + the cursor stream. Both already unref their timers, but a
  // child process is not a timer: nothing else would reap it.
  stopPresenceEffects()
  // Flush the learned message overlay one last time so the final session's observations
  // aren't lost between debounced saves (Task #36).
  saveUserOverlay(buffsModule.overlaySnapshot())
  // Dev only, and null in every other build: a live DSQL socket is not a timer and would hold
  // the process open long past the last window.
  if (closeDevTriage) void closeDevTriage().catch((err: unknown) => logError('main:triage', err))
  if (process.platform !== 'darwin') app.quit()
})
