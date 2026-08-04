// preload/perf.ts — the performance-HUD half of the app bridge (docs/plans/perf-profiling.md).
//
// Spread into `api` in index.ts rather than written there, because that file is at the repo's
// 400-code-line factoring ceiling and the answer to that is a split, not a widened threshold.
// It is the same one-module-per-domain shape main's `ipc/` uses, and it changes nothing about
// the surface: `window.eq.getPerfPrefs()` and friends sit exactly where they always would.
//
// NOTHING HERE COSTS ANYTHING WHILE THE HUD IS OFF. Main creates no timer until the switch is
// on, so `onPerfSample` subscribes to a channel that is genuinely silent — which is why the
// title-bar chip may subscribe unconditionally.

import { ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { PerfHudPrefs, PerfSample, StartupProfile } from '../shared/perf'

export const perfBridge = {
  /**
   * Subscribe to the live sample push (one every 2 s while the HUD is on). The payload is
   * `null` EXACTLY ONCE when the HUD is switched off — the chip hides on it rather than freezing
   * on the last numbers it received, which is what "hidden entirely when disabled" means.
   */
  onPerfSample: (cb: (sample: PerfSample | null) => void): (() => void) => {
    const listener = (_e: unknown, sample: PerfSample | null): void => cb(sample)
    ipcRenderer.on(IPC.onPerfSample, listener)
    return () => ipcRenderer.removeListener(IPC.onPerfSample, listener)
  },
  /** The persisted HUD switch. Off by default. */
  getPerfPrefs: (): Promise<PerfHudPrefs> => ipcRenderer.invoke(IPC.perfPrefsGet),
  /** Flip the HUD switch; the sampler starts/stops in the same call, so the first sample lands
   *  immediately rather than at the next tick. Resolves to what was actually stored. */
  setPerfHudEnabled: (enabled: boolean): Promise<PerfHudPrefs> =>
    ipcRenderer.invoke(IPC.perfSetEnabled, enabled),
  /** The startup profile for the launch you are in (also written to disk for the next one). */
  getStartupProfile: (): Promise<StartupProfile> => ipcRenderer.invoke(IPC.perfGetStartup),
  /** Report the `rendererHydrated` startup phase — the one mark only the renderer can make.
   *  Fire-and-forget: a startup measurement must never be something the UI waits on, and a
   *  duplicate is refused by main's phase accounting rather than by a flag kept here. */
  reportRendererHydrated: (): void => {
    try {
      ipcRenderer.send(IPC.perfRendererHydrated)
    } catch {
      // A missing startup mark is a missing measurement, never a broken window.
    }
  }
}
