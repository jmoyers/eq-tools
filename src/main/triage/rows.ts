// ============================================================================
// rows.ts — DSQL row -> the shapes that cross the bridge. Pure, AWS-free, tested.
// ============================================================================
//
// Split out of backend.ts for the same reason triageCluster.mts is split out of the CLI: the
// interesting decisions here are decisions about MEANING, and they must be testable without a
// database, a network or credentials. Nothing in this file imports `pg`, `@aws-sdk/*` or
// Electron, so `tests/triageIpcGuard.test.mts` loads it directly.
//
// Two of those decisions are load-bearing:
//
//   * THE LOG STATE IS TRI-STATE. `log_json` present means the client DECLARED a slice;
//     whether the presigned upload actually landed is a separate fact that costs a HeadObject.
//     The list stops at `declared`, the detail resolves `present` / `missing`. Flattening the
//     two would erase the failed-upload case, which is real and which the CLI prints.
//   * `env_json` IS TEXT HOLDING JSON (schema.sql says so, and nothing ever queries into it).
//     So the parse is TOTAL: a truncated or non-object blob yields `{}`. A detail pane that
//     throws because one row's env is malformed is worse than one that shows no env.

import type {
  TriageDetail,
  TriageLogState,
  TriageOpsState,
  TriageBlockedInstall,
  TriageRow
} from '../../shared/triage'
import type {
  AppChannelTag,
  FeedbackType,
  ReportStatus,
  Severity
} from '../../shared/feedback'

/** A DSQL row as node-postgres hands it over: every column is `unknown` until proven. */
export type Row = Record<string, unknown>

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)
/** Optional text column: NULL and '' both mean "not set", never the empty string. */
const opt = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s.length > 0 ? s : undefined
}
const optNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** TOTAL: never throws, never returns a non-object, never yields non-string values. */
export function parseEnv(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return out
}

/** `log_json` holds the LogSliceMeta the client sent. Total, like parseEnv. */
function parseLogMeta(raw: unknown): { bytes?: number; lines?: number } {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const meta = parsed as { bytes?: unknown; lines?: unknown }
    return {
      ...(typeof meta.bytes === 'number' ? { bytes: meta.bytes } : {}),
      ...(typeof meta.lines === 'number' ? { lines: meta.lines } : {})
    }
  } catch {
    return {}
  }
}

/** Did this report DECLARE a slice? (Not: did it land — that needs S3.) */
export function declaresLog(row: Row): boolean {
  return row.log_json !== null && row.log_json !== undefined
}

/** One list row. The description IS the report — there is no title and no contact to read. */
export function toRow(row: Row): TriageRow {
  const severity = opt(row.severity)
  const cluster = opt(row.cluster_id)
  const triagedAt = optNum(row.triaged_at)
  return {
    reportId: str(row.report_id),
    type: str(row.report_type, 'bug') as FeedbackType,
    description: str(row.description),
    appVersion: str(row.app_version, '?'),
    platform: str(row.platform, '?'),
    channel: str(row.channel, 'prod') as AppChannelTag,
    status: str(row.status, 'new') as ReportStatus,
    ...(severity ? { severity: severity as Severity } : {}),
    ...(cluster ? { cluster } : {}),
    spamScore: num(row.spam_score),
    receivedAt: num(row.received_at),
    ...(triagedAt === undefined ? {} : { triagedAt }),
    log: declaresLog(row) ? 'declared' : 'none'
  }
}

/**
 * The full record. `logLanded` is the caller's HeadObject answer and is only consulted when a
 * key exists — passing `false` for a report that never attached anything must NOT read as a
 * failed upload.
 */
export function toDetail(row: Row, logLanded: boolean): TriageDetail {
  const key = opt(row.log_key)
  const meta = parseLogMeta(row.log_json)
  const dupeOf = opt(row.dupe_of)
  const issueUrl = opt(row.issue_url)
  const note = opt(row.disposition)
  const redactedAt = optNum(row.redacted_at)
  const log: TriageLogState = !declaresLog(row) && !key ? 'none' : logLanded ? 'present' : 'missing'
  return {
    row: toRow(row),
    installId: str(row.install_id),
    clientTs: num(row.client_ts),
    env: parseEnv(row.env_json),
    ...(dupeOf ? { dupeOf } : {}),
    ...(issueUrl ? { issueUrl } : {}),
    ...(note ? { note } : {}),
    ...(redactedAt === undefined ? {} : { redactedAt }),
    ...(key ? { logKey: key } : {}),
    ...(meta.bytes === undefined ? {} : { logBytes: meta.bytes }),
    ...(meta.lines === undefined ? {} : { logLines: meta.lines }),
    log
  }
}

/** Default kill-switch prose for a cluster whose seed row is missing entirely. */
const NO_CONFIG_MESSAGE = 'Feedback is not open yet. Please try again later.'

/**
 * The Ops state, stated POSITIVELY (`accepting`), which is the opposite polarity from the
 * CLI's `closed on|off`. One polarity, chosen here, labelled in the UI — see the note on
 * `TriageOpsState`. A missing config row reads as NOT accepting, matching schema.sql's seed:
 * a stack whose switch has never been set is closed, and this panel must not claim otherwise.
 */
export function toOps(config: Row | null, profiles: readonly Row[]): TriageOpsState {
  return {
    accepting: config?.accepting === true,
    closedMessage: str(config?.closed_message, NO_CONFIG_MESSAGE),
    maxPerInstallPerDay: num(config?.max_per_install_per_day, 0),
    blocked: profiles.map(toBlocked)
  }
}

export function toBlocked(row: Row): TriageBlockedInstall {
  const reason = opt(row.blocked_reason)
  const blockedAt = optNum(row.blocked_at)
  return {
    installId: str(row.install_id),
    blocked: row.blocked === true,
    ...(reason ? { reason } : {}),
    ...(blockedAt === undefined ? {} : { blockedAt })
  }
}
