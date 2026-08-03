# In-app feedback loop + agentic triage — design

Status: DESIGN (no code written). Author: planning agent, 2026-08-03.
Constrained by `AGENTS.md` — Electron trust boundary, scrub law, channel isolation, wave
model, public repo. Read that first; this document only adds what is specific to feedback.

---

## 0. What we are building, in one paragraph

A user opens a dialog in the app, picks **Feature request** or **Bug report**, types a
description, optionally attaches a **scrubbed, time-windowed slice of their EverQuest log**
that they see in full before it leaves the machine, and hits Send. The main process POSTs a
small JSON body to a public API Gateway route; a single Lambda validates it, consumes a
per-install daily quota, writes a DynamoDB row, and hands back a **presigned S3 POST** that is
pinned to one key, one content type, 2 MB, and 5 minutes. Nothing else is public. On the dev
machine, a `scripts/triage-feedback.mts` reads DynamoDB and S3 **directly over IAM** — no
server-side list endpoint exists — clusters reports, and produces a digest that Claude reasons
over and turns into `set` / `issue` commands the human approves.

---

## 1. Decisions (the short list)

> **OWNER AMENDMENTS (2026-08-03, supersede anything below that disagrees):**
> - **IaC is Terraform (HCL)**, not CDK — owner decision. See the amended §7.1/§7.2.
> - **Region: us-east-1** (not us-east-2).
> - **Dedicated AWS sub-account** (AWS Organizations) for this product.
> - **Alarm email: jmoyers+eqc@gmail.com** on the SNS ops topic.
> - Open questions 1–3 in §11 are answered by the above; Q4 (contact field) = keep
>   optional; Q5 (ErrorBoundary prefill) = yes, as the stretch.

| # | Decision | Why |
|---|---|---|
| D1 | ~~AWS CDK~~ **Terraform (HCL)** — owner decision; Lambda bundled by our own esbuild step so the shared validator import survives | §7.1 |
| D2 | Infra lives **in this repo** under `infra/` (Terraform root + a tiny esbuild bundling script; no second npm package needed beyond esbuild, already in the tree) | §7.2 |
| D3 | **One Lambda** (`submit`). No presign route, no list route, no config route | §8 |
| D4 | Triage reads **DynamoDB + S3 directly over IAM** | §10 |
| D5 | **Presigned POST**, not PUT — only POST policies support `content-length-range` | §8.4 |
| D6 | Kill switch is a **DynamoDB config item read by the Lambda**; the app fetches no config, ever | §9.6 |
| D7 | The scrub drop-list is promoted to `src/shared/logScrub.ts`; `tests/fixture-scrub.mjs` becomes a shim | §5.1 |
| D8 | Feedback state (`installId`, offline queue) lives in `<userData>/feedback.json`, **not** electron-store | §6.4 |
| D9 | `installId` is a **quota key and a block handle, not an authenticator** | §9.3 |
| D10 | Dev/prod separation is in the **data model** (partition key), not in a second stack | §4.5 |
| D11 | **No changes to `src/main/security.ts`, `tests/security.test.mts`, or the renderer CSP** | §6.5 |
| D12 | No CAPTCHA. Spam is **scored, not rejected** (except hard limit violations) | §9.5 |

---

## 2. Threat model, stated plainly

The repo is public and the client ships **no secrets**. Therefore:

- The ingest endpoint is **effectively public-write**. Anyone can read the client source, see
  the URL and the payload shape, and POST to it. Design for that, do not pretend otherwise.
- `installId` is a client-generated UUID stored in a plain JSON file the user owns. A spammer
  mints a fresh one per request for free. It is **not** an authenticator. Its real jobs are:
  (a) make the honest path cheap and the *naive* abuse path annoying, (b) link a user's
  follow-up report to their earlier one, (c) give us one thing to block.
- The controls that actually bound damage are **structural, not identity-based**: Lambda
  reserved concurrency, API Gateway route throttles, DynamoDB on-demand billing, a hard
  payload cap, a prefix-and-size-pinned presign, S3 lifecycle expiry, CloudWatch log
  retention, and a budget alarm. Those hold even against an attacker with unlimited tokens.
- The **log slice is the sensitive artifact**, not the description. It is opt-in, previewable,
  scrubbed by the same law that governs committed fixtures, expires in 90 days, and is
  deletable on request.

---

## 3. Data model

### 3.1 The Report record (logical shape)

Defined once, in `src/shared/feedback.ts`, imported by the renderer (dialog), the main process
(submit), and the Lambda (validate). One definition, three consumers — that is the point.

```ts
export const FEEDBACK_API_VERSION = 1

export type FeedbackType = 'feature' | 'bug'
export type AppChannelTag = 'prod' | 'dev'          // 'e2e' never submits — see §6.6
export type ReportStatus =
  | 'new' | 'triaged' | 'accepted' | 'shipped' | 'wontfix' | 'duplicate' | 'spam'
export type Severity = 'p0' | 'p1' | 'p2' | 'p3'

/** What the user typed. Renderer-owned; validated by the SAME function main and the Lambda use. */
export interface FeedbackDraft {
  type: FeedbackType
  /** ≤ MAX_TITLE. Optional but strongly encouraged — it is the best clustering signal we get. */
  title?: string
  /** MIN_DESCRIPTION..MAX_DESCRIPTION after trim. */
  description: string
  /** Optional email / Discord handle, ≤ MAX_CONTACT. PII — see retention (§3.5). */
  contact?: string
}

/** Everything the CLIENT knows about itself. Assembled in main; never typed by the user. */
export interface FeedbackEnv {
  appVersion: string                  // app.getVersion()
  channel: AppChannelTag              // src/main/channel.ts CHANNEL
  updateChannel: 'main' | 'stable'    // store.getUpdateChannel()
  platform: string                    // process.platform
  osRelease: string                   // os.release()
  arch: string                        // process.arch
  electron: string                    // process.versions.electron
  chrome: string                      // process.versions.chrome
  node: string                        // process.versions.node
}

/** Metadata about an attached slice. The BYTES go to S3, never through this JSON. */
export interface LogSliceMeta {
  bytes: number        // gzipped size the client is about to upload
  lines: number        // lines AFTER scrub
  dropped: number      // lines the scrub removed (shown in the preview, honest by construction)
  fromMs: number       // first kept line's timestamp
  toMs: number         // last kept line's timestamp
  sha256: string       // hex digest of the gz bytes — integrity, and a free dedupe key
}

export interface SubmitRequest {
  v: typeof FEEDBACK_API_VERSION
  draft: FeedbackDraft
  env: FeedbackEnv
  installId: string            // uuid v4 shape
  clientReportId: string       // uuid v4 — IDEMPOTENCY key across offline retries (§6.4)
  clientTs: number             // client clock, untrusted, kept for skew diagnostics
  log: LogSliceMeta | null
}

export type SubmitResponse =
  | { ok: true; reportId: string; upload: PresignedUpload | null }
  | { ok: false; error: SubmitErrorCode; message: string; field?: string; retryAfterSec?: number }

export type SubmitErrorCode =
  | 'invalid_payload' | 'blocked' | 'quota_exceeded' | 'closed' | 'too_large' | 'internal'

export interface PresignedUpload {
  url: string                       // S3 endpoint — VALIDATED before main POSTs to it (§6.5)
  fields: Record<string, string>    // the POST policy fields
  key: string
  expiresInSec: number
}
```

Limits, also in `src/shared/feedback.ts`, so the dialog, the slicer and the Lambda cannot
disagree:

```ts
export const MIN_DESCRIPTION = 10
export const MAX_DESCRIPTION = 4_000
export const MAX_TITLE = 120
export const MAX_CONTACT = 200
export const MAX_BODY_BYTES = 32 * 1024        // whole JSON request
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024  // gzipped slice
export const MAX_SLICE_LINES = 50_000
export const PREVIEW_MAX_LINES = 5_000          // what crosses IPC for the preview (§5.4)
export const LOG_WINDOW_CHOICES = [15, 30, 60] as const  // minutes
export const DEFAULT_LOG_WINDOW = 30
```

**Deliberately NOT collected**: character name, server, EQ install path, machine name, user
name, IP address (§9.7), any inventory/progress state. The character name *does* survive
inside an attached slice — that is disclosed in the dialog, and it is the user's own name in
their own log, which they have seen before sending.

### 3.2 DynamoDB — single table `EqCompanionFeedback`

Billing: **PAY_PER_REQUEST**. No provisioned capacity to over-scale, no autoscaling to
misconfigure. TTL attribute: `expiresAt` (epoch seconds).

| Item | pk | sk | Notes |
|---|---|---|---|
| Report | `REPORT#<ulid>` | `META` | the record above + triage fields |
| Install profile | `INSTALL#<installId>` | `PROFILE` | `{blocked, blockedReason, firstSeen, total}` |
| Daily quota | `INSTALL#<installId>` | `QUOTA#<yyyy-mm-dd>` | `{n, bytes, expiresAt}` TTL 3d |
| Idempotency | `INSTALL#<installId>` | `IDEMP#<clientReportId>` | `{reportId, expiresAt}` TTL 7d |
| Config / kill switch | `CONFIG` | `FEEDBACK` | `{acceptingReports, closedMessage, maxPerInstallPerDay}` |

`reportId` is a **ULID** — lexicographically sortable by creation time, so the GSI sort key
*is* the timeline and a `--since` filter is a plain `BETWEEN` on the sort key with no filter
expression and no extra attribute. Generated server-side only; a client-supplied id is never
trusted (that is what `clientReportId` is for, and it only keys the idempotency item).

**GSIs (two, both sparse-friendly, projection ALL):**

- `gsi1` *byChannel* — `gsi1pk = CH#<channel>`, `gsi1sk = <ulid>`.
  The workhorse: "every prod report since T, newest first." One partition per channel; at this
  product's volume that is nowhere near a hot-partition concern.
- `gsi2` *byStatus* — `gsi2pk = ST#<status>`, `gsi2sk = <ulid>`.
  "Everything still `new`", "everything `accepted` I haven't shipped."

No cluster GSI. Cluster membership is queried rarely and is a client-side filter on a
`byChannel` query — a third index costs write amplification on every report for a query we run
by hand once a week.

**Triage fields** (written only by the triage path, never by the Lambda, never by the client):
`status` (default `new`), `severity`, `cluster`, `dupeOf`, `disposition` (free text),
`issueUrl`, `triagedAt`, `redactedAt`.

**Server-written fields**: `receivedAt` (authoritative clock), `spamScore`, `logRef`.

### 3.3 S3 object layout

Bucket: CDK-generated physical name (see §7.3 — the account id must not be committed).

```
logs/<yyyy>/<mm>/<dd>/<reportId>.log.gz
```

- Block Public Access: **all four flags on**.
- Encryption: SSE-S3 (`AES256`). Enforced as a presign condition too, so an object cannot land
  unencrypted.
- Versioning: **off**. A versioned object makes "delete it on request" a lie.
- Lifecycle: `logs/` expires at **90 days**. No IA transition — at this volume the transition
  request cost exceeds the storage saved.
- CORS: **none needed**. Every writer and reader is a non-browser client (Electron main
  process, the triage script), so there is no `Origin` header and no preflight. Add CORS only
  if a future web client uploads directly.
- The presign policy pins the key exactly, so `logs/` is the only prefix that can ever be
  written and one presign can write exactly one object.

### 3.4 Date-partitioned keys, on purpose

`logs/<yyyy>/<mm>/<dd>/` rather than a flat prefix so a lifecycle rule, an `aws s3 ls`, and a
"wipe everything from last Tuesday's flood" are all trivial. The reportId is still in the name,
so an object always maps back to exactly one row.

### 3.5 Retention

| Data | Retention | Mechanism |
|---|---|---|
| Report row (description, env, triage) | indefinite — it *is* the backlog | none |
| `contact` field | until `triage-feedback forget <id>` | manual, one command |
| Log object | 90 days | S3 lifecycle |
| Quota counters | 3 days | DynamoDB TTL |
| Idempotency keys | 7 days | DynamoDB TTL |
| Lambda logs | 14 days | CloudWatch log group retention |
| API Gateway access logs (incl. source IP) | 14 days | log group retention — incident-only |

---

## 4. Client-side library

### 4.1 Module layout

The repo's factoring rules (`max-lines 400`, `max-lines-per-function 100`, `complexity 12`,
`max-params 4`) mean this is a directory, not a file — matching `src/main/combat/`,
`src/main/log/`, `src/main/ipc/`.

```
src/shared/feedback.ts          contract + limits + validateDraft/validateSubmit (pure, no deps)
src/shared/logScrub.ts          the promoted scrub (pure, no deps)  — §5.1
src/main/feedback/index.ts      the public API façade (this is the whole surface)
src/main/feedback/state.ts      <userData>/feedback.json: installId + queue persistence
src/main/feedback/slice.ts      read tail → window → scrub → cap → gzip
src/main/feedback/net.ts        endpoint constants + allowedUploadUrl() + fetch helpers
src/main/feedback/submit.ts     POST /v1/feedback, then the presigned S3 POST
src/main/feedback/queue.ts      offline queue + retry policy
src/main/ipc/feedback.ts        the four handlers
```

### 4.2 Public API (`src/main/feedback/index.ts`)

Small, typed, and free of Electron types in its signatures so the pieces stay unit-testable:

```ts
/** Stable anonymous per-install id. Minted lazily on FIRST feedback use, never at install. */
export function installId(): string

/** Everything the dialog needs to render its header + gate its controls. */
export function feedbackContext(): FeedbackContext
// { env: FeedbackEnv, endpointConfigured: boolean, queued: number, logAvailable: boolean }

/** Build (and cache for this session) a scrubbed slice. null when no character log is resolved. */
export function buildLogSlice(windowMinutes: number): Promise<FeedbackSlice | null>
// FeedbackSlice = LogSliceMeta & { gz: Buffer; previewLines: string[]; truncatedPreview: boolean }

/** Send. Never throws: every failure is a typed SubmitResult, and a network failure QUEUES. */
export function submitFeedback(
  draft: FeedbackDraft,
  opts: { attachLog: boolean; windowMinutes: number }
): Promise<SubmitResult>
// SubmitResult = { ok: true; reportId: string; logUploaded: boolean }
//              | { ok: false; error: SubmitErrorCode; message: string; queued: boolean }

/** Retry queued reports. Called at startup (+30s) and every 30 min. Returns how many drained. */
export function flushQueue(): Promise<number>

/** Write the FULL slice to a user-chosen path (the "save a copy" escape hatch). */
export function saveSliceToFile(windowMinutes: number): Promise<{ ok: boolean; path?: string }>
```

### 4.3 IPC additions

`src/shared/ipc.ts` — four channels, named after the domain like every other block:

```ts
  // ---- in-app feedback (Task #NN) ----
  // renderer -> main: the dialog's header context (versions, channel, queued count,
  // whether this build has an endpoint compiled in). Returns FeedbackContext.
  feedbackContext: 'feedback:context',
  // renderer -> main: build the scrubbed log slice for a window (minutes) and return a
  // CAPPED preview + the real counts. The bytes never cross IPC — only PREVIEW_MAX_LINES
  // of text plus the metadata. Returns FeedbackSlicePreview | null.
  feedbackBuildSlice: 'feedback:buildSlice',
  // renderer -> main: save the FULL slice to disk via the OS save dialog, so a user who
  // wants to read every byte before sending can. Returns {ok, path?, canceled?}.
  feedbackSaveSlice: 'feedback:saveSlice',
  // renderer -> main: submit. Args (draft, {attachLog, windowMinutes}). Never rejects;
  // a network failure resolves with {ok:false, queued:true}. Returns SubmitResult.
  feedbackSubmit: 'feedback:submit',
```

Preload adds four methods on `window.eq`, in the established style (typed, documented,
`ipcRenderer.invoke`). **No new push channels** — the dialog pulls on open; a queue-changed
push would be surface for no benefit.

### 4.4 Renderer feature

```
src/renderer/src/features/feedback/FeedbackDialog.tsx   the flow
src/renderer/src/features/feedback/LogPreview.tsx       the scrollable preview box
src/renderer/src/features/feedback/useFeedback.ts       context + submit state hook
```

Flow (one MUI `Dialog`, three states — compose, sending, done):

1. **Type toggle**: `Feature request | Bug report`. Default from the entry point (a
   "Report a problem" entry point preselects Bug).
2. **Title** (optional) + **Description** (required, live char counter against
   `MAX_DESCRIPTION`, Send disabled until `validateDraft` passes — the *same* validator the
   server runs, so a round trip is never spent learning something we already knew).
3. **Contact** (optional), labelled honestly: "Only if you want a reply. Stored with the
   report; ask us to delete it any time."
4. **Attach log** — shown only for `bug`. Checkbox **on by default** for bugs (it is the whole
   point of a bug report), with a window selector (15 / 30 / 60 min) and, beneath it, the
   preview — expanded, not collapsed. Feature requests never show this section.
5. **Preview box**: a fixed-height, `overflow:auto` monospace box (the AGENTS UI law — a
   growing list lives in a fixed-height scroll box) rendered through the existing
   `lib/useWindowedRows`. Header line, stated as *state*, never as process:
   `4,812 lines · 14:02–14:32 · 91 lines removed · 128 KB compressed`
   Dates through `lib/formatDate` (user-local; never UTC). A **Save a copy…** button writes
   the complete slice via the OS save dialog, so "you can see exactly what is sent" is
   literally true and not a claim about a truncated preview.
6. **Send**. On success: a short confirmation with the report id (so a user can quote it).
   On `closed`: the server's `closedMessage`, verbatim, as a quiet info state. On a network
   failure: "Saved — we'll send it next time you're online" plus the queued count.

**Entry point**: a footer item in `NavDrawer` ("Send feedback") that opens the dialog, hosted
from `App.tsx` (`feedbackOpen` state), plus a section in `PreferencesView` with the same two
buttons. Feedback is a *dialog*, not a `View` — `appViews.ts` is untouched.

**Stretch (same wave, optional)**: `lib/ErrorBoundary.tsx` gets a "Report this" action that
opens the dialog with `type:'bug'` and the error message/stack prefilled into the description.
High value, small diff — but it must not touch `src/main/errorLog.ts`.

### 4.5 dev vs prod separation

`channel` comes from `src/main/channel.ts`'s `CHANNEL`. Reports carry it; the `byChannel` GSI
partitions on it; the triage script defaults to `--channel prod`. Dev-channel reports (the
developer dogfooding the dialog) therefore never pollute the real backlog but are one flag
away.

`e2e` **never submits.** A hard guard in `submitFeedback` — `if (E2E) return { ok:false,
error:'internal', message:'disabled in e2e' }` — matching the precedent where
`provisionDefaultPacks()` is skipped in e2e. The headless harness must not touch the network
or create rows.

Channel is client-claimed and therefore untrusted; it is a *filter*, not a security control.
A flood can claim `prod`. That is fine — the structural caps do not depend on it.

---

## 5. The log slicer + scrubber

### 5.1 Promoting the scrub (the one part that touches existing law)

Today `tests/fixture-scrub.mjs` is plain ESM JavaScript in `tests/`, imported by six
`tests/extract-*.mjs` extractors. `src/main` cannot import it: it is outside both tsconfigs,
outside the electron-vite bundle graph, and shipping a file from `tests/` into the app would be
wrong on its face. Re-implementing the drop list in main is **forbidden** by AGENTS ("never
re-implement a drop list").

**Plan**: move the logic to `src/shared/logScrub.ts` (pure TypeScript, zero imports — no
`node:`, no Electron), and leave `tests/fixture-scrub.mjs` as a thin shim.

```ts
// src/shared/logScrub.ts  (new — the ONE definition of "third-party chat/social")
export const PET_CLAIM_RE = /told you, '(?:Attacking .+ Master|I am unable to wake .+?, Master)\.'$/
export interface ScrubOpts {
  /** The character whose own /who row and own identity survive. Fixtures: 'Primitive'.
   *  A user's report: their active character name. Absent ⇒ no self carve-out. */
  readonly selfName?: string
}
export function isThirdPartyChat(line: string, opts?: ScrubOpts): boolean
export function scrubKeep(line: string, opts?: ScrubOpts): boolean
/** The counting variant the preview needs: one pass, kept lines + how many were dropped. */
export function scrubLines(lines: readonly string[], opts?: ScrubOpts): { kept: string[]; dropped: number }
```

```js
// tests/fixture-scrub.mjs  (rewritten — a shim, not a second opinion)
import { PET_CLAIM_RE, isThirdPartyChat as shared, scrubKeep as keep } from '../src/shared/logScrub.ts'
export { PET_CLAIM_RE }
export const SELF_NAME = 'Primitive'
export const isThirdPartyChat = (line) => shared(line, { selfName: SELF_NAME })
export const scrubKeep = (line) => keep(line, { selfName: SELF_NAME })
```

Consequences, all of them deliberate:

- The extractors must now be invoked under the tsx loader:
  `node --import tsx tests/extract-combat-fixtures.mjs <log>`. Record that as npm scripts
  (`fixtures:combat`, `fixtures:buffs`, `fixtures:loot`, `fixtures:leveling`,
  `fixtures:item-tiers`, `fixtures:consider`) so the invocation lives in `package.json`
  instead of in someone's memory, and update `scripts/README.md` + the AGENTS scrub
  paragraph's file path.
- The scrub gains type-aware lint + typecheck coverage for the first time (`src/shared/**` is
  in both tsconfigs). Free win.
- The `selfName` carve-out becomes a **parameter** instead of a constant. That is exactly what
  the app-side use needs — for a fixture, self is `Primitive`; for a user's report, self is
  their active character.
- **Everything else stays byte-identical.** The DROP list, the pet-claim carve-out, the
  drop-never-rewrite law, the ordering of the checks: unchanged.

**Regression gate (mandatory, this is the repo's own law applied here):** after the promotion,
re-run every extractor against the live log and prove `git diff --stat tests/fixtures/` is
**empty**. A byte-identical fixture tree is the proof the promotion changed nothing. If the
tree is not clean beforehand, baseline it first.

*Rejected alternative*: converting the six extractors to `.mts` in the same wave. Bigger diff,
more risk, no additional benefit — note it as an optional follow-up.

### 5.2 Windowing — time AND bytes, in that order

Both, because either alone fails:

1. **Byte-bounded tail read.** Open the active character log **read-only** (`open(path,'r')`)
   and read at most the last `TAIL_READ_CAP = 16 MB` (`fh.read` at `size - cap`). Discard the
   first, possibly-partial line. This is the memory guarantee: the live log is 1.02M lines and
   growing, and no report may ever load it whole.
   **The game log is never opened for writing. Not `'a'`, not `'w'`, not ever.**
2. **Time window.** Anchor at the timestamp of the **last line in the file**, not at
   `Date.now()` — a user who alt-tabbed out twenty minutes ago must not get an empty slice.
   Window = `[anchor - windowMinutes, anchor]`. Parse each line's `[Sat Aug 01 13:00:28 2026]`
   prefix with **`parseEqTimestamp` re-exported from `src/main/log/parser.ts`** — reuse, never
   a second timestamp parser. Lines with an unparseable prefix (`ts === 0`) are kept if they
   fall between two in-window lines (continuation lines), else dropped.
3. **Scrub.** `scrubLines(lines, { selfName: activeCharacter.name })`. DROP the line; never
   rewrite it. Count the drops — the preview shows them.
4. **Line cap.** If still over `MAX_SLICE_LINES = 50_000`, keep the **last** 50k — the lines
   nearest the problem.
5. **Gzip.** `zlib.gzipSync(text, { level: 9 })`. EQ logs are extremely repetitive and
   compress ~8–12×.
6. **Size fit.** If gz bytes > `MAX_UPLOAD_BYTES` (2 MB), halve the window and retry, at most
   3 times, then hard-truncate from the front. Whatever survives is what the preview reports —
   the displayed span is always the *actual* span.

**Why these numbers.** A busy hour in this log runs ~30–60k lines / 3–6 MB raw; gzipped that
is roughly 300–600 KB. A 2 MB gz cap therefore covers a full 60-minute raid with several times
the headroom, while capping S3 cost per report at a rounding error and keeping the presign
policy's `content-length-range` meaningful. `MAX_SLICE_LINES` at 50k means the byte cap, not
the line cap, is normally the binding constraint — which is the right way round, because bytes
are what we pay for.

### 5.3 What survives the scrub, and saying so

The scrub drops third-party chat/social **by line shape**. It is a filter, not a proof. What
remains, by design, and what the dialog says in plain language:

- The user's own character name and their own `/who` row.
- Bystanders' names in *mechanical* lines (kill credit, fizzles, third-person buff emotes) —
  load-bearing for the world model, and they carry nobody's words.
- Zones, times of play, spells cast, loot, deaths.

Dialog copy (state, never process): *"Your log slice is included. Chat, tells, group and
/who lines are removed. Your character's name, zones, spells and combat lines stay — that's
what makes a bug reproducible. Read the whole thing below before you send it."*

### 5.4 Preview UX

`feedback:buildSlice` returns at most `PREVIEW_MAX_LINES = 5_000` lines of text plus the true
counts, so a 4 MB string never crosses IPC. Anything longer is previewed as **first 500 + last
4,500** with an explicit `… N lines omitted from this preview …` marker — and the **Save a
copy…** button writes the complete slice to disk. "You can see exactly what is sent" therefore
remains literally true rather than a claim about a truncated view.

---

## 6. Client mechanics

### 6.1 Where the network happens

**Main process only.** The renderer performs no `fetch`/XHR — `connect-src 'self'` in
`src/renderer/index.html` already makes that structurally impossible, and **this feature
requires zero CSP changes**. If a future agent finds themselves wanting to widen `connect-src`
for feedback, they have made a mistake: the work belongs in `src/main/feedback/`.

### 6.2 Endpoint constant

`src/main/feedback/net.ts`:

```ts
/** The ingest API. EMPTY until the stack is deployed (§12, wave F2) — an empty value means
 *  "this build has no feedback endpoint", which the UI reports honestly instead of failing. */
export const FEEDBACK_API_URL = ''  // e.g. 'https://<apiId>.execute-api.us-east-2.amazonaws.com/v1/feedback'
```

There is **no user-configurable endpoint override**. An overridable ingest URL is an
exfiltration primitive: it turns "attach my log" into "attach my log to a host of the
attacker's choosing." Explicitly rejected.

Moving to a custom domain later is a one-line change plus a release. Accepted debt; the
kill-switch message gives us a way to tell stragglers to update.

### 6.3 Timeouts and failure

`AbortController` with a 15 s budget for the JSON POST and 60 s for the S3 upload (the
`itemLookup`/`mobLookup` precedent). `submitFeedback` **never rejects**; every outcome is a
typed result. A 5xx or a network error queues; a 4xx does not (retrying a 400 forever is a
bug, not resilience).

### 6.4 Offline queue and idempotency

- Persisted at `<userData>/feedback.json`: `{ version: 1, installId, queue: QueuedReport[] }`.
- Slice bytes are **not** in that JSON — they go to `<userData>/feedback-pending/<clientReportId>.gz`
  and the queue entry holds the path + `LogSliceMeta`.
- Cap 10 entries, max 5 attempts each, exponential backoff, dropped after 7 days (the pending
  gz is unlinked with it).
- Flush on app start (+30 s, after the tail is attached) and every 30 min.
- Each queued report carries a stable `clientReportId`, sent as the idempotency key. The server
  writes `INSTALL#<id> / IDEMP#<clientReportId>` conditionally; a retry that races a successful
  first attempt gets **200 with the original `reportId`**, not a duplicate row.

**Why not electron-store?** The store-migration law exists so the *settings* file written by
any past build loads in today's build, indefinitely. Feedback state is disposable and
regenerable — an unreadable queue costs at most a few unsent reports. Paying the migration tax
(bump `CURRENT_SCHEMA_VERSION`, append a `MIGRATIONS` step, author a fixture) for disposable
state is the wrong trade, and putting a 2 MB blob anywhere near the settings file is worse. So:
its own file, its own tiny `version` integer, corrupt ⇒ regenerate from empty. **An executor
must not "helpfully" move this into electron-store** — that would trigger the migration law for
no benefit.

### 6.5 Trust-boundary implications (read this before touching anything)

- **`src/main/security.ts` is not modified. `tests/security.test.mts` is not modified.** They
  stay green, untouched, as a signal that this feature did not weaken the boundary.
- **`EXTERNAL_LINK_ALLOWLIST` is not widened.** The dialog offers no external link, so nothing
  new reaches `shell.openExternal`. If a future iteration wants a "view your report" link, that
  is a separate, deliberate decision with its own test.
- **New boundary, owned by this feature**: the presigned upload URL **comes from the server**.
  It is remote-supplied text that the main process is about to POST a file to — exactly the
  class of input `allowedExternalUrl` exists for. So `src/main/feedback/net.ts` gets a sibling
  in the same spirit:

  ```ts
  /** Validate the S3 endpoint the ingest API handed back, before main POSTs a log to it.
   *  https only · no credentials · default port · EXACT hostname match against the two legal
   *  S3 spellings for our bucket/region (virtual-hosted and path-style). Never endsWith/
   *  includes — `our-bucket.s3.us-east-2.amazonaws.com.evil.com` must fail, and does.
   *  Returns the normalized href, or null (in which case nothing is uploaded at all). */
  export function allowedUploadUrl(raw: unknown): string | null
  ```

  Pinned by a new `tests/feedbackNet.test.mts` that mirrors `security.test.mts`'s rigor: no
  Electron, no network, never skips. It lives beside the feature rather than inside
  `security.ts` so wave ownership stays disjoint and the pinned test file is untouched; a
  later consolidation into `security.ts` is a fine follow-up, on purpose, with intent.
- Renderer-supplied strings validated **at the IPC handler**: `windowMinutes` must be one of
  `LOG_WINDOW_CHOICES`; the draft goes through `validateDraft` in `src/main/ipc/feedback.ts`
  before anything else happens. Same law as `sounds:getData`'s `packId`.

### 6.6 Channel guards recap

| channel | submits? | why |
|---|---|---|
| prod | yes | the point |
| dev | yes, tagged `dev` | the developer dogfoods the real path; triage filters it out by default |
| e2e | **never** | hard guard; the headless harness must not touch the network |

---

## 7. Infrastructure

### 7.1 Terraform (owner decision, 2026-08-03) — and how the shared validator survives

**Terraform (HCL). Chosen by the owner**, superseding this plan's original CDK
recommendation. What CDK was buying and how each piece is kept:

- **The decisive concern — one validator, client and server — survives intact.** The Lambda
  handler stays TypeScript (`infra/lambda/submit.ts`) and still imports `validateSubmit`
  from `src/shared/feedback.ts`. We bundle it ourselves: `infra/build.mjs` runs **esbuild**
  (already in the repo's dependency tree) with `--bundle --platform=node --format=esm
  --target=node22` to `infra/dist/submit.mjs`, zips it, and Terraform's
  `aws_lambda_function` deploys it via `filename` + `source_code_hash =
  filebase64sha256(...)`. The handler is still unit-tested under `node --test` against the
  shared contract, unbundled.
- The controls this design leans on (route throttles, reserved concurrency, DDB TTL + GSIs,
  S3 lifecycle + BPA, budgets, alarms, log retention) are all first-class Terraform
  resources — nothing is lost, and `terraform plan` is the review artifact.
- **State**: S3 backend in the dedicated sub-account (one hand-created bootstrap bucket +
  DynamoDB lock table, documented in `infra/README.md`); the `backend "s3"` block ships from
  day one. Never commit `*.tfstate`.

### 7.2 Where it lives: this repo, `infra/`, as a Terraform root

**In this repo**, because a change to the request shape must be one commit that moves
`src/shared/feedback.ts`, the client, and the Lambda together. No second npm package is
needed — Terraform brings no node dependencies, and esbuild is already in the tree.

```
infra/
  versions.tf     terraform + provider pins, backend "s3" block
  variables.tf    region (us-east-1), alarm_email, triage_principal_arn
  api.tf          HTTP API + stage + route throttles
  lambda.tf       aws_lambda_function + reserved concurrency + log retention
  dynamo.tf       table + 2 GSIs + TTL
  s3.tf           bucket (random_id suffix) + BPA + lifecycle + SSE
  iam.tf          Lambda role (least-privilege §8.5) + triage role
  alarms.tf       SNS topic + email sub + CloudWatch alarms + AWS Budget
  outputs.tf      api_url, table_name, bucket_name, triage_role_arn
  build.mjs       esbuild bundle + zip for the handler
  lambda/submit.ts
  README.md       sub-account setup, backend bootstrap, apply, teardown
```

Root `.gitignore` gains `infra/.terraform/`, `infra/dist/`, `*.tfstate*`, and `.triage/`.

**CI**: `.github/workflows/infra.yml`, triggered only on `infra/**`:
`terraform fmt -check` · `terraform init -backend=false` · `terraform validate` ·
`node infra/build.mjs` (proves the handler bundles). **CI never plans or applies** —
no cloud credentials or OIDC deploy role exist in a public repo. Deployment is a manual
act from the dev machine against the sub-account profile.

### 7.3 Naming, with the web product in mind

This is the seed of the product's cloud footprint, so nothing is named "feedback" at a level
where a future website would have to live under it.

| Thing | Name | Growth note |
|---|---|---|
| Terraform root | `infra/` (state key `eqcompanion/feedback`) | future roots: `eqcompanion/web`, `eqcompanion/auth` share the backend |
| HTTP API | `eqcompanion-api`, stage `v1` | future web routes join **this** API under new paths |
| Route | `POST /v1/feedback` | versioned from day one |
| DynamoDB table | `EqCompanionFeedback` | one table per bounded context, not one per app |
| S3 bucket | `eqcompanion-logs-<random_id hex>` | see below |
| Triage role | `EqCompanionFeedbackTriageRole` | |
| SNS alarm topic | `EqCompanionOpsAlerts` | product-wide; email sub: jmoyers+eqc@gmail.com |
| Region | **us-east-1** | owner decision; the bucket makes it effectively sticky |

**The bucket name gets a `random_id` suffix** (Terraform `random_id` resource) for global
uniqueness, so the account id never appears in git — this repo is public, and an account id
in git is a gift to anyone probing. The triage script resolves every physical name from
**`terraform output -json`** once (run in `infra/`, or via the values cached at deploy time)
and caches them in `.triage/stack.json` (gitignored). Outputs: `api_url`, `table_name`,
`bucket_name`, `triage_role_arn`.

The only value that gets committed is `FEEDBACK_API_URL`, which contains the API id — not the
account id — and must be in the client anyway.

---

## 8. Server side

### 8.1 Topology

```
Internet ──POST /v1/feedback──► API Gateway HTTP API (stage v1, auth NONE)
                                   │ route throttle 2 rps / burst 5
                                   ▼
                            Lambda  eqcompanion-feedback-submit
                            Node 22 · ARM64 · 256 MB · 10 s · reservedConcurrency 5
                                   │
                     ┌─────────────┴─────────────┐
                     ▼                           ▼
            DynamoDB EqCompanionFeedback   presigned POST (returned to client)
                                                 │
Client ──multipart POST (≤2 MB, 5 min, one key)──┘──► S3 logs/<y>/<m>/<d>/<id>.log.gz
```

### 8.2 Exactly one Lambda

`POST /v1/feedback` is the entire public surface. Specifically **not** built:

- **No separate presign route.** A standalone presign endpoint is independently abusable (free
  presigns without ever writing a report). Folding the presign into the submit response means a
  presign can only be minted by an act that already passed validation, the kill switch, the
  block check, and the quota.
- **No list/read route.** Triage runs on the dev machine with an AWS profile; it queries
  DynamoDB and S3 directly over IAM (§10). Building a public authenticated read endpoint would
  create a second thing to secure for zero benefit. **D4.**
- **No config/health route.** The kill switch rides in the submit response (§9.6), so the app
  fetches no configuration at any point in its lifecycle.
- **No S3 event notification Lambda.** Whether an upload actually landed is answered by a
  `HeadObject` at triage time, which is free enough and one fewer moving part.

### 8.3 `POST /v1/feedback` — handler contract

**Request**: `Content-Type: application/json`, body = `SubmitRequest` (§3.1), ≤ 32 KB.

**Steps, cheapest first (each one is a place to stop):**

1. `Content-Length > MAX_BODY_BYTES` or unparseable JSON → **400 `invalid_payload`**.
   (API Gateway's own 10 MB ceiling is a backstop, not the control.)
2. `validateSubmit(body)` — the shared pure validator: `v === 1`, enum membership, length
   bounds, `installId`/`clientReportId` uuid shape, `appVersion` matches
   `/^\d+\.\d+\.\d+(?:-[\w.]+)?$/`, `log.bytes <= MAX_UPLOAD_BYTES`, `log.sha256` is 64 hex.
   Reject, never truncate — a silently truncated description is a lie to both parties.
   → **400 `invalid_payload` { field }**.
3. `BatchGetItem` for `CONFIG/FEEDBACK` and `INSTALL#<id>/PROFILE` (one round trip).
   Config is cached in Lambda module scope for 60 s, so warm invocations usually skip it.
   - `acceptingReports === false` → **503 `closed`**, `message` = the stored `closedMessage`,
     rendered verbatim to the user.
   - `profile.blocked` → **403 `blocked`**. The client stops retrying on 403.
4. Idempotency: `GetItem INSTALL#<id>/IDEMP#<clientReportId>`. Hit → **200** with the stored
   `reportId` and `upload: null`. (Folded into step 3's BatchGet.)
5. Quota: `UpdateItem` on `INSTALL#<id>/QUOTA#<utcDate>` —
   `ADD n :one, bytes :b SET expiresAt = :ttl`,
   `ConditionExpression: attribute_not_exists(n) OR n < :max` (`:max` from config, default
   **10/day**). `ConditionalCheckFailedException` → **429 `quota_exceeded`** with
   `retryAfterSec` = seconds to UTC midnight.
6. Mint `reportId` (ULID). Compute `spamScore` (§9.5).
7. `PutItem` the report with `ConditionExpression: attribute_not_exists(pk)`. Write the
   idempotency item in the same `TransactWriteItems` so a retry can never fork.
8. If `log !== null`: `createPresignedPost` (§8.4).
9. **201** `{ ok: true, reportId, upload }`.

**Responses** are all `application/json`:

| Status | `error` | When |
|---|---|---|
| 201 | — | created |
| 200 | — | idempotent replay; same `reportId`, `upload: null` |
| 400 | `invalid_payload` | shape/limits; carries `field` |
| 403 | `blocked` | install blocked |
| 413 | `too_large` | body over cap |
| 429 | `quota_exceeded` | daily per-install cap; carries `retryAfterSec` |
| 503 | `closed` | kill switch; carries the human `message` |
| 500 | `internal` | logged, never echoes internals to the client |

### 8.4 The presigned upload

`createPresignedPost` (`@aws-sdk/s3-presigned-post`) — **POST, not PUT** (D5): only the POST
policy language supports `content-length-range`. A presigned PUT can be handed any number of
bytes up to 5 GB, which would make the entire cost model a promise instead of a constraint.

```ts
Key:     `logs/${yyyy}/${mm}/${dd}/${reportId}.log.gz`   // server-chosen, never client-supplied
Expires: 300                                              // 5 minutes
Conditions: [
  ['content-length-range', 1, MAX_UPLOAD_BYTES],          // 1 B .. 2 MB, enforced by S3
  ['eq', '$Content-Type', 'application/gzip'],
  ['eq', '$x-amz-server-side-encryption', 'AES256'],
]
```

- The key is exact (not a `starts-with`), so one presign writes exactly one object at one path.
- 5 minutes is comfortably inside the Lambda role's temporary-credential lifetime (a presign
  dies with the credentials that signed it) and short enough that a leaked presign is close to
  worthless.
- The Lambda's role holds **`s3:PutObject` on `<bucket>/logs/*` and nothing else** — no
  `GetObject`, no `DeleteObject`, no `ListBucket`. The presign cannot grant what the signer
  lacks.

The client POSTs `multipart/form-data` built from `FormData` + `Blob` (both Node globals in
Electron 33) — no HTTP library dependency. On a non-2xx it records `logRef.uploaded` as
unknown and still keeps the report; a report without its log is far better than a lost report.

### 8.5 Lambda IAM (least privilege, spelled out)

| Action | Resource | Why |
|---|---|---|
| `dynamodb:GetItem`, `BatchGetItem` | table | config, profile, idempotency |
| `dynamodb:UpdateItem` | table | quota counter |
| `dynamodb:PutItem`, `TransactWriteItems` | table | the report + idempotency item |
| `s3:PutObject` | `<bucket>/logs/*` | to sign the presign |
| `logs:*` | its own log group | via the managed basic-execution policy |

Notably absent: `dynamodb:Query`, `dynamodb:Scan`, `dynamodb:DeleteItem`, any `s3:GetObject`.
The ingest path can create and count. It cannot read the corpus or delete anything — so a
compromised handler leaks nothing and destroys nothing.

---

## 9. Abuse and operations

### 9.1 Throttles

| Control | Value | Rationale |
|---|---|---|
| HTTP API default stage throttle | 5 rps / burst 10 | product-wide ceiling |
| `POST /v1/feedback` route throttle | 2 rps / burst 5 | ~170k reports/day upper bound; real demand is a handful |
| Lambda reserved concurrency | **5** | the hard blast-radius cap — bounded spend even if a throttle is misconfigured, and it can never starve a future function |
| Per-install daily quota | 10/day (config item, changeable without deploy) | a human filing an 11th report in one day is exceptional; make it a support case |
| Body cap | 32 KB | before any state is touched |
| Upload cap | 2 MB gz, 5 min, one key | S3-enforced, not client-promised |

### 9.2 Cost blast radius

- DynamoDB **on-demand**; nothing to over-provision, nothing to autoscale.
- CloudWatch log retention **14 days** on the Lambda group and the API access-log group. (This
  is the sneaky cost line in "serverless is free" architectures — set it explicitly.)
- S3 lifecycle **90 days** on `logs/`.
- **AWS Budgets**: $10/month with 50 / 80 / 100 % notifications to SNS → email.
- **CloudWatch alarms** → the same SNS topic:
  - API Gateway `Count` > 5,000 in 5 minutes (a flood is visible in minutes, not at month end)
  - API Gateway `5xx` > 10 in 5 minutes
  - Lambda `Errors` > 10 in 5 minutes, Lambda `Throttles` > 0
  - DynamoDB `ThrottledRequests` > 0
- Worst realistic case: an attacker saturating the 2 rps route throttle for a month is ~5.2 M
  requests ≈ $5 of API Gateway plus bounded Lambda/DDB — under the budget threshold and alarmed
  within five minutes.

### 9.3 Per-install anonymous tokens, honestly

`installId` is a UUIDv4 the client mints **lazily on first feedback use** (not at install —
there is no reason to create an identifier for a user who never files a report) and persists in
`<userData>/feedback.json`.

It is a **quota key and a block handle**. It is not a secret, it is not verified, and a
determined spammer rotates it for free. Saying so here prevents a future agent from building
policy on top of it as though it were an identity.

**Documented upgrade path, deliberately not built now**: a `POST /v1/install` mint endpoint
returning `{installId, token: HMAC(secret, installId)}`, with the submit handler verifying the
HMAC. That buys real revocation (a blocked token cannot be forged, only re-minted) at the cost
of a round trip, a secret to manage, and a second public route. **Trigger for building it**:
the first time we observe token *rotation* abuse specifically — i.e. blocks stop working. Not
before.

### 9.4 Blocking, takedown, wipe — what "dealing with abuse" actually looks like

| Situation | Command | Effect |
|---|---|---|
| One install spamming | `triage-feedback block <installId> --reason "..."` | PutItem `PROFILE.blocked=true` → every submit 403s. Instant, no deploy. |
| False positive | `triage-feedback unblock <installId>` | |
| Someone asks us to delete their report | `triage-feedback forget <reportId>` | strips `contact`, deletes the S3 object, sets `redactedAt`. Description kept (it's the bug). |
| Full erasure request | `triage-feedback wipe --install <installId>` | deletes every report + object from that install |
| Garbage flood already landed | `triage-feedback list --spam --since 1d --json \| triage-feedback set --status spam --stdin` | bulk-mark; rows stay for pattern analysis, logs expire on their own |
| Active flood in progress | `triage-feedback closed on --message "Feedback is paused while we fix an abuse problem — sorry."` | **instant global stop, no deploy** |
| Nuclear | `cd infra && terraform destroy` | bucket carries `lifecycle { prevent_destroy = true }` so evidence and real reports survive a destroy (remove the block deliberately to truly delete) |

### 9.5 Spam handling — scored, never rejected

**No CAPTCHA.** Friction on the report path costs us real bug reports from people who were
already annoyed enough to file one; the spam it would stop costs us a DynamoDB row. That trade
is not close.

The Lambda computes a cheap `spamScore` (0–100) from pure heuristics and stores it. It never
changes the response:

- description shorter than 25 chars after trim: +20
- fewer than 4 distinct words: +25
- more than 3 URLs: +30
- non-ASCII-letter ratio > 0.5, or a single character repeated > 20 times: +25
- all-caps ratio > 0.8 over 40+ chars: +15
- same `sha256`-of-description already seen from a different install today: +40 (a cheap
  copy-paste-flood signal, computed from a `DEDUPE#<hash>` TTL item)

Hard rejections stay limited to things that are *definitionally* invalid: empty/too-short
description, bad enum, oversize body, malformed uuid. Everything else lands as `status:'new'`
with a score, and triage bulk-marks. **A wrongly-rejected real bug report costs far more than a
spam row.**

### 9.6 Kill switch (D6)

A `CONFIG / FEEDBACK` DynamoDB item: `{ acceptingReports: boolean, closedMessage: string,
maxPerInstallPerDay: number }`, read by the Lambda (60 s module-scope cache).

- Flipping it is one `UpdateItem` — instant, no deploy, no release.
- Clients get `503 closed` plus the human message, which the dialog renders verbatim as a calm
  info state, not an error.
- The daily quota is in the same item, so tightening or loosening it is also deploy-free.
- **The app fetches no configuration at startup or at any other time.** This is the entire
  reason the kill switch lives in the *response* rather than in a config document the client
  polls: a polled config file is a new network dependency, a new failure mode, and a new
  surface. The only time the app talks to us is when the user pressed Send.

### 9.7 Source IPs

**Not stored on the report item.** An IP is PII and buys almost nothing at this scale (the
quota key and the structural caps do the work). API Gateway access logging is enabled with
14-day retention as an **incident-only** record: if there is ever a real flood, the evidence
exists for two weeks and then evaporates. That is the right balance between "we can investigate
an attack" and "we are not building a log of who reported what from where."

---

## 10. Triage workflow

### 10.1 Access path

The dev machine has an AWS profile. `scripts/triage-feedback.mts` uses the AWS SDK v3 directly
against DynamoDB and S3. **There is no server-side read API** (D4).

- Optional `--role-arn` assumes `EqCompanionFeedbackTriageRole` (created by the Terraform
  root, trusted by the principal in `var.triage_principal_arn`). Using the role rather
  than raw admin credentials keeps the least-privilege story real and makes the same script
  work unchanged from a second machine or a future CI job.
- Role permissions: `dynamodb:Query/GetItem/UpdateItem/DeleteItem/BatchWriteItem` on the table
  and its indexes; `s3:GetObject/DeleteObject/ListBucket` on `<bucket>/logs/*`.
- Physical resource names resolve from `terraform output -json` (run in `infra/`) on first
  run, cached at `.triage/stack.json` (gitignored). No account id, table name, or bucket
  name is committed.

**Dependencies**: `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-s3`
go in the root **`devDependencies`** — `scripts/**` is inside
`tsconfig.node.json`, so the script must typecheck with the rest of the tree, and
electron-builder packages only `dependencies`, so nothing reaches the installer. (Verify that
claim once, mechanically, in the wave gate.) None of them has an install hook, so
`.npmrc ignore-scripts=true` is unaffected — but remember `npm run deps:electron` after any
`npm install`.

### 10.2 Commands

```
triage-feedback list   [--status new] [--channel prod|dev|all] [--type bug|feature]
                       [--since 7d] [--min-score N] [--limit 100] [--json]
triage-feedback show   <reportId>          # full record; downloads + gunzips the slice to .triage/
triage-feedback digest [--since 7d]        # the markdown brief a human/Claude reads
triage-feedback cluster [--since 30d] [--write]
triage-feedback set    <reportId> [--status ...] [--severity p0..p3] [--cluster ID]
                       [--dupe-of ID] [--note "..."]   # also accepts --stdin for bulk
triage-feedback issue  <reportId>          # gh issue create; stamps issueUrl back
triage-feedback forget <reportId>          # strip contact + delete the object
triage-feedback wipe   --install <id>
triage-feedback block  <installId> --reason "..."   |   unblock <installId>
triage-feedback closed <on|off> [--message "..."]
```

`--since 7d` becomes a ULID range on the GSI sort key — a `BETWEEN` query, no filter
expression, no scan. A `--scan` escape hatch exists and prints a loud warning.

### 10.3 Clustering

Two layers. The script is deterministic and never calls a model; the model reasons over the
script's output.

**Layer 1 — deterministic pre-cluster** (`scripts/triageCluster.mts`, a pure module with unit
tests in `tests/triageCluster.test.mts`):

1. **Crash-signature clustering first, and it is the strong one.** Any report whose description
   *or* attached slice contains an `[everquest-companion:error]` line yields a key of
   `<source tag>|<first stack frame>` — e.g. `renderer:ErrorBoundary|CombatTimeline.tsx:214`.
   That is a far better identity than prose, and it is a repo-specific advantage: our own error
   harness stamps exactly the fields needed. Reports sharing a signature are one cluster,
   period.
2. **Token-set near-duplicate** for the rest: normalize (lowercase, strip punctuation and
   digits, drop stopwords), tokenize, and group at Jaccard ≥ 0.6. Reuse `src/shared/fuzzy.ts`'s
   `tokenize` / `scoreQuery` if they fit the shape; if they turn out to be fight-name specific,
   keep the scoring local to `triageCluster.mts` rather than bending a tested module.
3. **Version-band annotation**: a cluster whose members are all on one `appVersion` is
   flagged — that is a regression, and it should be read differently from a long-standing gripe.
4. Cluster ids are stable and human-readable: `c-<first-report-ulid-suffix>`. `--write` stamps
   `cluster` on the members.

**Layer 2 — agentic (Claude, on the dev machine).** The loop is:

1. `triage-feedback digest --since 7d --json` emits a compact digest: one line per report,
   ≤ 200 chars, **PII stripped** (no `contact`, no log text) — small enough to reason over
   whole.
2. Claude reads it, proposes themes, merges clusters the token heuristic split, identifies
   duplicates, and drafts priorities against what it knows of the codebase (it can open the
   files the cluster implicates — that is the real advantage over a generic triage tool).
3. Claude **emits `triage-feedback set` / `issue` commands as text**. The human reads and runs
   them. The script never takes instructions from report content, and the model never writes to
   DynamoDB unattended.
4. For a cluster worth acting on, `triage-feedback show <id>` pulls the slice locally and Claude
   reads the actual log window — which is the whole reason we collect it.

**LAW: a log slice is never pasted into a public GitHub issue.** The repo is public. `issue`
posts the description, the env block, and a *summary* of what the log showed. The slice stays
in S3 and in `.triage/` (gitignored, and already covered by the blanket `*.log` ignore).

### 10.4 Human-facing output

`triage-feedback digest --since 7d` prints markdown, ready to paste into a chat turn:

```markdown
## Feedback digest — 7 days to 2026-08-03 (prod)
14 reports · 9 bug · 5 feature · 3 new clusters · 2 blocked installs · 0 spam-marked

### Clusters by weight
1. **c-8F2K · 5 reports · BUG · p1?** — overlay meter blank after zoning
   All on 0.1.3 (regression: first seen 0.1.3, 0 reports on 0.1.2)
   Logs: 5/5 attached · signature `renderer:ErrorBoundary|OverlayMeter.tsx:88`
   → suspect: zone finalize path (world-model law 7) races the overlay's snapshot pull
2. **c-1QZ7 · 3 reports · FEATURE** — "let me pin a specific fight to the overlay"
...

### Unclustered new bugs (2)
- 01J8… 0.1.3 win32 · "poison timer shows negative after re-coating" · log ✔

### Needs a decision
- c-1QZ7 (3×) — overlay pinning: scope call before it grows
```

---

## 11. Risks and open questions

| Risk | Severity | Mitigation |
|---|---|---|
| Public-write endpoint on a personal AWS account | **high** | reserved concurrency 5 + route throttle + on-demand DDB + 2 MB presign + 90-day lifecycle + 14-day log retention + $10 budget alarm + 5-minute flood alarm + instant kill switch |
| PII survives the scrub (own name, bystanders in mechanical lines, play times) | **high** | opt-in attach, mandatory in-dialog preview, "save a copy" for full inspection, plain-language disclosure, 90-day expiry, `forget`/`wipe` commands, never in a public issue |
| Scrub promotion silently changes fixture output | **high** | byte-identical `git diff --stat tests/fixtures/` gate after re-running all six extractors |
| Endpoint URL baked into the client; a domain move needs a release | medium | one constant in one file; kill-switch message can instruct stragglers; **no** user-configurable override (that is an exfil primitive) |
| `installId` mistaken for an identity by future work | medium | stated explicitly here and in the module header; HMAC upgrade path documented with an explicit trigger |
| AWS SDK leaks into the shipped app | medium | devDependencies only; verify once mechanically (`npm run dist:dir`, grep the asar for `@aws-sdk`) |
| Slicer reads a 1 GB log into memory | medium | 16 MB tail cap before anything else happens |
| Slicer touches the game log | **critical if it happened** | read-only `open(path,'r')`; assert in review; the wave brief says it twice |
| New files add lint-ratchet debt | low | zero new ratchet entries is the wave gate; adding one is the integrator's call, never an executor's |
| DynamoDB scan in triage gets expensive | low | GSI + ULID range queries; `--scan` warns loudly |
| Duplicate reports from offline retries | low | `clientReportId` idempotency item in the same transaction as the report |

**Open questions for the owner:**

1. **AWS account** — dedicated to this product, or shared with other jmoyers things? A
   dedicated account makes the budget alarm and a nuclear teardown genuinely safe. Recommend
   dedicated if it is cheap to create.
2. **Region** — us-east-2 assumed. The bucket makes this effectively one-way.
3. **Alarm email address** for the SNS topic.
4. **Contact field** — keep it, or drop it entirely and rely on GitHub issues for follow-up?
   Dropping it removes the only PII field and simplifies retention considerably. Recommend
   keeping it as optional; it is the difference between "can't reproduce, closing" and a fix.
5. **Should the ErrorBoundary auto-offer a prefilled bug report?** High value; slightly more
   renderer surface. Recommended as a stretch in the renderer wave.

---

## 12. Wave plan

Per AGENTS: 1–5 agents in parallel, **disjoint file ownership**, integrate → verify → commit
per wave. Shared hot files (`package.json`, `AGENTS.md`, `src/shared/ipc.ts`) are named to
exactly one owner each.

### Pre-wave (integrator, one small commit — the "keep the tree buildable" law)

Land **skeletons** of the two shared modules so every agent can import them from their first
edit and `npm run dev` never breaks:

- `src/shared/feedback.ts` — types + constants + `validateDraft`/`validateSubmit` signatures
  with real bodies for the trivial parts.
- `src/shared/logScrub.ts` — signatures + a temporary re-implementation-free body that simply
  re-exports the current logic (wave F1-A then does the real move and the byte-identical gate).
- `src/main/feedback/net.ts` — `FEEDBACK_API_URL = ''` and the `allowedUploadUrl` signature.
- Empty `infra/` directory with a stub `README.md` so F1-D has a home (Terraform needs no
  package.json; esbuild comes from the root tree).

### Wave F1 — four parallel agents

**F1-A · Shared contract + scrub promotion**
- Owns: `src/shared/feedback.ts`, `src/shared/logScrub.ts`, `tests/fixture-scrub.mjs`,
  `tests/feedbackContract.test.mts` (new), `scripts/README.md`.
- Does: fill in the contract + validators; move the DROP list with the `selfName` parameter;
  rewrite the shim; unit-test the validator against every limit boundary and the scrub against
  the exact families in the fixture-scrub header (including the pet-claim carve-out and the
  self `/who` row).
- **Verify**: `npm run typecheck` · `npm test` · **byte-identical fixture gate** — re-run all
  six extractors under `node --import tsx` and prove `git diff --stat tests/fixtures/` is
  empty. Reports the exact npm-script lines it needs; the integrator adds them to
  `package.json`.
- Touches nothing under `src/main`, `src/renderer`, `infra`.

**F1-B · Main-process feedback library**
- Owns: `src/main/feedback/{index,state,slice,submit,queue,net}.ts`,
  `src/main/ipc/feedback.ts` (new file only), `tests/feedbackSlice.test.mts`,
  `tests/feedbackNet.test.mts`.
- Does: the slicer (read-only tail, time window via `parseEqTimestamp`, scrub, caps, gzip), the
  `feedback.json` state file + queue, the submit path + presigned upload, `allowedUploadUrl`.
- **Verify**: typecheck · lint with **zero new ratchet entries**
  (`EQ_LINT_NO_RATCHET=1 npx eslint .` to see the true state) · new unit tests green ·
  `npm run dev` still compiles throughout.
- **Must not touch**: `src/main/security.ts`, `src/main/ipc/index.ts`, `src/shared/ipc.ts`,
  `src/main/store.ts`, `src/main/errorLog.ts`, anything under `src/renderer`.
- Brief must say, twice: **the game log is opened read-only and is never written to.**

**F1-C · IPC surface + preload + renderer feature**
- Owns: `src/shared/ipc.ts` (the four channels), `src/main/ipc/index.ts` (one registration
  line), `src/preload/index.ts` + `index.d.ts`,
  `src/renderer/src/features/feedback/**` (new), `src/renderer/src/App.tsx`,
  `src/renderer/src/components/NavDrawer.tsx`,
  `src/renderer/src/features/preferences/PreferencesView.tsx`.
- Does: channel names + preload methods + the dialog, preview (via `lib/useWindowedRows`,
  fixed height + own `overflow:auto`), entry points. Optional stretch:
  `lib/ErrorBoundary.tsx` "Report this".
- **Verify**: `npm run typecheck` (node **and** web) · lint · `npm test` ·
  **`npm run test:e2e`** (main + renderer changed ⇒ required by the operating model).
- Re-read `src/shared/ipc.ts`, `App.tsx`, `NavDrawer.tsx` immediately before each surgical edit
  (concurrent-agent law).

**F1-D · Infra (Terraform) + triage script**
- Owns: `infra/**`, `scripts/triage-feedback.mts`, `scripts/triageCluster.mts`,
  `tests/triageCluster.test.mts`, `.github/workflows/infra.yml`, `.gitignore`.
- Does: the Terraform root per amended §7.2 (HTTP API + throttles, Lambda + reserved
  concurrency + log retention, DDB + 2 GSIs + TTL, S3 + BPA + lifecycle + prevent_destroy,
  budget + alarms + SNS email sub, triage role, outputs), `build.mjs` esbuild bundling, the
  submit handler importing `validateSubmit` from `src/shared/feedback.ts`, and the triage
  CLI + pure clustering module.
- **Verify**: `cd infra && terraform fmt -check && terraform init -backend=false &&
  terraform validate && node build.mjs` (**no plan/apply**) · root `npm run typecheck`
  (scripts/ is in tsconfig.node) · `npm test` · lint.
- Reports the exact devDependency lines it needs; the integrator adds them to `package.json`
  and runs `npm install` + `npm run deps:electron`.

**Integrator (F1 close)**: owns `package.json`, `AGENTS.md`, the commit. Runs the full
gauntlet — `npm run typecheck` → `npm run lint` (+ `EQ_LINT_NO_RATCHET=1` to confirm no new
debt) → `npm test` → `npm run test:e2e`. Confirms `tests/security.test.mts` passes **and is
unmodified**. Confirms `git diff` shows no change to `src/main/security.ts` or
`src/renderer/index.html`.

At the end of F1 the feature is **complete but dark**: `FEEDBACK_API_URL` is empty, so the UI
reports "feedback isn't available in this build" and no network call is possible. That is
deliberate — F1 is independently shippable and cannot regress anything.

### Wave F2 — deploy and light it up (integrator + 1 agent)

**Integrator (manual, on the dev machine):**
1. One time: create the dedicated **sub-account** (AWS Organizations), an admin profile for
   it, and the state-backend bootstrap (S3 bucket + DynamoDB lock table) in **us-east-1**;
   record the steps in `infra/README.md`.
2. `cd infra && terraform init` then
   `terraform apply -var triage_principal_arn=<arn> -var alarm_email=jmoyers+eqc@gmail.com`
   (confirm the SNS subscription email).
3. Seed the config item: `triage-feedback closed off --message "…"` (i.e. `acceptingReports: true`).
4. Put the `api_url` output into `FEEDBACK_API_URL` in `src/main/feedback/net.ts`; commit.
5. End-to-end from the **dev** app: submit a bug with a log → verify the DDB row, the S3
   object, the `sha256`, and that the slice contains no third-party chat → `triage-feedback
   list --channel dev` → `show` → `digest`.
6. Negative tests, by hand: oversize body → 400; 11th report in a day → 429; `closed on` → 503
   with the message rendered in the dialog; `block` → 403; an expired presign → upload fails
   and the report still exists.

**F2-A · Docs** — owns `README.md` (a "Feedback" section: what is sent, what is not, how to ask
for deletion), `SECURITY.md` (the report/log-retention paragraph), `infra/README.md`
(bootstrap/deploy/teardown/rotate runbook). `AGENTS.md` stays the integrator's.

**F2-B · (optional) polish** — ErrorBoundary prefill if it was deferred; queue-flush wiring on
startup if deferred; a `feedback` section in the digest of the dev app's own errors.log.

### Release

Per the cadence law: **tag only when the user asks or at a clearly stable point.** F2 ends with
a real external dependency newly live, so let it soak on the dev channel before a tag.
