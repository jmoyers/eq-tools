// Central date/time formatting (Task #44). ALL timestamp rendering routes through
// these so the app displays LOCAL time consistently — the game log timestamps parse
// to a LOCAL epoch (parseEqTimestamp → Date.parse('Aug 01 2026 13:00:28') with no
// zone = local), and every formatter here uses toLocale*String WITHOUT an explicit
// `timeZone`, so the runtime's zone (e.g. America/Los_Angeles) is used end to end.
//
// Do NOT introduce toISOString / toUTCString / getUTC* for display, and do NOT bucket
// days by epoch math (Math.floor(ts / 86400000) is a UTC-day boundary — off by the
// local offset near midnight). Use `localDayKey` to group by LOCAL calendar day.

/** `ts` is epoch millis. A falsy/0 ts renders as empty (unknown timestamp). */

/** Date only, local: e.g. "8/1/2026". */
export function formatDate(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString()
}

/** Time only, local, 24h: e.g. "13:00:28". */
export function formatTime(ts: number, opts?: Intl.DateTimeFormatOptions): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour12: false, ...opts })
}

/** Date + time, local: e.g. "8/1/2026, 1:00:28 PM" (or per opts). */
export function formatDateTime(ts: number, opts?: Intl.DateTimeFormatOptions): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString([], opts)
}

/**
 * Coarse, human relative age: "just now" / "12m ago" / "3h ago" / "2d ago".
 * `ts` 0/undefined ⇒ '' (unknown). Deliberately COARSE — this is ambient text
 * (the left-nav update chip's "checked …" line), not a precise timestamp; the
 * exact clock time lives in Preferences via formatDateTime. `now` is injectable
 * so the mapping is testable without faking the clock.
 */
export function formatAge(ts: number | undefined, now: number = Date.now()): string {
  if (!ts) return ''
  const secs = Math.max(0, (now - ts) / 1000)
  if (secs < 90) return 'just now'
  const mins = secs / 60
  if (mins < 90) return `${Math.round(mins)}m ago`
  const hrs = mins / 60
  if (hrs < 36) return `${Math.round(hrs)}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/**
 * A stable per-LOCAL-day grouping key (YYYY-MM-DD in the local zone). Use this to
 * bucket events by calendar day instead of `Math.floor(ts / 86400000)`, which buckets
 * by the UTC day and therefore splits/merges the wrong events across local midnight.
 */
export function localDayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
