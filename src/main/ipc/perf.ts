// IPC: the performance HUD + the startup profile (docs/plans/perf-profiling.md).
//
// Four channels, and the interesting one is the SETTER: flipping the pref is only half the job —
// this session's timers have to come into line with it too. One handler doing both is what makes
// "off means no timer exists" true right now rather than after the next launch, and it is the
// same discipline `applyTelemetryEnabled` uses for the analytics switch.
//
// THE COMPOSITION SEAM. `src/main/perf.ts` deliberately does not import the store: the sampler
// is a mechanism, the pref is a policy, and keeping the dependency one-way means the store can
// stay reachable from module scope without a cycle. So the DECISION lives here (and, at launch,
// in the composition root) — both of which already import both halves.
//
// VALIDATED AT THE HANDLER, never trusted because today's only caller is the app's own UI (the
// `sounds:getData` rule). A non-boolean is not a guess: it leaves the pref exactly as it was.
// `perf:rendererHydrated` carries no payload at all, so there is nothing to validate — it is a
// SEND (fire-and-forget), because a startup mark must never be something the renderer waits on.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { markStartupPhase, startPerfSampler, startupProfile, stopPerfSampler } from '../perf'
import { getPerfHudPrefs, setPerfHudPrefs } from '../store'
import type { PerfHudPrefs } from '../../shared/perf'

/** Persist the switch AND bring this session's sampler into line with it. */
export function applyPerfHudEnabled(enabled: boolean): PerfHudPrefs {
  const next = setPerfHudPrefs({ enabled })
  if (next.enabled) startPerfSampler()
  else stopPerfSampler()
  return next
}

export function registerPerfIpc(): void {
  ipcMain.handle(IPC.perfPrefsGet, () => getPerfHudPrefs())

  ipcMain.handle(IPC.perfSetEnabled, (_e, enabled: unknown) =>
    typeof enabled === 'boolean' ? applyPerfHudEnabled(enabled) : getPerfHudPrefs()
  )

  ipcMain.handle(IPC.perfGetStartup, () => startupProfile())

  // The one phase main cannot observe: the renderer is the only thing that knows it has mounted.
  ipcMain.on(IPC.perfRendererHydrated, () => {
    markStartupPhase('rendererHydrated')
  })
}
