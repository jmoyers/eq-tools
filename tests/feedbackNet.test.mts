// feedback/net.ts — the upload boundary.
//
// The presigned upload URL is handed to us by a SERVER and then handed by the main process to
// `fetch` with a user's log slice attached. That makes it exactly the same class of input as
// the wiki-title URLs `security.ts allowedExternalUrl` guards: remote-supplied text aimed at a
// powerful sink. The sink here is different (we send data OUT rather than asking the OS to
// open something), and so is the failure: a hostname hole in this function is a log-exfil
// primitive.
//
// Same rigor, same shape as tests/security.test.mts: no Electron, no network, no fixtures, so
// this suite NEVER skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import * as net from '../src/main/feedback/net'
import { allowedUploadUrl, allowedUploadUrlFor, feedbackEndpointConfigured, uploadEndpoints } from '../src/main/feedback/net'

/** A realistic deployed name: `eqcompanion-logs-<random_id hex>` (§7.3). */
const BUCKET = 'eqcompanion-logs-9f3a2c17'
const REGION = 'us-east-1'
const ok = (raw: unknown): string | null => allowedUploadUrlFor(raw, BUCKET, REGION)

// ---- the shapes we actually produce -----------------------------------------------------

test('allowedUploadUrl accepts exactly the two legal S3 spellings for our bucket', () => {
  const { virtualHost, pathHost } = uploadEndpoints(BUCKET, REGION)
  assert.equal(virtualHost, 'eqcompanion-logs-9f3a2c17.s3.us-east-1.amazonaws.com')
  assert.equal(pathHost, 's3.us-east-1.amazonaws.com')

  // Virtual-hosted (what @aws-sdk/s3-presigned-post emits): the BUCKET ROOT. The object key
  // travels in the form fields, never in the URL.
  assert.equal(ok(`https://${virtualHost}`), `https://${virtualHost}/`)
  assert.equal(ok(`https://${virtualHost}/`), `https://${virtualHost}/`)
  // Path-style (forcePathStyle), with and without the trailing slash.
  assert.equal(ok(`https://${pathHost}/${BUCKET}`), `https://${pathHost}/${BUCKET}`)
  assert.equal(ok(`https://${pathHost}/${BUCKET}/`), `https://${pathHost}/${BUCKET}/`)
  // An explicit :443 is the default port, not a different service — WHATWG strips it.
  assert.equal(ok(`https://${virtualHost}:443/`), `https://${virtualHost}/`)
  // The host is normalized by `new URL()`, so a shouty spelling is the same host.
  assert.equal(ok(`https://${virtualHost.toUpperCase()}/`), `https://${virtualHost}/`)
})

test('the returned href is the NORMALIZED url, never the caller string', () => {
  const { virtualHost } = uploadEndpoints(BUCKET, REGION)
  // What we POST to is what we validated — the WHATWG normalization is already applied.
  assert.equal(ok(`https://${virtualHost}:443`), `https://${virtualHost}/`)
})

// ---- scheme, credentials, port, query ---------------------------------------------------

test('allowedUploadUrl refuses every scheme but https', () => {
  const { virtualHost } = uploadEndpoints(BUCKET, REGION)
  assert.equal(ok(`http://${virtualHost}/`), null) // a clear-text presign would leak the slice
  assert.equal(ok(`file:///C:/Windows/Temp/x`), null)
  assert.equal(ok(`data:text/plain,hi`), null)
  assert.equal(ok(`ftp://${virtualHost}/`), null)
  assert.equal(ok(`javascript:alert(1)`), null)
  assert.equal(ok(`eqimg://item/1`), null)
})

test('allowedUploadUrl refuses credentials, non-default ports, query and fragment', () => {
  const { virtualHost, pathHost } = uploadEndpoints(BUCKET, REGION)
  // Parses with hostname `evil.com`; the host test alone would catch it, and we also refuse
  // userinfo outright so we never SEND one.
  assert.equal(ok(`https://${virtualHost}@evil.com/`), null)
  assert.equal(ok(`https://user:pw@${virtualHost}/`), null)
  assert.equal(ok(`https://${virtualHost}:8443/`), null)
  assert.equal(ok(`https://${pathHost}:8443/${BUCKET}`), null)
  // The POST policy travels in the form fields. A query string is not a shape we produce.
  assert.equal(ok(`https://${virtualHost}/?x=1`), null)
  assert.equal(ok(`https://${virtualHost}/#frag`), null)
  assert.equal(ok(`https://${pathHost}/${BUCKET}?uploads`), null)
})

// ---- the hostname hole this function exists to close ------------------------------------

test('allowedUploadUrl matches the host EXACTLY (no endsWith/includes hole)', () => {
  const { virtualHost, pathHost } = uploadEndpoints(BUCKET, REGION)
  // The canonical suffix attack. THIS is the one that matters.
  assert.equal(ok(`https://${virtualHost}.evil.com/`), null)
  assert.equal(ok(`https://${pathHost}.evil.com/${BUCKET}`), null)
  // Prefix and infix variants.
  assert.equal(ok(`https://evil-${virtualHost}/`), null)
  assert.equal(ok(`https://x.${virtualHost}/`), null)
  assert.equal(ok(`https://evil.com/${virtualHost}/`), null)
  assert.equal(ok(`https://evil.com/?u=https://${virtualHost}/`), null)
  // Someone else's bucket in our region, in both spellings.
  assert.equal(ok(`https://not-our-bucket.s3.${REGION}.amazonaws.com/`), null)
  assert.equal(ok(`https://${pathHost}/not-our-bucket`), null)
  assert.equal(ok(`https://${pathHost}/not-our-bucket/${BUCKET}`), null)
  // Our bucket in the WRONG region is a different bucket.
  assert.equal(ok(`https://${BUCKET}.s3.us-west-2.amazonaws.com/`), null)
  assert.equal(ok(`https://s3.us-west-2.amazonaws.com/${BUCKET}`), null)
})

test('allowedUploadUrl accepts only the two spellings — no legacy or alternate endpoints', () => {
  // Every one of these is a real S3 endpoint form. None of them is a shape we emit, so none of
  // them is a shape we accept: each extra accepted host is another string to aim at us.
  assert.equal(ok(`https://${BUCKET}.s3.amazonaws.com/`), null) // legacy global
  assert.equal(ok(`https://s3.amazonaws.com/${BUCKET}`), null) // legacy global path-style
  assert.equal(ok(`https://${BUCKET}.s3-${REGION}.amazonaws.com/`), null) // legacy dashed region
  assert.equal(ok(`https://${BUCKET}.s3.dualstack.${REGION}.amazonaws.com/`), null)
  assert.equal(ok(`https://${BUCKET}.s3-accelerate.amazonaws.com/`), null)
  assert.equal(ok(`https://${BUCKET}.s3.${REGION}.amazonaws.com.cn/`), null)
})

test('allowedUploadUrl pins the PATH, not just the host', () => {
  const { virtualHost, pathHost } = uploadEndpoints(BUCKET, REGION)
  // Virtual-hosted: the bucket root only. A key in the path is not how a presigned POST works,
  // and accepting one would let a server aim the write at an arbitrary prefix.
  assert.equal(ok(`https://${virtualHost}/logs/2026/08/03/x.log.gz`), null)
  assert.equal(ok(`https://${virtualHost}//`), null)
  // Path-style: exactly our bucket, nothing deeper.
  assert.equal(ok(`https://${pathHost}/`), null)
  assert.equal(ok(`https://${pathHost}`), null)
  assert.equal(ok(`https://${pathHost}/${BUCKET}/logs/x.gz`), null)
  assert.equal(ok(`https://${pathHost}/${BUCKET}x`), null)
  assert.equal(ok(`https://${pathHost}/x${BUCKET}`), null)
  // Traversal is resolved by WHATWG BEFORE we compare, and we return the NORMALIZED href — so
  // a `..` spelling either normalizes to our own bucket (harmless: that is where it goes) or
  // fails the comparison. It can never widen what we POST to.
  assert.equal(ok(`https://${pathHost}/other/../${BUCKET}`), `https://${pathHost}/${BUCKET}`)
  assert.equal(ok(`https://${pathHost}/${BUCKET}/../other`), null)
})

// ---- garbage in ---------------------------------------------------------------------------

test('allowedUploadUrl refuses non-strings, empty, unparseable and absurdly long input', () => {
  for (const bad of [null, undefined, 0, 1, {}, [], true, Symbol('x')]) {
    assert.equal(ok(bad), null)
  }
  assert.equal(ok(''), null)
  assert.equal(ok('not a url'), null)
  assert.equal(ok('//no-scheme.example/'), null)
  assert.equal(ok(`https://${BUCKET}.s3.${REGION}.amazonaws.com/?${'a'.repeat(4096)}`), null)
})

// ---- the bucket/region shape guards ------------------------------------------------------

test('a malformed bucket or region can never produce a match', () => {
  // A dotted bucket adds a label boundary to the virtual-hosted host — refused outright.
  assert.equal(allowedUploadUrlFor('https://a.b.s3.us-east-1.amazonaws.com/', 'a.b', REGION), null)
  assert.equal(allowedUploadUrlFor('https://S3.us-east-1.amazonaws.com/X', 'X', REGION), null) // uppercase bucket
  assert.equal(allowedUploadUrlFor('https://b.s3.us-east-1.amazonaws.com/', 'b', REGION), null) // too short
  assert.equal(allowedUploadUrlFor('https://ok-bucket.s3.evil.amazonaws.com/', 'ok-bucket', 'evil'), null)
  assert.equal(allowedUploadUrlFor('https://ok-bucket.s3..amazonaws.com/', 'ok-bucket', ''), null)
})

// ---- THE SHIPPED CONSTANTS ---------------------------------------------------------------
//
// This build is LIT (wave F2 filled the three constants in from `terraform output`), so the
// old "ships dark" pins are gone. What replaces them is the property that actually matters and
// that survives a redeploy: the compiled endpoint is https, on OUR api and OUR region, and the
// bound `allowedUploadUrl` accepts our bucket and NOTHING else. The api id is deliberately not
// pinned literally — re-applying the root mints a new one, and a test that fails on a redeploy
// teaches people to edit tests.

test('the compiled endpoint is https on our own API, in our own region', () => {
  assert.equal(feedbackEndpointConfigured(), true)
  const u = new URL(net.FEEDBACK_API_URL)
  assert.equal(u.protocol, 'https:')
  assert.match(u.hostname, /^[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/)
  assert.equal(u.pathname, '/v1/feedback')
  assert.equal(u.username, '')
  assert.equal(u.search, '')
  assert.equal(net.FEEDBACK_S3_REGION, 'us-east-1')
  assert.match(net.FEEDBACK_S3_BUCKET, /^eqcompanion-logs-[0-9a-f]+$/)
})

test('the BOUND allowedUploadUrl accepts our bucket and refuses every other host', () => {
  const { virtualHost, pathHost } = uploadEndpoints(net.FEEDBACK_S3_BUCKET, net.FEEDBACK_S3_REGION)
  assert.equal(allowedUploadUrl(`https://${virtualHost}/`), `https://${virtualHost}/`)
  assert.equal(
    allowedUploadUrl(`https://${pathHost}/${net.FEEDBACK_S3_BUCKET}`),
    `https://${pathHost}/${net.FEEDBACK_S3_BUCKET}`
  )
  // The suffix attack, against the REAL name this build ships with.
  assert.equal(allowedUploadUrl(`https://${virtualHost}.evil.com/`), null)
  assert.equal(allowedUploadUrl('https://eqcompanion-logs-9f3a2c17.s3.us-east-1.amazonaws.com/'), null)
  assert.equal(allowedUploadUrl('http://127.0.0.1:8477/devstack/upload/x'), null)
})

test('net.ts exposes NO endpoint override — an overridable ingest URL is an exfil primitive', () => {
  // §6.2 rejects a user-configurable endpoint explicitly. This is the tripwire that makes the
  // rejection structural: adding a setter/override to this module fails the suite.
  const setters = Object.keys(net).filter((k) => /^(set|override|configure)/i.test(k))
  assert.deepEqual(setters, [])
  // And the constants are constants: the module exports no mutable binding for them.
  assert.equal(typeof net.FEEDBACK_API_URL, 'string')
  assert.equal(net.FEEDBACK_S3_REGION, 'us-east-1')
})

// ---- THE DEV GATE (scripts/dev-feedback-server.mts) --------------------------------------
//
// `EQ_FEEDBACK_URL` lets an UNPACKAGED, non-e2e Electron process point the whole feedback path
// at a LOOPBACK server, so the dialog, the quota, the idempotent replay and the presign leg
// are all rehearsable with no cloud. That is one env var away from being the exfiltration
// primitive §6.2 rejects, so the gate is pinned here from both sides:
//
//   * OPEN only for the exact fact set that means "a developer's own checkout", and only for
//     a url naming the machine the log is already on.
//   * CLOSED — byte-identically closed — for a PACKAGED build, for e2e, and for any process
//     that is not Electron at all. The last one is what this suite itself runs under, which is
//     why the module-level pins above still describe the compiled build.

const DEV_URL = 'http://127.0.0.1:8477/v1/feedback'
const facts = (over: Partial<net.RuntimeFacts> = {}): net.RuntimeFacts => ({
  execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
  platform: 'win32',
  electron: '33.2.0',
  e2e: false,
  url: DEV_URL,
  ...over,
})

test('the dev gate opens for an unpackaged Electron process with a loopback url', () => {
  assert.equal(net.devUnlocked(facts()), true)
  assert.equal(net.devEndpointFor(facts()), DEV_URL)
  // Electron's own isPackaged definition is per-platform: bare `electron` off win32.
  assert.equal(
    net.devEndpointFor(facts({ platform: 'linux', execPath: '/repo/node_modules/electron/dist/electron' })),
    DEV_URL
  )
  assert.equal(net.devEndpointFor(facts({ url: 'http://[::1]:8477/v1/feedback' })), 'http://[::1]:8477/v1/feedback')
})

test('THE PACKAGED PROOF: the gate is shut, and the env var does nothing at all', () => {
  // The packaged case as a VALUE — a real installed build's exe, everything else identical.
  const packaged = facts({ execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\everquest-companion\\EQ Legends Companion.exe' })
  assert.equal(net.devUnlocked(packaged), false)
  assert.equal(net.devEndpointFor(packaged), '')
  // ...and with the gate shut, `allowedUploadUrlFor` is the function it was before the dev
  // parameter existed: same answers, on the shipped bucket, for every shape.
  const { virtualHost } = uploadEndpoints(BUCKET, REGION)
  assert.equal(allowedUploadUrlFor(DEV_URL, BUCKET, REGION, net.devEndpointFor(packaged)), null)
  assert.equal(allowedUploadUrlFor('http://127.0.0.1:8477/devstack/upload/x', BUCKET, REGION, ''), null)
  assert.equal(allowedUploadUrlFor(`https://${virtualHost}/`, BUCKET, REGION, ''), `https://${virtualHost}/`)
  // Not Electron at all (a script, the Lambda, this test runner): shut.
  assert.equal(net.devEndpointFor(facts({ electron: undefined })), '')
  assert.equal(net.devEndpointFor(facts({ electron: '' })), '')
  // e2e: shut, so the headless harness can never be pointed at a server either.
  assert.equal(net.devEndpointFor(facts({ e2e: true })), '')
  // An unrecognized exe name reads as PACKAGED — the gate fails closed.
  assert.equal(net.devEndpointFor(facts({ execPath: 'C:\\weird\\thing.exe' })), '')
  assert.equal(net.devEndpointFor(facts({ execPath: '' })), '')
})

test('the dev endpoint is LOOPBACK-ONLY — that is what makes it not an exfil primitive', () => {
  // The whole safety argument: a value that can only name this machine cannot send a log
  // anywhere. Every one of these is refused even with the gate otherwise open.
  for (const bad of [
    'https://evil.com/v1/feedback',
    'http://evil.com/v1/feedback',
    'http://127.0.0.1.evil.com/v1/feedback',
    'http://localhost:8477/v1/feedback', // a NAME resolves through the machine's resolver
    'http://127.0.0.1:8477/v1/feedback?x=1',
    'http://127.0.0.1:8477/v1/feedback#f',
    'http://user:pw@127.0.0.1:8477/v1/feedback',
    'file:///C:/Windows/Temp/x',
    'ftp://127.0.0.1/x',
    'not a url',
    '',
  ]) {
    assert.equal(net.devEndpointFor(facts({ url: bad })), '', bad)
  }
  assert.equal(net.devEndpointFor(facts({ url: undefined })), '')
})

test('under the OPEN gate the extra accepted origin is exactly the dev endpoint, nothing else', () => {
  const origin = new URL(DEV_URL).origin
  const ok = (raw: string): string | null => allowedUploadUrlFor(raw, BUCKET, REGION, origin)
  assert.equal(ok('http://127.0.0.1:8477/devstack/upload/01J8ZQ'), 'http://127.0.0.1:8477/devstack/upload/01J8ZQ')
  // A different port, a different host, or anything clever attached is still refused.
  assert.equal(ok('http://127.0.0.1:9999/devstack/upload/x'), null)
  assert.equal(ok('http://[::1]:8477/devstack/upload/x'), null)
  assert.equal(ok('https://evil.com/devstack/upload/x'), null)
  assert.equal(ok('http://127.0.0.1:8477/x?y=1'), null)
  assert.equal(ok('http://user@127.0.0.1:8477/x'), null)
  // And the S3 rules are untouched by the dev origin being present.
  const { virtualHost } = uploadEndpoints(BUCKET, REGION)
  assert.equal(ok(`https://${virtualHost}/`), `https://${virtualHost}/`)
  assert.equal(ok(`https://${virtualHost}.evil.com/`), null)
})

test('IN A REAL PROCESS: setting EQ_FEEDBACK_URL changes nothing when the gate is shut', () => {
  // The pure tests above pin the predicate; this one pins the MODULE. Two child processes
  // import net.ts for real — one with the env var set, one without — and the resolved endpoint,
  // the dev origin and the upload verdict must come back byte-identical. This runner is not
  // Electron, which is exactly the "gate shut" case a packaged build is in.
  const netUrl = new URL('../src/main/feedback/net.ts', import.meta.url).href
  const code =
    `const n = await import(${JSON.stringify(netUrl)});` +
    `process.stdout.write(JSON.stringify([n.FEEDBACK_API_URL, n.DEV_UPLOAD_ORIGIN,` +
    ` n.allowedUploadUrl('http://127.0.0.1:8477/devstack/upload/x')]))`
  const run = (env: NodeJS.ProcessEnv): string =>
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      encoding: 'utf8',
      env,
    })

  const bare = { ...process.env }
  delete bare.EQ_FEEDBACK_URL
  const withEnv = run({ ...bare, EQ_FEEDBACK_URL: DEV_URL })
  const without = run(bare)
  assert.equal(withEnv, without)
  assert.equal(JSON.parse(withEnv)[1], '')
  assert.equal(JSON.parse(withEnv)[2], null)
})

// ---- THE STARTUP WIRING (feedback/queue.ts ← src/main/index.ts) --------------------------
//
// The offline queue only helps if something DRAINS it. `startQueueFlush()` shipped exported and
// uncalled, so a report queued after a failed send spooled to `<userData>/feedback.json` +
// `feedback-pending/*.gz` and sat there until it aged out unsent — silent data loss under a
// green suite. Two things are pinned here:
//
//   1. THE DECISION, as a pure function. `queueFlushEnabled` is the ONE guard both `flushQueue`
//      and `startQueueFlush` route through. The queue itself resolves
//      `app.getPath('userData')` through state.ts and therefore cannot be imported outside
//      Electron at all, which is exactly why the decision was lifted into net.ts.
//   2. THE SEAM, read off the composition root's source. Booting Electron to watch a timer is
//      the e2e harness's job, and the e2e harness is guard-excluded from this path by design,
//      so it can never observe it. A source pin costs nothing, never skips, and fails loudly if
//      a later refactor drops the call the way the first wave did.

test('queueFlushEnabled: the drain runs only with an endpoint, and never under EQ_E2E', () => {
  const url = 'https://pcy0z3xjp9.execute-api.us-east-1.amazonaws.com/v1/feedback'
  assert.equal(net.queueFlushEnabled(false, url), true)
  // A DARK build (§6.2: the constant ships empty until the stack is deployed) has nowhere to
  // send, so it must not spin timers that could only ever no-op.
  assert.equal(net.queueFlushEnabled(false, ''), false)
  // The headless harness never submits, so it never drains either — endpoint or not.
  assert.equal(net.queueFlushEnabled(true, url), false)
  assert.equal(net.queueFlushEnabled(true, ''), false)
  // …and the two ways of asking "does this build have an endpoint" agree.
  assert.equal(net.queueFlushEnabled(false, net.FEEDBACK_API_URL), net.feedbackEndpointConfigured())
})

test('the composition root STARTS the drain and stops it on shutdown', () => {
  const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(src, /import \{ startQueueFlush, stopQueueFlush \} from '\.\/feedback'/)
  assert.match(src, /^\s*startQueueFlush\(\)$/m)
  assert.match(src, /^\s*stopQueueFlush\(\)$/m)
})

test('both queue entry points route through the ONE guard', () => {
  // Two copies of a network gate is how one of them drifts: `flushQueue` and `startQueueFlush`
  // ask the same question, in the same words, of the same predicate.
  const src = readFileSync(new URL('../src/main/feedback/queue.ts', import.meta.url), 'utf8')
  assert.equal((src.match(/queueFlushEnabled\(E2E, FEEDBACK_API_URL\)/g) ?? []).length, 2)
})
