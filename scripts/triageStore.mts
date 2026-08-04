/**
 * triageStore.mts — the I/O half of triage: DynamoDB + S3, directly over IAM.
 *
 * THERE IS NO SERVER-SIDE READ API (D4). The dev machine has an AWS profile; this
 * module uses the SDK against the table and the bucket. Building a public,
 * authenticated read endpoint would be a second thing to secure for zero benefit.
 *
 * POLITENESS, the same discipline AGENTS.md's scraper law asks of every fetcher in
 * this repo, applied to a paid API instead of someone else's server:
 *   * CACHE FIRST — `terraform output -json` is shelled out ONCE and cached in
 *     .triage/stack.json; a downloaded slice is written to .triage/slices/ and a
 *     second `show` never re-downloads it. Re-runs are free.
 *   * RATE LIMIT — a deliberate pause between query pages, so a `--since 90d`
 *     sweep never behaves like a burst.
 *   * BACK OFF — adaptive retry mode with 5 attempts, so a throttle is answered by
 *     waiting rather than by hammering.
 *   * IDEMPOTENT — every mutation is a keyed Put/Update; re-running a command
 *     converges instead of duplicating.
 *
 * PHYSICAL NAMES ARE NEVER COMMITTED. Everything comes from the Terraform outputs
 * at run time; .triage/ is gitignored.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { setTimeout as sleep } from 'node:timers/promises'
import { ulidFloor, type TriageReport } from './triageCluster.mjs'
import type { AppChannelTag, FeedbackType, ReportStatus, Severity } from '../src/shared/feedback'

const ROOT = resolve(import.meta.dirname, '..')
export const TRIAGE_DIR = join(ROOT, '.triage')
const STACK_FILE = join(TRIAGE_DIR, 'stack.json')
const SLICE_DIR = join(TRIAGE_DIR, 'slices')

/** Pause between query pages. Nothing here is time-critical; the table is not free. */
const PAGE_PAUSE_MS = 150

export interface Stack {
  region: string
  table_name: string
  bucket_name: string
  triage_role_arn: string
  api_url: string
}

export interface AccessOptions {
  profile?: string
  roleArn?: string
}

const STACK_KEYS = ['region', 'table_name', 'bucket_name', 'triage_role_arn', 'api_url'] as const

/**
 * Resolve every physical name from `terraform output -json`, ONCE, and cache it.
 * Delete .triage/stack.json (or pass refresh) after an apply that renamed anything.
 */
export function loadStack(refresh = false): Stack {
  if (!refresh && existsSync(STACK_FILE)) {
    return JSON.parse(readFileSync(STACK_FILE, 'utf8')) as Stack
  }
  const raw = execFileSync('terraform', ['output', '-json'], {
    cwd: join(ROOT, 'infra'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const outputs = JSON.parse(raw) as Record<string, { value: unknown } | undefined>
  const stack = {} as Record<string, string>
  for (const key of STACK_KEYS) {
    const value = outputs[key]?.value
    if (typeof value !== 'string') {
      throw new Error(`terraform output is missing "${key}" — has the stack been applied?`)
    }
    stack[key] = value
  }
  mkdirSync(TRIAGE_DIR, { recursive: true })
  writeFileSync(STACK_FILE, `${JSON.stringify(stack, null, 2)}\n`)
  return stack as unknown as Stack
}

export interface Clients {
  ddb: DynamoDBDocumentClient
  s3: S3Client
  stack: Stack
}

/**
 * `--profile` is usually all that is needed: the deploy profile itself performs the
 * role assumption (source_profile + role_arn in ~/.aws/config). `--role-arn` is for
 * the case where it does not — a second machine, or a future CI job.
 */
export function makeClients(stack: Stack, options: AccessOptions): Clients {
  if (options.profile) process.env.AWS_PROFILE = options.profile
  const credentials = options.roleArn
    ? fromTemporaryCredentials({
        params: { RoleArn: options.roleArn, RoleSessionName: 'eq-companion-triage' },
      })
    : undefined
  const config = {
    region: stack.region,
    maxAttempts: 5,
    retryMode: 'adaptive',
    ...(credentials ? { credentials } : {}),
  }
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient(config)),
    s3: new S3Client(config),
    stack,
  }
}

// ---- reads -------------------------------------------------------------------------

export type Row = Record<string, unknown>

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback)

/** DynamoDB row -> the PII-free projection clustering and the digest work on. */
export function toTriageReport(row: Row): TriageReport {
  const env = (row.env ?? {}) as Row
  const title = str(row.title)
  return {
    reportId: str(row.reportId),
    type: str(row.type, 'bug') as FeedbackType,
    ...(title ? { title } : {}),
    description: str(row.description),
    appVersion: str(env.appVersion, '?'),
    platform: str(env.platform, '?'),
    channel: str(env.channel, 'prod') as AppChannelTag,
    status: str(row.status, 'new') as ReportStatus,
    spamScore: num(row.spamScore),
    receivedAt: num(row.receivedAt),
    hasLog: row.log !== null && row.log !== undefined,
  }
}

export interface ListFilter {
  channel: AppChannelTag | 'all'
  sinceMs: number
  limit: number
  status?: ReportStatus
  type?: FeedbackType
  minScore?: number
}

/**
 * A ULID range query on the byChannel GSI: `BETWEEN` on the sort key, no filter
 * expression, no scan. status/type/score are applied client-side afterwards — a
 * third index would cost write amplification on every report for a query run by
 * hand once a week.
 */
export async function listReports(c: Clients, filter: ListFilter): Promise<Row[]> {
  const channels: AppChannelTag[] = filter.channel === 'all' ? ['prod', 'dev'] : [filter.channel]
  const floor = ulidFloor(filter.sinceMs)
  const rows: Row[] = []

  for (const channel of channels) {
    let cursor: Row | undefined
    do {
      const page = await c.ddb.send(
        new QueryCommand({
          TableName: c.stack.table_name,
          IndexName: 'gsi1',
          KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk >= :floor',
          ExpressionAttributeValues: { ':pk': `CH#${channel}`, ':floor': floor },
          ScanIndexForward: false,
          Limit: Math.min(filter.limit, 100),
          ExclusiveStartKey: cursor,
        }),
      )
      rows.push(...((page.Items ?? []) as Row[]))
      cursor = page.LastEvaluatedKey as Row | undefined
      if (cursor) await sleep(PAGE_PAUSE_MS)
    } while (cursor && rows.length < filter.limit * channels.length)
  }

  return rows
    .filter((r) => (filter.status ? r.status === filter.status : true))
    .filter((r) => (filter.type ? r.type === filter.type : true))
    .filter((r) => num(r.spamScore) >= (filter.minScore ?? 0))
    .sort((a, b) => str(b.reportId).localeCompare(str(a.reportId)))
    .slice(0, filter.limit)
}

export async function getReport(c: Clients, reportId: string): Promise<Row | null> {
  const res = await c.ddb.send(
    new GetCommand({
      TableName: c.stack.table_name,
      Key: { pk: `REPORT#${reportId}`, sk: 'META' },
    }),
  )
  return (res.Item as Row | undefined) ?? null
}

/** The escape hatch. Callers print a loud warning before using it (§10.2). */
export async function scanInstall(c: Clients, installId: string): Promise<Row[]> {
  const rows: Row[] = []
  let cursor: Row | undefined
  do {
    const page = await c.ddb.send(
      new ScanCommand({
        TableName: c.stack.table_name,
        FilterExpression: 'installId = :id AND sk = :meta',
        ExpressionAttributeValues: { ':id': installId, ':meta': 'META' },
        ExclusiveStartKey: cursor,
      }),
    )
    rows.push(...((page.Items ?? []) as Row[]))
    cursor = page.LastEvaluatedKey as Row | undefined
    if (cursor) await sleep(PAGE_PAUSE_MS)
  } while (cursor)
  return rows
}

// ---- writes ------------------------------------------------------------------------

export interface TriagePatch {
  status?: ReportStatus
  severity?: Severity
  cluster?: string
  dupeOf?: string
  note?: string
  issueUrl?: string
}

/** Idempotent by construction: a keyed UpdateItem of exactly the fields provided. */
export async function setTriage(c: Clients, reportId: string, patch: TriagePatch): Promise<void> {
  const sets: string[] = ['triagedAt = :now']
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = { ':now': Date.now() }

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    sets.push(`#${key} = :${key}`)
    names[`#${key}`] = key === 'note' ? 'disposition' : key
    values[`:${key}`] = value
  }
  // byStatus is a real index, so the projection has to move with the field.
  if (patch.status) {
    sets.push('gsi2pk = :gsi2pk')
    values[':gsi2pk'] = `ST#${patch.status}`
  }

  await c.ddb.send(
    new UpdateCommand({
      TableName: c.stack.table_name,
      Key: { pk: `REPORT#${reportId}`, sk: 'META' },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(pk)',
      ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
    }),
  )
}

export async function setBlocked(
  c: Clients,
  installId: string,
  blocked: boolean,
  reason: string,
): Promise<void> {
  await c.ddb.send(
    new PutCommand({
      TableName: c.stack.table_name,
      Item: {
        pk: `INSTALL#${installId}`,
        sk: 'PROFILE',
        blocked,
        blockedReason: reason,
        blockedAt: Date.now(),
      },
    }),
  )
}

/** The kill switch (§9.6). One UpdateItem — instant, no deploy, no release. */
export async function setAccepting(c: Clients, accepting: boolean, message?: string): Promise<void> {
  const values: Record<string, unknown> = { ':a': accepting }
  let expr = 'SET acceptingReports = :a'
  if (message !== undefined) {
    expr += ', closedMessage = :m'
    values[':m'] = message
  }
  await c.ddb.send(
    new UpdateCommand({
      TableName: c.stack.table_name,
      Key: { pk: 'CONFIG', sk: 'FEEDBACK' },
      UpdateExpression: expr,
      ExpressionAttributeValues: values,
    }),
  )
}

/**
 * `forget` (§3.5): the ONE PII field goes, the description stays — it is the bug
 * report, and keeping it is why "we deleted your contact details" is not a lie about
 * the rest. `redactedAt` records that it happened.
 */
export async function redactContact(c: Clients, reportId: string): Promise<void> {
  await c.ddb.send(
    new UpdateCommand({
      TableName: c.stack.table_name,
      Key: { pk: `REPORT#${reportId}`, sk: 'META' },
      UpdateExpression: 'REMOVE contact SET redactedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':now': Date.now() },
    }),
  )
}

export async function deleteReportRow(c: Clients, reportId: string): Promise<void> {
  await c.ddb.send(
    new DeleteCommand({
      TableName: c.stack.table_name,
      Key: { pk: `REPORT#${reportId}`, sk: 'META' },
    }),
  )
}

// ---- the log objects ---------------------------------------------------------------

export function logKeyOf(row: Row): string | null {
  const ref = row.logRef as Row | null | undefined
  const key = ref ? str(ref.key) : ''
  return key.length > 0 ? key : null
}

/** Did the upload actually land? One HeadObject, which is why no S3 event Lambda exists. */
export async function logObjectExists(c: Clients, key: string): Promise<boolean> {
  try {
    await c.s3.send(new HeadObjectCommand({ Bucket: c.stack.bucket_name, Key: key }))
    return true
  } catch {
    return false
  }
}

/**
 * Download + gunzip a slice to .triage/slices/<reportId>.log. CACHED: a second call
 * is a no-op. The file is gitignored twice over (`.triage/` and the blanket `*.log`)
 * and its contents never reach a public issue.
 */
export async function downloadSlice(c: Clients, reportId: string, key: string): Promise<string> {
  mkdirSync(SLICE_DIR, { recursive: true })
  const dest = join(SLICE_DIR, `${reportId}.log`)
  if (existsSync(dest)) return dest
  const res = await c.s3.send(
    new GetObjectCommand({ Bucket: c.stack.bucket_name, Key: key }),
  )
  if (!res.Body) throw new Error(`S3 returned no body for ${key}`)
  const gz = Buffer.from(await res.Body.transformToByteArray())
  writeFileSync(dest, gunzipSync(gz))
  return dest
}

export async function deleteSlice(c: Clients, key: string): Promise<void> {
  await c.s3.send(new DeleteObjectCommand({ Bucket: c.stack.bucket_name, Key: key }))
}
