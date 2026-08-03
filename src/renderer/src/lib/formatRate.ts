// Shared number formatting for the DPS meter + overlay (Task #54). One source of truth so
// the main view, drill-down, segment list, tooltips, and the floating overlay all render rates
// and totals identically.
//
// Per the user's spec (AGENTS.md "Formatting"):
//   - RATES render as '21.7k dps' / '2.3M dps' — the WORD 'dps' after the number, k thousands,
//     M millions (this REPLACES every '/s' occurrence).
//   - TOTALS keep k/M scaling but carry NO unit word ('21.7k', '2.3M').

/** k/M-scaled magnitude with no unit word (used for damage TOTALS + as the number part of a rate). */
export function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(Math.round(n))
}

/** A DPS rate: the k/M-scaled number followed by the word 'dps', e.g. '21.7k dps', '2.3M dps'. */
export function formatRate(n: number): string {
  return `${formatNum(n)} dps`
}

/** A HEALING rate (Task #59), same shape as formatRate with the word 'hps': '1.2k hps'. Lives
 *  here so the healing overlays never grow a second, divergent number formatter. */
export function formatHealRate(n: number): string {
  return `${formatNum(n)} hps`
}

/**
 * SMALL rates — the leveling analytics ones (levels/hr, kills/hr) — are a DIFFERENT number
 * shape from the combat ones, and deliberately do NOT go through `formatNum`.
 *
 * `formatNum` is built for damage: it k/M-scales above a thousand and ROUNDS TO AN INTEGER
 * below it (`formatNum(1.42) === '1'`). A levels-per-hour rate lives almost entirely in the
 * 0–10 band, so routing it through that would render every honest 1.42 as a flat '1' — the
 * whole quantity, silently destroyed. So: two decimals under 10, one under 100, integer above
 * (a three-digit kills/hr needs no fraction, and a rate that large only comes from a very
 * short window anyway). They still live HERE rather than in the leveling feature, because the
 * "ONE source" rule (AGENTS.md, Formatting) is about the file, not about the algorithm.
 */
function formatSmall(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const v = Math.abs(n)
  if (v >= 100) return n.toFixed(0)
  if (v >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

/** A LEVELS-per-hour rate: '1.42 lvl/hr', '0.35 lvl/hr', '124 lvl/hr'. "Levels of progress",
 *  never experience points — the log states a level-bar percentage and nothing else. */
export function formatLevelRate(n: number): string {
  return `${formatSmall(n)} lvl/hr`
}

/** A KILLS-per-hour rate: '38.5 kills/hr', '0.75 kills/hr', '240 kills/hr'. */
export function formatKillRate(n: number): string {
  return `${formatSmall(n)} kills/hr`
}
