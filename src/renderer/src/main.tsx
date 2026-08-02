import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import { theme } from './theme/theme'
import App from './App'
import { ErrorBoundary } from './lib/ErrorBoundary'

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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
