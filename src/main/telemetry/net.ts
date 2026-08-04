// telemetry/net.ts — the ONLY place usage analytics knows a hostname, and the law that makes
// "this build sends nothing" a structural fact rather than a promise.
//
// ============================ THIS BUILD IS DARK ============================
//
// `TELEMETRY_API_URL` is `''` in every build that exists today and stays that way until wave
// A2 applies the Terraform root. An empty value is not a failure mode — it means "this build
// has no telemetry endpoint", which the Preferences pane states out loud ("last batch sent" is
// permanently empty and says why) and which makes a network call structurally impossible.
//
// THERE IS NO fetch/XHR/http IN THIS DIRECTORY AT ALL. That is deliberate and it is pinned
// (`tests/telemetryNet.test.mts` greps every file under `src/main/telemetry/`): the dark-build
// guarantee does not rest on a boolean somebody could invert, because there is no transport to
// unlock. Wave A2 adds the POST, the endpoint and the negative tests in one commit — together
// with the SECURITY.md / README amendment that the "no telemetry" promise then requires.
//
// There is NO user-configurable endpoint override and there must never be one, for exactly the
// reason feedback/net.ts spells out at length: an overridable ingest URL is an exfiltration
// primitive, not a convenience. Unlike feedback there is not even a loopback dev gate here —
// telemetry has no local-stack rehearsal need, and a gate that does not exist cannot be widened.
//
// The predicate below is the telemetry twin of `queueFlushEnabled` (feedback/net.ts) and lives
// here for the same reason: it is PURE, it is the whole startup decision, and it must stay
// pinnable by a node test that loads no Electron.

import type { TelemetryPrefs } from '../../shared/telemetry'

/**
 * The ingest API as COMPILED IN. EMPTY until wave A2 — see the banner. e.g.
 * 'https://<apiId>.execute-api.us-east-1.amazonaws.com/v1/telemetry'.
 */
export const TELEMETRY_API_URL = ''

/** Does this build have an endpoint compiled in? The Preferences pane gates its honesty note
 *  on this, and it is `false` in every build shipped to date. */
export function telemetryEndpointConfigured(): boolean {
  return TELEMETRY_API_URL.length > 0
}

/**
 * May this process SEND? Four facts, each fatal on its own — the same shape and the same
 * discipline as `queueFlushEnabled`:
 *
 *   * `e2e`         — the headless harness never sends (plan T7). It must never spin a timer
 *                     that could reach the network behind a test's back.
 *   * `endpoint`    — a DARK build has nowhere to send; timers that can only no-op are noise.
 *   * `enabled`     — the user's switch. Off means off, immediately (the buffer is dropped too).
 *   * `noticeShown` — T1, AND THIS IS THE POINT OF THE WHOLE DESIGN: collection may buffer
 *                     before the first-run notice has rendered, but the NETWORK does not start
 *                     until it has. "Opt-out" never means "sent before you were told".
 *
 * Moot while the endpoint is '' — and encoded anyway, because the predicate is what wave A2
 * inherits, and a gate written after the transport is a gate written too late.
 */
export function telemetryFlushEnabled(
  e2e: boolean,
  endpoint: string,
  prefs: TelemetryPrefs
): boolean {
  return !e2e && endpoint.length > 0 && prefs.enabled && prefs.noticeShown
}

/**
 * May this process COLLECT into the local ring? Only the user's own switch decides.
 *
 * Deliberately NOT gated on the notice or on the endpoint: T1 says "collection may buffer
 * pre-notice; the network starts only after the notice renders", and a buffer that fills from
 * the first second is what makes the notice's "here is exactly what would be sent" panel show
 * something real instead of an empty box. Nothing here can leave the machine — the only reader
 * of the ring is the flush loop, and the flush loop is gated above.
 */
export function telemetryCollectEnabled(prefs: TelemetryPrefs): boolean {
  return prefs.enabled
}
