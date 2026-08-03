import { app } from 'electron'
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Tiny append-only error logger. Every captured error (main-process crashes,
 * renderer window.onerror, React ErrorBoundary, forwarded renderer console
 * errors, failed loads, dead render processes) funnels through here so a BLANK
 * WINDOW is never silent again.
 *
 * Writes to BOTH sinks:
 *   (a) `<userData>/errors.log` — a durable file agents/devs can read after the
 *       fact (truncated at ~1MB to stay small; we keep it dead simple).
 *   (b) `console.error` with the grep-able `[everquest-companion:error]` prefix so the
 *       `electron-vite dev --watch` stdout captures it live for agents.
 */

const MAX_LOG_BYTES = 1_000_000 // ~1MB — rotate by truncation past this.
const PREFIX = '[everquest-companion:error]'

let cachedPath: string | null = null

/** Resolve (and memoize) `<userData>/errors.log`, creating userData if needed. */
function logPath(): string {
  if (cachedPath) return cachedPath
  const dir = app.getPath('userData')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // userData almost always exists; ignore if the mkdir races/fails.
  }
  cachedPath = join(dir, 'errors.log')
  return cachedPath
}

/** Best-effort JSON stringify that survives Errors and circular refs. */
function stringifyPayload(payload: unknown): string {
  if (payload instanceof Error) {
    return `${payload.name}: ${payload.message}\n${payload.stack ?? '(no stack)'}`
  }
  if (typeof payload === 'string') return payload
  try {
    return JSON.stringify(payload, replacer())
  } catch {
    return String(payload)
  }
}

/** JSON replacer that unwraps nested Error objects and drops circular refs. */
function replacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack }
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }
}

/**
 * Log an error to the file + console. `source` is a short tag (e.g.
 * `main:uncaughtException`, `renderer:onerror`, `renderer:console`) so lines are
 * greppable by origin. Never throws — logging must not itself crash the app.
 */
export function logError(source: string, payload: unknown): void {
  const ts = new Date().toISOString()
  const body = stringifyPayload(payload)
  const line = `${ts} ${PREFIX} [${source}] ${body}\n`

  // (b) console.error first — cheapest, always reaches dev stdout even if the
  // file write fails (e.g. app not ready yet).
  // eslint-disable-next-line no-console
  console.error(PREFIX, `[${source}]`, body)

  // (a) durable file, with lazy truncation-based rotation.
  try {
    const path = logPath()
    try {
      if (statSync(path).size > MAX_LOG_BYTES) {
        writeFileSync(path, `${ts} ${PREFIX} [errorLog] log truncated at ~1MB\n`)
      }
    } catch {
      // File doesn't exist yet — appendFileSync will create it.
    }
    appendFileSync(path, line)
  } catch (err) {
    // Last resort: don't let a logging failure become a new uncaught error.
    // eslint-disable-next-line no-console
    console.error(PREFIX, '[errorLog] failed to write errors.log', err)
  }
}

/** Absolute path of the error log, for diagnostics/tests. */
export function errorLogPath(): string {
  return logPath()
}
