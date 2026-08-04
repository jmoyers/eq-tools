/**
 * triage-feedback.mts — the feedback backlog, from the dev machine (§10).
 *
 *   npx tsx scripts/triage-feedback.mts <command> [options]
 *
 * Reads Aurora DSQL and S3 DIRECTLY OVER IAM; there is no server-side read API to
 * secure, and no database password to hold (DSQL authenticates with a signed IAM
 * token minted locally). Physical names come from `terraform output -json`, cached
 * in .triage/stack.json (gitignored) — nothing about the account is committed.
 *
 * TWO LAWS THIS FILE ENFORCES, not just documents:
 *
 *   1. A LOG SLICE NEVER REACHES A PUBLIC ISSUE. `issue` runs the body through
 *      `assertNoLogSlice` and refuses if a raw EQ log line is anywhere in it. The
 *      slice stays in S3 and in .triage/ (gitignored twice over).
 *   2. THE SCRIPT NEVER TAKES INSTRUCTIONS FROM REPORT CONTENT. It is deterministic
 *      end to end. The agentic layer is a HUMAN reading `digest` output, asking
 *      Claude for an opinion, and running the `set`/`issue` commands it suggests.
 *      Nothing here calls a model, and no model writes to the database unattended.
 *
 * AUTH: `--profile <name>` (the deploy profile already performs role assumption via
 * source_profile/role_arn) or `--role-arn <arn>` to assume the triage role directly.
 *
 * THE I/O HALF NOW LIVES IN `src/main/triage/store.ts`, not beside this file. It moved when
 * the dev-only triage TAB landed in the app: both front ends read the same backlog, so there
 * is exactly one implementation of every statement and they cannot drift. Nothing about this
 * CLI changed — same commands, same flags, same output.
 */

import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  assertNoLogSlice,
  clusterReports,
  parseSince,
  renderDigest,
  type Cluster,
  type TriageReport,
} from './triageCluster.mjs'
import {
  applySchema,
  deleteReportRow,
  deleteSlice,
  downloadSlice,
  getReport,
  listReports,
  loadStack,
  logKeyOf,
  logObjectExists,
  makeClients,
  reportsForInstall,
  SCHEMA_FILE,
  setAccepting,
  setBlocked,
  setTriage,
  stampRedacted,
  toTriageReport,
  type Clients,
  type ListFilter,
  type Row,
} from '../src/main/triage/store'
import {
  REPORT_STATUSES,
  SEVERITIES,
  FEEDBACK_TYPES,
  type ReportStatus,
  type Severity,
} from '../src/shared/feedback'

/** A row column is `unknown`; never let one reach a template literal untyped. */
const text = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

const USAGE = `triage-feedback <command> [options]

  migrate                             apply infra/schema.sql to the DSQL cluster
                                      (idempotent; run once after every apply)
  list    [--status S] [--channel prod|dev|all] [--type bug|feature] [--since 7d]
          [--min-score N] [--limit 100] [--json]
  show    <reportId>                  full record; downloads + gunzips the slice
  digest  [--since 7d] [--channel C]  the markdown brief a human/Claude reads
  cluster [--since 30d] [--write]     deterministic clusters; --write stamps them
  set     <reportId...> [--status S] [--severity p0..p3] [--cluster ID]
          [--dupe-of ID] [--note "..."] [--stdin]
  issue   <reportId>                  gh issue create; stamps issueUrl back
  forget  <reportId>                  delete the slice object + stamp the redaction
  wipe    --install <installId>       delete every report + object from an install
  block   <installId> --reason "..."  |  unblock <installId>
  closed  <on|off> [--message "..."]  the kill switch (instant, no deploy)

  Global: --profile <aws-profile> --role-arn <arn> --refresh (re-read tf outputs)`

const OPTIONS = {
  status: { type: 'string' },
  channel: { type: 'string' },
  type: { type: 'string' },
  since: { type: 'string' },
  'min-score': { type: 'string' },
  limit: { type: 'string' },
  severity: { type: 'string' },
  cluster: { type: 'string' },
  'dupe-of': { type: 'string' },
  note: { type: 'string' },
  reason: { type: 'string' },
  message: { type: 'string' },
  install: { type: 'string' },
  profile: { type: 'string' },
  'role-arn': { type: 'string' },
  json: { type: 'boolean' },
  write: { type: 'boolean' },
  stdin: { type: 'boolean' },
  refresh: { type: 'boolean' },
  help: { type: 'boolean' },
} as const

type Args = Record<string, string | boolean | undefined>

interface Ctx {
  args: Args
  rest: string[]
  clients: () => Clients
}

const NOW = Date.now()

function oneOf<T extends string>(value: unknown, allowed: readonly T[], flag: string): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${flag}: expected one of ${allowed.join(', ')}`)
  }
  return value as T
}

function filterFrom(args: Args, defaultSince: string): ListFilter {
  const channel = oneOf(args.channel, ['prod', 'dev', 'all'] as const, '--channel') ?? 'prod'
  const filter: ListFilter = {
    channel,
    sinceMs: parseSince(typeof args.since === 'string' ? args.since : defaultSince, NOW),
    limit: Number(args.limit ?? 100),
  }
  const status = oneOf(args.status, REPORT_STATUSES, '--status')
  if (status) filter.status = status
  const type = oneOf(args.type, FEEDBACK_TYPES, '--type')
  if (type) filter.type = type
  if (args['min-score'] !== undefined) filter.minScore = Number(args['min-score'])
  return filter
}

function reportsFor(ctx: Ctx, defaultSince: string): Promise<Row[]> {
  return listReports(ctx.clients(), filterFrom(ctx.args, defaultSince))
}

function shortDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

// ---- commands ------------------------------------------------------------------------

/**
 * `migrate` — apply infra/schema.sql (F2 step 2.5).
 *
 * WHY THIS IS A CLI COMMAND AND NOT TERRAFORM. DSQL DDL needs an IAM-signed
 * postgres connection; Terraform has no resource that speaks the wire protocol and
 * no way to mint the token, so the alternative would be a `null_resource` +
 * `local-exec` shelling out to exactly this code with none of the reporting. The
 * schema is a reviewable SQL file and this is the reviewable thing that applies it.
 *
 * It is IDEMPOTENT and safe to re-run: every statement that already landed is
 * reported as `exists` rather than failing the run. `${LAMBDA_ROLE_ARN}` — the one
 * value that carries the account id, which is why schema.sql holds a placeholder —
 * is substituted from the terraform output.
 */
async function cmdMigrate(ctx: Ctx): Promise<void> {
  const c = ctx.clients()
  const sql = readFileSync(SCHEMA_FILE, 'utf8').replaceAll(
    '${LAMBDA_ROLE_ARN}',
    c.stack.lambda_role_arn,
  )
  const steps = await applySchema(c, sql)
  for (const step of steps) {
    const head = step.sql.replace(/\s+/g, ' ').slice(0, 96)
    console.log(`${step.status === 'applied' ? 'applied ' : 'exists  '} ${head}`)
  }
  const applied = steps.filter((s) => s.status === 'applied').length
  console.log(
    `\n${String(applied)} applied, ${String(steps.length - applied)} already present.\n` +
      'Indexes are built ASYNCHRONOUSLY — they are usable once DSQL finishes the job.',
  )
}

async function cmdList(ctx: Ctx): Promise<void> {
  const rows = await reportsFor(ctx, '7d')
  if (ctx.args.json) {
    console.log(JSON.stringify(rows.map(toTriageReport), null, 2))
    return
  }
  for (const row of rows) {
    const r = toTriageReport(row)
    const head = r.description.replace(/\s+/g, ' ').slice(0, 60)
    console.log(
      `${r.reportId}  ${shortDate(r.receivedAt)}  ${r.type.padEnd(7)} ${r.status.padEnd(9)} ` +
        `${r.appVersion.padEnd(8)} ${r.hasLog ? 'log' : '   '} ${r.spamScore.toString().padStart(3)}  ${head}`,
    )
  }
  console.log(`\n${rows.length} report(s).`)
}

async function cmdShow(ctx: Ctx): Promise<void> {
  const [reportId] = ctx.rest
  if (!reportId) throw new Error('show: <reportId> is required')
  const c = ctx.clients()
  const row = await getReport(c, reportId)
  if (!row) throw new Error(`no such report: ${reportId}`)
  console.log(JSON.stringify(row, null, 2))

  const key = logKeyOf(row)
  if (!key) return
  if (!(await logObjectExists(c, key))) {
    console.log('\n[log slice: declared but never landed — the upload failed or expired]')
    return
  }
  console.log(`\n[log slice: ${await downloadSlice(c, reportId, key)}]`)
}

function digestInputs(rows: Row[]): { reports: TriageReport[]; clusters: Cluster[] } {
  const reports = rows.map(toTriageReport).sort((a, b) => a.reportId.localeCompare(b.reportId))
  return { reports, clusters: clusterReports(reports) }
}

async function cmdDigest(ctx: Ctx): Promise<void> {
  const filter = filterFrom(ctx.args, '7d')
  const { reports, clusters } = digestInputs(await listReports(ctx.clients(), filter))
  if (ctx.args.json) {
    console.log(JSON.stringify({ reports, clusters }, null, 2))
    return
  }
  console.log(renderDigest(reports, clusters, { sinceMs: filter.sinceMs, nowMs: NOW, channel: filter.channel }))
}

async function cmdCluster(ctx: Ctx): Promise<void> {
  const { clusters } = digestInputs(await reportsFor(ctx, '30d'))
  for (const c of clusters) {
    const flag = c.regression ? ` REGRESSION(${c.versions[0]})` : ''
    console.log(`${c.id}  ${c.kind.padEnd(6)} ${String(c.reportIds.length).padStart(3)}x${flag}  ${c.label}`)
    if (c.signature) console.log(`        signature ${c.signature}`)
  }
  if (!ctx.args.write) {
    console.log('\n(dry run — pass --write to stamp `cluster` on the members)')
    return
  }
  const client = ctx.clients()
  for (const c of clusters) {
    for (const id of c.reportIds) await setTriage(client, id, { cluster: c.id })
  }
  console.log(`\nstamped ${clusters.length} cluster(s).`)
}

function idsFor(ctx: Ctx): string[] {
  if (!ctx.args.stdin) return ctx.rest
  const raw = readFileSync(0, 'utf8').trim()
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed) ? parsed : []
    return list.map((e) => (typeof e === 'string' ? e : text((e as Row).reportId)))
  }
  return raw.split(/\s+/).filter((s) => s.length > 0)
}

async function cmdSet(ctx: Ctx): Promise<void> {
  const ids = idsFor(ctx)
  if (ids.length === 0) throw new Error('set: give at least one reportId (or --stdin)')
  const patch = {
    status: oneOf<ReportStatus>(ctx.args.status, REPORT_STATUSES, '--status'),
    severity: oneOf<Severity>(ctx.args.severity, SEVERITIES, '--severity'),
    cluster: typeof ctx.args.cluster === 'string' ? ctx.args.cluster : undefined,
    dupeOf: typeof ctx.args['dupe-of'] === 'string' ? ctx.args['dupe-of'] : undefined,
    note: typeof ctx.args.note === 'string' ? ctx.args.note : undefined,
  }
  const c = ctx.clients()
  for (const id of ids) await setTriage(c, id, patch)
  console.log(`updated ${ids.length} report(s).`)
}

function issueBody(row: Row, r: TriageReport): string {
  const env = JSON.parse(text(row.env_json, '{}')) as Record<string, unknown>
  const facts = ['appVersion', 'channel', 'updateChannel', 'platform', 'osRelease', 'arch', 'electron']
    .map((k) => `- ${k}: ${text(env[k], '?')}`)
    .join('\n')
  const log = r.hasLog
    ? '\n\nA scrubbed log slice was attached and is available to maintainers; it is deliberately not reproduced here.'
    : ''
  return `### Reported\n\n${r.description}\n\n### Environment\n\n${facts}\n\n_Report ${r.reportId}_${log}\n`
}

async function cmdIssue(ctx: Ctx): Promise<void> {
  const [reportId] = ctx.rest
  if (!reportId) throw new Error('issue: <reportId> is required')
  const c = ctx.clients()
  const row = await getReport(c, reportId)
  if (!row) throw new Error(`no such report: ${reportId}`)
  const r = toTriageReport(row)

  // The issue title is the first 100 characters of the description — reports carry no title
  // of their own any more, so there is nothing to prefer over it.
  const title = r.description.replace(/\s+/g, ' ').slice(0, 100)
  const body = issueBody(row, r)
  // THE LAW. Refuse rather than trust ourselves to have been careful.
  assertNoLogSlice(`${title}\n${body}`, `a public issue for ${reportId}`)

  const url = execFileSync(
    'gh',
    ['issue', 'create', '--title', title, '--body', body, '--label', r.type === 'bug' ? 'bug' : 'enhancement'],
    { encoding: 'utf8' },
  ).trim()
  await setTriage(c, reportId, { issueUrl: url, status: 'accepted' })
  console.log(url)
}

/**
 * `forget` — the deletion-request path, minus a job it no longer has.
 *
 * It used to do two things: NULL the `contact` column and delete the S3 slice object. The
 * contact half is gone with the column (retired from the wire, then dropped from the schema),
 * so what remains is the half that was always the substantive one — the log window somebody
 * attached is destroyed, and `redacted_at` records that it was. The description stays: it IS
 * the bug report. For "delete everything about me", that is `wipe --install`.
 */
async function cmdForget(ctx: Ctx): Promise<void> {
  const [reportId] = ctx.rest
  if (!reportId) throw new Error('forget: <reportId> is required')
  const c = ctx.clients()
  const row = await getReport(c, reportId)
  if (!row) throw new Error(`no such report: ${reportId}`)
  const key = logKeyOf(row)
  if (key) await deleteSlice(c, key)
  await stampRedacted(c, reportId)
  console.log(
    key
      ? `forgot the log slice for ${reportId} (deleted ${key})`
      : `${reportId} had no slice; stamped redacted anyway`,
  )
}

async function cmdWipe(ctx: Ctx): Promise<void> {
  const installId = typeof ctx.args.install === 'string' ? ctx.args.install : ''
  if (!installId) throw new Error('wipe: --install <installId> is required')
  console.warn(
    'WARNING: wipe reads every report row — there is deliberately no index on ' +
      'installId, so this is an unindexed full-table query. It is billed by the ' +
      'bytes it touches; run it for a deletion request, not out of curiosity.',
  )
  const c = ctx.clients()
  const rows = await reportsForInstall(c, installId)
  for (const row of rows) {
    const key = logKeyOf(row)
    if (key) await deleteSlice(c, key)
    await deleteReportRow(c, text(row.report_id))
  }
  console.log(`wiped ${rows.length} report(s) for install ${installId}.`)
}

async function cmdBlock(ctx: Ctx): Promise<void> {
  const [installId] = ctx.rest
  if (!installId) throw new Error('block: <installId> is required')
  const reason = typeof ctx.args.reason === 'string' ? ctx.args.reason : ''
  if (!reason) throw new Error('block: --reason "..." is required (the profile records why)')
  await setBlocked(ctx.clients(), installId, true, reason)
  console.log(`blocked ${installId}: every submit now 403s. No deploy needed.`)
}

async function cmdUnblock(ctx: Ctx): Promise<void> {
  const [installId] = ctx.rest
  if (!installId) throw new Error('unblock: <installId> is required')
  await setBlocked(ctx.clients(), installId, false, 'unblocked')
  console.log(`unblocked ${installId}.`)
}

async function cmdClosed(ctx: Ctx): Promise<void> {
  const [state] = ctx.rest
  if (state !== 'on' && state !== 'off') throw new Error('closed: expected `on` or `off`')
  const message = typeof ctx.args.message === 'string' ? ctx.args.message : undefined
  await setAccepting(ctx.clients(), state === 'off', message)
  console.log(
    state === 'on'
      ? 'feedback CLOSED — clients get 503 + the message, rendered verbatim.'
      : 'feedback OPEN.',
  )
}

const COMMANDS: Record<string, (ctx: Ctx) => Promise<void>> = {
  migrate: cmdMigrate,
  list: cmdList,
  show: cmdShow,
  digest: cmdDigest,
  cluster: cmdCluster,
  set: cmdSet,
  issue: cmdIssue,
  forget: cmdForget,
  wipe: cmdWipe,
  block: cmdBlock,
  unblock: cmdUnblock,
  closed: cmdClosed,
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: OPTIONS,
    allowPositionals: true,
  })
  const [command, ...rest] = positionals
  if (!command || values.help || !(command in COMMANDS)) {
    console.log(USAGE)
    process.exitCode = command && !(command in COMMANDS) ? 1 : 0
    return
  }

  // A box rather than a `let`: the finally below has to see what the closure
  // assigned, and control-flow analysis narrows a captured `let` to `null` there.
  const held: { clients: Clients | null } = { clients: null }
  const ctx: Ctx = {
    args: values,
    rest,
    clients: () => {
      held.clients ??= makeClients(loadStack(values.refresh === true), {
        ...(typeof values.profile === 'string' ? { profile: values.profile } : {}),
        ...(typeof values['role-arn'] === 'string' ? { roleArn: values['role-arn'] } : {}),
      })
      return held.clients
    },
  }
  try {
    await COMMANDS[command](ctx)
  } finally {
    // A live postgres socket holds the event loop open. Without this the CLI
    // prints its answer and then hangs until DSQL's one-hour connection timeout.
    await held.clients?.close()
  }
}

await main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
