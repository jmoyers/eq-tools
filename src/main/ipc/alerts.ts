// IPC: the alerts extension (Task #18) and the event-log feed (Task #59) it writes into.
// They share a domain because an alert fire IS a feed row — the registry host folds one into
// the other, and both of the renderer-originated reports below end with the same flushNow.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { alertsModule, eventFeedModule, registry } from '../pipeline'
import {
  deleteAlert,
  getAlertPrefs,
  getAlerts,
  resetAlerts,
  saveAlert,
  setAlertPrefs
} from '../store'
import type { AlertDef, AlertPrefs, FeedReport } from '../../shared/types'

export function registerAlertsIpc(): void {
  ipcMain.handle(IPC.listAlerts, () => getAlerts())
  ipcMain.handle(IPC.saveAlert, (_e, def: AlertDef) => {
    const list = saveAlert(def)
    alertsModule.setDefs(list) // keep the live evaluator in sync
    return list
  })
  ipcMain.handle(IPC.deleteAlert, (_e, id: string) => {
    const list = deleteAlert(id)
    alertsModule.setDefs(list)
    return list
  })
  // test = return the def so the renderer plays its sound directly (no live fire).
  ipcMain.handle(IPC.testAlert, (_e, id: string) => getAlerts().find((a) => a.id === id) ?? null)
  // reset all alerts to the seeded built-in set (Task #22).
  ipcMain.handle(IPC.resetAlerts, () => {
    const list = resetAlerts()
    alertsModule.setDefs(list)
    return list
  })
  // renderer reports an 'app'-triggered fire (bossDefeat) so the module's recent-
  // fires history stays the single source of truth. We record it and flush so the
  // fire rides the same module:delta transport event/raw fires use (Task #22).
  ipcMain.on(IPC.appFired, (_e, payload: { alertId: string; context: string }) => {
    if (!payload?.alertId) return
    alertsModule.appFired(payload.alertId, payload.context ?? '')
    // The alerts delta this flush emits is folded into the event feed by feedAlertDelta (the
    // registry host), so an app-signal fire (bossDefeat / questComplete) shows up in the
    // event log exactly like a main-side event/raw fire. eventFeed is registered after
    // alerts, so the resulting feed row rides out on this same flush.
    registry.flushNow()
  })
  // ---- event feed (Task #59): renderer-detected events ----
  // Only the renderer's posky/turn-in machinery can see a Sky quest complete, so it reports
  // completions here. Main owns the ring + ids; flushNow pushes the row straight out to the
  // 'events' overlay instead of waiting on the next log event / 1s tick.
  ipcMain.on(IPC.feedReport, (_e, report: FeedReport) => {
    if (!report?.title) return
    eventFeedModule.report(report)
    registry.flushNow()
  })

  ipcMain.handle(IPC.getAlertPrefs, () => getAlertPrefs())
  ipcMain.handle(IPC.setAlertPrefs, (_e, prefs: AlertPrefs) => setAlertPrefs(prefs))
}
