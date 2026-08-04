// The COMPILE-TIME dev-tools flag, declared for TypeScript.
//
// The value is substituted by the renderer `define` in electron.vite.config.ts — `true` under
// `electron-vite dev`, `false` for `electron-vite build` (and therefore for every installer and
// for `npm run test:e2e`, which builds the same way). It is not a variable that exists at
// runtime: rollup sees a literal and deletes the branch it guards, which is what STRIPS the
// dev-only triage tab out of shipped bundles rather than merely hiding it.
//
// TYPED AS POSSIBLY-UNDEFINED ON PURPOSE, because it genuinely can be: a `define` is baked in
// when a dev server BOOTS, and config changes never hot-apply, so a long-running `npm run dev`
// that predates the config edit serves a world where this identifier was never declared. Nothing
// in the app may reference it bare — `src/renderer/src/devFlags.ts` is the ONE reader, it guards
// with `typeof`, and it treats an absent define as "stale server, show the dev surface" rather
// than as a `false`, because a missing define silently HID the tab. The value that decides
// dev-vs-build there is `import.meta.env.DEV`, not this. See the incident note in that file.
declare const __EQ_DEV_TOOLS__: boolean | undefined
