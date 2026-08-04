import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // `include` EXTERNALIZES four devDependencies that would otherwise be BUNDLED.
    //
    // externalizeDepsPlugin externalizes `dependencies` only, which is right: a devDependency
    // is normally never imported by main. The dev-only triage surface (src/main/triage/**) is
    // the exception — it reaches `pg` and three `@aws-sdk/*` packages behind a dynamic import
    // gated on `!app.isPackaged`.
    //
    // MEASURED, not assumed: without this line rollup follows that dynamic import and bundles
    // both SDKs into out/main/chunks (917 kB across 23 chunks, one of them 647 kB), and since
    // electron-builder packages `out/**` wholesale, every shipped installer would carry the
    // AWS SDK and a postgres driver as dead weight — and the dev gate would be the ONLY thing
    // standing between a shipped build and a working backlog client. Externalized, the emitted
    // chunk is ~10 kB of our own code whose `require("pg")` / `require("@aws-sdk/…")` CANNOT
    // resolve in a packaged app, because electron-builder never installs devDependencies.
    // That is what makes "a shipped build is structurally incapable of reading the backlog" a
    // property of the packaging rather than a promise about a boolean.
    //
    // electron-vite 5 moved this from a plugin (`externalizeDepsPlugin`, now deprecated) to
    // `build.externalizeDeps`, which is ON BY DEFAULT and takes the same {include, exclude}.
    // Same behaviour, one fewer import — but note the default: every environment below
    // externalizes `dependencies` now whether or not it says so.
    //
    // Inlined data JSONs (spells/mobs/items/classes) emit as JSON.parse("...") instead of
    // pretty-printed object literals — measured 4.66 MB smaller main bundle and a faster
    // startup parse the day items.json (6.8 MB raw) landed.
    json: { stringify: true },
    build: {
      externalizeDeps: {
        include: ['pg', '@aws-sdk/client-s3', '@aws-sdk/credential-providers', '@aws-sdk/dsql-signer']
      },
      rollupOptions: {
        // TWO main-process bundles. `index` is the app; `speechWorker` is the Kokoro
        // synthesis worker_thread (docs/plans/voice-alerts.md D2 — inference must never run
        // on the thread that tails the log). It has to be a separate entry because
        // `new Worker(path)` loads a FILE: rolling it into index.js would give the worker no
        // file to load, and bundling it as a data-url string would put onnxruntime's native
        // require inside an eval. Emitted as out/main/speechWorker.js, beside index.js, which
        // is what `join(__dirname, 'speechWorker.js')` in ipc/speech.ts resolves in dev AND
        // inside the packaged asar.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          speechWorker: resolve(__dirname, 'src/main/speech/worker.ts')
        }
      }
    }
  },
  preload: {
    // No `externalizeDeps` line: electron-vite 5 defaults it to true, which is exactly what
    // the old bare `externalizeDepsPlugin()` did here.
    build: {
      rollupOptions: {
        // Three preloads: the full app bridge (index), a minimal overlay bridge (overlay)
        // that exposes only the combat snapshot + overlay window controls (Task #52), and
        // the receive-only cursor-ring bridge (cursor) — three methods, none of which can
        // change anything. electron-vite emits out/preload/{index,overlay,cursor}.js.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          cursor: resolve(__dirname, 'src/preload/cursor.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // ---- THE DEV-TOOLS STRIP -------------------------------------------------------------
    // `__EQ_DEV_TOOLS__` is a COMPILE-TIME constant, not a runtime flag. The triage tab's whole
    // component tree is reached only through `if (__EQ_DEV_TOOLS__) import('./features/triage/…')`,
    // so substituting `false` here turns that branch into dead code and rollup tree-shakes the
    // feature — its components, its strings and its imports — out of the bundle entirely. A
    // runtime check would leave all of it shipped and merely hidden.
    //
    // TRUE ONLY UNDER `electron-vite dev`. That command sets NODE_ENV_ELECTRON_VITE=development
    // before it loads this file; `electron-vite build` sets 'production'. Anything else — a
    // bare `vite build`, a future command, an unset environment — reads as false, because the
    // default for "should this build carry the operator's backlog viewer" is NO.
    //
    // Proof, not intent: `electron-vite build` then grepping out/renderer for a marker string
    // from the tab must find nothing. `npm run test:e2e` builds the same way, which is why the
    // e2e suite can assert the nav row is ABSENT in a production-shaped build.
    define: {
      __EQ_DEV_TOOLS__: JSON.stringify(process.env.NODE_ENV_ELECTRON_VITE === 'development')
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        // Three HTML entries: the main app (index), the floating overlay meters (overlay,
        // Task #52) and the cursor ring (cursor) — one <div> and no framework.
        // electron-vite emits out/renderer/{index,overlay,cursor}.html.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          cursor: resolve(__dirname, 'src/renderer/cursor.html')
        }
      }
    }
  }
})
