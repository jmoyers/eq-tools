// IPC: class-combo user corrections — the two WRITE channels of the combo feature.
//
// Reads do not appear here on purpose: the combo module rides the generic module transport
// (`module:getSnapshot('combo')` + `module:delta`, ipc/world.ts), like every other module.
// A correction is different in kind — it is persisted per character and it re-labels the past.
//
// EVERY FIELD IS VALIDATED AT THE HANDLER (the trust-boundary rule in AGENTS.md): a renderer
// string is a renderer string whether or not today's only caller is the app's own UI. `classes`
// must be 1–3 members of the closed ClassAbbr set, deduped; timestamps must be finite, ordered,
// and at/after the launch epoch (a pre-launch correction describes the wiped beta character and
// the store migration drops it anyway — refusing it here means it never gets written).

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import { isClassAbbr, MAX_COMBO_SLOTS, type ClassAbbr, type ComboCorrection } from '../../shared/classCombo'
import { LAUNCH_MS } from '../log/epochDetector'
import { comboModule } from '../pipeline'
import { activeCharId } from '../session'
import { clearComboCorrections, getComboCorrections, setComboCorrection } from '../store'

/** A validated `[startTs, endTs]` span, or null. `endTs` null means "from startTs onward". */
function span(raw: unknown): { startTs: number; endTs: number | null } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { startTs, endTs } = raw as { startTs?: unknown; endTs?: unknown }
  if (typeof startTs !== 'number' || !Number.isFinite(startTs) || startTs < LAUNCH_MS) return null
  if (endTs === null || endTs === undefined) return { startTs, endTs: null }
  if (typeof endTs !== 'number' || !Number.isFinite(endTs) || endTs < startTs) return null
  return { startTs, endTs }
}

/** 1–3 distinct ClassAbbr codes, or null. Anything else is rejected whole, never filtered. */
function classes(raw: unknown): ClassAbbr[] | null {
  if (!Array.isArray(raw)) return null
  const deduped = [...new Set(raw)]
  if (deduped.length !== raw.length) return null
  if (deduped.length < 1 || deduped.length > MAX_COMBO_SLOTS) return null
  return deduped.every(isClassAbbr) ? deduped : null
}

export function registerComboIpc(): void {
  // Character-scoped, PULLED rather than pushed: `reset()` on a character switch marks the
  // module stale and the next recompute asks this provider again. See ComboModule.
  comboModule.setCorrectionsProvider(() => getComboCorrections(activeCharId()))

  ipcMain.handle(IPC.comboSetCorrection, (_e, payload: unknown) => {
    const range = span(payload)
    const picked = classes((payload as { classes?: unknown } | null)?.classes)
    if (!range || !picked) return { ok: false as const, error: 'Invalid combo correction.' }
    const correction: ComboCorrection = { ...range, classes: picked, setAt: Date.now() }
    setComboCorrection(activeCharId(), correction)
    comboModule.invalidate()
    return { ok: true as const }
  })

  ipcMain.handle(IPC.comboClearCorrection, (_e, payload: unknown) => {
    const range = span(payload)
    if (!range) return { ok: false as const, error: 'Invalid combo range.' }
    clearComboCorrections(activeCharId(), range.startTs, range.endTs)
    comboModule.invalidate()
    return { ok: true as const }
  })
}
