// THE PLAIN-TEXT LAYOUT PRIMITIVES shared by every copy-out block (copyText.ts, procsCopy.ts).
//
// Extracted from copyText.ts, unchanged, when the proc-analytics sections arrived: that file was
// at 294 code lines against a 400 ceiling with an EMPTY ratchet, and the plan's instruction for
// this wave is EXTRACT, never grow. Splitting on the primitives rather than on the views is what
// keeps the split acyclic — both view modules depend on this one and neither on the other.
//
// The constraints these encode are the whole reason the feature exists (see copyText.ts's
// header): no markdown, nothing wider than MAX_WIDTH, numbers through the app's ONE formatter,
// and a label column that gives ground before a number ever does.

import type { SegmentView } from '@shared/combat'

/**
 * Widest line we ever emit. Discord's message column and EQ's own chat window both wrap well
 * before 80, and a wrapped table row is worse than a narrow one — so the label column gives
 * ground (and clips) before a line is allowed past this.
 */
export const MAX_WIDTH = 72

/** Column separator. Two spaces read as a gutter in a monospace font without drawing anything. */
const GAP = '  '
/** A label column never shrinks below this — past it the names stop being recognisable. */
const MIN_LABEL = 10

/**
 * `mm:ss` duration. THE one spelling in the app (combatShared re-exports it for the JSX
 * surfaces) — it lives on this side because this module is the MUI-free half and node tests
 * import it directly, and combatShared.tsx cannot be imported without MUI + the `@shared` value
 * alias.
 */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * A short elapsed time. Sub-minute reads in tenths of a second — a slow that lands in 4.2s
 * versus 4.9s is a real difference to a rogue — and anything longer falls back to the app's
 * one `m:ss` spelling rather than printing "76.0s".
 *
 * MOVED here from procsCopy.ts (the clipboard half) when the breakdown card's proc strip needed
 * it too: procsCopy already imports procRows, so procRows could not have imported it back
 * without a cycle. This module is the acyclic floor both view modules stand on, which is exactly
 * what it was extracted to be — see the header. procsCopy re-exports it, so every existing
 * import path is unchanged.
 */
export function fmtElapsed(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : fmtDur(ms / 1000)
}

export type Align = 'left' | 'right'
export interface Col {
  header: string
  align: Align
}

/** Truncation marker matches the app's own ellipsis; plain '.' runs read as an abbreviation. */
export function clip(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, Math.max(1, w - 1)) + '…'
}

/**
 * Fixed-width columns from FORMATTED cells: widths come from the content, numeric columns
 * pad-start (so '3.6k' and '412' share a right edge) and the label column pads-end. If the
 * table would exceed MAX_WIDTH the LABEL column is the only one that gives ground — clipping a
 * mob name is recoverable, clipping a number is a lie. Every line is trimmed at the end so a
 * row with empty trailing cells carries no invisible padding into the paste.
 */
export function table(cols: Col[], rows: string[][]): string[] {
  const w = cols.map((c, i) => Math.max(c.header.length, ...rows.map((r) => r[i].length)))
  const total = (): number => w.reduce((a, b) => a + b, 0) + GAP.length * (w.length - 1)
  const label = cols.findIndex((c) => c.align === 'left')
  if (label >= 0 && total() > MAX_WIDTH) w[label] = Math.max(MIN_LABEL, w[label] - (total() - MAX_WIDTH))
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (cols[i].align === 'left' ? clip(c, w[i]).padEnd(w[i]) : clip(c, w[i]).padStart(w[i])))
      .join(GAP)
      .trimEnd()
  return [line(cols.map((c) => c.header)), ...rows.map(line)]
}

/**
 * The rank column has NO header, and that is deliberate: '#' at the start of a line is a
 * heading in Discord's markdown, so a pasted table would open with its first row swallowed into
 * a giant H1. A numbered column needs no label anyway.
 */
export const RANK = ''

/** A rounded percentage, carrying the estimate prefix when its inputs were estimates. */
export function pctText(n: number, a = ''): string {
  return `${a}${Math.round(n)}%`
}

/** `4 mobs` / `1 mob` — plural agreement without a library. */
export function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The subject line every block opens with: `[<lead> — ]<fight name> · <duration>`. NAMES give
 * ground to the width, never the duration — a clipped mob name is still recognisable, a clipped
 * clock is a wrong number.
 */
export function subjectLine(lead: string | null, seg: SegmentView): string {
  const tail = ` · ${fmtDur(seg.durationSec)}`
  const budget = MAX_WIDTH - tail.length
  if (!lead) return clip(seg.name, budget) + tail
  const l = clip(lead, Math.max(MIN_LABEL, budget - MIN_LABEL - 3))
  return `${l} — ${clip(seg.name, Math.max(MIN_LABEL, budget - l.length - 3))}${tail}`
}

/**
 * Pack a ' · '-separated stat run into lines that fit the width. A stat run is the one place a
 * block can't bound itself — a fight with every optional stat present simply has more to say —
 * so it WRAPS on a separator instead of clipping: dropping a stat would be an edit, and letting
 * the line run would hand the chat client the wrap point.
 */
export function statLines(parts: string[]): string[] {
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    const next = cur ? `${cur} · ${p}` : p
    if (next.length > MAX_WIDTH && cur) {
      out.push(cur)
      cur = p
    } else cur = next
  }
  if (cur) out.push(cur)
  return out
}

/**
 * WORD-wrap a sentence to the paste width, with an indent. `statLines` wraps on the app's ' · '
 * separator and cannot help here: the proc-attribution notes are PROSE, they are the engine's
 * own words (world-model law 1 — the note IS the honesty), and they must travel verbatim rather
 * than be summarised into something that fits.
 */
export function wrapText(text: string, indent = ''): string[] {
  const width = Math.max(MIN_LABEL, MAX_WIDTH - indent.length)
  const out: string[] = []
  let cur = ''
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const next = cur ? `${cur} ${word}` : word
    if (next.length > width && cur) {
      out.push(indent + cur)
      cur = word
    } else cur = next
  }
  if (cur) out.push(indent + cur)
  return out
}
