// ============================================================================
// validate.ts — every renderer-supplied triage argument, checked AT THE BOUNDARY.
// ============================================================================
//
// Same law as `sounds:getData`'s packId and `feedback:submit`'s draft: a handler is a public
// function of the renderer process, and it is validated because it is a boundary — not
// because we distrust today's only caller. The triage tab compiles into dev builds only, and
// this file still validates everything, because "the gate upstream is closed" is an argument
// for defence in depth, not against it.
//
// TWO ARGUMENTS ARE GENUINELY DANGEROUS AND EACH GETS A SHAPE, NOT A TYPE CHECK:
//
//   * `reportId` reaches a FILE PATH — `.triage/slices/<reportId>.log` — as well as a SQL
//     parameter. A ULID is 26 Crockford base32 characters (no I, L, O, U) and nothing else, so
//     that is what is required. `..` and separators cannot survive it. This is the same
//     reasoning as `isSafePackId`, applied before the string reaches `join()`.
//   * `since` reaches `parseSince`, which accepts an arbitrary `Date.parse`-able string. The
//     window is restricted to the toolbar's own choices, so the answer set is bounded by an
//     enum rather than by whatever the renderer computes.
//
// PURE: no Electron, no AWS, no `node:` — which is what lets tests/triageIpcGuard.test.mts
// load it and pin every rule without credentials.

import { FEEDBACK_TYPES, REPORT_STATUSES, SEVERITIES } from '../../shared/feedback'
import {
  TRIAGE_LIMIT_MAX,
  TRIAGE_SINCE_CHOICES,
  type TriageChannelFilter,
  type TriageListQuery,
  type TriagePatch
} from '../../shared/triage'

/** Crockford base32, 26 characters — the exact shape of a server-minted report id. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
/** `crypto.randomUUID()` shape — an installId, as minted by the client. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const CHANNELS: readonly TriageChannelFilter[] = ['prod', 'dev', 'all']

/** Bounds for the free-text triage fields. Generous, but not unbounded — every one of these
 *  is written into a column that the digest and the Ops panel then render. */
export const MAX_NOTE = 2_000
export const MAX_CLUSTER_ID = 64
export const MAX_REASON = 500
export const MAX_CLOSED_MESSAGE = 500

function isIn<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v)
}

/** A trimmed, non-empty, bounded string — or null, which every caller treats as "reject". */
function boundedText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 && t.length <= max ? t : null
}

export function isReportId(v: unknown): v is string {
  return typeof v === 'string' && ULID_RE.test(v)
}

export function isInstallId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

/** A whole number the SQL `LIMIT` can carry, inside the bound the toolbar can ask for. */
function isLimit(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= TRIAGE_LIMIT_MAX
}

/** The two OPTIONAL filters. Absent is fine; present-but-illegal is a rejection, never a drop. */
function queryFilters(q: Record<string, unknown>): Pick<TriageListQuery, 'status' | 'type'> | null {
  if (q.status !== undefined && !isIn(q.status, REPORT_STATUSES)) return null
  if (q.type !== undefined && !isIn(q.type, FEEDBACK_TYPES)) return null
  return {
    ...(q.status === undefined ? {} : { status: q.status }),
    ...(q.type === undefined ? {} : { type: q.type })
  }
}

/**
 * The list/digest query. Returns null on ANYTHING unexpected — no clamping, no defaults
 * filled in silently. A renderer that asks for something illegal gets an error it can show,
 * which is more useful than a quietly different answer than the one on screen.
 */
export function validateQuery(raw: unknown): TriageListQuery | null {
  if (typeof raw !== 'object' || raw === null) return null
  const q = raw as Record<string, unknown>
  if (!isIn(q.channel, CHANNELS)) return null
  if (!isIn(q.since, TRIAGE_SINCE_CHOICES)) return null
  if (!isLimit(q.limit)) return null
  const filters = queryFilters(q)
  if (filters === null) return null
  return { channel: q.channel, since: q.since, limit: q.limit, ...filters }
}

/** The closed-union half of a patch. Mutates `patch`; false means "reject the whole thing". */
function patchUnions(p: Record<string, unknown>, patch: TriagePatch): boolean {
  if (p.status !== undefined) {
    if (!isIn(p.status, REPORT_STATUSES)) return false
    patch.status = p.status
  }
  if (p.severity !== undefined) {
    if (!isIn(p.severity, SEVERITIES)) return false
    patch.severity = p.severity
  }
  // dupeOf names ANOTHER report, so it is held to the same ULID shape as reportId.
  if (p.dupeOf !== undefined) {
    if (!isReportId(p.dupeOf)) return false
    patch.dupeOf = p.dupeOf
  }
  return true
}

/** The free-text half. Same contract: mutate on success, false to reject. */
function patchText(p: Record<string, unknown>, patch: TriagePatch): boolean {
  if (p.cluster !== undefined) {
    const cluster = boundedText(p.cluster, MAX_CLUSTER_ID)
    if (cluster === null) return false
    patch.cluster = cluster
  }
  if (p.note !== undefined) {
    const note = boundedText(p.note, MAX_NOTE)
    if (note === null) return false
    patch.note = note
  }
  return true
}

/**
 * The triage write. An EMPTY patch is rejected: `setTriage` would otherwise stamp `triaged_at`
 * and change nothing, which is a lie about the record having been triaged.
 *
 * `issueUrl` is deliberately NOT accepted here. It is stamped by `triage-feedback issue`,
 * which is the command that ran `assertNoLogSlice` over the body it posted — letting the UI
 * write that column would put a URL on a report with no evidence anything was published.
 */
export function validatePatch(raw: unknown): TriagePatch | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  const patch: TriagePatch = {}
  if (!patchUnions(p, patch) || !patchText(p, patch)) return null
  return Object.keys(patch).length > 0 ? patch : null
}

/** The kill switch's optional prose. `undefined` keeps whatever the cluster already says. */
export function validateClosedMessage(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return undefined
  return boundedText(raw, MAX_CLOSED_MESSAGE)
}

/** Blocking REQUIRES a reason (the profile records why); unblocking does not. */
export function validateBlockReason(raw: unknown, blocked: boolean): string | null {
  if (!blocked && (raw === undefined || raw === null)) return 'unblocked'
  return boundedText(raw, MAX_REASON)
}
