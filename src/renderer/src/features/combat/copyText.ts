// PLAIN-TEXT SERIALIZATION of what the combat panel is currently showing — the "copy this
// view" feature. Pure and MUI-free (node-testable exactly like dashboardData.ts), so the
// golden tests assert EXACT output strings: the strings ARE the spec.
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
// There are FIVE views to serialize, one per drill level the user can be looking at:
//   level 1  formatSegmentText  — the ranked source meter (outgoing or incoming)
//   level 2  formatEntityText   — one source's flat skill list (pets nested, per the pref)
//   level 2  formatTargetText   — everything you+pet landed on one mob
//   panel    formatMobsText     — the Damage-by-mob card's ranked rows
//   panel    formatProcsText    — the Procs tab. Lives in procsCopy.ts (it outgrew this file
//                                 when the proc-analytics sections landed) and is re-exported
//                                 below, so every existing importer is unaffected.
// The layout primitives every block shares live in copyTable.ts.

import type { SegmentView, SourceView } from '@shared/combat'
import { flattenSkills, type MobBreakdown, type SkillRow, type TargetDetail } from './dashboardData'
import { nestedRows, type OwnRow } from './petRows'
import { RANK, count, pctText, statLines, subjectLine, table, type Col } from './copyTable'
import { formatNum, formatRate } from '../../lib/formatRate'

// The width constant and the `m:ss` spelling keep their old import path: combatShared.tsx
// re-exports `fmtDur` from HERE for every JSX surface, and the copy goldens import MAX_WIDTH.
export { MAX_WIDTH, fmtDur } from './copyTable'
// The Procs half, re-exported from its own module (see the header).
export { fmtElapsed, formatProcsText, slowRollupText } from './procsCopy'

/**
 * Label for the aggregated slay row + its inline tag. Spelled literally for the same reason
 * dashboardData spells it literally: a VALUE import from '@shared/combat' would break the node
 * tests, which run without the renderer's `@shared` alias.
 */
const SLAY_LABEL = 'Slay Undead'

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

// ── Level 1: the ranked source meter ────────────────────────────────────────────────

/**
 * The header stat run: direction, total, dps. Active-time DPS rides along under exactly the
 * panel's condition (outgoing only, and only when the fight actually had idle gaps — otherwise
 * it is the same number twice), and so does the enemy-heal caveat.
 */
function segmentStats(seg: SegmentView, mode: 'out' | 'in'): string[] {
  const total = mode === 'out' ? seg.outTotal : seg.inTotal
  const dps = mode === 'out' ? seg.outDps : seg.inDps
  const act =
    mode === 'out' && seg.activeSec > 0 && seg.activeSec < seg.durationSec ? ` (act ${formatRate(seg.activeDps)})` : ''
  const stats = [`${mode === 'out' ? 'Outgoing' : 'Incoming'} damage`, formatNum(total), `${formatRate(dps)}${act}`]
  if (mode === 'out' && seg.enemyHealTotal > 0) stats.push(`+${formatNum(seg.enemyHealTotal)} enemy heal`)
  return stats
}

/** The ranked source table. Optional columns appear only when some row HAS that data. */
function sourceTable(rows: SourceView[], mode: 'out' | 'in'): string[] {
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

  return table(
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
}

/** The incoming view's healing footer, exactly as the panel appends it under the list. */
function healFooter(seg: SegmentView): string[] {
  if (seg.incomingHealTotal <= 0) return []
  const out = ['', `Heals received: ${formatNum(seg.incomingHealTotal)}`]
  for (const h of seg.incomingHealers.slice(0, 4)) out.push(`  ${h.name} · ${formatNum(h.total)} (${h.count})`)
  return out
}

/**
 * The meter as the user sees it at level 1: the panel's header line, then the ranked sources.
 * `mode` picks the same rows/total/dps the panel does, so an Incoming copy can never carry
 * outgoing numbers. Optional columns appear only when some row HAS that data — a fight with no
 * avoided swings has no Hit column at all, rather than a column of '100%'.
 */
export function formatSegmentText(seg: SegmentView, mode: 'out' | 'in'): string {
  const rows = mode === 'out' ? seg.entities : seg.incoming
  const out: string[] = [subjectLine(null, seg), ...statLines(segmentStats(seg, mode))]

  if (rows.length === 0) {
    out.push(mode === 'out' ? 'No outgoing damage in this segment.' : 'No incoming damage in this segment.')
    return out.join('\n')
  }

  out.push('', ...sourceTable(rows, mode))
  if (mode === 'in') out.push(...healFooter(seg))
  return out.join('\n')
}

// ── Level 2a: one source's flat skill list ──────────────────────────────────────────

/**
 * The OPTIONAL columns a flat skill list needs, decided by the DATA and decided ONCE: a fight
 * with no avoided swings has no Miss column at all, rather than a column of blanks. Split out
 * of `skillTable` so a table that mixes skill rows with nested PET rows can share exactly the
 * same column set — two stacked tables would drift apart the moment a pet's total was wider
 * than any skill's.
 */
function skillCols(rows: SkillRow[]): Col[] {
  const cols: Col[] = [
    { header: 'Skill', align: 'left' },
    { header: 'Total', align: 'right' },
    { header: 'Hits', align: 'right' }
  ]
  if (rows.some((s) => s.hits > 0)) cols.push({ header: 'Avg', align: 'right' }, { header: 'Max', align: 'right' })
  if (rows.some((s) => s.crits > 0)) cols.push({ header: 'Crit', align: 'right' })
  if (rows.some((s) => (s.misses ?? 0) > 0)) cols.push({ header: 'Miss', align: 'right' })
  if (rows.some((s) => (s.resists ?? 0) > 0)) cols.push({ header: 'Resist', align: 'right' })
  return cols
}

/**
 * One skill row's cells, in whatever column order `skillCols` produced. `a` is the estimate
 * prefix: it rides on every DERIVED number, and never on `Max` — an observed maximum is a lower
 * bound, not a scaled estimate, and prefixing it would claim it had been adjusted.
 */
function skillCells(s: SkillRow, cols: Col[], a: string): string[] {
  const misses = s.misses ?? 0
  const resists = s.resists ?? 0
  const by = new Map<string, string>([
    ['Total', `${a}${formatNum(s.total)}`],
    ['Hits', `${a}${s.hits}`],
    ['Avg', s.hits > 0 ? `${a}${formatNum(Math.round(s.total / s.hits))}` : ''],
    ['Max', s.hits > 0 ? formatNum(s.max) : ''],
    ['Crit', s.crits > 0 ? pctText((s.crits / Math.max(1, s.hits)) * 100, a) : ''],
    // Same omission the meter row makes: a rate is only meaningful once something was avoided.
    ['Miss', misses > 0 ? pctText((misses / (s.hits + misses)) * 100, a) : ''],
    ['Resist', resists > 0 ? pctText((resists / (s.hits + resists)) * 100, a) : '']
  ])
  return cols.map((c, i) => (i === 0 ? skillName(s) : (by.get(c.header) ?? '')))
}

/** The flat skill list as a table — a source's list, or one mob's. */
function skillTable(rows: SkillRow[], a: string): string[] {
  const cols = skillCols(rows)
  return table(
    cols,
    rows.map((s) => skillCells(s, cols, a))
  )
}

/**
 * A NESTED PET row, as the panel draws it: one line item inside your breakdown, ranked among
 * your skill lanes, wearing the pet's real display name (law 4 — the label is never a coined
 * "Pet", and no point of pet damage is ever folded into a lane of yours).
 *
 * Total and Hits are the pet's own; every remaining skill column stays EMPTY rather than
 * borrowing a skill's meaning — a pet aggregate has no single biggest hit, and printing one
 * would invent an observation.
 */
function petCells(r: Extract<OwnRow, { kind: 'pet' }>, width: number): string[] {
  const cells = [`${r.pet.name} (pet)`, formatNum(r.pet.total), String(r.pet.hits)]
  while (cells.length < width) cells.push('')
  return cells
}

/** The flat list with pets nested in, as ONE table sharing ONE column set. */
function ownTable(rows: OwnRow[]): string[] {
  const cols = skillCols(rows.flatMap((r) => (r.kind === 'skill' ? [r.skill] : [])))
  return table(
    cols,
    rows.map((r) => (r.kind === 'pet' ? petCells(r, cols.length) : skillCells(r.skill, cols, '')))
  )
}

/**
 * Level 2, entity drill: one source's flat ranked skill list — the SAME list the panel shows
 * (`flattenSkills`, slay already grouped into one row), plus the melee-rounds footer when the
 * heuristic has anything to say. These numbers come from the engine's authoritative aggregate,
 * never from the event ring, so nothing here is ever estimated.
 *
 * `pets` are the pet sources NESTED into this list, exactly as the panel nests them while the
 * 'Combine pet into your damage' preference is on. Passing them is what closes the gap the
 * drill wave left: the panel showed the pet as a line item and the clipboard silently dropped
 * it, so a pasted "your breakdown" was missing a row the reader could see on screen.
 */
export function formatEntityText(seg: SegmentView, entity: SourceView, pets: SourceView[] = []): string {
  const stats = [formatNum(entity.total), formatRate(entity.dps), `${entity.hits} hits`]
  if (entity.crits > 0) stats.push(`${Math.round(entity.critPct)}% crit`)
  if (entity.misses > 0) stats.push(`${Math.round(entity.hitPct)}% hit`)
  if (entity.resists > 0) stats.push(`${Math.round(entity.resistPct)}% resist`)

  const rows = pets.length > 0 ? nestedRows(entity, pets) : null
  const skills = flattenSkills(entity)
  const out = [subjectLine(sourceName(entity), seg), ...statLines(stats)]
  if (skills.length === 0 && !rows) {
    out.push('No skill breakdown for this source.')
    return out.join('\n')
  }
  out.push('', ...(rows ? ownTable(rows) : skillTable(skills, '')))

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
