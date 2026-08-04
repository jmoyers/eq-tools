// useFeedback — the feedback dialog's state, held apart from its markup (Task #65, §4.4).
//
// Three concerns, three hooks:
//   useFeedbackContext  the header context main pulls together (versions, channel, queued
//                       count, and whether this build has an endpoint compiled in at all).
//   useLogSlice         build/rebuild the scrubbed slice for the chosen window, plus the
//                       "Save a copy…" escape hatch. Only ever active for a bug report with
//                       the attachment ticked — a feature request never reads the log.
//   useFeedback         the composed dialog state: draft + validation gate + submit outcome.
//
// The VALIDATION GATE is the point of `draftProblem`: it runs the SAME `validateDraft` the
// main process and (later) the Lambda run, so Send is never enabled for something the server
// would reject, and a round trip is never spent learning what we already knew. It is the one
// place the validator's result shape is read, so a contract tweak lands in one line.

import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_LOG_WINDOW,
  MAX_DESCRIPTION,
  MAX_TITLE,
  validateDraft,
  type FeedbackDraft,
  type FeedbackType
} from '@shared/feedback'
import { CRASH_REPORT_KEY } from '../../lib/ErrorBoundary'

/**
 * The BRIDGE's own reply shapes, derived from the bridge rather than re-declared.
 *
 * `src/shared/feedback.ts` owns the WIRE contract (draft, env, limits, validators) — the part
 * the renderer, main and the ingest Lambda all have to agree on. The three shapes below are
 * renderer-facing IPC replies, so they are declared beside the methods that return them
 * (`src/preload/index.ts`, the same place `ShareSaveResult` lives). The renderer cannot import
 * that file — tsconfig.web includes `src/preload/index.d.ts` only — and a second hand-written
 * copy of a contract is a contract that will eventually disagree with itself. So we read them
 * off `window.eq`, which index.d.ts does declare.
 */
type Bridge = Window['eq']
export type FeedbackContext = Awaited<ReturnType<Bridge['getFeedbackContext']>>
export type FeedbackSlicePreview = NonNullable<Awaited<ReturnType<Bridge['buildFeedbackSlice']>>>
export type SubmitResult = Awaited<ReturnType<Bridge['submitFeedback']>>

/** What the dialog is doing right now. `done` renders an outcome instead of the form. */
export type FeedbackPhase = 'compose' | 'sending' | 'done'

/** The four honest endings of a Send (§4.4 step 6). `closed` carries the SERVER's message. */
export interface FeedbackOutcome {
  kind: 'sent' | 'queued' | 'closed' | 'error'
  message: string
  reportId?: string
}

/** Seed values for an entry point that already knows something (ErrorBoundary → a bug). */
export interface FeedbackPrefill {
  type?: FeedbackType
  title?: string
  description?: string
}

interface DraftFields {
  type: FeedbackType
  title: string
  description: string
  contact: string
}

const EMPTY: DraftFields = { type: 'feature', title: '', description: '', contact: '' }

/** The typed fields as the contract wants them: trimmed, with empty optionals omitted. */
export function toDraft(f: DraftFields): FeedbackDraft {
  const title = f.title.trim()
  const contact = f.contact.trim()
  return {
    type: f.type,
    description: f.description.trim(),
    ...(title ? { title } : {}),
    ...(contact ? { contact } : {})
  }
}

/**
 * `null` when the draft is sendable, else the reason — from the SHARED validator, so the
 * button's enabled state and the server's answer can never disagree.
 */
export function draftProblem(draft: FeedbackDraft): string | null {
  const res = validateDraft(draft)
  return res.ok ? null : res.message
}

/** Pull the header context when the dialog opens. Null until it lands. */
export function useFeedbackContext(open: boolean): FeedbackContext | null {
  const [ctx, setCtx] = useState<FeedbackContext | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.eq.getFeedbackContext().then((c) => {
      if (alive) setCtx(c)
    })
    return () => {
      alive = false
    }
  }, [open])
  return ctx
}

export interface LogSliceState {
  slice: FeedbackSlicePreview | null
  loading: boolean
  saving: boolean
  savedPath: string | null
  saveCopy: () => void
}

/**
 * Build the slice for `windowMinutes` whenever the attachment is active. Main caches per
 * session, so re-ticking the checkbox is free; changing the window is a fresh build.
 */
export function useLogSlice(active: boolean, windowMinutes: number): LogSliceState {
  const [slice, setSlice] = useState<FeedbackSlicePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedPath, setSavedPath] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let alive = true
    setLoading(true)
    setSavedPath(null)
    void window.eq
      .buildFeedbackSlice(windowMinutes)
      .then((s) => {
        if (alive) setSlice(s)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [active, windowMinutes])

  const saveCopy = useCallback(() => {
    setSaving(true)
    void window.eq
      .saveFeedbackSlice(windowMinutes)
      .then((r) => {
        if (r.ok && r.path) setSavedPath(r.path)
      })
      .finally(() => {
        setSaving(false)
      })
  }, [windowMinutes])

  return { slice, loading, saving, savedPath, saveCopy }
}

/** Map the typed submit result onto the outcome the dialog renders. Never throws. */
export function toOutcome(res: SubmitResult): FeedbackOutcome {
  if (res.ok) {
    return {
      kind: 'sent',
      reportId: res.reportId,
      message: res.logUploaded
        ? 'Thanks — your report and its log slice are in.'
        : 'Thanks — your report is in.'
    }
  }
  if (res.queued) {
    return { kind: 'queued', message: "Saved — we'll send it next time you're online." }
  }
  return { kind: res.error === 'closed' ? 'closed' : 'error', message: res.message }
}

/**
 * The crash the ErrorBoundary parked before reloading, as a bug prefill — read ONCE and
 * cleared, so a later reload never re-opens a report for a crash that is already filed.
 * Everything is defensive: the value is JSON we wrote, but it survived a process the whole
 * point of which is that something went wrong.
 */
function readCrashPrefill(): FeedbackPrefill | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(CRASH_REPORT_KEY)
    if (raw !== null) sessionStorage.removeItem(CRASH_REPORT_KEY)
  } catch {
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const v = parsed as { message?: unknown; stack?: unknown }
  const message = typeof v.message === 'string' ? v.message : ''
  const stack = typeof v.stack === 'string' ? v.stack : ''
  if (!message && !stack) return null
  // Truncated to the contract's own ceiling: a prefill the SHARED validator would reject is a
  // Send button that can never light up, which reads as the report form being broken too.
  return {
    type: 'bug',
    title: `Crash: ${message}`.slice(0, MAX_TITLE),
    description: `The app hit a render error and I reloaded it.\n\n${message}\n\n${stack}`.slice(
      0,
      MAX_DESCRIPTION
    )
  }
}

export interface FeedbackDialogControl {
  open: boolean
  prefill: FeedbackPrefill | undefined
  openFeedback: (prefill?: FeedbackPrefill) => void
  close: () => void
}

/**
 * App-level ownership of the dialog: who has it open and what it was seeded with. Also the one
 * place the ErrorBoundary's parked crash is picked up — App.tsx mounts once per reload, which
 * is exactly when a "Report this" reload arrives.
 */
export function useFeedbackDialog(): FeedbackDialogControl {
  const [open, setOpen] = useState(false)
  const [prefill, setPrefill] = useState<FeedbackPrefill | undefined>(undefined)

  useEffect(() => {
    const crash = readCrashPrefill()
    if (!crash) return
    setPrefill(crash)
    setOpen(true)
  }, [])

  const openFeedback = useCallback((p?: FeedbackPrefill): void => {
    setPrefill(p)
    setOpen(true)
  }, [])
  const close = useCallback((): void => {
    setOpen(false)
  }, [])

  return { open, prefill, openFeedback, close }
}

export interface FeedbackState {
  fields: DraftFields
  setField: <K extends keyof DraftFields>(key: K, value: DraftFields[K]) => void
  setType: (t: FeedbackType) => void
  attachLog: boolean
  setAttachLog: (v: boolean) => void
  windowMinutes: number
  setWindowMinutes: (m: number) => void
  draft: FeedbackDraft
  problem: string | null
  phase: FeedbackPhase
  outcome: FeedbackOutcome | null
  send: () => void
}

/**
 * The dialog's whole state machine. Everything resets when the dialog OPENS (never on close —
 * the closing animation would visibly wipe the outcome the user is still reading).
 */
export function useFeedback(open: boolean, prefill?: FeedbackPrefill): FeedbackState {
  const [fields, setFields] = useState<DraftFields>(EMPTY)
  const [attachLog, setAttachLog] = useState(false)
  const [windowMinutes, setWindowMinutes] = useState<number>(DEFAULT_LOG_WINDOW)
  const [phase, setPhase] = useState<FeedbackPhase>('compose')
  const [outcome, setOutcome] = useState<FeedbackOutcome | null>(null)

  useEffect(() => {
    if (!open) return
    const type = prefill?.type ?? 'feature'
    setFields({
      ...EMPTY,
      type,
      title: prefill?.title ?? '',
      description: prefill?.description ?? ''
    })
    // Bug reports attach the log BY DEFAULT — it is the whole point of a bug report.
    setAttachLog(type === 'bug')
    setWindowMinutes(DEFAULT_LOG_WINDOW)
    setPhase('compose')
    setOutcome(null)
  }, [open, prefill])

  const setField = useCallback(
    <K extends keyof DraftFields>(key: K, value: DraftFields[K]): void => {
      setFields((f) => ({ ...f, [key]: value }))
    },
    []
  )

  // A type switch re-arms the attachment default rather than remembering the last answer:
  // "Bug report" means "attach my log" unless this bug report says otherwise.
  const setType = useCallback((t: FeedbackType): void => {
    setFields((f) => ({ ...f, type: t }))
    setAttachLog(t === 'bug')
  }, [])

  const draft = toDraft(fields)
  const problem = draftProblem(draft)

  const send = useCallback((): void => {
    setPhase('sending')
    const attach = fields.type === 'bug' && attachLog
    void window.eq
      .submitFeedback(toDraft(fields), { attachLog: attach, windowMinutes })
      .then((res) => {
        setOutcome(toOutcome(res))
        setPhase('done')
      })
      .catch((err: unknown) => {
        // submitFeedback is contractually non-rejecting; if the IPC itself dies we still owe
        // the user an answer rather than a dialog frozen on "Sending…".
        setOutcome({ kind: 'error', message: String(err) })
        setPhase('done')
      })
  }, [fields, attachLog, windowMinutes])

  return {
    fields,
    setField,
    setType,
    attachLog,
    setAttachLog,
    windowMinutes,
    setWindowMinutes,
    draft,
    problem,
    phase,
    outcome,
    send
  }
}
