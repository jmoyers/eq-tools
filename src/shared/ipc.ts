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
  // renderer -> main: fuzzy-search the WHOLE (uncapped) fight history + the live fight by
  // name/zone (Task #61). Args: (text, limit?). Returns FightSearchResult.
  searchFights: 'combat:searchFights',

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

  // ---- floating overlay DPS meter (Task #52; per-kind windows in Task #54) ----
  // All overlay channels carry an OverlayKind ('fight' | 'overall') as their first arg so the
  // two independent overlay windows are addressed separately.
  // renderer(main app) -> main: toggle a kind's overlay window open/closed. Arg: kind.
  overlayToggle: 'overlay:toggle',
  // renderer(main app) -> main: query the open-state map for all kinds. Returns Record<kind,bool>.
  overlayGetState: 'overlay:getState',
  // main -> renderer(main app): a kind's open-state changed. Payload: {kind, open}. Keeps the
  // TitleBar overlay menu in sync (also fires when an overlay closes itself).
  onOverlayState: 'overlay:state',
  // renderer(overlay) -> main: set click-through (locked) vs interactive. Args: kind, locked.
  overlaySetLocked: 'overlay:setLocked',
  // renderer(overlay) -> main: fine-grained mouse-event pass-through toggle used by the
  // hover sensor while locked. Args: kind, ignore (true = pass through, false = capture).
  overlaySetIgnoreMouse: 'overlay:setIgnoreMouse',
  // renderer(overlay) -> main: close the overlay from its own close button. Arg: kind.
  overlayClose: 'overlay:close',
  // renderer(overlay) -> main: read a kind's persisted config. Arg: kind. Returns OverlayConfig.
  overlayGetConfig: 'overlay:getConfig',
  // renderer(overlay) -> main: persist a kind's config (partial merge). Args: kind, patch.
  overlaySetConfig: 'overlay:setConfig',
  // main -> renderer(overlay): the persisted config changed. Payload: {kind, config}. The overlay
  // ignores pushes that aren't its own kind.
  onOverlayConfig: 'overlay:config',

  // ---- auto-update (Task #27; reworked in Task #55) ----
  // main -> renderer: push update lifecycle {state, version?, percent?, message?, checkedAt?}.
  onUpdateStatus: 'update:status',
  // renderer -> main: PULL the last status. The push above only reaches renderers that
  // were mounted at the transition; Preferences mounts late, so it hydrates from here.
  getUpdateStatus: 'update:getStatus',
  // renderer -> main: run a check now ("Check for updates"). Resolves to the resulting
  // status; a no-op idle status in dev.
  checkForUpdates: 'update:checkNow',
  // renderer -> main: apply the downloaded update now (quit + install + relaunch).
  installUpdate: 'update:install',
  // renderer -> main: the running app's version (app.getVersion()), shown in Preferences.
  getAppVersion: 'app:getVersion',

  // ---- event feed / 'events' overlay (Task #59) ----
  // renderer(main app) -> main: report a renderer-DETECTED feed event (today: a Sky quest
  // completed live — only the renderer's posky/turn-in machinery can see that). Main owns the
  // ring + ids; the entry then reaches the overlay over the ordinary module transport.
  // Payload: FeedReport. Fire-and-forget.
  feedReport: 'feed:report',

  // ---- cross-window deep link (Task #64) ----
  // renderer(overlay) -> main: "focus the app on this" (AppFocus). Main shows/restores/focuses
  // the MAIN window and forwards the payload on `onFocusView`. Fire-and-forget; the payload's
  // `view` is re-validated at the handler against the closed AppFocusView union.
  focusView: 'app:focusView',
  // main -> renderer(main app): a deep link landed. App.tsx switches to the named view and
  // hands the target down (today: the mob to drill into).
  onFocusView: 'app:focusedView',

  // ---- class-combo corrections (docs/plans/class-combo-inference.md § 5.3) ----
  // READS need no channel of their own — the combo module rides the generic module transport
  // (`module:getSnapshot('combo')` + `module:delta`). These two exist because a correction is a
  // WRITE: the user telling the app "that span was PAL/ROG/BER", which is persisted per
  // character and outlives every replay.
  // renderer -> main: record a correction. Payload {startTs, endTs, classes}. `classes` must be
  // a 1-3 list of the 16 ClassAbbr literals and the timestamps must be finite and ordered —
  // VALIDATED AT THE HANDLER, never trusted because today's only caller is the app's own UI.
  comboSetCorrection: 'combo:setCorrection',
  // renderer -> main: drop every correction overlapping [startTs, endTs] ("Reset to detected").
  // A TIME RANGE, not an interval id: ids are recompute-unstable by design (§ 5.4).
  comboClearCorrection: 'combo:clearCorrection',

  // ---- item knowledge ("what's this lore/quest item for", Task #53) ----
  // renderer -> main: look up an item's lore/quest knowledge (local posky-first, then a
  // cached, politely-throttled wiki lookup). Returns ItemKnowledge.
  itemsLookup: 'items:lookup',

  // ---- mob knowledge ("what does this thing drop", Task #63) ----
  // renderer -> main: look up a mob's drop knowledge (own loot history + local quest catalog
  // first, then a cached, politely-throttled wiki lookup). Returns MobKnowledge. Exposed on
  // BOTH bridges — the main window's "recently considered" card and the events overlay's
  // consider rows ask the same question of the same cache-first door.
  mobsLookup: 'mobs:lookup',

  // ---- map viewer (docs/plans/map-viewer.md §4.2) ----
  // Main owns `fs` and owns effectiveEqRoot(), so main reads and parses `<eqRoot>\maps` and
  // the renderer receives columnar typed arrays (~690 KB worst case, once per zone change).
  // `zone` and every packId reach a join() and are validated AT THE HANDLER (isSafePackId).
  // renderer -> main: the installed packs (no absolute paths). Returns MapPackListResult.
  mapsListPacks: 'maps:listPacks',
  // renderer -> main: zone stems, all packs or one. Args: (packId?). Returns ZoneShort[].
  mapsListZones: 'maps:listZones',
  // renderer -> main: one zone's parsed map. Args: (zone, prefs?) where prefs picks the pack
  // PER LAYER — geometry and labels routinely come from different packs (§6.3), and the
  // outcome is reported back in MapData.sources. Returns MapGetResult.
  mapsGet: 'maps:get',
  // renderer -> main: fuzzy label search — one zone (opts.zone) or the whole corpus.
  // Args: (query, opts?). Returns MapSearchHit[].
  mapsSearch: 'maps:search',

  // ---- settings / alert sharing ("profiles" — src/shared/profiles.ts) ----
  // Every call carries the renderer's whitelisted localStorage prefs (UI_PREF_SPECS): main
  // owns the electron-store half of a bundle, the renderer owns the localStorage half.
  // renderer -> main: encode the GLOBAL settings bundle. Args: (uiPrefs). Returns the string.
  shareExportSettings: 'share:exportSettings',
  // renderer -> main: encode one alert (ids:[id]) or all of them (ids omitted/empty).
  shareExportAlerts: 'share:exportAlerts',
  // renderer -> main: save an already-encoded string to a file via the OS save dialog.
  // Args: (text, suggestedName). Returns {ok, path?, canceled?}.
  shareSaveFile: 'share:saveFile',
  // renderer -> main: open a .eqshare/.txt via the OS picker and PREVIEW it. Args: (uiPrefs).
  shareOpenFile: 'share:openFile',
  // renderer -> main: decode + plan a pasted string WITHOUT writing anything. Args:
  // (text, uiPrefs). Returns SharePreview (never throws; failures come back as prose).
  sharePreview: 'share:preview',
  // renderer -> main: apply a previewed string additively. Args: (text, uiPrefs, selection).
  // Returns ShareApplyResult, incl. the localStorage writes the renderer must perform.
  shareApply: 'share:apply',

  // ---- misc pushes ----
  onLine: 'log:line',
  onCharacter: 'log:character',

  // ---- error harness (renderer -> main, fire-and-forget) ----
  // window.onerror / onunhandledrejection / React ErrorBoundary report here so
  // renderer crashes land in errors.log + dev stdout and never leave a blank window.
  reportError: 'error:report'
} as const
