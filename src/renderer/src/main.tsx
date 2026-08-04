import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { theme } from './theme/theme'
import App from './App'
import { ErrorBoundary } from './lib/ErrorBoundary'
import { DEV_TOOLS, DEV_TOOLS_DEFINE } from './devFlags'

// --- The dev-tools flag, stated out loud (dev only) ---
// "The Triage tab is missing" has twice been a stale `npm run dev` whose bundle predates the
// `__EQ_DEV_TOOLS__` define, and twice it was invisible: no error, no tab, nothing to grep. One
// line at boot turns that into a glance at the console. `import.meta.env.DEV` is a literal
// `false` in a build, so this whole block — and the string — is deleted from every installer;
// production stays silent, exactly like the rest of the renderer.
if (import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.info(
    `[everquest-companion] dev-tools: DEV_TOOLS=${String(DEV_TOOLS)}, __EQ_DEV_TOOLS__ define ` +
      (DEV_TOOLS_DEFINE === undefined
        ? 'ABSENT — this dev server booted before the define existed; restart `npm run dev` if a dev-only surface misbehaves'
        : `= ${String(DEV_TOOLS_DEFINE)}`)
  )
}

// --- Renderer error capture (Task #13) ---
// Install global handlers BEFORE React mounts so even a failure during the very
// first render (or a bad theme) is reported to main → errors.log + dev stdout.
// Fire-and-forget over the `error:report` IPC channel via the preload bridge.
function report(source: string, message: string, stack?: string): void {
  try {
    window.eq?.reportError({ message, stack, source })
  } catch {
    // Preload bridge missing (itself an error already logged in main) — ignore.
  }
}

window.addEventListener('error', (e) => {
  const err = e.error as Error | undefined
  report('onerror', err?.message ?? e.message, err?.stack)
})

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as unknown
  if (reason instanceof Error) report('unhandledrejection', reason.message, reason.stack)
  else report('unhandledrejection', String(reason))
})

// index.html always carries #root; if it ever does not, fail loudly here rather
// than letting createRoot throw a container error nobody can trace back.
const container = document.getElementById('root')
if (!container) throw new Error('renderer: #root container missing from index.html')

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
