// shareCodec.ts — the wire format for share strings (the ONE place compression lives).
//
//   EQC1-<base64url(deflateRaw(utf8(canonicalJson(envelope))))>
//
// Split from src/shared/profiles.ts because it needs node:zlib: the shared module stays
// pure so the renderer can bundle it, and the renderer reaches this codec over IPC. That
// also means there is exactly ONE encoder and ONE decoder in the app — no chance of the two
// sides disagreeing about the format.
//
// Design notes:
//  - deflateRaw (no zlib/gzip header): every byte counts in a chat message, and the prefix
//    already identifies the format.
//  - base64url (`-`/`_`, no `=` padding): survives Discord, IRC, query strings and
//    double-click-to-select without mangling. Single line, always.
//  - decode NEVER throws: every failure comes back as a typed ShareDecodeError so the UI can
//    say what went wrong ("cut off when it was copied") instead of surfacing a stack.

import { deflateRawSync, inflateRawSync } from 'node:zlib'
import {
  canonicalJson,
  SHARE_LIMITS,
  SHARE_PREFIX,
  validateEnvelope,
  type ShareDecodeError,
  type ShareEnvelope,
  type ShareKind,
  type ShareValidation
} from '../shared/profiles'

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/** Encode an envelope into its single-line share string. */
export function encodeShareString(env: ShareEnvelope): string {
  const json = canonicalJson(env)
  return SHARE_PREFIX + toBase64Url(deflateRawSync(Buffer.from(json, 'utf8'), { level: 9 }))
}

/**
 * Decode a pasted string. Tolerant of the ways chat clients mangle a paste — surrounding
 * whitespace, wrapped lines, a stray code-fence — but never of a bad checksum: a payload
 * whose body doesn't match its `sum` is REJECTED rather than partially applied.
 */
export function decodeShareString(input: string): ShareValidation {
  if (!input) return { ok: false, error: 'empty' }
  // Strip anything that can't be part of a base64url payload or the prefix: newlines from a
  // wrapped paste, backticks from a code fence, trailing punctuation from a sentence.
  const cleaned = input.trim().replace(/[\s`"'<>]/g, '')
  if (!cleaned) return { ok: false, error: 'empty' }
  if (cleaned.length > SHARE_LIMITS.maxStringChars) return { ok: false, error: 'too-long' }

  const at = cleaned.indexOf(SHARE_PREFIX)
  if (at < 0) {
    // A different generation (EQC2-…) is a "newer version" story, not a "wrong thing" one.
    return { ok: false, error: /^EQC\d+-/.test(cleaned) ? 'newer-version' : 'not-a-share-string' }
  }
  const payload = cleaned.slice(at + SHARE_PREFIX.length).replace(/[^A-Za-z0-9_-]+$/, '')
  if (!payload) return { ok: false, error: 'corrupt' }

  let json: string
  try {
    const inflated = inflateRawSync(fromBase64Url(payload))
    if (inflated.length > SHARE_LIMITS.maxJsonChars) return { ok: false, error: 'too-long' }
    json = inflated.toString('utf8')
  } catch {
    return { ok: false, error: 'corrupt' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, error: 'corrupt' }
  }
  return validateEnvelope(parsed)
}

/** Cheap "is the user even holding a share string" test, for live paste validation. */
export function looksLikeShareString(input: string): boolean {
  return input.replace(/\s/g, '').includes(SHARE_PREFIX)
}

/** Typed re-export so callers don't have to reach into shared/profiles for the error union. */
export type { ShareDecodeError, ShareKind }
