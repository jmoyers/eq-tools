// Central registry of IPC channel names so main/preload/renderer stay in sync.

export const IPC = {
  // renderer -> main (invoke/handle)
  getProgress: 'progress:get',
  reloadInventory: 'inventory:reload',
  setQuestComplete: 'progress:setQuestComplete',
  getLootHistory: 'loot:getHistory',
  getCharacter: 'character:get',

  // main -> renderer (send/on)
  onLoot: 'log:loot',
  onLine: 'log:line'
} as const
