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
  redactContact,
  setAccepting,
  setBlocked,
  setTriage,
  toTriageReport,
  type Clients,
  type ListFilter
} from './store'
import { toDetail, toOps, toRow } from './rows'

/** The whole surface `ipc.ts` is allowed to reach. Nothing here knows about Electron. */
export interface TriageBackend {
  list: (q: TriageListQuery) => Promise<TriageRow[]>
  detail: (reportId: string) => Promise<TriageDetail | null>
  slice: (reportId: string) => Promise<TriageSlice | null>
  patch: (reportId: string, patch: TriagePatch) => Promise<void>
  /** Strip the contact and delete the S3 object. The description STAYS — it is the report. */
  forget: (reportId: string) => Promise<void>
  ops: () => Promise<TriageOpsState>
  setAccepting: (accepting: boolean, message?: string) => Promise<void>
  setBlocked: (installId: string, blocked: boolean, reason: string) => Promise<void>
  digest: (q: TriageListQuery) => Promise<TriageDigest>
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
      // Statement for statement, this is the CLI's `forget`: the object goes, the contact is
      // nulled and stamped, the description stays because the description IS the bug report.
      if (key) await deleteSlice(c, key)
      await redactContact(c, reportId)
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

    close: async () => {
      const open = held
      held = null
      if (open) await open.close()
    }
  }
}
