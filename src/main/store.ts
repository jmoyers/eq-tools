import Store from 'electron-store'
import type { HeldCounts, ProgressState } from '../shared/types'

const defaults: ProgressState = {
  inventory: {},
  liveLoot: {},
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
  const p = getProgress()
  // A fresh inventory snapshot supersedes any live-loot deltas accumulated
  // against the previous snapshot.
  return setProgress({ ...p, inventory: counts, liveLoot: {}, inventorySource: source })
}

export function addLiveLoot(item: string): ProgressState {
  const p = getProgress()
  const key = item.toLowerCase()
  const liveLoot = { ...p.liveLoot, [key]: (p.liveLoot[key] ?? 0) + 1 }
  return setProgress({ ...p, liveLoot })
}

export function resetLiveLoot(): ProgressState {
  return setProgress({ ...getProgress(), liveLoot: {} })
}

export function setQuestComplete(questKey: string, complete: boolean): ProgressState {
  const p = getProgress()
  const set = new Set(p.completedQuests)
  if (complete) set.add(questKey)
  else set.delete(questKey)
  return setProgress({ ...p, completedQuests: [...set] })
}
