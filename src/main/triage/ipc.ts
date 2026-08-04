// ============================================================================
// ipc.ts — the `triage:*` channels. DEV BUILDS ONLY. Never registered in a shipped app.
// ============================================================================
//
// HOW THIS MODULE IS REACHED, and why a shipped build cannot reach it — three independent
// locks, any one of which is sufficient:
//
//   1. THE GATE. `src/main/index.ts` calls `registerTriageIpc()` from inside
//      `if (!app.isPackaged && !E2E)`, behind a DYNAMIC `import()`. A packaged app never
//      evaluates this module at all, and neither does the headless e2e harness.
//   2. THE DEPENDENCIES. The chain below reaches `@aws-sdk/client-s3`,
//      `@aws-sdk/credential-providers`, `@aws-sdk/dsql-signer` and `pg` — every one of them a
//      **devDependency**. electron-builder packages `dependencies` only, so even a build with
//      the gate patched out would fail to resolve them. This is a structural property of the
//      packaging, not a runtime check someone can flip.
//   3. THE CREDENTIALS. Authentication is an IAM token that `@aws-sdk/dsql-signer` derives
//      locally from the LAUNCHING SHELL's AWS profile (`AWS_PROFILE`, default `eqc`) — the
//      same door the `triage-feedback` CLI uses. There is no password anywhere to leak.
//      Possession of the owner's IAM credentials IS the access control; any other shell gets
//      IAM denials on the first statement and this panel renders them as prose.
//
// THE RENDERER STILL DOES NOT GET TO BE TRUSTED. Every argument below is validated at the
// handler (`validate.ts`) — `reportId` in particular reaches a file path as well as a SQL
// parameter and is required to be a 26-character ULID and nothing else.
//
// THE LAW (§10.3): a raw log slice never reaches anything public. `triage:slice` moves capped
// slice TEXT from main to the renderer over IPC, where it is rendered in a local window. It is
// never written to a published artefact, never put in an issue body, and only exists in a
// build compiled with the dev flag on.

import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { TriageAnalytics, TriageResult } from '../../shared/triage'
import { awsBackend, type TriageBackend } from './backend'
import {
  isInstallId,
  isReportId,
  validateBlockReason,
  validateClosedMessage,
  validatePatch,
  validateQuery
} from './validate'

/**
 * Usage analytics has no table to read yet.
 *
 * `docs/plans/usage-analytics.md` wave A2 is the infra that would create one; A1 (the client)
 * is not built either. The panel says so in the app's own words rather than rendering zeros —
 * a zeroed dashboard is indistinguishable from "nobody used the app", and this app does not
 * invent data it cannot observe (world-model law 1).
 */
const ANALYTICS_UNAVAILABLE: TriageAnalytics = {
  available: false,
  table: 'usage_daily',
  reason:
    'Usage analytics lands with telemetry wave A2 (docs/plans/usage-analytics.md). ' +
    'Nothing is collected and no table exists yet, so there is nothing to show — ' +
    'this panel stays empty rather than rendering zeros.'
}

/** Prose, never a stack. An IAM denial is the ACCESS CONTROL WORKING and must read like it. */
function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/AccessDenied|not authorized|UnrecognizedClient|ExpiredToken|could not be refreshed|CredentialsProviderError/i.test(raw)) {
    return `${raw}\n\nThis surface authenticates with your shell's AWS profile (AWS_PROFILE, default 'eqc'). Nothing else grants access.`
  }
  return raw
}

/** One shape for every reply: a rejected invoke would leave the panel blank with no reason. */
async function attempt<T>(run: () => Promise<T>): Promise<TriageResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (err) {
    return { ok: false, error: message(err) }
  }
}

const REJECT = { ok: false as const, error: 'Invalid triage request — rejected at the handler.' }

/**
 * `backend` is injectable so the surface can be driven without AWS; the default is the real
 * one. Returns a disposer that closes the DSQL connection — the app calls it on teardown so a
 * live socket cannot hold the process open (the same hang the CLI's `finally` exists for).
 */
export function registerTriageIpc(backend: TriageBackend = awsBackend()): () => Promise<void> {
  ipcMain.handle(IPC.triageList, async (_e, raw: unknown) => {
    const q = validateQuery(raw)
    return q === null ? REJECT : await attempt(() => backend.list(q))
  })

  ipcMain.handle(IPC.triageDetail, async (_e, reportId: unknown) =>
    isReportId(reportId) ? await attempt(() => backend.detail(reportId)) : REJECT
  )

  ipcMain.handle(IPC.triageSlice, async (_e, reportId: unknown) =>
    isReportId(reportId) ? await attempt(() => backend.slice(reportId)) : REJECT
  )

  ipcMain.handle(IPC.triagePatch, async (_e, reportId: unknown, rawPatch: unknown) => {
    const patch = validatePatch(rawPatch)
    if (!isReportId(reportId) || patch === null) return REJECT
    return await attempt(() => backend.patch(reportId, patch))
  })

  ipcMain.handle(IPC.triageForget, async (_e, reportId: unknown) =>
    isReportId(reportId) ? await attempt(() => backend.forget(reportId)) : REJECT
  )

  ipcMain.handle(IPC.triageOps, async () => await attempt(() => backend.ops()))

  // POSITIVE POLARITY, decided once (see TriageOpsState): `accepting: false` is what the CLI
  // spells `closed on`. The UI label says "Accepting reports" so the switch cannot read
  // backwards.
  ipcMain.handle(IPC.triageSetAccepting, async (_e, accepting: unknown, rawMessage: unknown) => {
    const text = validateClosedMessage(rawMessage)
    if (typeof accepting !== 'boolean' || text === null) return REJECT
    return await attempt(() => backend.setAccepting(accepting, text))
  })

  ipcMain.handle(IPC.triageSetBlocked, async (_e, installId: unknown, blocked: unknown, rawReason: unknown) => {
    if (!isInstallId(installId) || typeof blocked !== 'boolean') return REJECT
    const reason = validateBlockReason(rawReason, blocked)
    if (reason === null) return REJECT
    return await attempt(() => backend.setBlocked(installId, blocked, reason))
  })

  ipcMain.handle(IPC.triageDigest, async (_e, raw: unknown) => {
    const q = validateQuery(raw)
    return q === null ? REJECT : await attempt(() => backend.digest(q))
  })

  ipcMain.handle(IPC.triageAnalytics, (): TriageResult<TriageAnalytics> => ({
    ok: true,
    value: ANALYTICS_UNAVAILABLE
  }))

  return () => backend.close()
}
