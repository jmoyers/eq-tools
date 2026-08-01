// Central registry of IPC channel names so main/preload/renderer stay in sync.

export const IPC = {
  // renderer -> main (invoke/handle)
  getProgress: 'progress:get',
  reloadInventory: 'inventory:reload',
  setQuestComplete: 'progress:setQuestComplete',
  getLootHistory: 'loot:getHistory',
  getKills: 'loot:getKills',
  getTurnIns: 'turnins:get',
  getLevels: 'levels:get',
  getAAs: 'aa:get',
  getCharacter: 'character:get',
  listCharacters: 'character:list',
  setCharacter: 'character:set',

  // main -> renderer (send/on)
  onLoot: 'log:loot',
  onTurnIn: 'log:turnin',
  onLevel: 'log:level',
  onAA: 'log:aa',
  onLine: 'log:line'
} as const
