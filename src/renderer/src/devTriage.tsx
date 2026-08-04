// ============================================================================
// devTriage — the ONE place the compile-time dev-tools flag reaches a component tree.
// ============================================================================
//
// `__EQ_DEV_TOOLS__` is substituted by the renderer `define` in electron.vite.config.ts: `true`
// under `electron-vite dev`, `false` for `electron-vite build`. When it is false this file
// compiles to `const Lazy = null` and the `import()` below is DEAD CODE — rollup removes the
// call, the chunk it would have produced is never emitted, and `features/triage/**` leaves no
// trace in `out/renderer`. That is a STRIP, not a hide: there is no bundled component to
// un-hide, no string to grep, and no route into it.
//
// The dynamic import is what makes the strip possible. A static `import TriageView from …`
// would pull the tree into the graph before any branch could remove it.

import { type JSX, Suspense, lazy } from 'react'
import { CircularProgress } from '@mui/material'
import { DEV_TOOLS } from './devFlags'

const LazyTriageView = DEV_TOOLS ? lazy(() => import('./features/triage/TriageView')) : null

/** Renders the dev triage tab, or nothing at all in a build compiled without the flag. */
export default function DevTriageView(): JSX.Element | null {
  if (!LazyTriageView) return null
  return (
    <Suspense fallback={<CircularProgress size={20} />}>
      <LazyTriageView />
    </Suspense>
  )
}
