// Central registry of IPC channel names so main/preload/renderer stay in sync.

export const IPC = {
  // ---- module transport (the one pattern for loot/turnins/kills/leveling/character) ----
  // renderer -> main
  getModuleSnapshot: 'module:getSnapshot',
  // main -> renderer
  onModuleDelta: 'module:delta',

  // ---- progress / inventory (per-character persisted state) ----
  getProgress: 'progress:get',
  reloadInventory: 'inventory:reload',
  setQuestComplete: 'progress:setQuestComplete',
  // main -> renderer: progress changed (quest completion / inventory), so every
  // view that shows progress stays consistent without re-fetching on a timer.
  onProgress: 'progress:changed',
  // main -> renderer: the active character's *-Inventory.txt was auto-reloaded.
  onInventoryReload: 'inventory:autoReloaded',

  // ---- character selection ----
  getCharacter: 'character:get',
  listCharacters: 'character:list',
  setCharacter: 'character:set',

  // ---- combat (its own snapshot transport — see modules/types.ts) ----
  getCombatSnapshot: 'combat:snapshot',
  onCombatActivity: 'combat:activity',

  // ---- alerts extension (Task #18) ----
  // CRUD over alert defs + global sound prefs (renderer -> main).
  listAlerts: 'alerts:list',
  saveAlert: 'alerts:save',
  deleteAlert: 'alerts:delete',
  // test = renderer plays the alert's sound directly (main just echoes the def).
  testAlert: 'alerts:test',
  // reset all alert defs back to the seeded built-in set (Task #22).
  resetAlerts: 'alerts:reset',
  // renderer reports an 'app'-triggered fire (e.g. bossDefeat) so the module's
  // history stays the single source of truth (Task #22). Payload {alertId, context}.
  appFired: 'alerts:appFired',
  getAlertPrefs: 'alertPrefs:get',
  setAlertPrefs: 'alertPrefs:set',
  // sound packs (discovery + audio bytes)
  listSoundPacks: 'sounds:listPacks',
  getSoundData: 'sounds:getData',

  // ---- misc pushes ----
  onLine: 'log:line',
  onCharacter: 'log:character',

  // ---- error harness (renderer -> main, fire-and-forget) ----
  // window.onerror / onunhandledrejection / React ErrorBoundary report here so
  // renderer crashes land in errors.log + dev stdout and never leave a blank window.
  reportError: 'error:report'
} as const
