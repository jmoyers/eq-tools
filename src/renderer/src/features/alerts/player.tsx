// AlertPlayer — an always-mounted (App-level) component that turns fired alerts
// into sound, and the `fireAppSignal` entry point for renderer-side app triggers.
//
// Two firing paths converge here:
//   1. module:delta 'alerts' — the main-side AlertsModule fired an event/raw
//      trigger on a LIVE log event. We look up the def, respect mute, and play at
//      globalVolume × alert.volume. (Cooldown/enabled were already enforced in the
//      module; we don't re-check here.)
//   2. fireAppSignal('bossDefeat') — a renderer-only signal (main can't evaluate
//      it because it depends on derived boss state). App calls this exactly where
//      boss confetti fires. We match it against every enabled 'app' alert with the
//      matching signal, applying the SAME cooldown the module would.
//
// The player keeps a live copy of defs + prefs (hydrated on mount, refreshed on
// window focus and after any save via the shared store below) so both paths have
// what they need without prop-drilling.

import { useEffect } from 'react'
import type { AlertDef, AlertPrefs, AlertsDelta, AppSignal, ModuleDelta } from '@shared/types'
import { playSound } from './soundCache'

// ---- shared, module-level alert state (so fireAppSignal works outside React) ----

let defs: AlertDef[] = []
let prefs: AlertPrefs = { globalVolume: 0.7, muted: false }
const appCooldown = new Map<string, number>()
const DEFAULT_COOLDOWN_MS = 2000

const subscribers = new Set<() => void>()
/** Subscribe to defs/prefs changes (AlertsView re-reads after it saves). */
export function onAlertStoreChange(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
function notify(): void {
  for (const cb of subscribers) cb()
}

/** Re-fetch defs + prefs from main into the shared player state. */
export async function refreshAlertStore(): Promise<void> {
  const [d, p] = await Promise.all([window.eq.listAlerts(), window.eq.getAlertPrefs()])
  defs = d
  prefs = p
  notify()
}

export function currentPrefs(): AlertPrefs {
  return prefs
}
export function currentDefs(): AlertDef[] {
  return defs
}

/** Effective volume for an alert: globalVolume × (alert.volume ?? 1), clamped. */
function effectiveVolume(def: AlertDef): number {
  const v = (def.volume ?? 1) * prefs.globalVolume
  return Math.max(0, Math.min(1, v))
}

/** Play a def's sound now (skips if muted). Used by both firing paths + test. */
export function playAlertNow(def: AlertDef): void {
  if (prefs.muted) return
  void playSound(def.sound.packId, def.sound.soundId, effectiveVolume(def))
}

/**
 * Fire a renderer-side app signal (e.g. 'bossDefeat'). Plays every enabled 'app'
 * alert whose trigger.signal matches, honoring each alert's cooldown so a
 * double-invocation in the same tick can't double-play. `context` (e.g. the boss
 * name) is reported to main via appFired so the module's recent-fires history —
 * the single source of truth — records the signal with meaningful matched text.
 */
export function fireAppSignal(signal: AppSignal, context = ''): void {
  const now = Date.now()
  for (const def of defs) {
    if (!def.enabled) continue
    if (def.trigger.type !== 'app' || def.trigger.signal !== signal) continue
    const cd = def.cooldownMs ?? DEFAULT_COOLDOWN_MS
    const last = appCooldown.get(def.id)
    if (last !== undefined && now - last < cd) continue
    appCooldown.set(def.id, now)
    playAlertNow(def)
    // Route the fire through main so history stays the single source of truth.
    window.eq.appFired(def.id, context)
  }
}

/** The mounted component: hydrates the store + plays main-fired alert deltas. */
export default function AlertPlayer(): null {
  useEffect(() => {
    void refreshAlertStore()
    // Refresh on focus so prefs edited elsewhere (or seeded on first run) apply.
    const onFocus = (): void => void refreshAlertStore()
    window.addEventListener('focus', onFocus)

    const offDelta = window.eq.onModuleDelta<AlertsDelta>((d: ModuleDelta<AlertsDelta>) => {
      if (d.moduleId !== 'alerts') return
      for (const fire of d.delta.fired) {
        const def = defs.find((a) => a.id === fire.alertId)
        if (def) playAlertNow(def)
      }
    })
    return () => {
      window.removeEventListener('focus', onFocus)
      offDelta()
    }
  }, [])

  return null
}
