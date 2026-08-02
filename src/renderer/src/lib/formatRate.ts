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
