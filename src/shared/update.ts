// update.ts — the PURE half of auto-update (Task #60).
//
// Everything here is side-effect free so it can be unit-tested without Electron:
// the polling cadence (interval + jitter + failure backoff), semver-ish version
// comparison (the "we already got updated away from that build" guard), and the
// status -> UI-state mapping the left-nav chip and Preferences both render from.
//
// The effectful half (electron-updater wiring, IPC, persistence) lives in
// src/main/updater.ts; the chip lives in components/UpdateChip.tsx.

import type { UpdateStatus } from './types'

// ---------------------------------------------------------------- cadence
//
// "Somewhat infrequently" (user's word). The old cadence was +10s then every
// 30 min — 48 feed hits per day per install, for a desktop app whose releases
// land a few times a week at most. That is pure noise against GitHub's
// unauthenticated rate limit and buys nothing: an update the user learns about
// 3 hours late still installs itself the next time they quit.
//
//   startup  : ~45s after launch, + up to 30s of jitter.
//              10s was inside the startup log replay (~6s of `hydrating` on the
//              real log, plus window paint + sound-pack provisioning). 45s puts
//              the check in idle time, where it belongs.
//   periodic : every 4 h, +/- 25% jitter -> a real spacing of 3 h - 5 h.
//              Jitter matters because every install of a hobby app tends to be
//              launched at the same time of day (raid night); a fixed interval
//              turns that into a synchronized burst on one GitHub repo. Six
//              checks a day is still far more than the release rate.
//   failure  : exponential backoff from 15 min, doubling, CAPPED AT the normal
//              interval — so a flaky network retries sooner than 4 h, and a
//              hard outage (or a rate-limit wall) decays to the normal cadence
//              instead of hammering. Jitter applies to backoff too.
//
// Manual "Check for updates" in Preferences always bypasses all of this.

/** Delay from launch to the FIRST check. */
export const STARTUP_DELAY_MS = 45_000
/** Extra uniform jitter [0, n) added to the startup delay. */
export const STARTUP_JITTER_MS = 30_000
/** Base spacing between background checks. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** Fractional jitter applied to every periodic/backoff delay: +/- 25%. */
export const JITTER_FRACTION = 0.25
/** First retry delay after a failed check; doubles per consecutive failure. */
export const BACKOFF_BASE_MS = 15 * 60 * 1000
/**
 * How many times we let autoDownload re-attempt the SAME version before we stop
 * pulling it automatically. Prevents an unbounded download loop against a
 * corrupt asset / a proxy that truncates; the user can still retry by hand.
 */
export const MAX_DOWNLOAD_ATTEMPTS = 3

/** Apply +/- JITTER_FRACTION to `ms`. `rand` is injectable so tests are deterministic. */
function jitter(ms: number, rand: () => number): number {
  const span = ms * JITTER_FRACTION
  return Math.round(ms - span + rand() * span * 2)
}

/**
 * How long to wait before the next background check.
 *
 * `consecutiveFailures` counts checks that ended in an error since the last
 * successful one (0 = healthy). The returned delay is always > 0 and never
 * exceeds CHECK_INTERVAL_MS * (1 + JITTER_FRACTION).
 */
export function nextCheckDelayMs(
  opts: { phase: 'startup' | 'periodic'; consecutiveFailures?: number },
  rand: () => number = Math.random
): number {
  if (opts.phase === 'startup') return STARTUP_DELAY_MS + Math.round(rand() * STARTUP_JITTER_MS)
  const fails = Math.max(0, Math.floor(opts.consecutiveFailures ?? 0))
  if (fails === 0) return jitter(CHECK_INTERVAL_MS, rand)
  // 15m, 30m, 1h, 2h, 4h, 4h, ... — capped at the healthy interval.
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (fails - 1), CHECK_INTERVAL_MS)
  return jitter(backoff, rand)
}

// ------------------------------------------------------- version comparison
//
// Our versions are semver with a CI-stamped prerelease on the main channel
// (`1.4.0-main.231`). electron-updater does its own comparison, but we guard
// independently for one specific case the user hits: apply-on-quit already
// installed build N, and a status pushed just before the relaunch (or a feed
// that still lists N) must NOT resurface as "restart to update" on a build that
// IS N. Never offer a version that isn't strictly newer than what's running.

/** Split "1.4.0-main.231" into [major, minor, patch] + prerelease identifiers. */
function parseVersion(v: string): { nums: number[]; pre: string[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim())
  if (!m) return null
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : []
  }
}

/**
 * semver precedence: -1 / 0 / 1. Numeric prerelease identifiers compare
 * numerically (`main.9` < `main.10` — a plain string compare gets this wrong,
 * which is exactly the CI run-number case), a prerelease sorts BELOW its
 * release, and an unparseable version compares equal (we refuse to guess).
 */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  const core = compareCore(pa.nums, pb.nums)
  if (core !== 0) return core
  return comparePrerelease(pa.pre, pb.pre)
}

/** major.minor.patch, left to right. 0 when all three are equal. */
function compareCore(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/**
 * Prerelease precedence: NO prerelease sorts above one (1.0.0 > 1.0.0-main.1), then
 * identifier by identifier, and a shorter identifier list sorts below a longer one that
 * agrees on the shared prefix.
 */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const c = compareIdentifier(x, y)
    if (c !== 0) return c
  }
  return 0
}

/** One prerelease identifier pair. All-digit identifiers compare NUMERICALLY (`main.9` < `main.10`). */
function compareIdentifier(x: string, y: string): number {
  const nx = /^\d+$/.test(x) ? Number(x) : null
  const ny = /^\d+$/.test(y) ? Number(y) : null
  if (nx !== null && ny !== null) return nx === ny ? 0 : nx < ny ? -1 : 1
  return x === y ? 0 : x < y ? -1 : 1
}

/** True when `candidate` is strictly newer than `current` (unknown ⇒ false). */
export function isNewerVersion(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate || !current) return false
  return compareVersions(candidate, current) > 0
}

/**
 * True when `candidate` is NOT worth offering because we already run it (or
 * newer) — the "apply-on-quit already installed this" case.
 *
 * Deliberately conservative: if either version is missing or unparseable we
 * return FALSE (not stale) rather than silently suppressing a real update.
 * Never guess (world-model law 1) — an unknown comparison defers to
 * electron-updater's own verdict.
 */
export function isStaleVersion(candidate: string | undefined, current: string | undefined): boolean {
  if (!candidate || !current) return false
  if (!parseVersion(candidate) || !parseVersion(current)) return false
  return compareVersions(candidate, current) <= 0
}

// -------------------------------------------------------- status -> UI state
//
// ONE mapping, shared by the nav chip and (for its headline) Preferences, so the
// two surfaces can never disagree about whether an update is really waiting.
//
// Product rule: the ONLY loud state is 'ready'. Everything else — including every
// error — renders as the quiet "checked <age> ago" line. A failed check is not
// the user's problem and must never look like one; the message survives in
// Preferences > Updates for whoever goes looking.

export type UpdateChipState =
  /** An update is downloaded and staged: the one inviting, clickable state. */
  | { kind: 'ready'; version?: string; checkedAt?: number }
  /** Downloading in the background — a thin, calm progress affordance. */
  | { kind: 'downloading'; percent: number; version?: string; checkedAt?: number }
  /** Transient work (checking / found-but-not-started): muted one-liner. */
  | { kind: 'working'; label: string; checkedAt?: number }
  /** The resting state: "checked 2h ago" (or "never"), click to check. `disabled` means the
   *  updater is off for this process (dev build) — render a truthful static note, not a
   *  forever-stale check affordance. */
  | { kind: 'quiet'; checkedAt?: number; failed: boolean; message?: string; disabled?: boolean }

/**
 * Map a raw UpdateStatus onto what the chip should render.
 *
 * `currentVersion` (app.getVersion()) is the updated-away guard: a status naming
 * a version we are ALREADY running is stale — demote it to quiet rather than
 * inviting a pointless relaunch. An unknown/unparseable pair is trusted as-is
 * (we only demote on a positive "not newer" verdict).
 */
export function updateChipState(status: UpdateStatus, currentVersion?: string): UpdateChipState {
  const checkedAt = status.checkedAt
  const stale = (v?: string): boolean => isStaleVersion(v, currentVersion)

  switch (status.state) {
    case 'ready':
      if (stale(status.version)) return { kind: 'quiet', checkedAt, failed: false }
      return { kind: 'ready', version: status.version, checkedAt }
    case 'downloading':
      if (stale(status.version)) return { kind: 'quiet', checkedAt, failed: false }
      return {
        kind: 'downloading',
        percent: Math.max(0, Math.min(100, Math.round(status.percent ?? 0))),
        version: status.version,
        checkedAt
      }
    case 'available':
      if (stale(status.version)) return { kind: 'quiet', checkedAt, failed: false }
      return { kind: 'working', label: 'Update found…', checkedAt }
    case 'checking':
      return { kind: 'working', label: 'Checking for updates…', checkedAt }
    case 'error':
      return { kind: 'quiet', checkedAt, failed: true, message: status.message }
    case 'idle':
    default:
      return { kind: 'quiet', checkedAt, failed: false, disabled: status.disabled }
  }
}
