// ============================================================================
// ESLint 9 flat config — everquest-companion
// ============================================================================
//
// WHY THIS EXISTS. The tree is ~54k lines of TypeScript across an Electron main
// process, two React renderer entries (app + overlay), a shared model layer,
// scrapers and a node:test suite. `tsc --strict` already catches type errors;
// what it cannot catch is a 1,982-line engine.ts, a 60-branch reducer, or a
// `catch {}` that swallows a real failure. This config is the second gate:
// type-aware correctness rules plus hard FACTORING limits.
//
// THREE LAYERS, in increasing order of specificity:
//
//   1. correctness   js.configs.recommended + typescript-eslint
//                    strictTypeChecked + stylisticTypeChecked, type-aware via
//                    the TS project service (see PROJECT WIRING below), plus
//                    react-hooks for the renderer.
//   2. factoring     complexity / max-depth / max-lines / max-lines-per-function
//                    / max-params. Thresholds are MEASURED, not guessed — see
//                    the distribution table below.
//   3. the ratchet   eslint.ratchet.mjs, a generated per-file rule-off block
//                    listing exactly today's violations so `npm run lint` is
//                    green with zero source changes. IT ONLY SHRINKS.
//
// ---------------------------------------------------------------------------
// PROJECT WIRING
// ---------------------------------------------------------------------------
// Type-aware rules need a program per file. `projectService: true` hands that to
// TypeScript's own project service, which resolves each file through the NEAREST
// tsconfig.json — here the solution-style root `tsconfig.json`, whose two
// references (tsconfig.node.json = main/preload/shared/scripts,
// tsconfig.web.json = renderer/shared) are exactly the two programs
// `npm run typecheck` builds. So lint and typecheck see identical file sets and
// identical compiler options; there is no third opinion to drift.
//
// `tests/**` and plain `.mjs`/`.cjs` files are in NEITHER tsconfig (the suite runs
// through tsx, never tsc). Rather than invent a lint-only tsconfig that could
// drift, those files get `disableTypeChecked` — they keep every syntactic rule
// (including the whole factoring layer) and drop only the ones needing a program.
// Wiring tests into a real tsconfig is a worthwhile follow-up; it is not this
// config's job to fake it.
//
// ---------------------------------------------------------------------------
// FACTORING THRESHOLDS — the measurement that chose them
// ---------------------------------------------------------------------------
// Measured with `npm run lint:measure` (scripts/lint-report.mts), which re-runs
// ESLint with the five rules pinned to FLOOR values (max: 0) and reads the
// ACTUAL metric out of every message. So the table below is a distribution over
// the real tree — every function, every file — not violation counts against a
// number someone already picked.
//
// Baseline taken 2026-08-03 (`scripts/lint-measure.txt` holds the full output):
//
//   rule                       n    p50   p75   p90   p95   p99    max   chosen
//   ---------------------- -----  ----- ----- ----- ----- -----  -----   ------
//   complexity              3681      1     3     5     8    20    146       12
//   max-depth               2353      1     2     2     3     4      5        3
//   max-lines                210    102   215   410   560   909   1240      400
//   max-lines-per-function  3564      4    10    22    34   112    385      100
//   max-params              2534      1     2     2     3     4      9        4
//
// Threshold sweep (sites / files that violate at each candidate):
//
//   complexity              8: 171/85   10: 118/64   12:  86/51   15: 58/42   20: 36/29
//   max-depth               3:  30/13    4:   3/3     5:   0/0
//   max-lines             300:  38/38  400:  21/21  500:  15/15  600:  8/8   800: 4/4
//   max-lines-per-function 60:  81/46   80:  51/36  100:  42/32  120: 32/27  150: 26/23
//   max-params              3:  37/16    4:  24/11    5:   7/5     6:  5/3
//
// THE ARGUMENT for each number:
//
//   complexity 12 — p95 is 8 and p99 is 20, so 12 sits between them: it is not
//     where the code lives, it is where the code went wrong. The 86 offenders
//     are the parser's line-shape cascade (`classify`, complexity 146), the
//     buffs module's `onEvent` (79) and a row of 48–60-branch React components
//     (ItemWindow, MobPage, OverlayMeter, CombatView, HealMeter) — dispatch
//     tables wearing an if-chain, which is exactly what this exercise is for.
//     15 would spare ~28 of them for no design reason; 10 would start catching
//     honest reducers.
//
//   max-depth 3 — the DATA overrode the obvious pick here. The tree's deepest
//     nesting anywhere is 5, and a max of 4 would catch THREE sites in the whole
//     repo: a rule that vacuous is a regression tripwire, not a target. At 3 it
//     catches 30 sites in 13 files, and 3 levels inside one function is a fair
//     reading ceiling — past that the inner block wants a name.
//
//   max-lines 400 (code lines; see "counting rules" below) — p90 is 410, so 400
//     is deliberately set AT the ninetieth percentile: the top tenth of files by
//     mass is precisely the population the user asked to have factored. 21 files.
//     The head of that list is the point — engine.ts (1240 code lines),
//     AlertsView.tsx (952), buffs.ts (909), index.ts (834), CombatView.tsx (792),
//     EventLogOverlay.tsx (726). A threshold chosen to excuse those would be
//     theatre. They get refactored by later waves, not exempted forever.
//
//   max-lines-per-function 100 — p95 is 34, p99 is 112. 100 lands just under the
//     top percentile and catches 42 sites in 32 files: the god-components
//     (PoskyView 385, SoundPacksDialog 378, AlertsView 368, CombatTimelineInner
//     362) and the mega-switches (parser's `classify`, 347). React components
//     dominate, which is correct — a 380-line component is a module that has not
//     admitted it yet.
//
//   max-params 4 — p95 is 3, max is 9. Past four positional arguments an options
//     object is strictly more readable and strictly harder to call wrongly. 24
//     sites, headed by engine.ts `buildView` (9) and parser.ts `dmg` (9).
//
// Counting rules: `skipBlankLines`/`skipComments` are ON for max-lines and
// max-lines-per-function. This file's own header would otherwise be a violation,
// and — more to the point — the metric we want is CODE mass, not documentation.
// This repo comments heavily on purpose (see AGENTS.md); punishing that would
// teach exactly the wrong lesson.
//
// IIFEs are exempt from max-lines-per-function (`IIFEs: false`, the default):
// a top-level `await (async () => {...})()` in a script is a module body, not a
// function that wants extracting.
//
// ---------------------------------------------------------------------------
// RULES DELIBERATELY OFF (and why — do not re-enable without reading this)
// ---------------------------------------------------------------------------
// Everything else in strictTypeChecked/stylisticTypeChecked is ON. The carve-outs
// below are judgements about THIS codebase, each one narrow:
//
//   @typescript-eslint/no-unnecessary-condition — off. The whole app parses an
//     untrusted, growing text file and an on-disk JSON store written by older
//     builds. Types describe the SHAPE WE EXPECT; the defensive checks are
//     load-bearing at exactly the boundaries where the type is a hope. This rule
//     would delete them and call it cleanup.
//   @typescript-eslint/no-confusing-void-expression — ignoreArrowShorthand: true.
//     Measured: without it, 237 violations across 41 files, EVERY one of them
//     `onClick={() => setOpen(false)}`. The rule's real catch (a void expression
//     used as a value) stays on; the part that would have wrapped a thousand
//     idiomatic handlers in braces does not.
//   @typescript-eslint/restrict-template-expressions — allowNumber: true.
//     `${dps}` in a log line is not a bug.
//   @typescript-eslint/no-non-null-assertion — kept ON, but see the ratchet.
//
// And two rules added BEYOND the presets, because the tree already assumed them:
// `no-console` and `no-new` both had hand-written `eslint-disable` comments in
// src/ before any ESLint config existed (errorLog.ts, ErrorBoundary.tsx,
// AlertsView.tsx, profiles.ts). Turning them on honours that intent and makes
// those directives live instead of stale. `no-console` is OFF for scripts/ and
// tests/, which print to a human by design.
//
// ---------------------------------------------------------------------------
// THE RATCHET CONTRACT
// ---------------------------------------------------------------------------
//   * eslint.ratchet.mjs is GENERATED (`npm run lint:ratchet`) and lists, per
//     file, exactly the rules that file violates today.
//   * IT ONLY EVER SHRINKS. A refactor wave deletes the entries it fixed and
//     re-runs `npm run lint` (NOT `lint:ratchet`) to prove they are gone.
//   * ADDING an entry — a new file, or a new rule on an existing file — is the
//     integrator's call, never an executor's, and never a way to land code that
//     does not pass. Regenerating wholesale to "fix" a red build silently widens
//     the ratchet and is the one thing this design exists to prevent.
//   * `EQ_LINT_NO_RATCHET=1 npx eslint .` shows the true, un-suppressed state.
// ============================================================================

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import { ratchet } from './eslint.ratchet.mjs'

/** Files this config never looks at: build output, vendored data, binaries. */
const IGNORES = [
  'out/**',
  'out-e2e/**',
  'dist/**',
  // esbuild bundle output for the feedback Lambda (infra/build.mjs) — generated,
  // 5.8k phantom no-var errors if linted. gitignored too; both lists need it.
  'infra/dist/**',
  'infra/.terraform/**',
  'release/**',
  'node_modules/**',
  'build/**',
  'site/**',
  'resources/**',
  'tests/fixtures/**',
  'tests/e2e/artifacts/**',
  'scripts/sources/cache/**',
  'scripts/sandbox/results/**',
  // THROWAWAY diagnostic replays. AGENTS.md's operating model has the planner
  // write `scripts/_*.mts`, run it once against the real log, and delete it.
  // They exist for minutes and are never committed — linting them made the
  // ratchet capture a file that vanished mid-session (observed: `_probe.mts`
  // appeared in one generation and not the next). Never lint them.
  'scripts/_*',
  // Generated/scraped datasets and the ratchet itself.
  '**/*.json',
  'eslint.ratchet.mjs',
]

/** The factoring layer. Numbers argued in the header. */
export const FACTORING_RULES = {
  complexity: ['error', { max: 12 }],
  'max-depth': ['error', { max: 3 }],
  'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': [
    'error',
    { max: 100, skipBlankLines: true, skipComments: true },
  ],
  'max-params': ['error', { max: 4 }],
}

export default tseslint.config(
  { ignores: IGNORES },

  // ---- 1. correctness -----------------------------------------------------
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // A stale `eslint-disable` is a lie about the code. Fail on it.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // See "RULES DELIBERATELY OFF" above.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true },
      ],
      'no-new': 'error',
      'no-console': 'error',
      // `_`-prefixed = intentionally unused. Everything else is dead weight.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // `==` against null is the one idiom worth keeping (null|undefined).
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-param-reassign': 'error',
      // Empty catch/block is how a real failure gets swallowed silently; this
      // app's whole error story is "it lands in errors.log".
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // ---- 2. factoring -------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    rules: FACTORING_RULES,
  },

  // ---- environments -------------------------------------------------------
  // Node: main process, preload, scrapers, tests, tooling.
  {
    files: [
      'src/main/**',
      'src/preload/**',
      'scripts/**',
      'tests/**',
      '*.{ts,mts,mjs,cjs,js}',
    ],
    languageOptions: { globals: globals.node },
  },
  // Browser: both renderer entries (app + overlay).
  {
    files: ['src/renderer/**'],
    languageOptions: { globals: globals.browser },
  },
  // Preload straddles both.
  {
    files: ['src/preload/**'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // ---- react-hooks (renderer only) ---------------------------------------
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...reactHooks.configs['recommended-latest'],
  },

  // ---- carve-out: files outside both tsconfigs ---------------------------
  // tests/** and hand-written .mjs/.cjs are not in tsconfig.node/web, so no
  // program exists for them. They keep every syntactic rule and lose only the
  // type-aware ones.
  {
    files: ['tests/**', '**/*.{mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // ---- carve-out: tests --------------------------------------------------
  {
    files: ['tests/**'],
    rules: {
      // A node:test case IS one long linear assertion block. Splitting it to
      // satisfy a line count buys nothing and hides the golden window.
      'max-lines-per-function': 'off',
      // Fixture-driven tests legitimately index into known-shaped data.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // The extractors and the e2e harness narrate to whoever is watching.
      'no-console': 'off',
    },
  },

  // ---- carve-out: scripts ------------------------------------------------
  {
    files: ['scripts/**'],
    rules: {
      // Scrapers report progress to a human watching a 15-minute crawl.
      'no-console': 'off',
    },
  },

  // ---- 3. the ratchet (LAST — it must win) --------------------------------
  // Skippable for measurement: EQ_LINT_NO_RATCHET=1 shows the true state.
  ...(process.env.EQ_LINT_NO_RATCHET ? [] : ratchet),
)
