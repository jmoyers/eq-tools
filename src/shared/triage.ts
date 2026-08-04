// ============================================================================
// TRIAGE CONTRACT — the shapes the DEV-ONLY triage tab moves across IPC.
// ============================================================================
//
// This file is the seam between `src/main/triage/**` (which talks to Aurora DSQL and S3 over
// the launching shell's AWS profile) and `src/renderer/src/features/triage/**` (which renders
// what it is handed and fetches nothing itself — the renderer never reaches the network, and
// the CSP is untouched by this feature).
//
// WHY THE SHAPES LIVE HERE AND NOT IN `src/main/triage`: the renderer names every one of them
// and cannot import from `src/main` under either tsconfig. Same reasoning, same placement as
// `src/shared/feedback.ts`'s IPC-crossing block.
//
// PURE, like every other `src/shared/**` module: zero imports beyond the feedback contract's
// own type unions, no `node:`, no Electron, no DOM.
//
// THE LAW (docs/plans/feedback-triage.md §10.3) applies to everything here: a raw log slice
// never reaches anything public. `TriageSlice.lines` travels main -> renderer over IPC and is
// rendered in a local window; it is never written to a file the app publishes, never put in an
// issue body, and only ever exists in a build that has the dev flag compiled in.

import type {
  AppChannelTag,
  FeedbackType,
  ReportStatus,
  Severity
} from './feedback'

// ---- filters --------------------------------------------------------------------------

export type TriageChannelFilter = AppChannelTag | 'all'

/** Every field is re-validated AT THE HANDLER — `since` reaches `parseSince`, `limit` reaches
 *  a SQL `LIMIT`, and the two unions reach a WHERE clause. */
export interface TriageListQuery {
  channel: TriageChannelFilter
  /** `7d` / `12h` / `30m` / an ISO date — the CLI's own `--since` grammar. */
  since: string
  limit: number
  status?: ReportStatus
  type?: FeedbackType
}

/** The list's `since` choices, so the toolbar and the validator cannot disagree. */
export const TRIAGE_SINCE_CHOICES = ['24h', '7d', '30d', '90d', '365d'] as const
export const TRIAGE_LIMIT_MAX = 500
export const TRIAGE_DEFAULT_QUERY: TriageListQuery = {
  channel: 'all',
  since: '30d',
  limit: 200
}

// ---- rows -----------------------------------------------------------------------------

/**
 * Whether this report has a log slice, and whether it actually LANDED.
 *
 * TRI-STATE ON PURPOSE. `declared` means the report row carries slice metadata; whether the
 * presigned upload ever completed is a separate fact that costs one HeadObject to learn, so
 * the LIST reports `none | declared` (no per-row round trip) and the DETAIL upgrades it to
 * `present | missing`. Collapsing the two would make "the upload failed or expired" — a real
 * case the CLI prints — indistinguishable from a healthy attachment.
 */
export type TriageLogState = 'none' | 'declared' | 'present' | 'missing'

/** One row of the Reports table. The description IS the report: `title` and `contact` were
 *  retired from the wire contract and then dropped from the schema, so there is nothing here
 *  for a list to leak (the same rule `TriageReport` in scripts/triageCluster.mts obeys). */
export interface TriageRow {
  reportId: string
  type: FeedbackType
  description: string
  appVersion: string
  platform: string
  channel: AppChannelTag
  status: ReportStatus
  severity?: Severity
  cluster?: string
  spamScore: number
  receivedAt: number
  triagedAt?: number
  /** `none` or `declared` here — the list never pays for a HeadObject. */
  log: TriageLogState
}

/** The full record behind one row. There is no `contact`: the column is gone from the schema,
 *  so the detail pane has nothing extra to show and `forget` has nothing extra to clear. */
export interface TriageDetail {
  row: TriageRow
  installId: string
  clientTs: number
  /** `env_json`, parsed. TEXT-holding-JSON in the schema, so the parse is total: an
   *  unparseable blob yields `{}` rather than throwing across IPC. */
  env: Record<string, string>
  dupeOf?: string
  issueUrl?: string
  note?: string
  /** Stamped by `forget`: this report's log slice was destroyed on request. */
  redactedAt?: number
  logKey?: string
  /** From `log_json` — what the client SAID it uploaded. */
  logBytes?: number
  logLines?: number
  /** Resolved against S3: `present` or `missing` when a key exists, else `none`. */
  log: TriageLogState
}

/** The triage-only writes. Mirrors the CLI's `set` flags exactly. */
export interface TriagePatch {
  status?: ReportStatus
  severity?: Severity
  cluster?: string
  dupeOf?: string
  note?: string
}

// ---- the log slice --------------------------------------------------------------------

/**
 * A downloaded, gunzipped slice, CAPPED for the bridge. The bytes are fetched in main, cached
 * under `.triage/slices/` (gitignored twice over) and only `lines` crosses IPC — the same
 * discipline `feedback:buildSlice` uses for the outbound preview, and for the same reason: a
 * multi-megabyte string does not belong on the bridge.
 */
export interface TriageSlice {
  reportId: string
  lines: string[]
  /** True when the slice holds more than `lines` shows — `totalLines` is the real count. */
  truncated: boolean
  totalLines: number
  /** Where the cached copy lives on this machine. Local, gitignored, never published. */
  path: string
}

// ---- ops ------------------------------------------------------------------------------

/**
 * The kill switch, stated POSITIVELY.
 *
 * The CLI spells this as `closed on|off`, which is a double negative once it reaches
 * `setAccepting(state === 'off')`. The UI owns one polarity — `accepting` — and its label says
 * so, because an inverted kill switch is the single worst bug this panel could ship.
 */
export interface TriageOpsState {
  accepting: boolean
  closedMessage: string
  maxPerInstallPerDay: number
  blocked: TriageBlockedInstall[]
}

export interface TriageBlockedInstall {
  installId: string
  blocked: boolean
  reason?: string
  blockedAt?: number
}

// ---- digest ---------------------------------------------------------------------------

/** Structurally identical to `Cluster` in scripts/triageCluster.mts, restated here because the
 *  renderer cannot import from `scripts/` under tsconfig.web. Main passes those values through. */
export interface TriageClusterView {
  id: string
  kind: 'crash' | 'tokens'
  signature?: string
  reportIds: string[]
  types: FeedbackType[]
  versions: string[]
  regression: boolean
  withLogs: number
  label: string
}

export interface TriageDigest {
  /** Exactly what `triage-feedback digest` prints — the same `renderDigest` call. */
  markdown: string
  clusters: TriageClusterView[]
  reportCount: number
}

// ---- analytics (usage telemetry — NOT BUILT YET) ---------------------------------------

/**
 * The Analytics tab consumes this, and today it always answers `available: false`.
 *
 * Usage analytics is planned in `docs/plans/usage-analytics.md`: wave A1 is the client and A2
 * is the infra that would give this tab a table to read. Neither is built. The tab states that
 * plainly rather than rendering zeros — a dashboard of zeros is indistinguishable from a
 * dashboard of "nobody used the app", and this app does not fabricate data (world-model law 1).
 * The `available: true` arm is written out so the shape is fixed now and A2 has a target.
 */
export interface TriageAnalyticsData {
  windowDays: number
  installs: number
  sessions: number
  byVersion: { version: string; installs: number }[]
  byPlatform: { platform: string; installs: number }[]
  byFeature: { feature: string; opens: number }[]
}

export type TriageAnalytics =
  | { available: false; reason: string; table: string }
  | { available: true; data: TriageAnalyticsData }

// ---- the reply envelope ----------------------------------------------------------------

/**
 * EVERY triage channel answers with one of these instead of rejecting.
 *
 * The failure mode this exists for is not a bug, it is the ACCESS CONTROL working: a shell
 * without the owner's AWS credentials gets an IAM denial from DSQL or S3 on the very first
 * statement. That has to render as prose in the panel, not as an unhandled rejection in a
 * renderer that then shows a blank tab.
 */
export type TriageResult<T> = { ok: true; value: T } | { ok: false; error: string }
