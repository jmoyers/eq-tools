// ============================================================================
// eslint.ratchet.mjs — GENERATED. Do not hand-edit to make a build green.
// ============================================================================
//
// THE RATCHET ONLY SHRINKS.
//
// Every entry below is a rule that a file violates TODAY, turned off for that
// file alone so `npm run lint` passes with zero source changes. It is a debt
// register, not a permission slip.
//
//   * A refactor wave DELETES the entries it fixed and re-runs `npm run lint`.
//     If the file is clean the deletion sticks; if it is not, lint says so.
//   * ADDING an entry — a new file, or a new rule on an existing file — is the
//     INTEGRATOR's call. Never an executor's, and never the way to land code
//     that does not pass.
//   * Regenerating wholesale (`npm run lint:ratchet`) after writing new code
//     silently widens the ratchet and defeats the entire design. Regenerate only
//     to seed it, or to re-baseline after a deliberate rule-set change.
//   * `EQ_LINT_NO_RATCHET=1 npx eslint .` shows the true, un-suppressed state.
//   * The worklist for the refactor waves is lint-worklist.md, generated beside
//     this file from the same run.
//
// Baseline: 112 files, 302 file×rule entries, 591 suppressed violations.
// Generated 2026-08-03 by scripts/lint-report.mts.
// The trailing `// N` on each line is that file's violation count for that rule
// at generation time — a size hint for whoever picks the file up, nothing more.
// ============================================================================

/** @type {import('eslint').Linter.Config[]} */
export const ratchet = [
  {
    files: ['scripts/azure-sign.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off', // 2
    },
  },
  {
    files: ['scripts/fetch-packs.mts'],
    rules: {
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 1
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off', // 1
      'complexity': 'off', // 2
    },
  },
  {
    files: ['scripts/gen-icon.mts'],
    rules: {
      '@typescript-eslint/prefer-for-of': 'off', // 1
      'max-params': 'off', // 3
    },
  },
  {
    files: ['scripts/scrape-bosses.ts'],
    rules: {
      '@typescript-eslint/prefer-includes': 'off', // 1
    },
  },
  {
    files: ['scripts/scrape-mobs.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-parameters': 'off', // 1
      '@typescript-eslint/restrict-plus-operands': 'off', // 1
      'complexity': 'off', // 2
    },
  },
  {
    files: ['scripts/scrape-posky.ts'],
    rules: {
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 1
    },
  },
  {
    files: ['scripts/scrape-quests.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-parameters': 'off', // 1
      '@typescript-eslint/prefer-for-of': 'off', // 1
      '@typescript-eslint/restrict-plus-operands': 'off', // 1
      'complexity': 'off', // 2
      'max-depth': 'off', // 9
    },
  },
  {
    files: ['scripts/scrape-spells.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off', // 1
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 2
      'complexity': 'off', // 1
    },
  },
  {
    files: ['scripts/site-screens.mts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 3
      '@typescript-eslint/no-unsafe-assignment': 'off', // 1
      '@typescript-eslint/no-unsafe-call': 'off', // 9
      '@typescript-eslint/no-unsafe-member-access': 'off', // 9
      '@typescript-eslint/no-unsafe-return': 'off', // 2
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off', // 1
      'complexity': 'off', // 1
      'max-params': 'off', // 1
    },
  },
  {
    files: ['scripts/sources/eqlegends.ts'],
    rules: {
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 3
      'complexity': 'off', // 3
      'max-depth': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['scripts/sources/mobPage.ts'],
    rules: {
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 1
    },
  },
  {
    files: ['scripts/sources/questPage.ts'],
    rules: {
      'complexity': 'off', // 1
    },
  },
  {
    files: ['src/main/channel.ts'],
    rules: {
      '@typescript-eslint/dot-notation': 'off', // 1
      'no-console': 'off', // 3
    },
  },
  {
    files: ['src/main/combat/engine.ts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 1
      '@typescript-eslint/no-non-null-assertion': 'off', // 1
      '@typescript-eslint/no-unused-vars': 'off', // 10
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 2
      '@typescript-eslint/prefer-optional-chain': 'off', // 2
      'complexity': 'off', // 9
      'max-depth': 'off', // 3
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 1
      'max-params': 'off', // 6
    },
  },
  {
    files: ['src/main/combat/fightSearch.ts'],
    rules: {
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
    },
  },
  {
    files: ['src/main/combat/healing.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // 1
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 1
      'max-params': 'off', // 1
    },
  },
  {
    files: ['src/main/combat/world.ts'],
    rules: {
      'complexity': 'off', // 1
      'max-params': 'off', // 1
    },
  },
  {
    files: ['src/main/data/defaultPacks.ts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 1
    },
  },
  {
    files: ['src/main/data/messageOverlay.ts'],
    rules: {
      'complexity': 'off', // 1
    },
  },
  {
    files: ['src/main/data/overlayPersistence.ts'],
    rules: {
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
    },
  },
  {
    files: ['src/main/e2e.ts'],
    rules: {
      '@typescript-eslint/dot-notation': 'off', // 1
    },
  },
  {
    files: ['src/main/errorLog.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-arguments': 'off', // 1
    },
  },
  {
    files: ['src/main/imageCache.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off', // 2
      'complexity': 'off', // 1
      'no-console': 'off', // 2
    },
  },
  {
    files: ['src/main/index.ts'],
    rules: {
      '@typescript-eslint/dot-notation': 'off', // 4
      '@typescript-eslint/no-floating-promises': 'off', // 1
      '@typescript-eslint/no-non-null-assertion': 'off', // 3
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // 3
      '@typescript-eslint/no-unnecessary-type-conversion': 'off', // 2
      '@typescript-eslint/no-unsafe-argument': 'off', // 1
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off', // 1
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 1
      'max-params': 'off', // 3
      'no-console': 'off', // 11
    },
  },
  {
    files: ['src/main/itemLookup.ts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 1
      '@typescript-eslint/no-redundant-type-constituents': 'off', // 2
      '@typescript-eslint/no-unsafe-assignment': 'off', // 1
      '@typescript-eslint/no-unsafe-member-access': 'off', // 1
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
      'max-depth': 'off', // 1
    },
  },
  {
    files: ['src/main/itemLookupParse.ts'],
    rules: {
      'complexity': 'off', // 3
      'max-depth': 'off', // 2
    },
  },
  {
    files: ['src/main/log/Tailer.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-declaration-merging': 'off', // 2
    },
  },
  {
    files: ['src/main/log/bus.ts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 1
      '@typescript-eslint/no-non-null-assertion': 'off', // 1
    },
  },
  {
    files: ['src/main/log/config.ts'],
    rules: {
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
    },
  },
  {
    files: ['src/main/log/discovery.ts'],
    rules: {
      'max-depth': 'off', // 1
    },
  },
  {
    files: ['src/main/log/parser.ts'],
    rules: {
      '@typescript-eslint/no-redundant-type-constituents': 'off', // 1
      '@typescript-eslint/no-unused-vars': 'off', // 1
      '@typescript-eslint/prefer-optional-chain': 'off', // 2
      'complexity': 'off', // 1
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 1
      'max-params': 'off', // 4
      'prefer-const': 'off', // 1
    },
  },
  {
    files: ['src/main/log/reducers.ts'],
    rules: {
      'max-params': 'off', // 1
    },
  },
  {
    files: ['src/main/log/scanHistory.ts'],
    rules: {
      'max-depth': 'off', // 3
    },
  },
  {
    files: ['src/main/mobLookup.ts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 1
      '@typescript-eslint/no-redundant-type-constituents': 'off', // 2
      '@typescript-eslint/no-unsafe-assignment': 'off', // 1
      '@typescript-eslint/no-unsafe-member-access': 'off', // 1
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
      'max-depth': 'off', // 1
    },
  },
  {
    files: ['src/main/mobLookupLocal.ts'],
    rules: {
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
    },
  },
  {
    files: ['src/main/mobLookupParse.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-conversion': 'off', // 3
    },
  },
  {
    files: ['src/main/modules/alerts.ts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 1
      '@typescript-eslint/no-base-to-string': 'off', // 1
    },
  },
  {
    files: ['src/main/modules/buffs.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off', // 4
      '@typescript-eslint/no-redundant-type-constituents': 'off', // 4
      '@typescript-eslint/no-unused-vars': 'off', // 1
      '@typescript-eslint/prefer-optional-chain': 'off', // 4
      'complexity': 'off', // 6
      'max-depth': 'off', // 2
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 1
      'max-params': 'off', // 2
    },
  },
  {
    files: ['src/main/modules/consider.ts'],
    rules: {
      'complexity': 'off', // 1
    },
  },
  {
    files: ['src/main/modules/eventFeed.ts'],
    rules: {
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
      'max-params': 'off', // 1
    },
  },
  {
    files: ['src/main/modules/registry.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-parameters': 'off', // 1
    },
  },
  {
    files: ['src/main/modules/turnins.ts'],
    rules: {
      '@typescript-eslint/prefer-optional-chain': 'off', // 2
    },
  },
  {
    files: ['src/main/packRegistry.ts'],
    rules: {
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 2
      'complexity': 'off', // 2
    },
  },
  {
    files: ['src/main/provisionPacks.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off', // 1
    },
  },
  {
    files: ['src/main/share.ts'],
    rules: {
      '@typescript-eslint/consistent-indexed-object-style': 'off', // 1
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // 1
      '@typescript-eslint/non-nullable-type-assertion-style': 'off', // 1
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
      'complexity': 'off', // 1
      'max-depth': 'off', // 2
    },
  },
  {
    files: ['src/main/sounds.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // 1
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
    },
  },
  {
    files: ['src/main/store.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-conversion': 'off', // 1
      '@typescript-eslint/prefer-optional-chain': 'off', // 2
      'no-console': 'off', // 1
    },
  },
  {
    files: ['src/main/storeMigrations.ts'],
    rules: {
      '@typescript-eslint/dot-notation': 'off', // 15
      'complexity': 'off', // 1
    },
  },
  {
    files: ['src/main/updater.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off', // 1
      '@typescript-eslint/no-unnecessary-type-conversion': 'off', // 2
      'max-lines-per-function': 'off', // 1
      'no-console': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/App.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 2
      'complexity': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/components/TitleBar.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 2
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/components/UpdateChip.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 1
      'complexity': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/data/index.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // 2
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/alerts/AlertsView.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 5
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 4
    },
  },
  {
    files: ['src/renderer/src/features/alerts/SoundPacksDialog.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 1
      '@typescript-eslint/no-dynamic-delete': 'off', // 1
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off', // 1
      'complexity': 'off', // 1
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/features/alerts/SuggestAlertsDialog.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 4
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/bosses/BossView.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 3
      '@typescript-eslint/no-unsafe-argument': 'off', // 1
      'complexity': 'off', // 1
      'max-lines-per-function': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/features/buffs/BuffsView.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 4
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // 1
      '@typescript-eslint/non-nullable-type-assertion-style': 'off', // 5
      'complexity': 'off', // 2
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/features/combat/CombatDashboard.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 5
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
      'complexity': 'off', // 2
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/combat/CombatTimeline.tsx'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 1
      '@typescript-eslint/no-deprecated': 'off', // 1
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
      'complexity': 'off', // 2
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/combat/CombatView.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 11
      '@typescript-eslint/no-unsafe-argument': 'off', // 3
      '@typescript-eslint/no-unsafe-return': 'off', // 3
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 2
      'complexity': 'off', // 2
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/features/combat/FightPicker.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 4
      'complexity': 'off', // 1
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/combat/combatShared.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 11
      '@typescript-eslint/no-unnecessary-template-expression': 'off', // 1
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off', // 1
      'no-console': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/features/combat/copyText.ts'],
    rules: {
      'complexity': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/combat/dashboardData.ts'],
    rules: {
      'complexity': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/favorites/FavoriteStar.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/favorites/QuestFlagButtons.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/features/favorites/useFavorites.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/favorites/useQuestFlags.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/inventory/reconcile.ts'],
    rules: {
      'complexity': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/leveling/LevelingView.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 5
      'complexity': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/loot/ItemDetailDialog.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 5
      '@typescript-eslint/no-unsafe-argument': 'off', // 1
      'complexity': 'off', // 2
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/loot/LootView.tsx'],
    // 2 stale eslint-disable comment(s) predating this config.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 7
      '@typescript-eslint/no-misused-promises': 'off', // 1
      'complexity': 'off', // 2
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/mobs/MobPage.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 5
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 1
      'complexity': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/mobs/MobsView.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/features/mobs/RecentlyConsidered.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 3
      'complexity': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/posky/ItemTooltip.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/posky/PoskyView.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 4
      '@typescript-eslint/no-misused-promises': 'off', // 1
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // 1
      '@typescript-eslint/no-unsafe-assignment': 'off', // 1
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 1
      'complexity': 'off', // 1
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/features/posky/sharedItems.ts'],
    rules: {
      'complexity': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/posky/turnInCelebration.ts'],
    rules: {
      '@typescript-eslint/prefer-optional-chain': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/posky/useProgress.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/preferences/PreferencesView.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 8
      'complexity': 'off', // 2
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/features/profiles/ProfileSharing.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/features/profiles/ShareImportDialog.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 2
      'complexity': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/lib/Confetti.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/lib/ItemWindow.tsx'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 2
      '@typescript-eslint/no-deprecated': 'off', // 4
      'complexity': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/lib/KnownItemTooltip.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 6
    },
  },
  {
    files: ['src/renderer/src/lib/ObservedItemWindow.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/lib/clipboard.ts'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/lib/useModule.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-type-parameters': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/main.tsx'],
    rules: {
      '@typescript-eslint/non-nullable-type-assertion-style': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/overlay/EventLogOverlay.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 7
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off', // 1
      '@typescript-eslint/non-nullable-type-assertion-style': 'off', // 1
      '@typescript-eslint/prefer-nullish-coalescing': 'off', // 2
      'complexity': 'off', // 3
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/overlay/HealMeter.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 6
      '@typescript-eslint/no-unnecessary-template-expression': 'off', // 1
      'complexity': 'off', // 2
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 2
    },
  },
  {
    files: ['src/renderer/src/overlay/OverlayMeter.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 5
      'complexity': 'off', // 1
      'max-lines': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/overlay/OverlaySelect.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 1
      'complexity': 'off', // 1
      'max-lines-per-function': 'off', // 1
    },
  },
  {
    files: ['src/renderer/src/overlay/main.tsx'],
    rules: {
      '@typescript-eslint/no-deprecated': 'off', // 1
      '@typescript-eslint/non-nullable-type-assertion-style': 'off', // 1
    },
  },
  {
    files: ['src/shared/combat.ts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 2
    },
  },
  {
    files: ['src/shared/fuzzy.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off', // 3
      'complexity': 'off', // 1
    },
  },
  {
    files: ['src/shared/itemStats.ts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 1
      'complexity': 'off', // 2
    },
  },
  {
    files: ['src/shared/logEventKinds.ts'],
    // 1 stale eslint-disable comment(s) predating this config.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['src/shared/logEvents.ts'],
    rules: {
      '@typescript-eslint/no-redundant-type-constituents': 'off', // 2
    },
  },
  {
    files: ['src/shared/profiles.ts'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off', // 2
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // 1
      '@typescript-eslint/no-unnecessary-type-conversion': 'off', // 1
      'complexity': 'off', // 4
      'max-lines': 'off', // 1
      'max-params': 'off', // 1
    },
  },
  {
    files: ['src/shared/types.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off', // 8
      'max-lines': 'off', // 1
    },
  },
  {
    files: ['src/shared/update.ts'],
    rules: {
      'complexity': 'off', // 1
    },
  },
  {
    files: ['tests/combatTaxonomyWindows.test.mts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 1
      'complexity': 'off', // 1
    },
  },
  {
    files: ['tests/considerWindows.test.mts'],
    rules: {
      'max-lines': 'off', // 1
    },
  },
  {
    files: ['tests/defaultSoundPack.test.mts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 1
    },
  },
  {
    files: ['tests/e2e/combat-dashboard.e2e.mts'],
    rules: {
      '@typescript-eslint/array-type': 'off', // 2
      'complexity': 'off', // 1
      'max-depth': 'off', // 3
      'max-lines': 'off', // 1
    },
  },
  {
    files: ['tests/epochWindows.test.mts'],
    rules: {
      'max-depth': 'off', // 1
    },
  },
  {
    files: ['tests/fullReplaySmoke.test.mts'],
    rules: {
      'complexity': 'off', // 1
    },
  },
  {
    files: ['tests/healingWindows.test.mts'],
    rules: {
      'max-depth': 'off', // 1
    },
  },
  {
    files: ['tests/itemLookup.test.mts'],
    rules: {
      'max-lines': 'off', // 1
    },
  },
]

export default ratchet
