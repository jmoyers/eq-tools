// Small formatting helpers for BuffsView (kept out of the component for reuse/testing).

/**
 * Format a millisecond duration compactly: seconds under a minute, m:ss under an
 * hour, h:mm above. Null/≤0 renders as an em-dash.
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (totalMin < 60) return `${totalMin}m ${sec.toString().padStart(2, '0')}s`
  const hr = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return `${hr}h ${min.toString().padStart(2, '0')}m`
}

/**
 * Fraction of the estimated window still remaining (1 = just landed, 0 = expired),
 * clamped to [0,1]. Used to drive the progress bar. `estimatedMs` must be > 0.
 */
export function remainingFraction(elapsedMs: number, estimatedMs: number): number {
  if (estimatedMs <= 0) return 0
  const frac = 1 - elapsedMs / estimatedMs
  return frac < 0 ? 0 : frac > 1 ? 1 : frac
}
