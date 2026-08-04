// feedback/net.ts — the ONLY place this feature knows a hostname, and the boundary that
// decides where a user's log slice is allowed to go.
//
// TWO THINGS LIVE HERE, and both are security surface:
//
//  1. `FEEDBACK_API_URL` — the ingest endpoint, compiled in. It ships EMPTY (the feature is
//     "dark") until the Terraform root is applied. An empty value is not a failure mode: it
//     means "this build has no feedback endpoint", which the dialog reports honestly and
//     which makes a network call structurally impossible.
//
//     There is NO user-configurable endpoint override, and there must never be one. An
//     overridable ingest URL turns "attach my log" into "attach my log to a host of the
//     attacker's choosing" — it is an exfiltration primitive, not a convenience. Moving to a
//     custom domain later is a one-line change plus a release; that debt is accepted on
//     purpose (docs/plans/feedback-triage.md §6.2).
//
//  2. `allowedUploadUrl()` — the presigned upload URL comes back from the SERVER. It is
//     remote-supplied text that the main process is about to POST a file to, which is exactly
//     the class of input `security.ts allowedExternalUrl` exists for. So it gets the same
//     rigor: https only, no credentials, default port, no query/fragment, and an EXACT
//     hostname match against the two legal S3 spellings for OUR bucket in OUR region. Never
//     `endsWith`/`includes` — `our-bucket.s3.us-east-1.amazonaws.com.evil.com` must fail, and
//     it does (tests/feedbackNet.test.mts pins every shape).
//
//     It lives beside the feature rather than inside `security.ts` so this wave's file
//     ownership stays disjoint and `tests/security.test.mts` stays untouched as a signal that
//     the boundary was not weakened. Consolidating it into security.ts later is a fine,
//     deliberate follow-up.
//
// All network here is MAIN-PROCESS ONLY. The renderer performs no fetch/XHR — `connect-src
// 'self'` in index.html already makes that structurally impossible, and this feature requires
// ZERO CSP changes. An agent who finds themselves wanting to widen `connect-src` for feedback
// has made a mistake: the work belongs in this directory.

/**
 * The ingest API. EMPTY until the stack is deployed (wave F2) — an empty value means "this
 * build has no feedback endpoint", which the UI reports honestly instead of failing.
 *
 * e.g. 'https://<apiId>.execute-api.us-east-1.amazonaws.com/v1/feedback'
 */
export const FEEDBACK_API_URL = ''

/**
 * The S3 bucket the presigned POST must target, and its region. EMPTY alongside the API URL:
 * a dark build cannot upload anything anywhere, because `allowedUploadUrl` can never match an
 * empty bucket (see `looksLikeBucket`). Filled in by wave F2 from `terraform output`.
 *
 * The bucket name carries a `random_id` suffix for global uniqueness, so committing it leaks
 * no account id — that is the whole reason the name is randomized (§7.3).
 */
export const FEEDBACK_S3_BUCKET = ''
/** Region of the bucket above. Owner decision, 2026-08-03. */
export const FEEDBACK_S3_REGION = 'us-east-1'

/** JSON POST budget. The `itemLookup`/`mobLookup` precedent, one notch longer. */
export const SUBMIT_TIMEOUT_MS = 15_000
/** Upload budget — 2 MB over a bad hotel connection is the case this covers. */
export const UPLOAD_TIMEOUT_MS = 60_000

/** Longest URL we will even look at, matching security.ts's MAX_LINK_LEN reasoning. */
const MAX_UPLOAD_URL_LEN = 2048

/** Shared with every other outbound request this app makes (imageCache/itemLookup/mobLookup). */
const UA = 'everquest-companion/0.1 (feedback)'

/** Does this build have an endpoint compiled in? The dialog gates its Send button on it. */
export function feedbackEndpointConfigured(): boolean {
  return FEEDBACK_API_URL.length > 0
}

/**
 * S3 bucket names we accept as OUR bucket. Deliberately stricter than S3's own rule: no dots.
 *
 * A dot in a bucket name adds a label boundary to the virtual-hosted hostname
 * (`a.b.s3.<region>.amazonaws.com`), which is precisely the ambiguity an exact-match check
 * exists to avoid — and it breaks TLS wildcard validation anyway. Our bucket is
 * `eqcompanion-logs-<hex>`, so this costs nothing and removes a whole class of confusion.
 */
function looksLikeBucket(bucket: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
}

/** Region shape check, so a crafted region can never inject extra hostname labels. */
function looksLikeRegion(region: string): boolean {
  return /^[a-z]{2}-[a-z]+-\d$/.test(region)
}

/**
 * The two legal S3 endpoint spellings for `bucket` in `region`, and nothing else:
 *
 *   virtual-hosted  https://<bucket>.s3.<region>.amazonaws.com/      (what the SDK emits)
 *   path-style      https://s3.<region>.amazonaws.com/<bucket>       (forcePathStyle)
 *
 * The legacy global spellings (`<bucket>.s3.amazonaws.com`, `s3-<region>.amazonaws.com`,
 * dualstack, accelerate, access points) are NOT accepted. Every one of them is a host we do
 * not need, and each extra accepted shape is another string an attacker gets to aim at.
 */
export function uploadEndpoints(bucket: string, region: string): { virtualHost: string; pathHost: string } {
  return { virtualHost: `${bucket}.s3.${region}.amazonaws.com`, pathHost: `s3.${region}.amazonaws.com` }
}

/** Parse a bounded string as a URL. Non-strings, empty, absurdly long and malformed all → null. */
function parseBoundedUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_UPLOAD_URL_LEN) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/**
 * Plain https with nothing clever attached: no credentials, default port, no query, no
 * fragment. `createPresignedPost` returns a bare bucket endpoint and the policy travels in the
 * form FIELDS, so anything beyond that is not a shape we produce and not one we accept.
 */
function isPlainHttps(u: URL): boolean {
  return (
    u.protocol === 'https:' &&
    u.username === '' &&
    u.password === '' &&
    u.port === '' &&
    u.search === '' &&
    u.hash === ''
  )
}

/**
 * Validate the S3 endpoint the ingest API handed back, BEFORE main POSTs a log slice to it.
 * Returns the normalized href, or null — in which case nothing is uploaded at all (the report
 * itself still stands; a report without its log beats a leaked log).
 *
 * Every check, and why it is a check and not a nicety:
 *   * `https:` ONLY        — an `http:` presign would put a user's log on the wire in clear.
 *                            `file:`/`data:` would make "upload" mean something else entirely.
 *   * no credentials       — `https://our-bucket.s3.us-east-1.amazonaws.com@evil.com/` parses
 *                            with hostname `evil.com`; the host test already rejects it, and
 *                            refusing userinfo outright means we never send one either.
 *   * default port only    — `:8443` on an S3 hostname is not S3.
 *   * no query, no fragment — `createPresignedPost` returns a bare bucket endpoint; the policy
 *                            travels in the form FIELDS, never in the URL. Anything extra is
 *                            not a shape we produce, so it is not a shape we accept.
 *   * EXACT hostname match — never endsWith/includes. `new URL()` lowercases and punycodes the
 *                            host, so a homoglyph domain can never compare equal.
 *   * path pinned          — path-style must address exactly OUR bucket (`/<bucket>`), and
 *                            virtual-hosted must be the bucket root (`/`). Compared against
 *                            the RAW pathname, never a decoded one: a percent-encoded spelling
 *                            of our own bucket is harmless, and comparing raw is strictly
 *                            fail-closed.
 *
 * `bucket`/`region` are parameters (not read from the constants) so the security tests can pin
 * the real matching behavior on a realistic name while the shipped build stays dark.
 */
export function allowedUploadUrlFor(raw: unknown, bucket: string, region: string): string | null {
  // A dark build (empty bucket) can never match anything — no upload is possible at all.
  if (!looksLikeBucket(bucket) || !looksLikeRegion(region)) return null
  const u = parseBoundedUrl(raw)
  if (u === null || !isPlainHttps(u)) return null
  const { virtualHost, pathHost } = uploadEndpoints(bucket, region)
  if (u.hostname === virtualHost) return u.pathname === '/' ? u.toString() : null
  if (u.hostname === pathHost) return u.pathname === `/${bucket}` || u.pathname === `/${bucket}/` ? u.toString() : null
  return null
}

/** `allowedUploadUrlFor` bound to this build's compiled-in bucket/region. */
export function allowedUploadUrl(raw: unknown): string | null {
  return allowedUploadUrlFor(raw, FEEDBACK_S3_BUCKET, FEEDBACK_S3_REGION)
}

/**
 * The outcome of an HTTP attempt, as data. NOTHING in this module throws: `submitFeedback`
 * never rejects (§6.3), and the only way to keep that promise cheaply is for the transport to
 * report failure instead of raising it.
 *
 * `status: 0` means the request never got an answer (DNS, offline, TLS, timeout) — the case
 * that QUEUES. A real 4xx does not queue; retrying a 400 forever is a bug, not resilience.
 */
export interface HttpAttempt {
  status: number
  /** Parsed JSON body when the response carried one, else null. */
  body: unknown
  /** Present only when `status === 0`: the transport error, for the queue's diagnostics. */
  networkError?: string
}

function transportFailure(err: unknown): HttpAttempt {
  return { status: 0, body: null, networkError: err instanceof Error ? err.message : String(err) }
}

/** Read a response body as JSON, tolerating an empty or non-JSON body (returns null). */
async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.length === 0) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** POST a JSON body. Never throws. */
export async function postJson(url: string, body: unknown, timeoutMs = SUBMIT_TIMEOUT_MS): Promise<HttpAttempt> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    return { status: res.status, body: await readJsonBody(res) }
  } catch (err) {
    return transportFailure(err)
  }
}

/**
 * POST a multipart form (the presigned S3 upload). `FormData`/`Blob` are Node globals in
 * Electron 33, so this needs no HTTP dependency and no boundary bookkeeping.
 *
 * `url` MUST already have been through `allowedUploadUrl` — this function does not re-check,
 * and its only caller (submit.ts) validates first and refuses to upload on null.
 */
export async function postForm(url: string, form: FormData, timeoutMs = UPLOAD_TIMEOUT_MS): Promise<HttpAttempt> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA },
      body: form,
      signal: AbortSignal.timeout(timeoutMs)
    })
    return { status: res.status, body: null }
  } catch (err) {
    return transportFailure(err)
  }
}
