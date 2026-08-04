/**
 * devS3Leg.mts — the S3 half of the local stack: the response shape, S3's error XML, a
 * dependency-free multipart parser, and the presign POLICY check.
 *
 * MOVED OUT OF `dev-feedback-server.mts` UNCHANGED, for room. That file sat at exactly the
 * repo's 400-code-line ceiling, and the `/v1/telemetry` rehearsal had to go somewhere; a split
 * is this repo's standing answer to that (`triageCluster.mts`, `src/main/triage/store.ts`,
 * `telemetryValidate.ts`), never a widened threshold. Everything here is PURE and takes no
 * server state, which is exactly why it is the piece that moved: the parts that know about
 * `State` stayed put.
 *
 * FIDELITY, unchanged from the header it came from: this reproduces what S3 CHECKS (the pinned
 * key, the two `eq` conditions, the content-length-range) and the words it says when a check
 * fails. It does not reproduce the SIGNATURE — there is no key to sign with locally, so a
 * client that mangled `Policy`/`X-Amz-Signature` is accepted here and refused by the real S3.
 */

import { Buffer } from 'node:buffer'

/** What a route answers with. `xml` is the S3 shape; `json` is the ingest API's. */
export interface Res {
  status: number
  json?: unknown
  xml?: string
  /** Extra detail for the one console line this request prints. */
  note?: string
}

/** S3's own words for the two `content-length-range` failures. */
export const TOO_BIG = 'Your proposed upload exceeds the maximum allowed size'
export const TOO_SMALL = 'Your proposed upload is smaller than the minimum allowed size'

export const s3Error = (status: number, code: string, message: string): Res => ({
  status,
  xml: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
  note: code,
})

export function boundaryOf(contentType: string | undefined): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '')
  if (m === null) return null
  const b = (m[1] ?? m[2] ?? '').trim()
  return b.length === 0 ? null : b
}

function addPart(out: Map<string, Buffer>, raw: Buffer): void {
  const sep = raw.indexOf('\r\n\r\n')
  if (sep === -1) return
  const name = /name="([^"]*)"/i.exec(raw.subarray(0, sep).toString('latin1'))?.[1]
  if (name === undefined) return
  // The payload runs to the CRLF that precedes the next delimiter.
  out.set(name, raw.subarray(sep + 4, Math.max(sep + 4, raw.length - 2)))
}

/** Dependency-free multipart/form-data split. Enough for what `FormData` emits, no more. */
export function multipartFields(body: Buffer, boundary: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const delim = Buffer.from(`--${boundary}`)
  let at = body.indexOf(delim)
  while (at !== -1) {
    const start = at + delim.length
    const next = body.indexOf(delim, start)
    if (next === -1) break
    addPart(out, body.subarray(start, next))
    at = next
  }
  return out
}

/** The three `Conditions` the real presign policy pins, checked the way S3 checks them. */
export function policyViolation(parts: Map<string, Buffer>, key: string): Res | null {
  const field = (name: string): string => parts.get(name)?.toString('utf8') ?? ''
  const pinned: [string, string][] = [
    ['key', key],
    ['Content-Type', 'application/gzip'],
    ['x-amz-server-side-encryption', 'AES256'],
  ]
  const bad = pinned.find(([name, want]) => field(name) !== want)
  if (bad === undefined) return null
  return s3Error(403, 'AccessDenied', `Invalid according to Policy: Policy Condition failed: ["eq", "$${bad[0]}", ...]`)
}
