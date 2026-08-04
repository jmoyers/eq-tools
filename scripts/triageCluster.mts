/**
 * triageCluster.mts — the DETERMINISTIC half of triage (§10.3, layer 1).
 *
 * Pure functions, no AWS, no I/O, no model. Given a list of reports it produces
 * clusters and a markdown digest; `scripts/triage-feedback.mts` does the talking to
 * DynamoDB and S3, and Claude reasons over the digest this file renders. Keeping
 * the two apart is what makes the clustering testable (tests/triageCluster.test.mts)
 * and what keeps the script honest: it never takes instructions from report content.
 *
 * TWO LAYERS OF IDENTITY, and the first one is the strong one:
 *
 *   1. CRASH SIGNATURE. Any report whose description (or attached slice) carries an
 *      `[everquest-companion:error]` line yields `<source tag>|<first stack frame>`
 *      — e.g. `renderer:ErrorBoundary|OverlayMeter.tsx:88`. That is a far better
 *      identity than prose, and it is a repo-specific advantage: our own error
 *      harness (src/main/errorLog.ts) stamps exactly the two fields needed. Reports
 *      sharing a signature are one cluster, full stop.
 *   2. TOKEN-SET near-duplicate for everything else: normalize, drop stopwords,
 *      group at Jaccard >= 0.6 by single link.
 *
 * A cluster whose members all sit on ONE appVersion is flagged as a probable
 * REGRESSION — that reads completely differently from a long-standing gripe.
 *
 * THE LAW, encoded here as `containsLogSlice`: A LOG SLICE NEVER REACHES A PUBLIC
 * ISSUE. This repo is public. `triage-feedback issue` runs every candidate body
 * through that check and refuses rather than trusting itself to have been careful.
 */

import type { AppChannelTag, FeedbackType, ReportStatus } from '../src/shared/feedback'

/** The projection of a report row that clustering and the digest need. NO `contact`, ever:
 *  this shape is what gets rendered, and PII must not be renderable — and since the schema
 *  dropped `title` and `contact` outright there is no longer a column to project. */
export interface TriageReport {
  reportId: string
  type: FeedbackType
  description: string
  appVersion: string
  platform: string
  channel: AppChannelTag
  status: ReportStatus
  spamScore: number
  receivedAt: number
  hasLog: boolean
  /** Text of a LOCALLY downloaded slice, when the caller has one. Never rendered. */
  logText?: string
}

export interface Cluster {
  id: string
  kind: 'crash' | 'tokens'
  /** Present for `kind: 'crash'` — the `<source>|<frame>` identity. */
  signature?: string
  reportIds: string[]
  types: FeedbackType[]
  versions: string[]
  /** Every member on one appVersion (and more than one member) ⇒ read as a regression. */
  regression: boolean
  withLogs: number
  label: string
}

// ---- ULID time arithmetic -----------------------------------------------------------
//
// reportId is a ULID, so the GSI sort key IS the timeline: `--since 7d` is a plain
// BETWEEN on the sort key with no filter expression, no extra attribute and no scan.
// These three functions are the whole reason that works, so they are pure and tested.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** The LOWEST ULID that could have been minted at `ms` — the left edge of a range query. */
export function ulidFloor(ms: number): string {
  let rest = Math.max(0, Math.floor(ms))
  let out = ''
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[rest % 32] + out
    rest = Math.floor(rest / 32)
  }
  return `${out}${'0'.repeat(16)}`
}

/** Milliseconds encoded in a ULID's first 10 characters; NaN if it is not one. */
export function ulidTimestamp(id: string): number {
  let ms = 0
  for (const ch of id.slice(0, 10).toUpperCase()) {
    const v = CROCKFORD.indexOf(ch)
    if (v < 0) return Number.NaN
    ms = ms * 32 + v
  }
  return id.length >= 10 ? ms : Number.NaN
}

/** `7d` / `12h` / `30m` / an ISO date. Returns the absolute epoch-ms lower bound. */
export function parseSince(spec: string, nowMs: number): number {
  const rel = /^(\d+)\s*([dhm])$/i.exec(spec.trim())
  if (rel) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[rel[2].toLowerCase() as 'd' | 'h' | 'm']
    return nowMs - Number(rel[1]) * unit
  }
  const abs = Date.parse(spec)
  if (Number.isNaN(abs)) throw new Error(`--since: expected 7d / 12h / 30m or an ISO date, got "${spec}"`)
  return abs
}

// ---- crash signatures --------------------------------------------------------------

/** `<iso> [everquest-companion:error] [<source>] <body>` — src/main/errorLog.ts. */
const ERROR_LINE_RE = /\[everquest-companion:error\]\s*\[([^\]]+)\]/
/** First stack frame that names one of our source files. */
const FRAME_RE = /\bat\s[^\n]*?([\w.-]+\.(?:tsx|ts|mts|jsx|js|mjs)):(\d+)/

/**
 * The strong identity: source tag + first stack frame. Returns null when the text
 * carries no error line at all (the common case for a feature request).
 */
export function crashSignature(text: string): string | null {
  const err = ERROR_LINE_RE.exec(text)
  if (!err) return null
  const source = err[1].trim()
  const rest = text.slice(err.index)
  const frame = FRAME_RE.exec(rest)
  if (frame) return `${source}|${frame[1]}:${frame[2]}`
  // No frame (a forwarded console error, a string payload). Fall back to the head of
  // the message so two identical failures still land together.
  const head = rest
    .slice(err[0].length)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return head.length > 0 ? `${source}|${head}` : source
}

// ---- token sets --------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'but', 'not', 'you', 'your', 'was', 'were', 'are', 'has',
  'have', 'had', 'this', 'that', 'with', 'from', 'when', 'then', 'than', 'they',
  'their', 'there', 'its', 'about', 'after', 'before', 'into', 'out', 'get',
  'got', 'can', 'cant', 'cannot', 'dont', 'doesnt', 'didnt', 'wont', 'would',
  'could', 'should', 'just', 'like', 'some', 'any', 'all', 'also', 'only',
  'very', 'really', 'please', 'thanks', 'hey', 'app', 'application',
])

/** lowercase, strip punctuation AND digits (a version number is not a topic), drop
 *  stopwords and anything under three characters. */
export function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  return new Set(words)
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

// ---- clustering --------------------------------------------------------------------

export const JACCARD_THRESHOLD = 0.6

/** Human-readable and STABLE: derived from the first member's ULID, which never moves. */
export function clusterId(firstReportId: string): string {
  return `c-${firstReportId.slice(-4).toUpperCase()}`
}

function reportText(r: TriageReport): string {
  return r.description
}

function label(r: TriageReport): string {
  const raw = r.description.replace(/\s+/g, ' ').trim()
  return raw.length > 72 ? `${raw.slice(0, 71)}…` : raw
}

function summarize(members: TriageReport[], kind: Cluster['kind'], signature?: string): Cluster {
  const versions = [...new Set(members.map((m) => m.appVersion))].sort()
  // The FIRST member labels the cluster. This used to prefer a member who wrote a title,
  // on the reasoning that a pasted stack trace is a terrible label; with `title` gone from
  // the contract there is nothing to prefer, and first-by-ULID is the stable choice (it is
  // already the id's source, so label and id name the same report).
  const named = members[0]
  return {
    id: clusterId(members[0].reportId),
    kind,
    signature,
    reportIds: members.map((m) => m.reportId),
    types: [...new Set(members.map((m) => m.type))],
    versions,
    regression: members.length > 1 && versions.length === 1,
    withLogs: members.filter((m) => m.hasLog).length,
    label: label(named),
  }
}

/**
 * Crash signatures first, then token-set near-duplicates over what is left.
 * Deterministic: input order (which is ULID order, i.e. time order) decides both
 * cluster membership ties and the id.
 */
export function clusterReports(reports: readonly TriageReport[]): Cluster[] {
  const byCrash = new Map<string, TriageReport[]>()
  const rest: TriageReport[] = []
  for (const r of reports) {
    const sig = crashSignature(`${r.description}\n${r.logText ?? ''}`)
    if (sig === null) {
      rest.push(r)
      continue
    }
    const bucket = byCrash.get(sig)
    if (bucket) bucket.push(r)
    else byCrash.set(sig, [r])
  }

  const groups: { members: TriageReport[]; tokens: Set<string> }[] = []
  for (const r of rest) {
    const tokens = tokenize(reportText(r))
    const hit = groups.find((g) =>
      g.members.some((m) => jaccard(tokenize(reportText(m)), tokens) >= JACCARD_THRESHOLD),
    )
    if (hit) hit.members.push(r)
    else groups.push({ members: [r], tokens })
  }

  const crashClusters = [...byCrash.entries()].map(([sig, members]) =>
    summarize(members, 'crash', sig),
  )
  const tokenClusters = groups
    .filter((g) => g.members.length > 1)
    .map((g) => summarize(g.members, 'tokens'))
  return [...crashClusters, ...tokenClusters].sort(
    (a, b) => b.reportIds.length - a.reportIds.length || a.id.localeCompare(b.id),
  )
}

// ---- THE LAW ------------------------------------------------------------------------

/** `[Sat Aug 01 13:00:28 2026] ` — the EQ log line prefix, the shape a slice is made of. */
const EQ_LOG_LINE_RE =
  /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}\]/

/**
 * True when `text` contains anything that looks like a raw EverQuest log line.
 * The repo is PUBLIC: `issue` posts the description, the env block and a SUMMARY of
 * what the log showed. The slice itself stays in S3 and in .triage/ (gitignored).
 */
export function containsLogSlice(text: string): boolean {
  return EQ_LOG_LINE_RE.test(text)
}

/** Refuse rather than trust ourselves to have been careful. */
export function assertNoLogSlice(text: string, what: string): void {
  if (containsLogSlice(text)) {
    throw new Error(
      `refusing to publish ${what}: it contains raw EverQuest log lines. ` +
        'A log slice never reaches a public issue (§10.3) — summarize what the log showed instead.',
    )
  }
}

// ---- digest -------------------------------------------------------------------------

const DIGEST_LINE_MAX = 200

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** One report, <= 200 chars, PII-free by construction (this shape has no contact field). */
export function digestLine(r: TriageReport): string {
  const text = r.description.replace(/\s+/g, ' ').trim()
  const head = `${r.reportId.slice(-6)} ${r.appVersion} ${r.platform} · `
  const tail = `${r.hasLog ? ' · log ✔' : ''}${r.spamScore >= 40 ? ` · spam ${r.spamScore}` : ''}`
  const room = Math.max(20, DIGEST_LINE_MAX - head.length - tail.length - 2)
  const body = text.length > room ? `${text.slice(0, room - 1)}…` : text
  return `${head}"${body}"${tail}`
}

export interface DigestOptions {
  sinceMs: number
  nowMs: number
  channel: string
}

function digestHeader(reports: readonly TriageReport[], clusters: readonly Cluster[], o: DigestOptions): string[] {
  const bugs = reports.filter((r) => r.type === 'bug').length
  const spam = reports.filter((r) => r.status === 'spam').length
  const days = Math.max(1, Math.round((o.nowMs - o.sinceMs) / 86_400_000))
  return [
    `## Feedback digest — ${days} days to ${isoDay(o.nowMs)} (${o.channel})`,
    '',
    `${reports.length} reports · ${bugs} bug · ${reports.length - bugs} feature · ` +
      `${clusters.length} clusters · ${spam} spam-marked`,
  ]
}

function clusterBlock(c: Cluster, index: number): string[] {
  const kinds = c.types.map((t) => t.toUpperCase()).join('/')
  const lines = [
    `${index + 1}. **${c.id} · ${c.reportIds.length} reports · ${kinds}** — ${c.label}`,
  ]
  lines.push(
    c.regression
      ? `   All on ${c.versions[0]} (regression candidate)`
      : `   Versions: ${c.versions.join(', ')}`,
  )
  const sig = c.signature ? ` · signature \`${c.signature}\`` : ''
  lines.push(`   Logs: ${c.withLogs}/${c.reportIds.length} attached${sig}`)
  return lines
}

/**
 * The markdown brief a human (or Claude, on the dev machine) reads whole. Small on
 * purpose: one line per report, no contact, no log text.
 */
export function renderDigest(
  reports: readonly TriageReport[],
  clusters: readonly Cluster[],
  options: DigestOptions,
): string {
  const clustered = new Set(clusters.flatMap((c) => c.reportIds))
  const loose = reports.filter((r) => !clustered.has(r.reportId))
  const out = digestHeader(reports, clusters, options)

  if (clusters.length > 0) {
    out.push('', '### Clusters by weight')
    clusters.forEach((c, i) => out.push(...clusterBlock(c, i)))
  }

  const looseBugs = loose.filter((r) => r.type === 'bug')
  if (looseBugs.length > 0) {
    out.push('', `### Unclustered bugs (${looseBugs.length})`)
    for (const r of looseBugs) out.push(`- ${digestLine(r)}`)
  }

  const looseFeatures = loose.filter((r) => r.type === 'feature')
  if (looseFeatures.length > 0) {
    out.push('', `### Unclustered feature requests (${looseFeatures.length})`)
    for (const r of looseFeatures) out.push(`- ${digestLine(r)}`)
  }

  if (reports.length === 0) out.push('', '_No reports in this window._')
  return `${out.join('\n')}\n`
}
