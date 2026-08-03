// IPC: read-only pulls off the log-derived world — the generic module transport and the
// combat engine's snapshot/search surface.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { SnapshotOpts } from '../../shared/combat'
import { combat, registry } from '../pipeline'

export function registerWorldIpc(): void {
  // Generic module transport: one handler serves every registered module.
  ipcMain.handle(IPC.getModuleSnapshot, (_e, moduleId: string) => registry.snapshot(moduleId))
  ipcMain.handle(IPC.getCombatSnapshot, (_e, opts: SnapshotOpts | undefined) =>
    combat.snapshot(Date.now(), opts ?? {})
  )
  // Fight-history search (Task #61). Read-only over the engine; `limit` is clamped here so a
  // renderer bug can't ask for an unbounded payload over IPC.
  ipcMain.handle(IPC.searchFights, (_e, text: unknown, limit: unknown) =>
    combat.searchFights(
      typeof text === 'string' ? text : '',
      typeof limit === 'number' && Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 500) : undefined
    )
  )
}
