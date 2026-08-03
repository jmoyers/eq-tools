// useAlertsStore — the alerts view's data layer: defs, prefs and installed sound
// packs over IPC, plus the live recent-fires history from the alerts module.
// Extracted from AlertsView.tsx (Wave D factoring); every call and its ordering
// is unchanged.
//
// Recent fires come from the alerts module's per-alert ring buffer (the single
// source of truth), hydrated + kept live via useModule: event/raw fires arrive as
// module deltas, and renderer 'app' fires are routed back through main (appFired)
// so they land in the same history.
//
// Everything else is persisted via IPC (alerts:save / alerts:reset /
// alertPrefs:set); after any write we call refreshAlertStore() so the always-
// mounted AlertPlayer picks up the change immediately (it shares def/pref state).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AlertDef,
  AlertFireRecord,
  AlertPrefs,
  AlertsDelta,
  AlertsSnap,
  SoundPack
} from '@shared/types'
import { useModule } from '../../lib/useModule'
import { onAlertStoreChange, refreshAlertStore } from './player'
import { invalidateSoundCaches } from './soundCache'

function applyAlertsDelta(state: AlertsSnap, delta: AlertsDelta): AlertsSnap {
  if (!delta.fired?.length) return state
  const history = { ...state.history }
  for (const f of delta.fired) {
    const arr = (history[f.alertId] ?? []).concat({ ts: f.ts, matchedText: f.matchedText })
    // Mirror the module's HISTORY_CAP of 20 so the renderer copy stays bounded.
    history[f.alertId] = arr.length > 20 ? arr.slice(arr.length - 20) : arr
  }
  return { ...state, history }
}

export interface AlertsStore {
  alerts: AlertDef[]
  prefs: AlertPrefs
  sortedPacks: SoundPack[]
  history: Record<string, AlertFireRecord[]>
  /** Re-read defs + prefs + packs from main. */
  reload: () => Promise<void>
  /** Re-list packs after a registry install/uninstall. */
  refreshPacks: () => Promise<void>
  persistAlerts: (def: AlertDef) => Promise<void>
  removeAlert: (id: string) => Promise<void>
  resetAlerts: () => Promise<void>
  persistPrefs: (next: AlertPrefs) => Promise<void>
  /** Local-only prefs update (volume slider drag; committed separately). */
  setPrefs: (next: AlertPrefs) => void
  /** Local-only per-alert volume update while its slider is dragged. */
  setAlertVolume: (id: string, volume: number) => void
}

export function useAlertsStore(): AlertsStore {
  const [alerts, setAlerts] = useState<AlertDef[]>([])
  const [prefs, setPrefs] = useState<AlertPrefs>({ globalVolume: 0.7, muted: false })
  const [packs, setPacks] = useState<SoundPack[]>([])

  // Live recent-fires history from the alerts module (single source of truth).
  const snap = useModule<AlertsSnap, AlertsDelta>('alerts', applyAlertsDelta)
  const history = snap?.history ?? {}

  const reload = useCallback(async () => {
    const [a, p, ps] = await Promise.all([
      window.eq.listAlerts(),
      window.eq.getAlertPrefs(),
      window.eq.listSoundPacks()
    ])
    setAlerts(a)
    setPrefs(p)
    setPacks(ps)
  }, [])

  useEffect(() => {
    void reload()
    // Keep in sync if the player refreshes the shared store (e.g. on focus).
    const off = onAlertStoreChange(() => void reload())
    // A shipped default pack may finish auto-provisioning after startup — re-list packs
    // and drop any stale sound caches so it's immediately selectable/playable (Task #39).
    const offPacks = window.eq.onSoundPacksChanged(() => {
      invalidateSoundCaches()
      void reload()
    })
    return () => {
      off()
      offPacks()
    }
  }, [reload])

  // After a registry install/uninstall, re-list packs so the inline pickers +
  // add/edit dialog surface the change immediately, and refresh the always-mounted
  // player's shared store (it caches nothing pack-related, but keeps everything in
  // sync on the same tick).
  const refreshPacks = useCallback(async () => {
    const ps = await window.eq.listSoundPacks()
    setPacks(ps)
    await refreshAlertStore()
  }, [])

  const persistAlerts = useCallback(async (def: AlertDef) => {
    const list = await window.eq.saveAlert(def)
    setAlerts(list)
    await refreshAlertStore()
  }, [])

  const removeAlert = useCallback(async (id: string) => {
    const list = await window.eq.deleteAlert(id)
    setAlerts(list)
    await refreshAlertStore()
  }, [])

  const resetAlerts = useCallback(async () => {
    const list = await window.eq.resetAlerts()
    setAlerts(list)
    await refreshAlertStore()
  }, [])

  const persistPrefs = useCallback(async (next: AlertPrefs) => {
    setPrefs(next)
    await window.eq.setAlertPrefs(next)
    await refreshAlertStore()
  }, [])

  const setAlertVolume = useCallback((id: string, volume: number) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, volume } : a)))
  }, [])

  const sortedPacks = useMemo(
    () => [...packs].sort((a, b) => (a.source === b.source ? 0 : a.source === 'bundled' ? -1 : 1)),
    [packs]
  )

  return {
    alerts,
    prefs,
    sortedPacks,
    history,
    reload,
    refreshPacks,
    persistAlerts,
    removeAlert,
    resetAlerts,
    persistPrefs,
    setPrefs,
    setAlertVolume
  }
}
