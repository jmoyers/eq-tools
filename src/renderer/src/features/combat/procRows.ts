// PURE ROW SHAPING for the Procs tab's analytics surface (docs/plans/proc-analytics.md §7).
// No JSX, no MUI — the same MUI-free half that `dashboardData.ts` and `copyText.ts` occupy, so
// the node tests can assert these rows directly and both the panel AND the clipboard read the
// SAME shaping. A second spelling of "what does an absent rate look like" is exactly how the
// pasted block and the panel start disagreeing.
//
// HONESTY (the laws this file exists to enforce, AGENTS.md + plan §1):
//   law 5 — a rate is ABSENT below its sample floor, NEVER 0. Every absent cell renders an
//           em dash and carries the floor in its hover text: `1 proc in a 2-second pull` is
//           not `30 ppm`, and a meter that prints it once prints it forever. The COUNT beside
//           it is always exact — only the division is withheld.
//   law 1 — the engine's own note strings ride through VERBATIM. `EffectAttribution.note` and
//           `confounds` are the honesty of this feature; paraphrasing them into a chip label
//           would delete the sentence and keep the number.
//   law 6 — a slay lane's damage is "damage on swings that PROCCED", never "damage slay added".
//           The marginal figure is an ESTIMATE and never travels without its assumption.
//
// FLOORS ARE SPELLED LITERALLY HERE. They are decided by `src/main/combat/procWindows.ts`
// (MIN_ACTIVE_SEC / MIN_SWINGS) and the renderer cannot import from `src/main`. They are used
// only to WORD the hover ("needs at least 10s"), never to decide absence — absence is the
// engine's decision, read off the undefined field. So a drift here misstates a sentence; it can
// never manufacture or suppress a number.

import { formatNum, formatPer100, formatPpm, formatRate } from '../../lib/formatRate'
import type {
  AttributionReport,
  AttributionVerdict,
  EdgeEvidence,
  MarginalEstimate,
  ProcLaneView,
  ProcOrigin,
  ProcRateView,
  StateKind,
  StateSpan
} from '@shared/procAnalytics'

/** Mirrors `procWindows.MIN_ACTIVE_SEC` — for the hover sentence only (see the header). */
export const MIN_ACTIVE_SEC = 10
/** Mirrors `procWindows.MIN_SWINGS` — for the hover sentence only (see the header). */
export const MIN_SWINGS = 20

/** What an absent rate LOOKS like. An em dash, never '0.0' and never a blank cell: a blank
 *  reads as "nothing to say", and this cell has something to say (see its hover). */
export const ABSENT = '—'

/**
 * The active-time caveat, stated rather than fixed (plan §4.2). `route()` accrues active time
 * BEFORE the incoming/outgoing split, so a pull where you are being beaten on while stunned
 * accrues active seconds you did not swing in. Changing that would move `activeDps`, a shipped
 * number, so the number keeps the meter's meaning and the UI says what it means.
 */
export const ACTIVE_TIME_NOTE =
  'Procs per minute of ACTIVE combat time — the meter’s own definition: gaps between attributed ' +
  'hits capped at 3s each, incoming damage included. The per-100-swings figure beside it has no ' +
  'such ambiguity.'

/** The mechanical denominator's caveat (law 6): swings AS LOGGED. */
export const SWINGS_NOTE =
  'Procs per 100 of YOUR logged swing attempts — melee and slay hits plus your misses. The ' +
  'mechanically correct figure for a chance-on-hit proc. Main-hand vs off-hand and double/triple ' +
  'attack are undistinguishable in this log, so these are swings as logged.'

/** Slay Undead's assumption, carried with the number wherever the number goes (plan §5.6). */
export const SLAY_MARGINAL_NOTE =
  'Assumes a Slay swing would otherwise have landed for your mean melee hit this segment. The ' +
  'row’s damage is the damage on swings that PROCCED slay — the swing was going to land anyway.'

/** ONE cell of a rate column: what to draw, whether it is an absence, and what the hover says. */
export interface RateCell {
  text: string
  /** true when the sample floor was not met — `text` is then `ABSENT`. */
  absent: boolean
  /** The hover. For an absence it names the floor AND how short this selection is. */
  hint: string
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * The ppm cell. `ppmActive` is the headline denominator; the engine withholds it (and `ppmWall`)
 * below `MIN_ACTIVE_SEC`, and this renders that withholding rather than papering over it.
 */
export function ppmCell(rate: ProcRateView, activeSec: number): RateCell {
  if (rate.ppmActive === undefined) {
    return {
      text: ABSENT,
      absent: true,
      hint:
        `No per-minute rate: that needs at least ${MIN_ACTIVE_SEC}s of active combat time and this ` +
        `selection has ${Math.round(activeSec)}s. ${plural(rate.count, 'proc')} counted — the count ` +
        'is exact; only the division is withheld.'
    }
  }
  const wall = rate.ppmWall === undefined ? '' : ` (${formatPpm(rate.ppmWall)} of wall clock)`
  return { text: formatPpm(rate.ppmActive), absent: false, hint: `${ACTIVE_TIME_NOTE}${wall}` }
}

/** The per-100-swings cell. Absent below `MIN_SWINGS` logged swings. */
export function per100Cell(rate: ProcRateView): RateCell {
  if (rate.per100Swings === undefined) {
    return {
      text: ABSENT,
      absent: true,
      hint:
        `No per-swing rate: that needs at least ${MIN_SWINGS} logged swing attempts and this ` +
        `selection has ${rate.swings}. ${plural(rate.count, 'proc')} counted — the count is exact.`
    }
  }
  return { text: formatPer100(rate.per100Swings), absent: false, hint: `${SWINGS_NOTE} ${rate.swings} swings logged.` }
}

/**
 * The headline run — `278 procs · 238 ppm · 66.2/100 swings` — as labeled parts.
 *
 * ONE spelling for the panel AND the clipboard. Each part LABELS ITSELF even when absent: a
 * bare em dash inside a free-text run has no column header to say what it is missing, so the
 * absent case reads `— ppm` / `— per 100 swings` rather than two anonymous dashes.
 */
export function overallParts(overall: ProcRateView, activeSec: number): RateCell[] {
  const ppm = ppmCell(overall, activeSec)
  const per = per100Cell(overall)
  return [
    { text: plural(overall.count, 'proc'), absent: false, hint: 'Every detected proc in this selection — poison Strikes, cast-less spell effects and Slay Undead together.' },
    { ...ppm, text: ppm.absent ? `${ABSENT} ppm` : ppm.text },
    { ...per, text: per.absent ? `${ABSENT} per 100 swings` : `${per.text} swings` }
  ]
}

/** Tier A, and MEASURED — read back out of the same aggregate the damage bars come from. */
export interface LaneContribution {
  damage: number
  pctOfOut: number
  dps: number
  /** `231k · 5% of out · 41 dps` */
  text: string
}

/** One row of the unified lane list. */
export interface LaneRow {
  key: string
  name: string
  /** The label was ambiguous (a shared emote / a shared dispel tier) — the app's `~` treatment.
   *  The COUNT is exact either way; only the name is in doubt. */
  ambiguous: boolean
  origin: ProcOrigin
  count: number
  ppm: RateCell
  per100: RateCell
  /** Absent when the lane carried no damage — a proc emote has no amount and must never get one. */
  contribution?: LaneContribution
  /** Healing this lane returned. Kept apart from damage all the way down: a tap can return more
   *  than it deals, so neither can be derived from the other. */
  heal?: number
  /** SLAY ONLY: the excess over an ordinary swing. An ESTIMATE — see SLAY_MARGINAL_NOTE. */
  marginal?: number
}

function contributionOf(l: ProcLaneView): LaneContribution | undefined {
  if (l.directDamage <= 0) return undefined
  return {
    damage: l.directDamage,
    pctOfOut: l.pctOfOut,
    dps: l.dpsContribution,
    text: `${formatNum(l.directDamage)} · ${Math.round(l.pctOfOut)}% of out · ${formatRate(l.dpsContribution)}`
  }
}

function laneRow(l: ProcLaneView, activeSec: number): LaneRow {
  const contribution = contributionOf(l)
  return {
    key: `${l.origin}|${l.name}`,
    name: l.name,
    ambiguous: l.ambiguous === true,
    origin: l.origin,
    count: l.count,
    ppm: ppmCell(l.rate, activeSec),
    per100: per100Cell(l.rate),
    ...(contribution ? { contribution } : {}),
    ...(l.directHeal > 0 ? { heal: l.directHeal } : {}),
    ...(l.marginalDamage !== undefined ? { marginal: l.marginalDamage } : {})
  }
}

/** The lane list, shaped. Order is the engine's (poison, then spell, then slay, each by count
 *  desc) — the order the questions get asked, and re-sorting here would fork it. */
export function laneRows(lanes: readonly ProcLaneView[], activeSec: number): LaneRow[] {
  return lanes.map((l) => laneRow(l, activeSec))
}

/** The lanes that have a Tier-A number worth a CONTRIBUTION row: damage, healing, or both. */
export function contributionRows(rows: readonly LaneRow[]): LaneRow[] {
  return rows.filter((r) => r.contribution !== undefined || r.heal !== undefined)
}

// ── The active-state ledger ─────────────────────────────────────────────────────────

/** The evidence vocabulary, in the words the UI prints. `censored` and `open` are DIFFERENT
 *  facts and neither may be drawn as the other: censored means the boundary is unknowable,
 *  open means it had not ended yet. */
export const EVIDENCE_LABEL: Record<EdgeEvidence, string> = {
  observed: 'observed',
  inferred: 'inferred',
  censored: 'censored',
  open: 'open'
}

export const EVIDENCE_HINT: Record<EdgeEvidence, string> = {
  observed: 'The game printed a line for this edge.',
  inferred: 'No line marks this edge — a mutually exclusive sibling replaced it (a new stance commit ends the previous stance; a re-apply supersedes its own span).',
  censored: 'This boundary is unknowable: the state was already active when the replay began, or a zone / death / epoch / reset severed it. It is never shown as a time.',
  open: 'Still active as of the last event in this selection.'
}

export const STATE_KIND_LABEL: Record<StateKind, string> = {
  stance: 'stance',
  invocation: 'invocation',
  coat: 'coat',
  buff: 'buff'
}

export interface StateRow {
  key: string
  kind: StateKind
  name: string
  startTs: number
  endTs?: number
  startEvidence: EdgeEvidence
  endEvidence: EdgeEvidence
  /** ms this span covers, clipped to the segment. Absent when the span never ended AND the
   *  segment has no known end to clip against — a duration we cannot state is not stated. */
  durationMs?: number
}

/**
 * The span table, chronological. `segEndTs` closes an OPEN span for display purposes only —
 * the row still wears its `open` chip, so a reader can never mistake the clipped length for an
 * observed end time.
 */
export function stateRows(states: readonly StateSpan[], segEndTs: number): StateRow[] {
  return [...states]
    .sort((a, b) => a.startTs - b.startTs || a.name.localeCompare(b.name))
    .map((s, i) => {
      const end = s.endTs ?? (segEndTs > s.startTs ? segEndTs : undefined)
      return {
        key: `${s.kind}|${s.key}|${s.startTs}|${i}`,
        kind: s.kind,
        name: s.name,
        startTs: s.startTs,
        ...(s.endTs !== undefined ? { endTs: s.endTs } : {}),
        startEvidence: s.startEvidence,
        endEvidence: s.endEvidence,
        ...(end !== undefined ? { durationMs: Math.max(0, end - s.startTs) } : {})
      }
    })
}

// ── Tier B: the attribution report ──────────────────────────────────────────────────

/**
 * The FOUR verdict chips, and none may be rendered as another. Chips convey STATE, never
 * methodology (AGENTS.md UI conventions) — the WHY is the engine's `note`, printed in the hover
 * verbatim.
 */
export const VERDICT_CHIP: Record<AttributionVerdict, string> = {
  measured: 'measured',
  estimate: '~ estimate',
  'insufficient-sample': 'no sample',
  'not-observable': 'not observable'
}

/** A signed rate: `+210 dps` / `-45 dps`. The sign is load-bearing — an unsigned delta beside
 *  the word "adds" would read as a gain whichever way it went. */
function signedRate(n: number): string {
  return `${n >= 0 ? '+' : '−'}${formatRate(Math.abs(n))}`
}

/**
 * The estimate as a RANGE, derived from the two IQRs — never a point (plan §5.3). A point
 * estimate on a matched-window comparison over uncontrolled content would be a precision claim
 * the data does not support, so the widest honest interval is what gets drawn and the medians
 * live in the hover.
 */
export function deltaRangeText(m: MarginalEstimate): string {
  const lo = m.iqrActive[0] - m.iqrInactive[1]
  const hi = m.iqrActive[1] - m.iqrInactive[0]
  return `~ ${signedRate(lo)} … ${signedRate(hi)}`
}

/** The medians, both n's, and the two comparisons that must never be blended into one headline
 *  (proc damage moves while damage-per-swing stays flat — averaging them hides the mechanism). */
export function marginalDetail(m: MarginalEstimate): string {
  return [
    `median ${formatRate(m.medDpsActive)} active (n=${m.nActive}) vs ${formatRate(m.medDpsInactive)} inactive (n=${m.nInactive})`,
    `proc damage ${formatRate(m.medProcDpsActive)} vs ${formatRate(m.medProcDpsInactive)}`,
    `damage per swing ${formatNum(m.medDmgPerSwingActive)} vs ${formatNum(m.medDmgPerSwingInactive)}`
  ].join(' · ')
}

export interface EffectRow {
  key: string
  kind: StateKind
  name: string
  verdict: AttributionVerdict
  /** The chip's word — one of VERDICT_CHIP's four. */
  chip: string
  /** TIER A, exact, when any lane was attributed to this state. Absent otherwise, which is the
   *  honest state today: the per-lane Tier-A numbers live in the lane list. */
  direct?: string
  /** TIER B as a range. Present only for `estimate`. */
  delta?: string
  /** Medians + n's for the hover. Present only for `estimate`. */
  detail?: string
  /** The engine's own sentence, VERBATIM (law 1). Never paraphrased into the chip. */
  note?: string
  /** Declared, never corrected. Printed beside the number as small disabled text. */
  confounds: string[]
}

export function effectRows(report: AttributionReport): EffectRow[] {
  return report.effects.map((e) => ({
    key: `${e.kind}|${e.key}`,
    kind: e.kind,
    name: e.name,
    verdict: e.verdict,
    chip: VERDICT_CHIP[e.verdict],
    ...(e.direct.damage > 0
      ? { direct: `${formatNum(e.direct.damage)} · ${formatRate(e.direct.dpsContribution)}` }
      : {}),
    ...(e.marginal ? { delta: deltaRangeText(e.marginal), detail: marginalDetail(e.marginal) } : {}),
    ...(e.note !== undefined ? { note: e.note } : {}),
    confounds: e.confounds
  }))
}

/** The report's own audit line: how many minutes were even eligible to be compared. Stated
 *  because "324 of 1,842 windows" is what turns a verdict from an assertion into a measurement. */
export function reportAuditLine(report: AttributionReport): string {
  return `${report.windowsEligible} of ${plural(report.windowsTotal, 'minute')} cleared the volume gates`
}
