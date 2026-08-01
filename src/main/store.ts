import Store from 'electron-store'
import type { HeldCounts, ProgressState } from '../shared/types'

const emptyProgress: ProgressState = {
  inventory: {},
  completedQuests: [],
  inventorySource: undefined
}

interface StoreShape {
  /** progress keyed by character id (name_server) */
  byCharacter: Record<string, ProgressState>
  /** last selected character's log path */
  activeLogPath?: string
}

const store = new Store<StoreShape>({
  name: 'eq-tools-progress',
  defaults: { byCharacter: {}, activeLogPath: undefined }
})

function allProgress(): Record<string, ProgressState> {
  return store.get('byCharacter', {})
}

export function getProgress(charId: string): ProgressState {
  return allProgress()[charId] ?? emptyProgress
}

function setProgress(charId: string, next: ProgressState): ProgressState {
  const all = allProgress()
  all[charId] = next
  store.set('byCharacter', all)
  return next
}

export function setInventory(
  charId: string,
  counts: HeldCounts,
  source: { path: string; loadedAt: string }
): ProgressState {
  return setProgress(charId, { ...getProgress(charId), inventory: counts, inventorySource: source })
}

export function setQuestComplete(charId: string, questKey: string, complete: boolean): ProgressState {
  const p = getProgress(charId)
  const set = new Set(p.completedQuests)
  if (complete) set.add(questKey)
  else set.delete(questKey)
  return setProgress(charId, { ...p, completedQuests: [...set] })
}

export function getActiveLogPath(): string | undefined {
  return store.get('activeLogPath')
}

export function setActiveLogPath(logPath: string): void {
  store.set('activeLogPath', logPath)
}
