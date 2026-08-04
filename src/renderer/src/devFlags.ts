// ============================================================================
// devFlags — the ONE reference to `__EQ_DEV_TOOLS__` in the renderer, and the reason it is
// written defensively.
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
// Hence `typeof … !== 'undefined'`: the one form that is safe to evaluate when the identifier
// was never declared, and that STILL folds to a literal when it was (the substitution happens
// inside the `typeof` too, so a build sees `typeof false !== 'undefined' && false`). A stale
// server degrades to "the dev tab is hidden" — wrong, but recoverable by restarting `npm run
// dev`, and never a blank app.
//
// EVERY gate reads `DEV_TOOLS` from here. One reference, one place to get this right.
export const DEV_TOOLS: boolean = typeof __EQ_DEV_TOOLS__ !== 'undefined' && __EQ_DEV_TOOLS__
