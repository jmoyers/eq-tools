// ============================================================================
// useTriage — the renderer's ONLY door to the backlog, and it is a door to MAIN.
// ============================================================================
//
// THE RENDERER NEVER FETCHES. Every byte on this tab arrives over `window.eq.triage*`, which
// is `ipcRenderer.invoke` and nothing else — no `fetch`, no SDK, no credentials in this
// process, and the Content-Security-Policy in index.html is untouched by this feature. Main
// holds the AWS profile; the renderer holds a promise.
//
// EVERY CALL ANSWERS `TriageResult<T>`, never a rejection, because the interesting failure is
// not a bug: a shell without the owner's IAM credentials gets a denial from DSQL on the first
// statement, and that has to render as prose in a panel rather than as a blank tab.
//
// `run` is a caller-supplied `useCallback`, which is what makes the effect's dependency honest:
// the query object is rebuilt on every render, so depending on IT would refetch forever.

import { useCallback, useEffect, useState } from 'react'
import type { TriageResult } from '@shared/triage'

export interface Async<T> {
  data: T | null
  error: string | null
  loading: boolean
  /** Re-run the same call — after a write, or after the user fixes their credentials. */
  reload: () => void
}

interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
}

/** A rejected invoke (no handler — i.e. somebody ran this against a packaged build) reads as
 *  an ordinary error, so even the impossible case renders instead of exploding. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useTriageCall<T>(run: () => Promise<TriageResult<T>>): Async<T> {
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true })

  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    void run().then(
      (res) => {
        if (!alive) return
        setState(
          res.ok
            ? { data: res.value, error: null, loading: false }
            : { data: null, error: res.error, loading: false }
        )
      },
      (err: unknown) => {
        if (alive) setState({ data: null, error: messageOf(err), loading: false })
      }
    )
    return () => {
      alive = false
    }
  }, [run, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { ...state, reload }
}

/** A WRITE: runs on demand, reports prose on failure, and tells the caller when to refetch. */
export interface Mutation {
  run: (call: () => Promise<TriageResult<unknown>>) => Promise<boolean>
  busy: boolean
  error: string | null
  clearError: () => void
}

export function useTriageMutation(onDone: () => void): Mutation {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (call: () => Promise<TriageResult<unknown>>): Promise<boolean> => {
      setBusy(true)
      setError(null)
      try {
        const res = await call()
        if (!res.ok) {
          setError(res.error)
          return false
        }
        onDone()
        return true
      } catch (err: unknown) {
        setError(messageOf(err))
        return false
      } finally {
        setBusy(false)
      }
    },
    [onDone]
  )

  return { run, busy, error, clearError: useCallback(() => setError(null), []) }
}
