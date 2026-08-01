// Central registry of IPC channel names so main/preload/renderer stay in sync.

export const IPC = {
  // renderer -> main (invoke/handle)
  getProgress: 'progress:get',
  reloadInventory: 'inventory:reload',
  setQuestComplete: 'progress:setQuestComplete',
  getLootHistory: 'loot:getHistory',
  getKills: 'loot:getKills',
  getTurnIns: 'turnins:get',
  getCharacter: 'character:get',
  listCharacters: 'character:list',
  setCharacter: 'character:set',

  // main -> renderer (send/on)
  onLoot: 'log:loot',
  onTurnIn: 'log:turnin',
  onLine: 'log:line'
} as const
