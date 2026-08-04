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

// ---- THE DARK-BUILD PINS -----------------------------------------------------------------

test('this build ships DARK: no endpoint, and no upload is possible at all', () => {
  // F1 is independently shippable precisely because these are empty. Wave F2 fills them in
  // from `terraform output`; until then the dialog reports "not available in this build".
  assert.equal(net.FEEDBACK_API_URL, '')
  assert.equal(net.FEEDBACK_S3_BUCKET, '')
  assert.equal(feedbackEndpointConfigured(), false)
  // With an empty bucket, even a perfectly-shaped S3 URL is refused — a dark build cannot be
  // talked into uploading a log by any server response, because there is no server.
  assert.equal(allowedUploadUrl('https://eqcompanion-logs-9f3a2c17.s3.us-east-1.amazonaws.com/'), null)
  assert.equal(allowedUploadUrl('https://s3.us-east-1.amazonaws.com/eqcompanion-logs-9f3a2c17'), null)
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
