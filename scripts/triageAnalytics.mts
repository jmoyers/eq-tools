/**
 * triageAnalytics.mts — the `analytics …` subcommands of `triage-feedback`.
 *
 * A separate file for the reason every split in this repo is: `triage-feedback.mts` was at the
 * 400-code-line ceiling, and a split is the answer to that rather than a widened threshold
 * (`triageCluster.mts`, `analyticsDigest.mts` and `src/main/triage/store.ts` are the same
 * move). Nothing about the CLI's shape changes: `analytics` is one entry in its COMMANDS table
 * and this module is what that entry runs.
 *
 * IT READS THE SAME CODE THE APP DOES. `buildAnalytics` here is the same function
 * `src/main/triage/backend.ts` calls for the Analytics tab, over the same statements in
 * `store.ts`. The CLI and the panel cannot print different numbers for the same window.
 */

import {
  deleteAnalyticsInstall,
  readAnalyticsInstalls,
  readUsageDaily,
  readUsageFunnelDaily,
  setTelemetryAccepting,
  type Clients,
} from '../src/main/triage/store'
import { buildAnalytics } from '../src/main/triage/analytics'
import {
  addDays,
  dayOf,
  toFunnelRows,
  toInstallRows,
  toUsageRows,
} from '../src/main/triage/usageRows'
import { renderAnalyticsDigest } from './analyticsDigest.mjs'

/** The CLI's parsed flags, as `parseArgs` hands them over. */
export type Args = Record<string, string | boolean | undefined>

export interface AnalyticsCtx {
  args: Args
  /** Lazily opens the DSQL connection — `analytics` with a bad flag must cost no round trip. */
  clients: () => Clients
  nowMs: number
}

const MAX_WINDOW_DAYS = 3650

/**
 * `analytics digest [--days N] [--json]` — the terminal view of the SAME numbers the Analytics
 * tab renders. Not a second computation: it reads the three tables and hands them to
 * `buildAnalytics`. A CLI that recomputed would eventually disagree with the panel, and the
 * disagreement would be invisible until somebody compared them side by side.
 */
export async function cmdAnalyticsDigest(ctx: AnalyticsCtx): Promise<void> {
  const days = Number(ctx.args.days ?? 30)
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
    throw new Error(`analytics digest: --days must be a whole number of days (1..${String(MAX_WINDOW_DAYS)})`)
  }
  const c = ctx.clients()
  const since = addDays(dayOf(ctx.nowMs), -(days - 1))
  const [usage, funnels, installs] = await Promise.all([
    readUsageDaily(c, since),
    readUsageFunnelDaily(c, since),
    readAnalyticsInstalls(c),
  ])
  const data = buildAnalytics({
    usage: toUsageRows(usage),
    funnels: toFunnelRows(funnels),
    installs: toInstallRows(installs),
    windowDays: days,
    nowMs: ctx.nowMs,
  })
  console.log(ctx.args.json ? JSON.stringify(data, null, 2) : renderAnalyticsDigest(data))
}

/**
 * `analytics wipe --id <analyticsId>` (plan T7) — the deletion path for usage analytics, and
 * it is one statement because there is only one row.
 *
 * WHAT IS NOT DELETED, and why that is the right answer rather than a limitation: the counters
 * this id contributed to. They are anonymous SUMS — `usage_daily` holds "37 map opens on
 * 2026-08-04", with no id anywhere in the table — so there is nothing in them to attribute to
 * a person, and subtracting a guess would corrupt a true number to satisfy a request the data
 * does not contain. The install row IS the id's entire footprint (plan §4), and it goes.
 */
export async function cmdAnalyticsWipe(ctx: AnalyticsCtx): Promise<void> {
  const id = typeof ctx.args.id === 'string' ? ctx.args.id : ''
  if (!id) throw new Error('analytics wipe: --id <analyticsId> is required')
  const gone = await deleteAnalyticsInstall(ctx.clients(), id)
  console.log(
    gone > 0
      ? `deleted the analytics_install row for ${id}.\n` +
          'The daily counters it contributed to are anonymous sums and are deliberately ' +
          'untouched — they carry no id and cannot be attributed to one.'
      : `no analytics_install row for ${id} (nothing to delete).`,
  )
}

/** The TELEMETRY kill switch — `telemetry_accepting`, the twin of `closed on|off`. */
async function setSwitch(ctx: AnalyticsCtx, accepting: boolean): Promise<void> {
  const rows = await setTelemetryAccepting(ctx.clients(), accepting)
  if (rows === 0) throw new Error('no feedback_config row — run `triage-feedback migrate` first')
  console.log(
    accepting
      ? 'telemetry OPEN — /v1/telemetry now accepts batches.'
      : 'telemetry CLOSED — every batch gets 503 + no counters move. No deploy needed.',
  )
}

export const ANALYTICS_SUBCOMMANDS: Record<string, (ctx: AnalyticsCtx) => Promise<void>> = {
  digest: cmdAnalyticsDigest,
  wipe: cmdAnalyticsWipe,
  open: (ctx) => setSwitch(ctx, true),
  close: (ctx) => setSwitch(ctx, false),
}

export function analyticsSubcommand(name: string | undefined): ((ctx: AnalyticsCtx) => Promise<void>) | null {
  return name === undefined ? null : (ANALYTICS_SUBCOMMANDS[name] ?? null)
}
