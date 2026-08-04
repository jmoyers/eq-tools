// IPC: in-app feedback — the four channels behind the report dialog (§4.3).
//
// EVERY RENDERER-SUPPLIED STRING IS VALIDATED HERE, at the boundary, not deeper in and not
// "because today's only caller is the app's own UI". That is the same law `sounds:getData`'s
// `packId` obeys, and it applies for the same reason: a handler is a public function of the
// renderer process, and the renderer is the part of this app most likely to be running
// someone else's code some day.
//
// What that means concretely:
//   * `windowMinutes` must be one of `LOG_WINDOW_CHOICES` — an enum, not a range. It reaches a
//     read of the user's game log; an arbitrary number would let the renderer choose how much
//     of it to materialize.
//   * the draft goes through `validateDraft` — the SAME pure validator the dialog gates Send on
//     and the ingest Lambda runs, so the three can never disagree about what "valid" means.
//
// Nothing here reaches past `src/main/feedback/index.ts`: the façade is the whole surface, and
// the slicer/queue/transport stay private to it. Registration is one line in
// `src/main/ipc/index.ts`, owned by the IPC-surface agent.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { LOG_WINDOW_CHOICES, validateDraft, type SubmitErrorCode } from '../../shared/feedback'
import { buildLogSlice, feedbackContext, saveSliceToFile, submitFeedback } from '../feedback'

/** The window selector's ONLY legal values (15 / 30 / 60 minutes). */
function isWindowChoice(v: unknown): v is (typeof LOG_WINDOW_CHOICES)[number] {
  return typeof v === 'number' && (LOG_WINDOW_CHOICES as readonly number[]).includes(v)
}

/** A rejection shaped like every other `SubmitResult`, so the dialog has one code path. */
function refuse(
  message: string,
  field?: string
): { ok: false; error: SubmitErrorCode; message: string; queued: boolean; field?: string } {
  return { ok: false, error: 'invalid_payload', message, queued: false, ...(field === undefined ? {} : { field }) }
}

export function registerFeedbackIpc(): void {
  // Header context: versions, channel, queued count, whether this build has an endpoint.
  ipcMain.handle(IPC.feedbackContext, () => feedbackContext())

  // Build the scrubbed slice and return a CAPPED preview. The gz bytes never cross IPC.
  // An unrecognized window is null (the dialog's "no log to attach" state), never a guess.
  ipcMain.handle(IPC.feedbackBuildSlice, async (_e, windowMinutes: unknown) =>
    isWindowChoice(windowMinutes) ? await buildLogSlice(windowMinutes) : null
  )

  // Write the FULL slice to a user-chosen path via the OS save dialog.
  ipcMain.handle(IPC.feedbackSaveSlice, async (_e, windowMinutes: unknown) =>
    isWindowChoice(windowMinutes) ? await saveSliceToFile(windowMinutes) : { ok: false }
  )

  // Submit. NEVER rejects: a network failure resolves with `{ok:false, queued:true}`.
  ipcMain.handle(IPC.feedbackSubmit, async (_e, draft: unknown, opts: unknown) => {
    const valid = validateDraft(draft)
    if (!valid.ok) return refuse(valid.message, valid.field)
    if (typeof opts !== 'object' || opts === null) return refuse('Missing send options.', 'opts')
    const { attachLog, windowMinutes } = opts as { attachLog?: unknown; windowMinutes?: unknown }
    if (typeof attachLog !== 'boolean') return refuse('attachLog must be true or false.', 'attachLog')
    if (!isWindowChoice(windowMinutes)) {
      return refuse(`windowMinutes must be one of: ${LOG_WINDOW_CHOICES.join(', ')}.`, 'windowMinutes')
    }
    return await submitFeedback(valid.value, { attachLog, windowMinutes })
  })
}
