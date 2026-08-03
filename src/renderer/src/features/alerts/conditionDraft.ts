// conditionDraft — the trigger-editing draft model shared by the alert dialog's
// condition editor and the alert list's trigger badge.
//
// Extracted verbatim from AlertsView.tsx (Wave D factoring); behavior unchanged.

import type { AlertTrigger, AlertTriggerPrimitive, AppSignal, LogEventKind } from '@shared/types'

/** Compact badge for ONE primitive condition: `event:uncharm`, `raw:/regex/i`, `app:bossDefeat`. */
export function primitiveBadge(t: AlertTriggerPrimitive): string {
  if (t.type === 'event') {
    const where = t.where && Object.keys(t.where).length
      ? ` {${Object.entries(t.where).map(([k, v]) => `${k}=${v}`).join(', ')}}`
      : ''
    return `event:${t.kind}${where}`
  }
  if (t.type === 'raw') return `raw:/${t.regex}/i`
  return `app:${t.signal}`
}

/** Compact trigger badge; a composite renders `any(…, …)` / `all(…, …)` (Task #47). */
export function triggerBadge(t: AlertTrigger): string {
  if ('conditions' in t) {
    return `${t.type}(${t.conditions.map(primitiveBadge).join(', ')})`
  }
  return primitiveBadge(t)
}

/** Validate a raw regex live; returns an error string or null. */
export function regexError(src: string): string | null {
  if (!src.trim()) return 'Enter a pattern'
  try {
    // eslint-disable-next-line no-new
    new RegExp(src, 'i')
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid regex'
  }
}

// ── Composite-trigger editing (Task #47) ──────────────────────────────────────
//
// The dialog edits triggers as a "combine mode" (single / any / all) over a LIST of primitive
// CONDITION DRAFTS. A single-condition alert is `mode:'single'` (backward-compatible: renders
// exactly like before). `any`/`all` show the condition list with add/remove rows. Each draft
// holds the union of every primitive's fields; only the relevant ones are read per type.

export type CombineMode = 'single' | 'any' | 'all'

export interface ConditionDraft {
  ttype: AlertTriggerPrimitive['type']
  kind: LogEventKind
  fieldKey: string
  fieldVal: string
  regex: string
  signal: AppSignal
}

export function blankCondition(): ConditionDraft {
  return { ttype: 'event', kind: 'uncharm', fieldKey: '', fieldVal: '', regex: '', signal: 'bossDefeat' }
}

/** Hydrate a condition draft from a stored primitive trigger. */
export function draftFromPrimitive(t: AlertTriggerPrimitive): ConditionDraft {
  const d = blankCondition()
  d.ttype = t.type
  if (t.type === 'event') {
    d.kind = t.kind
    const first = t.where ? Object.entries(t.where)[0] : undefined
    d.fieldKey = first?.[0] ?? ''
    d.fieldVal = first?.[1] ?? ''
  } else if (t.type === 'raw') {
    d.regex = t.regex
  } else {
    d.signal = t.signal
  }
  return d
}

/** Build a stored primitive trigger from a condition draft. */
export function primitiveFromDraft(d: ConditionDraft): AlertTriggerPrimitive {
  if (d.ttype === 'raw') return { type: 'raw', regex: d.regex }
  if (d.ttype === 'app') return { type: 'app', signal: d.signal }
  const where =
    d.fieldKey.trim() && d.fieldVal.trim() ? { [d.fieldKey.trim()]: d.fieldVal.trim() } : undefined
  return { type: 'event', kind: d.kind, where }
}

/** The /regex/ validation error for a condition draft's field value, or null. */
export function conditionFieldValErr(d: ConditionDraft): string | null {
  if (d.ttype !== 'event') return null
  const v = d.fieldVal.trim()
  return v.startsWith('/') && v.endsWith('/') ? regexError(v.slice(1, -1)) : null
}

/** The raw-regex validation error for a condition draft, or null. */
export function conditionRawErr(d: ConditionDraft): string | null {
  return d.ttype === 'raw' ? regexError(d.regex) : null
}
