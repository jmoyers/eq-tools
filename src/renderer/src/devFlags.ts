// ============================================================================
// devFlags — the ONE reference to `__EQ_DEV_TOOLS__` in the renderer, and the reason it is
// written the way it is.
// ============================================================================
//
// `__EQ_DEV_TOOLS__` is a compile-time `define` from electron.vite.config.ts. Two facts about
// vite `define` decide the shape of this file:
//
//   1. IT STRIPS. `electron-vite build` substitutes `false`, so `DEV_TOOLS` folds to a literal
//      and every branch guarded by it — the nav row, the content route, the
//      `lazy(() => import('./features/triage/…'))` — becomes dead code that rollup deletes.
//      Nothing of the triage feature reaches `out/renderer`. Proven by grep, not by intent.
//
//   2. IT ONLY EXISTS FROM THE MOMENT A DEV SERVER STARTED. A `define` is baked in when the
//      server boots and CONFIG CHANGES NEVER HOT-APPLY. A long-running `npm run dev` that
//      predates the config edit therefore serves a world where the identifier is simply not
//      declared — and a bare reference to an undeclared global is a `ReferenceError`, not
//      `undefined`. That is exactly what happened while this feature was being built: the
//      owner's running dev app threw `ReferenceError: __EQ_DEV_TOOLS__ is not defined` out of
//      appViews.ts at module scope, App never mounted, and the window went blank.
//
// THE RULE, and why it changed. `typeof … !== 'undefined' && __EQ_DEV_TOOLS__` was safe against
// the ReferenceError, but it made a stale server read as `false` — the dev tab silently VANISHED
// with no error anywhere, which cost the owner a debugging session a second time. A missing
// define is not evidence that dev tools are unwanted; it is evidence that the server is old.
//
// So the anchor is `import.meta.env.DEV`, vite's OWN builtin: it needs no config, it is true on
// any dev server no matter when it booted, and it is substituted with a literal `false` in every
// build (`electron-vite build`, and therefore every installer and `npm run test:e2e`). The
// `__EQ_DEV_TOOLS__` term is kept as an OVERRIDE for the one thing the builtin cannot express —
// a deliberate `false` from a config that DOES have the define — and `typeof` still guards it so
// a stale server evaluates without throwing.
//
//   dev server, define present  → DEV && __EQ_DEV_TOOLS__  (true under `electron-vite dev`)
//   dev server, define STALE    → DEV && true              → tab visible, degrade UPWARD
//   production build            → false && …               → folds to `false`, branch deleted
//
// The strip guarantee is unchanged: `import.meta.env.DEV` is a literal `false` in a build, so
// `false && (…)` folds exactly as before and rollup deletes everything behind it. Asserted end
// to end by tests/e2e/feedback.e2e.mts (`nav-triage` must be ABSENT in a production-shaped run).
//
// EVERY gate reads `DEV_TOOLS` from here. One reference, one place to get this right — and
// src/renderer/src/main.tsx logs the resolved value at boot so "the tab is missing" is one
// glance at the console instead of an archaeology dig.
export const DEV_TOOLS: boolean =
  import.meta.env.DEV && (typeof __EQ_DEV_TOOLS__ === 'undefined' || __EQ_DEV_TOOLS__)

/** What the `define` itself said — `undefined` means "this bundle predates it", i.e. a STALE dev
 *  server. Exported for the boot log in main.tsx ONLY, so that diagnostic does not have to become
 *  a second bare-ish reader of the identifier: this file stays the one place that names it. */
export const DEV_TOOLS_DEFINE: boolean | undefined =
  typeof __EQ_DEV_TOOLS__ === 'undefined' ? undefined : __EQ_DEV_TOOLS__
