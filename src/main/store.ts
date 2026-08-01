import Store from 'electron-store'
import type { HeldCounts, ProgressState } from '../shared/types'

const defaults: ProgressState = {
  inventory: {},
  completedQuests: [],
  inventorySource: undefined
}

const store = new Store<{ progress: ProgressState }>({
  name: 'eq-tools-progress',
  defaults: { progress: defaults }
})

export function getProgress(): ProgressState {
  return store.get('progress', defaults)
}

function setProgress(next: ProgressState): ProgressState {
  store.set('progress', next)
  return next
}

export function setInventory(counts: HeldCounts, source: { path: string; loadedAt: string }): ProgressState {
  return setProgress({ ...getProgress(), inventory: counts, inventorySource: source })
}

export function setQuestComplete(questKey: string, complete: boolean): ProgressState {
  const p = getProgress()
  const set = new Set(p.completedQuests)
  if (complete) set.add(questKey)
  else set.delete(questKey)
  return setProgress({ ...p, completedQuests: [...set] })
}
