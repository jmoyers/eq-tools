// PLAIN-TEXT SERIALIZATION of what the combat panel is currently showing — the "copy this
// view" feature. Pure and MUI-free (node-testable exactly like dashboardData.ts), so the
// golden tests below assert EXACT output strings: the strings ARE the spec.
//
// What it is for: pasting a breakdown into guild chat / Discord. That is the whole reason for
// every constraint here —
//   - NO markdown (no **bold**, no | tables, no ``` fences): the app must not decide how the
//     destination renders it, and half of these destinations render markdown as literal text.
//   - No box drawing beyond spaces, '-' and the app's own '·' separator.
//   - Lines stay within MAX_WIDTH so a chat client's own wrapping never shreds a table.
//   - Numbers go through the app's ONE formatter (lib/formatRate), so a pasted total reads
//     '3.6k' exactly like the meter it came from.
//   - HONESTY (world-model laws 1 + 5): every value the source data flags as ESTIMATED keeps
//     its '~' prefix and the block carries a footer saying what '~' means. Observed maxima are
//     never prefixed — they are lower bounds, not scaled estimates (see dashboardData's header)
//     — and a column is NEVER emitted for data the segment doesn't have.
//
// There are FOUR views to serialize, one per drill level the user can be looking at:
//   level 1  formatSegmentText  — the ranked source meter (outgoing or incoming)
//   level 2  formatEntityText   — one source's flat skill list
//   level 2  formatTargetText   — everything you+pet landed on one mob
//   panel    formatMobsText     — the Damage-by-mob card's ranked rows

import type { SegmentView, SourceView } from '@shared/combat'
import { flattenSkills, type MobBreakdown, type SkillRow, type TargetDetail } from './dashboardData'
import { formatNum, formatRate } from '../../lib/formatRate'

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
 * surfaces) — it lives here because this module is the MUI-free half and node tests import it
 * directly, and combatShared.tsx cannot be imported without MUI + the `@shared` value alias.
 */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Label for the aggregated slay row + its inline tag. Spelled literally for the same reason
 * dashboardData spells it literally: a VALUE import from '@shared/combat' would break the node
 * tests, which run without the renderer's `@shared` alias.
 */
const SLAY_LABEL = 'Slay Undead'

type Align = 'left' | 'right'
interface Col {
  header: string
  align: Align
}

/** Truncation marker matches the app's own ellipsis; plain '.' runs read as an abbreviation. */
function clip(s: string, w: number): string {
  return s.length <= w ? s : s.slice(0, Math.max(1, w - 1)) + '…'
}

/**
 * Fixed-width columns from FORMATTED cells: widths come from the content, numeric columns
 * pad-start (so '3.6k' and '412' share a right edge) and the label column pads-end. If the
 * table would exceed MAX_WIDTH the LABEL column is the only one that gives ground — clipping a
 * mob name is recoverable, clipping a number is a lie. Every line is trimmed at the end so a
 * row with empty trailing cells carries no invisible padding into the paste.
 */
function table(cols: Col[], rows: string[][]): string[] {
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
const RANK = ''

/** A rounded percentage, carrying the estimate prefix when its inputs were estimates. */
function pctText(n: number, a = ''): string {
  return `${a}${Math.round(n)}%`
}

/** The footer that makes a '~' in the block above mean something to someone who wasn't here. */
const APPROX_NOTE = '~ = estimated: this fight kept only a sample of its events.'

/** `Vebarn (pet)` — the text equivalent of the meter row's pet chip. */
function sourceName(e: SourceView): string {
  return e.kind === 'pet' ? `${e.name} (pet)` : e.name
}

/**
 * A skill row's name with the category tag the UI's `SkillName` adds: a Slay Undead proc is
 * logged under its WEAPON verb, so 'Backstab' alone would read as a plain backstab row.
 */
function skillName(s: SkillRow): string {
  return s.category === 'slay' && s.name !== SLAY_LABEL ? `${s.name} · ${SLAY_LABEL}` : s.name
}

/**
 * The subject line every block opens with: `[<lead> — ]<fight name> · <duration>`. NAMES give
 * ground to the width, never the duration — a clipped mob name is still recognisable, a clipped
 * clock is a wrong number.
 */
function subjectLine(lead: string | null, seg: SegmentView): string {
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
function statLines(parts: string[]): string[] {
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

// ── Level 1: the ranked source meter ────────────────────────────────────────────────

/**
 * The meter as the user sees it at level 1: the panel's header line, then the ranked sources.
 * `mode` picks the same rows/total/dps the panel does, so an Incoming copy can never carry
 * outgoing numbers. Optional columns appear only when some row HAS that data — a fight with no
 * avoided swings has no Hit column at all, rather than a column of '100%'.
 */
export function formatSegmentText(seg: SegmentView, mode: 'out' | 'in'): string {
  const rows = mode === 'out' ? seg.entities : seg.incoming
  const total = mode === 'out' ? seg.outTotal : seg.inTotal
  const dps = mode === 'out' ? seg.outDps : seg.inDps

  // Active-time DPS rides along under exactly the panel's condition (outgoing only, and only
  // when the fight actually had idle gaps — otherwise it is the same number twice).
  const act =
    mode === 'out' && seg.activeSec > 0 && seg.activeSec < seg.durationSec ? ` (act ${formatRate(seg.activeDps)})` : ''
  const stats = [`${mode === 'out' ? 'Outgoing' : 'Incoming'} damage`, formatNum(total), `${formatRate(dps)}${act}`]
  if (mode === 'out' && seg.enemyHealTotal > 0) stats.push(`+${formatNum(seg.enemyHealTotal)} enemy heal`)

  const out: string[] = [subjectLine(null, seg), ...statLines(stats)]

  if (rows.length === 0) {
    out.push(mode === 'out' ? 'No outgoing damage in this segment.' : 'No incoming damage in this segment.')
    return out.join('\n')
  }

  const showCrit = rows.some((r) => r.crits > 0)
  const showHit = rows.some((r) => r.misses > 0)
  const showResist = rows.some((r) => r.resists > 0)
  const cols: Col[] = [
    { header: RANK, align: 'right' },
    { header: mode === 'out' ? 'Source' : 'Attacker', align: 'left' },
    { header: 'Total', align: 'right' },
    { header: 'DPS', align: 'right' }
  ]
  if (showCrit) cols.push({ header: 'Crit', align: 'right' })
  if (showHit) cols.push({ header: 'Hit', align: 'right' })
  if (showResist) cols.push({ header: 'Resist', align: 'right' })

  out.push(
    '',
    ...table(
      cols,
      rows.map((e, i) => {
        const cells = [String(i + 1), sourceName(e), formatNum(e.total), formatRate(e.dps)]
        if (showCrit) cells.push(e.crits > 0 ? pctText(e.critPct) : '')
        // Same omission the meter row makes: hit% is only meaningful once a swing was avoided.
        if (showHit) cells.push(e.misses > 0 ? pctText(e.hitPct) : '')
        if (showResist) cells.push(e.resists > 0 ? pctText(e.resistPct) : '')
        return cells
      })
    )
  )

  // The incoming view's healing footer, exactly as the panel appends it under the list.
  if (mode === 'in' && seg.incomingHealTotal > 0) {
    out.push('', `Heals received: ${formatNum(seg.incomingHealTotal)}`)
    for (const h of seg.incomingHealers.slice(0, 4)) out.push(`  ${h.name} · ${formatNum(h.total)} (${h.count})`)
  }
  return out.join('\n')
}

/** `4 mobs` / `1 mob` — plural agreement without a library. */
function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// ── Level 2a: one source's flat skill list ──────────────────────────────────────────

/**
 * Columns shared by the two flat-skill views (a source's list and a mob's list). `a` is the
 * estimate prefix: it rides on every DERIVED number, and never on `Max` — an observed maximum
 * is a lower bound, not a scaled estimate, and prefixing it would claim it had been adjusted.
 */
function skillTable(rows: SkillRow[], a: string): string[] {
  const showAvg = rows.some((s) => s.hits > 0)
  const showCrit = rows.some((s) => s.crits > 0)
  const showMiss = rows.some((s) => (s.misses ?? 0) > 0)
  const showResist = rows.some((s) => (s.resists ?? 0) > 0)
  const cols: Col[] = [
    { header: 'Skill', align: 'left' },
    { header: 'Total', align: 'right' },
    { header: 'Hits', align: 'right' }
  ]
  if (showAvg) cols.push({ header: 'Avg', align: 'right' }, { header: 'Max', align: 'right' })
  if (showCrit) cols.push({ header: 'Crit', align: 'right' })
  if (showMiss) cols.push({ header: 'Miss', align: 'right' })
  if (showResist) cols.push({ header: 'Resist', align: 'right' })

  return table(
    cols,
    rows.map((s) => {
      const misses = s.misses ?? 0
      const resists = s.resists ?? 0
      const cells = [skillName(s), `${a}${formatNum(s.total)}`, `${a}${s.hits}`]
      if (showAvg) {
        cells.push(s.hits > 0 ? `${a}${formatNum(Math.round(s.total / s.hits))}` : '')
        cells.push(s.hits > 0 ? formatNum(s.max) : '')
      }
      if (showCrit) cells.push(s.crits > 0 ? pctText((s.crits / Math.max(1, s.hits)) * 100, a) : '')
      if (showMiss) cells.push(misses > 0 ? pctText((misses / (s.hits + misses)) * 100, a) : '')
      if (showResist) cells.push(resists > 0 ? pctText((resists / (s.hits + resists)) * 100, a) : '')
      return cells
    })
  )
}

/**
 * Level 2, entity drill: one source's flat ranked skill list — the SAME list the panel shows
 * (`flattenSkills`, slay already grouped into one row), plus the melee-rounds footer when the
 * heuristic has anything to say. These numbers come from the engine's authoritative aggregate,
 * never from the event ring, so nothing here is ever estimated.
 */
export function formatEntityText(seg: SegmentView, entity: SourceView): string {
  const stats = [formatNum(entity.total), formatRate(entity.dps), `${entity.hits} hits`]
  if (entity.crits > 0) stats.push(`${Math.round(entity.critPct)}% crit`)
  if (entity.misses > 0) stats.push(`${Math.round(entity.hitPct)}% hit`)
  if (entity.resists > 0) stats.push(`${Math.round(entity.resistPct)}% resist`)

  const rows = flattenSkills(entity)
  const out = [subjectLine(sourceName(entity), seg), ...statLines(stats)]
  if (rows.length === 0) {
    out.push('No skill breakdown for this source.')
    return out.join('\n')
  }
  out.push('', ...skillTable(rows, ''))

  const r = entity.rounds
  if (r && (r.multiHitRounds > 0 || r.maxHitsInRound > 1)) {
    out.push(
      '',
      `Melee rounds: ${r.totalRounds} · avg ${r.avgHitsPerRound.toFixed(2)} hits/round · ${r.multiHitRounds} multi-hit · up to ${r.maxHitsInRound}/round`
    )
  }
  return out.join('\n')
}

// ── Level 2b: everything you + pet landed on ONE mob ────────────────────────────────

/**
 * Level 2, mob drill. Derived from the encounter's event ring, so the whole block wears the
 * `~` treatment whenever that ring was downsampled and/or truncated — including the footer that
 * says what `~` means. The "you + pet combined" line is not decoration: this list answers what
 * killed the mob, not who, and the panel says so too.
 */
export function formatTargetText(seg: SegmentView, target: string, detail: TargetDetail): string {
  const a = detail.estimated ? '~' : ''
  const share = seg.outTotal > 0 ? (detail.total / seg.outTotal) * 100 : 0
  const stats = [`${a}${formatNum(detail.total)}`, `${Math.round(share)}% of outgoing`, `${a}${detail.hits} hits`]
  if (detail.crits > 0) stats.push(`${a}${detail.crits} crit`)
  if (detail.misses > 0) stats.push(`${a}${detail.misses} avoided`)
  if (detail.resists > 0) stats.push(`${a}${detail.resists} resisted`)

  const out = [subjectLine(`Damage to ${target}`, seg), ...statLines(stats), 'you + pet combined']
  if (detail.rows.length === 0) {
    out.push('Nothing landed on this mob in the selected segment.')
    return out.join('\n')
  }
  out.push('', ...skillTable(detail.rows, a))
  if (detail.estimated) out.push('', APPROX_NOTE)
  return out.join('\n')
}

// ── The Damage-by-mob card ──────────────────────────────────────────────────────────

/**
 * The mob card's ranked rows. `limit` is the card's own row cap, so the paste is what the user
 * is LOOKING at; the rows the card left off are acknowledged rather than silently dropped.
 * Counts here are event-derived (hence `~` when the ring was inexact); `Share` is a ratio of
 * two estimates and is left unprefixed, exactly as the card renders it.
 */
export function formatMobsText(seg: SegmentView, mobs: MobBreakdown, limit?: number): string {
  const a = mobs.estimated ? '~' : ''
  const shown = limit != null ? mobs.rows.slice(0, limit) : mobs.rows
  const out = [subjectLine('Damage by mob', seg), `${count(mobs.rows.length, 'mob')} · ${a}${formatNum(mobs.total)}`]
  if (shown.length === 0) {
    out.push('Nothing landed on anything yet.')
    return out.join('\n')
  }

  const showCrit = shown.some((m) => m.crits > 0)
  const showMiss = shown.some((m) => m.misses > 0)
  const showResist = shown.some((m) => m.resists > 0)
  const cols: Col[] = [
    { header: RANK, align: 'right' },
    { header: 'Mob', align: 'left' },
    { header: 'Total', align: 'right' },
    { header: 'Share', align: 'right' },
    { header: 'Hits', align: 'right' }
  ]
  if (showCrit) cols.push({ header: 'Crit', align: 'right' })
  if (showMiss) cols.push({ header: 'Avoided', align: 'right' })
  if (showResist) cols.push({ header: 'Resist', align: 'right' })

  out.push(
    '',
    ...table(
      cols,
      shown.map((m, i) => {
        const cells = [String(i + 1), m.target, `${a}${formatNum(m.total)}`, `${Math.round(m.share)}%`, `${a}${m.hits}`]
        if (showCrit) cells.push(m.crits > 0 ? `${a}${m.crits}` : '')
        if (showMiss) cells.push(m.misses > 0 ? `${a}${m.misses}` : '')
        if (showResist) cells.push(m.resists > 0 ? `${a}${m.resists}` : '')
        return cells
      })
    )
  )
  if (mobs.rows.length > shown.length) out.push(`+${mobs.rows.length - shown.length} more not shown`)
  if (mobs.estimated) out.push('', APPROX_NOTE)
  return out.join('\n')
}
