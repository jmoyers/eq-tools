// ============================================================================
// backend.ts — the TriageBackend seam, and its one AWS-touching implementation.
// ============================================================================
//
// WHY AN INTERFACE AT ALL. `store.ts` is a set of free functions over a `Clients` value it
// builds itself from a Terraform output file and an AWS profile; it offers no injection point,
// so an IPC handler written directly against it can only be exercised with real credentials
// against the real cluster. The interface below is the injection point: `ipc.ts` names only
// `TriageBackend`, and `awsBackend()` is a thin pass-through whose entire job is to turn rows
// into the shapes in `src/shared/triage.ts` (all of which live in `rows.ts`, pure and tested).
//
// LAZY, AND ONE CONNECTION. `makeClients` opens the postgres socket on the FIRST statement,
// so merely having the triage tab compiled in costs nothing until the user opens it. The
// client is held for the process lifetime — a live DSQL connection is what makes the second
// query fast, and `close()` exists for the app's own teardown.
//
// CREDENTIALS COME FROM THE LAUNCHING SHELL: `AWS_PROFILE`, defaulting to `eqc` — the same
// profile name the CLI is documented with in AGENTS.md. Possession of those credentials IS
// the access control (see the header of store.ts); a different shell gets IAM denials, which
// arrive here as ordinary errors and are rendered as prose.

import { readFileSync } from 'node:fs'
import { PREVIEW_MAX_LINES } from '../../shared/feedback'
import type {
  TriageAnalytics,
  TriageDetail,
  TriageDigest,
  TriageListQuery,
  TriageOpsState,
  TriagePatch,
  TriageRow,
  TriageSlice
} from '../../shared/triage'
import {
  clusterReports,
  parseSince,
  renderDigest,
  type TriageReport
} from '../../../scripts/triageCluster.mjs'
import {
  deleteSlice,
  downloadSlice,
  getFeedbackConfig,
  getReport,
  listInstallProfiles,
  listReports,
  loadStack,
  logKeyOf,
  logObjectExists,
  makeClients,
  missingTable,
  readAnalyticsInstalls,
  readUsageDaily,
  readUsageFunnelDaily,
  setAccepting,
  setBlocked,
  setTriage,
  stampRedacted,
  toTriageReport,
  type Clients,
  type ListFilter
} from './store'
import { toDetail, toOps, toRow } from './rows'
import { buildAnalytics } from './analytics'
import { addDays, dayOf, toFunnelRows, toInstallRows, toUsageRows } from './usageRows'

/** The whole surface `ipc.ts` is allowed to reach. Nothing here knows about Electron. */
export interface TriageBackend {
  list: (q: TriageListQuery) => Promise<TriageRow[]>
  detail: (reportId: string) => Promise<TriageDetail | null>
  slice: (reportId: string) => Promise<TriageSlice | null>
  patch: (reportId: string, patch: TriagePatch) => Promise<void>
  /** Delete the S3 slice object and stamp the redaction. The report STAYS — it is the report. */
  forget: (reportId: string) => Promise<void>
  ops: () => Promise<TriageOpsState>
  setAccepting: (accepting: boolean, message?: string) => Promise<void>
  setBlocked: (installId: string, blocked: boolean, reason: string) => Promise<void>
  digest: (q: TriageListQuery) => Promise<TriageDigest>
  /** Usage analytics over the last `days`. Answers `available:false` ONLY for missing tables. */
  analytics: (days: number) => Promise<TriageAnalytics>
  close: () => Promise<void>
}

/** The profile whose credentials this process signs with. Owner's shell, owner's access. */
export const TRIAGE_PROFILE = process.env.AWS_PROFILE ?? 'eqc'

function toFilter(q: TriageListQuery, now: number): ListFilter {
  return {
    channel: q.channel,
    sinceMs: parseSince(q.since, now),
    limit: q.limit,
    ...(q.status === undefined ? {} : { status: q.status }),
    ...(q.type === undefined ? {} : { type: q.type })
  }
}

/**
 * The digest's inputs, in the CLI's exact order: map, then sort by reportId, then cluster.
 *
 * THE SORT IS LOAD-BEARING, not cosmetic. reportId is a ULID, so sorting by it is sorting by
 * MINT TIME, and `clusterReports` derives each cluster's id from its first member. Feed it
 * `received_at DESC` (which is what `listReports` returns) and the same backlog yields
 * different cluster ids than the CLI printed an hour ago.
 */
function digestInputs(rows: Record<string, unknown>[]): TriageReport[] {
  return rows.map(toTriageReport).sort((a, b) => a.reportId.localeCompare(b.reportId))
}

export function awsBackend(): TriageBackend {
  let held: Clients | null = null
  const clients = (): Clients => {
    held ??= makeClients(loadStack(), { profile: TRIAGE_PROFILE })
    return held
  }

  const detail = async (reportId: string): Promise<TriageDetail | null> => {
    const c = clients()
    const row = await getReport(c, reportId)
    if (!row) return null
    const key = logKeyOf(row)
    // ONE HeadObject, and only when a key exists — this is what upgrades `declared` to
    // `present` / `missing`, and it is why the LIST does not attempt the same answer.
    return toDetail(row, key === null ? false : await logObjectExists(c, key))
  }

  return {
    list: async (q) => (await listReports(clients(), toFilter(q, Date.now()))).map(toRow),

    detail,

    slice: async (reportId) => {
      const c = clients()
      const row = await getReport(c, reportId)
      if (!row) return null
      const key = logKeyOf(row)
      if (key === null) return null
      const path = await downloadSlice(c, reportId, key)
      // The gz bytes stay in main and on disk; only text crosses the bridge, capped by the
      // same constant the outbound feedback preview uses. THE LAW still holds: these lines
      // are rendered in a local window and go nowhere else.
      const all = readFileSync(path, 'utf8').split(/\r?\n/)
      const lines = all.slice(0, PREVIEW_MAX_LINES)
      return { reportId, lines, truncated: all.length > lines.length, totalLines: all.length, path }
    },

    patch: (reportId, patch) => setTriage(clients(), reportId, patch),

    forget: async (reportId) => {
      const c = clients()
      const row = await getReport(c, reportId)
      if (!row) throw new Error(`no such report: ${reportId}`)
      const key = logKeyOf(row)
      // Statement for statement, this is the CLI's `forget`: the slice object goes and the row
      // is stamped redacted. The report stays because the description IS the bug report — and
      // there is no contact column left to clear, the schema dropped it.
      if (key) await deleteSlice(c, key)
      await stampRedacted(c, reportId)
    },

    ops: async () => {
      const c = clients()
      return toOps(await getFeedbackConfig(c), await listInstallProfiles(c))
    },

    setAccepting: (accepting, message) => setAccepting(clients(), accepting, message),

    setBlocked: (installId, blocked, reason) => setBlocked(clients(), installId, blocked, reason),

    digest: async (q) => {
      const filter = toFilter(q, Date.now())
      const reports = digestInputs(await listReports(clients(), filter))
      const clusters = clusterReports(reports)
      const markdown = renderDigest(reports, clusters, {
        sinceMs: filter.sinceMs,
        nowMs: Date.now(),
        channel: q.channel
      })
      return { markdown, clusters, reportCount: reports.length }
    },

    /**
     * THE TWO FAILURES THIS DISTINGUISHES, because the panel renders them completely
     * differently and conflating them would be the tab's worst lie:
     *
     *   * `42P01 undefined_table` — the A2 migration has not been applied to this cluster.
     *     There is no data because there is nowhere to put it: `available:false`, naming the
     *     table, which is a fact an operator can act on.
     *   * EVERY OTHER OUTCOME, including three empty result sets — the tables exist and are
     *     empty (which is exactly the state while `TELEMETRY_API_URL` is still ''). That is
     *     honest zeros plus "no data yet", not a "not built" banner.
     *
     * Anything else (an IAM denial, a dropped socket) is thrown and reaches the panel as prose
     * through `attempt()`, the same as every other triage call.
     */
    analytics: async (days) => {
      const c = clients()
      const since = addDays(dayOf(Date.now()), -(days - 1))
      try {
        const [usage, funnels, installs] = await Promise.all([
          readUsageDaily(c, since),
          readUsageFunnelDaily(c, since),
          readAnalyticsInstalls(c)
        ])
        return {
          available: true,
          data: buildAnalytics({
            usage: toUsageRows(usage),
            funnels: toFunnelRows(funnels),
            installs: toInstallRows(installs),
            windowDays: days,
            nowMs: Date.now()
          })
        }
      } catch (err) {
        const table = missingTable(err)
        if (table === null) throw err
        return {
          available: false,
          table,
          reason:
            `The usage-analytics tables are not on this cluster (${table} does not exist). ` +
            'They are created by `npx tsx scripts/triage-feedback.mts migrate`, which applies ' +
            'infra/schema.sql — run it after the apply that ships wave A2.'
        }
      }
    },

    close: async () => {
      const open = held
      held = null
      if (open) await open.close()
    }
  }
}
