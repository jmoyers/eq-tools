// PROC-ANALYTICS ROW SHAPING (wave 3, the renderer) — and the text it serializes to.
//
// `procRows.ts` is the pure half of the Procs tab's new surface: it turns the engine's
// `ProcLaneView` / `StateSpan` / `AttributionReport` payload into the cells the panel draws AND
// the cells `procsCopy.ts` pastes, so the two can never disagree. Both are asserted here for
// exactly that reason — the panel's numbers and the clipboard's numbers come out of one call.
//
// The window is SYNTHETIC (the same territory as combatCopyText: pure arithmetic and layout
// over already-aggregated data, no log line to hand-read), but it carries every dimension at
// once: an ambiguous poison lane, a big spell lane, a lane that HEALS more than it deals, the
// slay lane with its marginal estimate, all four span-edge evidences, and two of the four
// attribution verdicts.
//
// THE LAWS UNDER TEST, and they are the whole point of the file:
//   law 5 — an absent rate renders an EM DASH and states its floor. Never 0, never blank.
//   law 1 — the engine's own note strings ride through VERBATIM into the row, and the ambiguity
//           `~` marks the NAME while the count beside it stays exact.
//   law 6 — a slay lane's damage is "damage on swings that procced", so its marginal figure is
//           a separate, `~`-marked field that never travels without its assumption.
//   §5.3  — a Tier-B estimate is a RANGE derived from the two IQRs, never a point.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ABSENT,
  MIN_ACTIVE_SEC,
  MIN_SWINGS,
  contributionRows,
  deltaRangeText,
  effectRows,
  laneRows,
  marginalDetail,
  per100Cell,
  ppmCell,
  reportAuditLine,
  stateRows
} from '../src/renderer/src/features/combat/procRows'
import { formatProcsText } from '../src/renderer/src/features/combat/procsCopy'
import { MAX_WIDTH } from '../src/renderer/src/features/combat/copyText'
import type { SegmentView } from '../src/shared/combat'
import type {
  AttributionReport,
  MarginalEstimate,
  ProcLaneView,
  ProcRateView,
  StateSpan
} from '../src/shared/procAnalytics'

// ── fixtures ────────────────────────────────────────────────────────────────────────

/** `count` and `swings` are always present and always exact — they are counts of lines the game
 *  printed. Only the three RATES can be missing, so `over` carries exactly those. */
function rate(count: number, swings: number, over: Partial<ProcRateView> = {}): ProcRateView {
  return { count, swings, ...over }
}

const LANES: ProcLaneView[] = [
  {
    name: 'Asp Venom Strike / Cobra Venom Strike',
    count: 15,
    origin: 'poison',
    ambiguous: true,
    rate: rate(15, 420, { ppmActive: 12.857, ppmWall: 10.843, per100Swings: 3.571 }),
    directDamage: 795,
    directHeal: 0,
    pctOfOut: 1.758,
    dpsContribution: 11.357,
    linked: []
  },
  {
    name: 'Smiting Strike',
    count: 214,
    origin: 'spell',
    rate: rate(214, 420, { ppmActive: 183.4, ppmWall: 154.7, per100Swings: 50.95 }),
    directDamage: 31900,
    directHeal: 0,
    pctOfOut: 70.5,
    dpsContribution: 455.7,
    linked: []
  },
  // The tap that RETURNS more than it deals — 474 healed against 458 dealt. Neither number can
  // be derived from the other, so the row carries both.
  {
    name: 'Lifetap Strike',
    count: 4,
    origin: 'spell',
    rate: rate(4, 420, { ppmActive: 3.43, ppmWall: 2.89, per100Swings: 0.952 }),
    directDamage: 458,
    directHeal: 474,
    pctOfOut: 1.01,
    dpsContribution: 6.54,
    linked: []
  },
  {
    name: 'Slay Undead',
    count: 45,
    origin: 'slay',
    rate: rate(45, 420, { ppmActive: 38.57, ppmWall: 32.53, per100Swings: 10.71 }),
    directDamage: 6000,
    directHeal: 0,
    pctOfOut: 13.26,
    dpsContribution: 85.7,
    marginalDamage: 1455,
    linked: []
  }
]

/** All four edge evidences across three spans, including one still OPEN. */
const STATES: StateSpan[] = [
  {
    kind: 'invocation',
    key: 'spellblade',
    name: 'spellblade',
    startTs: 1_000_000,
    endTs: 1_061_000,
    startEvidence: 'observed',
    endEvidence: 'inferred'
  },
  {
    kind: 'stance',
    key: 'offensive',
    name: 'offensive',
    startTs: 990_000,
    startEvidence: 'censored',
    endEvidence: 'open'
  },
  {
    kind: 'buff',
    key: 'instrument of nife',
    name: 'Instrument of Nife',
    startTs: 1_000_500,
    endTs: 1_120_500,
    startEvidence: 'observed',
    endEvidence: 'observed'
  }
]

const MARGINAL: MarginalEstimate = {
  nActive: 324,
  nInactive: 1289,
  medDpsActive: 640,
  medDpsInactive: 550,
  iqrActive: [500, 700],
  iqrInactive: [400, 600],
  deltaDps: 90,
  deltaPct: 16.4,
  medProcDpsActive: 727.8,
  medProcDpsInactive: 518.5,
  medDmgPerSwingActive: 26.2,
  medDmgPerSwingInactive: 26.3
}

const DIRECT_NOTE = 'No lane is attributed to this state; the exact per-lane numbers are in the lane list.'
const NIFE_NOTE =
  'This state was active in every one of the 913 eligible minutes. No comparison is possible — there is no control group.'

const REPORT: AttributionReport = {
  sessionId: 'zone',
  windowSec: 60,
  windowsTotal: 1842,
  windowsEligible: 1613,
  effects: [
    {
      kind: 'invocation',
      key: 'spellblade',
      name: 'spellblade',
      verdict: 'estimate',
      direct: { damage: 0, heal: 0, hits: 0, dpsContribution: 0, lanes: [] },
      marginal: MARGINAL,
      confounds: [
        'co-state — stance:offensive was active in 62% of active windows but 31% of inactive ones',
        'not tested — level drift and mob mix are not carried in the minute ledger'
      ],
      note: DIRECT_NOTE
    },
    {
      kind: 'buff',
      key: 'instrument of nife',
      name: 'Instrument of Nife',
      verdict: 'not-observable',
      direct: { damage: 230829, heal: 0, hits: 1096, dpsContribution: 41.2, lanes: ['Condemnation of Nife'] },
      confounds: [],
      note: NIFE_NOTE
    }
  ]
}

const SEG: SegmentView = {
  id: 'zone',
  kind: 'zone',
  name: 'The Plane of Sky — overall',
  durationSec: 83,
  active: false,
  activeSec: 70,
  outTotal: 45230,
  outDps: 545,
  activeDps: 646,
  entities: [],
  inTotal: 0,
  inDps: 0,
  incoming: [],
  enemyHealTotal: 0,
  incomingHealTotal: 0,
  incomingHealers: [],
  healing: { total: 0, restoredTotal: 0, absorbedTotal: 0 } as unknown as SegmentView['healing'],
  procs: {
    combatAtEngage: [],
    slowExpected: false,
    coats: [],
    strikes: [],
    strikeCount: 0,
    slowLands: 0,
    poisonDamage: [{ name: 'Asp Venom Strike', count: 15, total: 795 }],
    poisonDamageTotal: 795,
    dispels: [],
    dispelCount: 0,
    stanceSwitches: 1,
    invocationSwitches: 2,
    lanes: LANES,
    overall: rate(278, 420, { ppmActive: 238.29, ppmWall: 200.96, per100Swings: 66.19 }),
    states: STATES,
    attribution: REPORT
  }
}

// ── the rate cells: absence is a FIRST-CLASS value ──────────────────────────────────

test('a rate below its sample floor is an EM DASH that states the floor — never 0', () => {
  // The engine withholds `ppmActive` below MIN_ACTIVE_SEC of active time. A 2-second pull with
  // one proc is not "30 ppm", and a meter that prints it once prints it forever.
  const short = ppmCell(rate(1, 6), 2)
  assert.equal(short.text, ABSENT)
  assert.equal(short.absent, true)
  assert.ok(short.hint.includes(`${MIN_ACTIVE_SEC}s of active combat time`), short.hint)
  assert.ok(short.hint.includes('has 2s'), short.hint)
  // The COUNT is never withheld — only the division is. The hover says so.
  assert.ok(short.hint.includes('1 proc counted'), short.hint)

  const few = per100Cell(rate(1, 6))
  assert.equal(few.text, ABSENT)
  assert.equal(few.absent, true)
  assert.ok(few.hint.includes(`${MIN_SWINGS} logged swing attempts`), few.hint)
  assert.ok(few.hint.includes('has 6'), few.hint)
})

test('a rate above its floor renders with the app’s ONE spelling and carries the caveat', () => {
  const cell = ppmCell(rate(214, 420, { ppmActive: 183.4, ppmWall: 154.7, per100Swings: 50.95 }), 70)
  assert.equal(cell.text, '183 ppm')
  assert.equal(cell.absent, false)
  // The active-time definition is STATED, not silently redefined (plan §4.2): incoming damage
  // extends it, because that is what the shipped `activeDps` already means.
  assert.ok(cell.hint.includes('incoming damage included'), cell.hint)
  assert.ok(cell.hint.includes('155 ppm of wall clock'), cell.hint)
  assert.equal(per100Cell(rate(214, 420, { ppmActive: 183.4, ppmWall: 154.7, per100Swings: 50.95 })).text, '51.0/100')
})

// ── lane rows ───────────────────────────────────────────────────────────────────────

test('laneRows keeps the engine order, marks the ambiguous NAME, and never invents a total', () => {
  const rows = laneRows(LANES, 70)
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Asp Venom Strike / Cobra Venom Strike', 'Smiting Strike', 'Lifetap Strike', 'Slay Undead']
  )
  // `ambiguous` is about the LABEL. The count beside it is exact either way.
  assert.equal(rows[0].ambiguous, true)
  assert.equal(rows[0].count, 15)
  assert.equal(rows[1].ambiguous, false)
  // Healing is carried SEPARATELY: this lane returns more than it deals (474 vs 458), so one
  // could never be derived from the other.
  assert.equal(rows[2].heal, 474)
  assert.equal(rows[2].contribution?.damage, 458)
  // Every other lane has no healing at all — absent, not 0.
  assert.equal(rows[1].heal, undefined)
})

test('the slay lane carries its MARGINAL estimate in its own field, never merged into damage', () => {
  const slay = laneRows(LANES, 70).find((r) => r.origin === 'slay')
  assert.ok(slay)
  // directDamage is the damage of swings that PROCCED — the swing was going to land anyway.
  assert.equal(slay.contribution?.damage, 6000)
  // The excess over an ordinary swing is a DIFFERENT number and stays one.
  assert.equal(slay.marginal, 1455)
  assert.equal(slay.contribution?.text, '6.0k · 13% of out · 86 dps')
  // No other origin gets a marginal figure: for them the proc's whole damage IS its marginal.
  for (const r of laneRows(LANES, 70).filter((x) => x.origin !== 'slay')) assert.equal(r.marginal, undefined)
})

test('contributionRows keeps only the lanes with a Tier-A number to report', () => {
  const none: ProcLaneView[] = [
    { name: 'Befuddling Strike', count: 3, origin: 'poison', rate: rate(3, 420, { ppmActive: 2.5, ppmWall: 2.1, per100Swings: 0.71 }), directDamage: 0, directHeal: 0, pctOfOut: 0, dpsContribution: 0, linked: [] }
  ]
  // A proc EMOTE carries no amount and must never be given one — so it has no contribution row.
  assert.equal(contributionRows(laneRows(none, 70)).length, 0)
  assert.equal(contributionRows(laneRows(LANES, 70)).length, 4)
})

// ── state spans ─────────────────────────────────────────────────────────────────────

test('stateRows is chronological and keeps BOTH edges’ evidence', () => {
  const rows = stateRows(STATES, 1_200_000)
  assert.deepEqual(
    rows.map((r) => r.name),
    ['offensive', 'spellblade', 'Instrument of Nife']
  )
  // A span already running when the replay began starts CENSORED and — still running — ends
  // 'open'. Those are different facts and neither may be drawn as the other.
  assert.equal(rows[0].startEvidence, 'censored')
  assert.equal(rows[0].endEvidence, 'open')
  assert.equal(rows[0].endTs, undefined)
  // An open span's LENGTH is clipped to the segment for display; the chip still says 'open',
  // so the clipped length can never be misread as an observed end.
  assert.equal(rows[0].durationMs, 210_000)
  // A stance commit ends the previous stance with no line to say so — hence 'inferred'.
  assert.equal(rows[1].endEvidence, 'inferred')
  assert.equal(rows[1].durationMs, 61_000)
})

test('an open span with no knowable segment end declines to state a length', () => {
  // 0 means "not knowable here" (a finalized selection). A duration we cannot state is not
  // stated — it is never rounded down to zero or extrapolated to `now`.
  const rows = stateRows(STATES, 0)
  assert.equal(rows[0].durationMs, undefined)
  assert.equal(rows[1].durationMs, 61_000)
})

// ── Tier B ──────────────────────────────────────────────────────────────────────────

test('a Tier-B estimate is a RANGE off the two IQRs, never a point', () => {
  // active IQR [500,700] against inactive [400,600]: the widest honest interval is
  // 500-600 … 700-400. A point estimate here would be a precision claim the data can't support.
  assert.equal(deltaRangeText(MARGINAL), '~ −100 dps … +300 dps')
  const detail = marginalDetail(MARGINAL)
  // BOTH n's ride along — a delta with one n hidden is itself a precision claim.
  assert.ok(detail.includes('n=324'), detail)
  assert.ok(detail.includes('n=1289'), detail)
  // Proc damage and damage-per-swing are reported SEPARATELY: on the real log spellblade moves
  // proc damage ~40% while leaving damage-per-swing flat, and one blended headline would hide
  // the entire mechanism.
  assert.ok(detail.includes('proc damage 728 dps vs 519 dps'), detail)
  assert.ok(detail.includes('damage per swing'), detail)
})

test('effectRows carries the engine’s note VERBATIM and its confounds undeclared-free', () => {
  const rows = effectRows(REPORT)
  assert.equal(rows[0].chip, '~ estimate')
  assert.equal(rows[0].delta, '~ −100 dps … +300 dps')
  assert.equal(rows[0].note, DIRECT_NOTE)
  assert.deepEqual(rows[0].confounds, REPORT.effects[0].confounds)
  // Tier A is absent for this one (no lane is attributed to a state yet) — absent, not 0.
  assert.equal(rows[0].direct, undefined)

  // 'not-observable' is a RESULT, not a defect: one arm was structurally empty. It keeps its
  // exact Tier-A number, which is the honest answer, and its own sentence.
  assert.equal(rows[1].chip, 'not observable')
  assert.equal(rows[1].direct, '230.8k · 41 dps')
  assert.equal(rows[1].delta, undefined)
  assert.equal(rows[1].note, NIFE_NOTE)

  assert.equal(reportAuditLine(REPORT), '1613 of 1842 minutes cleared the volume gates')
})

// ── the same rows, as pasted text ───────────────────────────────────────────────────

test('formatProcsText serializes the whole analytics surface, and it fits the paste width', () => {
  const text = formatProcsText(SEG, undefined, 1_200_000)
  assert.equal(
    text,
    [
      'Procs — The Plane of Sky — overall · 1:23',
      '',
      '278 procs · 238 ppm · 66.2/100 swings',
      'Proc lane                                Count       PPM   Per 100',
      // The `~` marks the NAME the game left ambiguous; the count beside it is exact.
      '~ Asp Venom Strike / Cobra Venom Strike     15  12.9 ppm  3.57/100',
      'Smiting Strike                             214   183 ppm  51.0/100',
      'Lifetap Strike                               4  3.43 ppm  0.95/100',
      'Slay Undead                                 45  38.6 ppm  10.7/100',
      '',
      'Proc lane                          Damage  Share      DPS  Added  Healed',
      // The label column is the only one that gives ground to the width — clipping a lane name
      // is recoverable, clipping a number is a lie.
      '~ Asp Venom Strike / Cobra Venom…     795     2%   11 dps',
      'Smiting Strike                      31.9k    71%  456 dps',
      // Healing sits in its own column: this lane returned 474 while dealing 458.
      'Lifetap Strike                        458     1%    7 dps            474',
      'Slay Undead                          6.0k    13%   86 dps  ~1.5k',
      'Added ~ assumes a Slay swing would otherwise have landed for your mean',
      'melee hit this segment.',
      '',
      'Active state              Kind  Length     Start       End',
      'offensive               stance    3:30  censored      open',
      'spellblade          invocation    1:01  observed  inferred',
      'Instrument of Nife        buff    2:00  observed  observed',
      '',
      'Effects — 1613 of 1842 minutes cleared the volume gates',
      'spellblade (invocation) · ~ estimate · ~ −100 dps … +300 dps · [1]',
      '  median 640 dps active (n=324) vs 550 dps inactive (n=1289) · proc',
      '  damage 728 dps vs 519 dps · damage per swing 26 vs 26',
      '  co-state — stance:offensive was active in 62% of active windows but',
      '  31% of inactive ones',
      '  not tested — level drift and mob mix are not carried in the minute',
      '  ledger',
      'Instrument of Nife (buff) · not observable · 230.8k · 41 dps · [2]',
      // The notes are FOOTNOTED, deduped and verbatim: most of a session's states share one
      // sentence, and printing that paragraph eighteen times is noise, not honesty.
      '[1] No lane is attributed to this state; the exact per-lane numbers are',
      'in the lane list.',
      '[2] This state was active in every one of the 913 eligible minutes. No',
      'comparison is possible — there is no control group.',
      '',
      'Poison damage     Hits  Total',
      'Asp Venom Strike    15    795',
      '',
      '1 stance switch · 2 invocation switches'
    ].join('\n')
  )
  assert.ok(text.split('\n').every((l) => l.length <= MAX_WIDTH), text)
  // Same law as every other copy block: no markdown for a destination to re-render.
  assert.ok(!/[*_`|#]/.test(text), text)
})

test('the unified lane table REPLACES the poison-only one — a lane is never listed twice', () => {
  const legacy = { ...SEG, procs: { ...SEG.procs, strikes: [{ name: 'Weakening Strike', count: 2 }], strikeCount: 2 } }
  // With `lanes` present the shipped POISON PROCS table is suppressed (the lane list is a strict
  // superset of it), exactly as the panel suppresses it — paste and screen always agree.
  assert.ok(!formatProcsText(legacy, undefined, 0).includes('Poison proc  '))
  // Without `lanes` — an older payload, or a golden fixture built before this wave — it is the
  // only list there is, and it still renders.
  const noLanes = { ...legacy, procs: { ...legacy.procs, lanes: undefined, overall: undefined } }
  assert.ok(formatProcsText(noLanes, undefined, 0).includes('Weakening Strike'))
})

test('a rate-less selection prints em dashes in the table, never zeroes', () => {
  const tiny: ProcLaneView[] = [
    { name: 'Smiting Strike', count: 1, origin: 'spell', rate: rate(1, 4), directDamage: 0, directHeal: 0, pctOfOut: 0, dpsContribution: 0, linked: [] }
  ]
  const seg = {
    ...SEG,
    activeSec: 3,
    procs: { ...SEG.procs, poisonDamage: [], lanes: tiny, overall: rate(1, 4), states: [], attribution: undefined }
  }
  const text = formatProcsText(seg, undefined, 0)
  assert.equal(
    text,
    [
      'Procs — The Plane of Sky — overall · 1:23',
      '',
      // The headline's absent parts LABEL THEMSELVES: a bare dash outside a table has no column
      // header to say what is missing.
      `1 proc · ${ABSENT} ppm · ${ABSENT} per 100 swings`,
      'Proc lane       Count  PPM  Per 100',
      `Smiting Strike      1    ${ABSENT}        ${ABSENT}`,
      '',
      '1 stance switch · 2 invocation switches'
    ].join('\n')
  )
  // Not one zero rate anywhere: `1 proc in a 3-second pull` is not `20 ppm`, and it is not
  // `0 ppm` either.
  assert.ok(!/[\d.]+ ppm/.test(text), text)
})
