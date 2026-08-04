// THE PROCS TAB, AS TEXT — the rogue-poison ledger (Task #64) and the proc-analytics sections
// (docs/plans/proc-analytics.md §7). Extracted from copyText.ts per the plan: that file was at
// 294 code lines against a 400 ceiling with an EMPTY ratchet, and this half is the one that
// grew.
//
// Every number here is folded on ingest by the engine from the authoritative event stream —
// never from the capped/truncated event ring — so this block carries NO `~` estimate treatment
// and no APPROX footer. That is the one structural difference from formatMobsText, which IS
// ring-derived. The `~` marks that DO appear mean something else entirely and are each labeled
// where they occur:
//   `~ <lane>`   the game left the lane's NAME ambiguous (a shared emote). The count is exact.
//   `~ <n> added` Slay Undead's MARGINAL damage — an estimate with a stated assumption.
//   `~ estimate` a Tier-B verdict, drawn as a RANGE and never as a point.
//
// The attribution NOTES are printed verbatim as footnotes (law 1: the note is the honesty, and
// a paraphrase keeps the number while deleting the caveat). They are deduped into numbered
// footnotes because most of a session's stances share one sentence, and printing that paragraph
// eighteen times is noise, not honesty.

import { MAX_WIDTH, count, fmtDur, fmtElapsed, statLines, subjectLine, table, wrapText, type Col } from './copyTable'
import { formatNum, formatRate } from '../../lib/formatRate'
import {
  contributionRows,
  effectRows,
  laneRows,
  overallParts,
  reportAuditLine,
  stateRows,
  type EffectRow,
  type LaneRow
} from './procRows'
import type { ProcsView, SegmentView, SlowRollup } from '@shared/combat'

// `fmtElapsed` now lives in copyTable.ts beside `fmtDur` (the breakdown card's proc strip needs
// it and this module already depends on procRows, so procRows could not import it from here).
// Re-exported so `copyText.ts` — and through it every JSX surface — keeps its import path.
export { fmtElapsed } from './copyTable'

/**
 * The rolling time-to-slow line, in ONE spelling shared by the panel and the clipboard.
 *
 * Both halves of the denominator are always stated: the mean is over the pulls that LANDED,
 * and the ones that never landed are named separately (`+2 no land`). A bare "avg 3.8s" over
 * a set that silently dropped four whiffs would be exactly the aggregate law 5 forbids.
 * Returns null when no qualifying pull has finished — there is nothing honest to say yet.
 */
export function slowRollupText(slow: SlowRollup): string | null {
  if (slow.pulls === 0) return null
  if (slow.landed === 0) return `slow never landed in ${count(slow.pulls, 'pull')}`
  // `landed > 0` guarantees the engine populated the statistics, but this reads the field
  // rather than asserting it: an absent mean is a reason to say nothing, never to print NaN.
  if (slow.avgMs === undefined) return null
  const parts = [`avg ${fmtElapsed(slow.avgMs)} over ${count(slow.landed, 'pull')}`]
  if (slow.medianMs !== undefined && slow.medianMs !== slow.avgMs) parts.push(`median ${fmtElapsed(slow.medianMs)}`)
  if (slow.minMs !== undefined && slow.maxMs !== undefined && slow.minMs !== slow.maxMs) {
    parts.push(`${fmtElapsed(slow.minMs)}–${fmtElapsed(slow.maxMs)}`)
  }
  if (slow.noLand > 0) parts.push(`+${slow.noLand} no land`)
  return parts.join(' · ')
}

/** What was on the blades at engage — also the test for whether slow is even relevant. */
function coatParts(p: ProcsView): string[] {
  const coat: string[] = []
  if (p.coatAtEngage) coat.push(`coat ${p.coatAtEngage.poison}`)
  if (p.combatAtEngage.length) coat.push(`venoms ${p.combatAtEngage.map((c) => c.poison).join(', ')}`)
  return coat
}

/**
 * The slow lines, which are the point of the tab. "not landed" and "no slow poison" are
 * different facts and are never collapsed into one phrase; the third case is only worth saying
 * when SOME poison was actually on, since on a fight with bare blades the whole feature is
 * beside the point (the block then falls through to its empty note).
 */
function slowLines(seg: SegmentView, hasCoat: boolean, slow?: SlowRollup): string[] {
  const p = seg.procs
  const out: string[] = []
  if (p.slowLandMs !== undefined) out.push(`Slow landed at ${fmtElapsed(p.slowLandMs)}${p.slowLands > 1 ? ` (${p.slowLands} total)` : ''}`)
  else if (p.slowExpected) out.push('Slow: not landed (a slow-capable coat was on)')
  else if (seg.kind === 'fight' && hasCoat) out.push('Slow: no slow-capable coat was on for this fight')
  const rolling = slow ? slowRollupText(slow) : null
  if (rolling) out.push(`Rolling: ${rolling}`)
  return out
}

/** A lane's display name, carrying the `~` the app uses for a label the game left ambiguous. */
function laneName(r: LaneRow): string {
  return r.ambiguous ? `~ ${r.name}` : r.name
}

/**
 * PROC RATES. The headline plus one row per lane, with BOTH denominators — an absent rate keeps
 * its em dash rather than becoming a zero (law 5), so a paste can never claim `30 ppm` from one
 * proc in a two-second pull.
 */
function rateLines(p: ProcsView, activeSec: number): string[] {
  const overall = p.overall
  const lanes = p.lanes ?? []
  if (!overall || lanes.length === 0) return []
  const out = ['', ...statLines(overallParts(overall, activeSec).map((p) => p.text))]
  const rows = laneRows(lanes, activeSec)
  // The RESISTED column appears only when some lane in this selection was resisted — an
  // all-empty column is noise in a pasted block, and its absence is not a claim about anything.
  const showResisted = rows.some((r) => r.resisted !== undefined)
  const cols: Col[] = [
    { header: 'Proc lane', align: 'left' },
    { header: 'Count', align: 'right' },
    ...(showResisted ? [{ header: 'Resisted', align: 'right' } as Col] : []),
    { header: 'PPM', align: 'right' },
    { header: 'Per 100', align: 'right' }
  ]
  out.push(
    ...table(
      cols,
      rows.map((r) => [
        laneName(r),
        String(r.count),
        ...(showResisted ? [r.resisted ?? ''] : []),
        r.ppm.text,
        r.per100.text
      ])
    )
  )
  return out
}

/**
 * CONTRIBUTION — Tier A, measured. `Added` appears only for the slay lane, whose damage is the
 * damage of swings that PROCCED rather than the damage the proc ADDED; the footer states that
 * assumption so the number can never travel without it.
 */
function contributionLines(p: ProcsView, activeSec: number): string[] {
  const rows = contributionRows(laneRows(p.lanes ?? [], activeSec))
  if (rows.length === 0) return []
  const showAdded = rows.some((r) => r.marginal !== undefined)
  const showHeal = rows.some((r) => r.heal !== undefined)
  const cols: Col[] = [
    { header: 'Proc lane', align: 'left' },
    { header: 'Damage', align: 'right' },
    { header: 'Share', align: 'right' },
    { header: 'DPS', align: 'right' }
  ]
  if (showAdded) cols.push({ header: 'Added', align: 'right' })
  if (showHeal) cols.push({ header: 'Healed', align: 'right' })
  const out = [
    '',
    ...table(
      cols,
      rows.map((r) => {
        const c = r.contribution
        const cells = [laneName(r), c ? formatNum(c.damage) : '', c ? `${Math.round(c.pctOfOut)}%` : '', c ? formatRate(c.dps) : '']
        if (showAdded) cells.push(r.marginal === undefined ? '' : `~${formatNum(r.marginal)}`)
        if (showHeal) cells.push(r.heal === undefined ? '' : formatNum(r.heal))
        return cells
      })
    )
  ]
  if (showAdded) {
    out.push(...wrapText('Added ~ assumes a Slay swing would otherwise have landed for your mean melee hit this segment.'))
  }
  return out
}

/** ACTIVE STATES. Both edges carry their evidence, because a span's END is almost never printed
 *  by the game — an inferred or censored boundary is shown as exactly that, never as a time. */
function stateLines(p: ProcsView, endTs: number): string[] {
  const rows = stateRows(p.states ?? [], endTs)
  if (rows.length === 0) return []
  const cols: Col[] = [
    { header: 'Active state', align: 'left' },
    { header: 'Kind', align: 'right' },
    { header: 'Length', align: 'right' },
    { header: 'Start', align: 'right' },
    { header: 'End', align: 'right' }
  ]
  return [
    '',
    ...table(
      cols,
      rows.map((r) => [
        r.name,
        r.kind,
        r.durationMs === undefined ? '—' : fmtDur(r.durationMs / 1000),
        r.startEvidence,
        r.endEvidence
      ])
    )
  ]
}

/** One effect's own lines: the verdict run, its medians, and its declared confounds. */
function effectBlock(r: EffectRow, mark: string): string[] {
  const head = [`${r.name} (${r.kind})`, r.chip]
  if (r.direct !== undefined) head.push(r.direct)
  if (r.delta !== undefined) head.push(r.delta)
  const out = statLines([...head, mark].filter((s) => s.length > 0))
  if (r.detail !== undefined) out.push(...wrapText(r.detail, '  '))
  for (const c of r.confounds) out.push(...wrapText(c, '  '))
  return out
}

/**
 * EFFECTS — Tier B, present only for a ZONE-session selection (a single pull has no inactive
 * sample). Every observed state gets a row, INCLUDING the ones whose honest answer is "no
 * comparison is possible": omitting them would make the feature look like it had nothing to say
 * about stances, when what it has to say is that the log never marks them.
 */
function effectLines(p: ProcsView): string[] {
  const report = p.attribution
  if (!report || report.effects.length === 0) return []
  const rows = effectRows(report)
  const notes: string[] = []
  const out = ['', `Effects — ${reportAuditLine(report)}`]
  for (const r of rows) {
    let mark = ''
    if (r.note !== undefined) {
      let idx = notes.indexOf(r.note)
      if (idx < 0) idx = notes.push(r.note) - 1
      mark = `[${idx + 1}]`
    }
    out.push(...effectBlock(r, mark))
  }
  notes.forEach((n, i) => out.push(...wrapText(`[${i + 1}] ${n}`)))
  return out
}

/** Switch counts + the coat timeline — the trailing "what changed" run. */
function procMiscLines(p: ProcsView): string[] {
  const misc: string[] = []
  // `count()` pluralizes with a bare 's', which is wrong for "switch" — spelled out here.
  const switches = (n: number, what: string): string => `${n} ${what} switch${n === 1 ? '' : 'es'}`
  if (p.stanceSwitches > 0) misc.push(switches(p.stanceSwitches, 'stance'))
  if (p.invocationSwitches > 0) misc.push(switches(p.invocationSwitches, 'invocation'))
  for (const c of p.coats) misc.push(`coated ${c.poison} @ ${fmtElapsed(c.tMs)}`)
  return misc.length ? ['', ...statLines(misc)] : []
}

/** The three per-lane proc tables, each emitted only when it has rows. The POISON PROCS table is
 *  suppressed once the engine sends the unified lane list, which is a strict superset of it —
 *  the panel makes exactly the same substitution, so the paste always matches the screen. */
function procTables(p: ProcsView): string[] {
  const out: string[] = []
  if (p.strikes.length && (p.lanes?.length ?? 0) === 0) {
    out.push('', ...table(
      [{ header: 'Poison proc', align: 'left' }, { header: 'Count', align: 'right' }],
      p.strikes.map((s) => [s.ambiguous ? `${s.name} (?)` : s.name, String(s.count)])
    ))
  }
  if (p.poisonDamage.length) {
    out.push('', ...table(
      [{ header: 'Poison damage', align: 'left' }, { header: 'Hits', align: 'right' }, { header: 'Total', align: 'right' }],
      p.poisonDamage.map((s) => [s.name, String(s.count), formatNum(s.total ?? 0)])
    ))
  }
  if (p.dispels.length) {
    out.push('', ...table(
      [{ header: 'Dispel landed', align: 'left' }, { header: 'Count', align: 'right' }],
      p.dispels.map((s) => [s.name, String(s.count)])
    ))
    out.push('Dispel lines name no caster — any class or NPC can print them.')
  }
  return out
}

/**
 * The Procs tab, as text.
 *
 * The dispel section deliberately says who it is NOT from. `<mob> feels a bit dispelled.` is
 * the Cancel Magic family's line, and pasting a bare "Dispels 4" into guild chat under a
 * rogue's name would read as a claim the log does not support.
 *
 * `endTs` only clips an OPEN state span's displayed length; 0 means "not knowable here", and
 * such a span then declines to state a length rather than inventing an end.
 */
export function formatProcsText(seg: SegmentView, slow?: SlowRollup, endTs = 0): string {
  const p = seg.procs
  const out = [subjectLine('Procs', seg)]

  const coat = coatParts(p)
  if (coat.length) out.push(...statLines(coat))
  out.push(...slowLines(seg, coat.length > 0, slow))
  // Section order MIRRORS the panel exactly (ProcsBody): the paste is what the user is looking
  // at, so a reader who has both open must not have to re-find anything.
  out.push(...rateLines(p, seg.activeSec))
  out.push(...contributionLines(p, seg.activeSec))
  out.push(...stateLines(p, endTs))
  out.push(...effectLines(p))
  out.push(...procTables(p))
  out.push(...procMiscLines(p))

  if (out.length === 1) out.push('No procs recorded in this segment.')
  return out.join('\n')
}

/** Re-exported so a consumer that only wants the width constant needn't learn two modules. */
export { MAX_WIDTH }
