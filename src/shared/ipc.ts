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

  // ---- EQ install-dir discovery + override (Settings gear) ----
  // renderer -> main: read the effective EQ config (root + how it resolved + log count).
  getEqConfig: 'eqconfig:get',
  // renderer -> main: open the OS folder-picker; on pick, persist the override + re-list.
  pickEqDir: 'eqconfig:pick',
  // renderer -> main: set the override to an explicit dir (undefined/'' ⇒ auto-detect).
  setEqDir: 'eqconfig:set',
  // renderer -> main: clear the override (revert to auto-discovery).
  resetEqDir: 'eqconfig:reset',
  // main -> renderer: the effective EQ config changed (override applied/cleared),
  // so the Settings dialog + any config-derived UI refresh.
  onEqConfigChanged: 'eqconfig:changed',

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
  // main -> renderer: the set of available sound packs changed (e.g. a shipped
  // default pack was auto-provisioned in the background at startup — Task #39). The
  // renderer re-lists packs + invalidates its sound caches so it becomes usable live.
  onSoundPacksChanged: 'sounds:changed',
  // suggested-alerts wizard (Task #38): a slim, searchable spell catalog derived from
  // the scraped spell DB + live per-spell usage from the buffs module's snapshot.
  spellsCatalog: 'spells:catalog',

  // ---- sound-pack registry (openpeon.com integration, Task #29) ----
  // renderer -> main: list registry packs annotated with installed flags.
  packsRegistry: 'packs:registry',
  // renderer -> main: install a pack by name (streams progress via onPackProgress).
  packsInstall: 'packs:install',
  // renderer -> main: uninstall a user-installed pack by name.
  packsUninstall: 'packs:uninstall',
  // main -> renderer: install progress {name, phase, percent?, message?}.
  onPackProgress: 'packs:progress',
  // renderer -> main: preview a registry pack BEFORE install (Task #31).
  // list a pack's sounds (name -> PackPreviewList) …
  packsPreviewList: 'packs:previewList',
  // … and stream a single preview audio file's bytes (name, file -> SoundData).
  packsPreviewSound: 'packs:previewSound',

  // ---- frameless window controls (Task #23) ----
  // renderer -> main: title-bar buttons drive the (frameless) native window.
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
  // main -> renderer: maximize state changed (bool) so the max/restore icon swaps.
  onWindowMaximized: 'window:maximized',

  // ---- floating overlay DPS meter (Task #52) ----
  // renderer(main app) -> main: toggle the overlay window open/closed.
  overlayToggle: 'overlay:toggle',
  // renderer(main app) -> main: query whether the overlay is currently open (bool).
  overlayGetState: 'overlay:getState',
  // main -> renderer(main app): overlay open-state changed (bool), so the TitleBar
  // toggle button reflects reality (also fires when the overlay closes itself).
  onOverlayState: 'overlay:state',
  // renderer(overlay) -> main: set click-through (locked) vs interactive. When locked,
  // mouse events pass through to the game except over hover-sensor regions the overlay
  // re-enables via forward:true. Payload: boolean `locked`.
  overlaySetLocked: 'overlay:setLocked',
  // renderer(overlay) -> main: fine-grained mouse-event pass-through toggle used by the
  // hover sensor while locked (true = ignore/pass through, false = capture). Payload bool.
  overlaySetIgnoreMouse: 'overlay:setIgnoreMouse',
  // renderer(overlay) -> main: close the overlay from its own close button.
  overlayClose: 'overlay:close',
  // renderer(overlay) -> main: read persisted overlay config (locked, bgAlpha, topN).
  overlayGetConfig: 'overlay:getConfig',
  // renderer(overlay) -> main: persist overlay config (partial merge).
  overlaySetConfig: 'overlay:setConfig',
  // main -> renderer(overlay): the persisted config changed (e.g. locked toggled from
  // main). Lets the overlay UI stay in sync. Payload: OverlayConfig.
  onOverlayConfig: 'overlay:config',

  // ---- auto-update (Task #27) ----
  // main -> renderer: push update lifecycle {state, version?, percent?, message?}.
  onUpdateStatus: 'update:status',
  // renderer -> main: apply the downloaded update now (quit + install + relaunch).
  installUpdate: 'update:install',
  // renderer <-> main: read/select the release channel ('main' | 'stable').
  getUpdateChannel: 'update:getChannel',
  setUpdateChannel: 'update:setChannel',

  // ---- item knowledge ("what's this lore/quest item for", Task #53) ----
  // renderer -> main: look up an item's lore/quest knowledge (local posky-first, then a
  // cached, politely-throttled wiki lookup). Returns ItemKnowledge.
  itemsLookup: 'items:lookup',

  // ---- misc pushes ----
  onLine: 'log:line',
  onCharacter: 'log:character',

  // ---- error harness (renderer -> main, fire-and-forget) ----
  // window.onerror / onunhandledrejection / React ErrorBoundary report here so
  // renderer crashes land in errors.log + dev stdout and never leave a blank window.
  reportError: 'error:report'
} as const
