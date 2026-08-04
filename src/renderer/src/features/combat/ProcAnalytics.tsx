// THE PROC-ANALYTICS SECTIONS of the Procs tab (docs/plans/proc-analytics.md §7): the rate
// headline and the unified lane list, Tier-A contribution, the active-state ledger, and the
// Tier-B effects report.
//
// Its own file, not more of ProcsPanel.tsx: that file is the shipped poison ledger and sits
// near the factoring ceiling with an EMPTY ratchet, and the two halves answer different
// questions anyway (what did my blades do this pull / what is proccing and what does it add).
// Every number arrives already SHAPED by procRows.ts — this file decides only where things sit
// and what the hover says, which is why the panel and the clipboard can never disagree.
//
// UI LAW (AGENTS.md): chips convey STATE — `measured`, `~ estimate`, `no sample`,
// `not observable`, `observed`, `inferred`, `censored`, `open`. NEVER methodology. The WHY
// lives in Tooltips, and where the engine wrote the sentence (an attribution `note`, a confound)
// the sentence travels VERBATIM: those strings are the honesty of this feature, and a
// paraphrase would keep the number and delete the caveat.

import { Box, Stack, Tooltip, Typography } from '@mui/material'
import type { ProcsView } from '@shared/combat'
import { formatNum as fmt } from '../../lib/formatRate'
import { formatTime } from '../../lib/formatDate'
import { fmtDur } from './copyText'
import {
  ABSENT,
  EVIDENCE_HINT,
  EVIDENCE_LABEL,
  SLAY_MARGINAL_NOTE,
  STATE_KIND_LABEL,
  contributionRows,
  effectRows,
  laneRows,
  overallParts,
  reportAuditLine,
  stateRows,
  type EffectRow,
  type LaneRow,
  type RateCell
} from './procRows'
import { CAT_COLOR, QuietNote, RESIST_COLOR } from './combatShared'
import { MARKER_COLOR } from './markerStyle'

/** Lane hues, by origin — the same three the charts use, so a lane means one thing app-wide. */
const ORIGIN_COLOR = { poison: MARKER_COLOR.coat, spell: CAT_COLOR.spell, slay: CAT_COLOR.slay }

/** Section heading, matching ProcsPanel's own. Duplicated rather than exported across the two
 *  files because it is four lines of styling and the alternative is a circular import. */
function Section({ title, right, children }: { title: string; right?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box sx={{ mt: 0.75 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={1}>
        <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: 10, letterSpacing: '0.05em' }}>
          {title}
        </Typography>
        {right !== undefined && (
          <Typography variant="caption" noWrap sx={{ color: 'text.disabled', fontSize: 10 }}>
            {right}
          </Typography>
        )}
      </Stack>
      {children}
    </Box>
  )
}

/**
 * ONE rate cell. An absence renders the em dash at DISABLED weight and keeps its hover — the
 * hover is the whole point: a blank cell says "nothing to report", and this cell is reporting
 * that the sample is too small to divide by (law 5). It is never 0.
 */
function Rate({ cell, width }: { cell: RateCell; width: number }): React.JSX.Element {
  return (
    <Tooltip title={cell.hint}>
      <Typography
        variant="caption"
        noWrap
        sx={{ width, textAlign: 'right', flexShrink: 0, color: cell.absent ? 'text.disabled' : 'text.secondary' }}
      >
        {cell.text}
      </Typography>
    </Tooltip>
  )
}

/** A quiet uppercase chip. State, never process. */
function Chip({ label, hint, color }: { label: string; hint: string; color?: string }): React.JSX.Element {
  return (
    <Tooltip title={hint}>
      <Typography
        component="span"
        variant="caption"
        noWrap
        sx={{
          flexShrink: 0,
          px: 0.5,
          borderRadius: '3px',
          fontSize: 9,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          bgcolor: 'rgba(255,255,255,0.06)',
          color: color ?? 'text.secondary'
        }}
      >
        {label}
      </Typography>
    </Tooltip>
  )
}

/** `Smiting Strike ×214 ······ 4.0 ppm · 3.5/100`. The count is exact; the two rates are the
 *  cells above and may each be an honest absence. */
function LaneRateRow({ row }: { row: LaneRow }): React.JSX.Element {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: '1px', minWidth: 0 }}>
      <Box sx={{ width: 6, height: 6, borderRadius: '2px', bgcolor: ORIGIN_COLOR[row.origin], flexShrink: 0 }} />
      <Typography variant="caption" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
        {row.ambiguous ? `~ ${row.name}` : row.name}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        ×{row.count}
      </Typography>
      {/* THE OTHER HALF OF THE LANE'S RECORD (2026-08-04). Landings alone were what let this
          panel say `90 slow landings` while the drill said `0 landed · 34 resisted` about the
          same Strike. Shown only when something WAS resisted — a 0 here would be furniture. */}
      {row.resisted !== undefined && (
        <Typography variant="caption" noWrap sx={{ flexShrink: 0, color: RESIST_COLOR }}>
          {row.resisted}
        </Typography>
      )}
      <Rate cell={row.ppm} width={62} />
      <Rate cell={row.per100} width={54} />
    </Box>
  )
}

/**
 * RATES — the headline the whole feature exists to answer, then one row per lane. The overall
 * figure is an IDENTITY over the rows beneath it (the engine sums the same lanes), so the
 * header can never drift from the list.
 */
function RatesSection({ procs, activeSec }: { procs: ProcsView; activeSec: number }): React.JSX.Element | null {
  const lanes = procs.lanes ?? []
  const overall = procs.overall
  if (!overall || lanes.length === 0) return null
  const rows = laneRows(lanes, activeSec)
  return (
    <Section title="PROC RATES">
      {/* The headline run, in the SAME spelling the clipboard uses (`overallParts`) — including
          the absent case, which labels itself (`— ppm`) because a bare dash outside a table has
          no column header to say what it is missing. */}
      <Stack direction="row" spacing={0.5} alignItems="baseline" flexWrap="wrap" sx={{ mb: 0.25, minWidth: 0 }}>
        {overallParts(overall, activeSec).map((p, i) => (
          <Tooltip key={p.text} title={p.hint}>
            <Typography
              variant="body2"
              noWrap
              sx={{ fontWeight: i === 0 ? 600 : 400, color: p.absent ? 'text.disabled' : 'text.secondary' }}
            >
              {i > 0 && '· '}
              {p.text}
            </Typography>
          </Tooltip>
        ))}
      </Stack>
      {rows.map((r) => (
        <LaneRateRow key={r.key} row={r} />
      ))}
    </Section>
  )
}

/**
 * CONTRIBUTION — Tier A, and MEASURED: every figure is read back out of the same aggregate the
 * damage bars come from, so it is an INDEX over damage already counted, never a second sum.
 *
 * The slay row is the one exception the type itself insists on: its damage is the damage of
 * swings that PROCCED, which is not the damage the proc ADDED, so it carries the `~` marginal
 * figure with its assumption in the hover and never presents the two as the same number.
 */
function ContributionRow({ row }: { row: LaneRow }): React.JSX.Element {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: '1px', minWidth: 0 }}>
      <Box sx={{ width: 6, height: 6, borderRadius: '2px', bgcolor: ORIGIN_COLOR[row.origin], flexShrink: 0 }} />
      <Typography variant="caption" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
        {row.ambiguous ? `~ ${row.name}` : row.name}
      </Typography>
      {row.heal !== undefined && (
        <Tooltip title="Healing these proc lines returned. Kept apart from damage on purpose — a tap can return more than it deals, so neither can be derived from the other.">
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            +{fmt(row.heal)} healed
          </Typography>
        </Tooltip>
      )}
      {row.marginal !== undefined && (
        <Tooltip title={SLAY_MARGINAL_NOTE}>
          <Typography variant="caption" sx={{ flexShrink: 0, color: CAT_COLOR.slay }}>
            ~ {fmt(row.marginal)} added
          </Typography>
        </Tooltip>
      )}
      <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 0 }}>
        {row.contribution?.text ?? ''}
      </Typography>
      <Chip
        label="measured"
        hint="Read back out of the same aggregate the damage bars come from — an index over damage already counted, not a second sum. Nothing here is estimated."
      />
    </Box>
  )
}

function ContributionSection({ procs, activeSec }: { procs: ProcsView; activeSec: number }): React.JSX.Element | null {
  const rows = contributionRows(laneRows(procs.lanes ?? [], activeSec))
  if (rows.length === 0) return null
  return (
    <Section title="CONTRIBUTION">
      {rows.map((r) => (
        <ContributionRow key={r.key} row={r} />
      ))}
    </Section>
  )
}

/**
 * ACTIVE STATES — the span ledger. BOTH edges carry evidence, because a span's end is almost
 * never printed by the game (97 Instrument of Nife applies against ONE observed fade in the
 * whole log). A `censored` or `inferred` end is shown as exactly that and never as a time.
 */
function StatesSection({ procs, endTs }: { procs: ProcsView; endTs: number }): React.JSX.Element | null {
  const rows = stateRows(procs.states ?? [], endTs)
  if (rows.length === 0) return null
  return (
    <Section title="ACTIVE STATES">
      {rows.map((r) => (
        <Box key={r.key} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: '1px', minWidth: 0 }}>
          <Typography variant="caption" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
            {r.name}
            <Typography component="span" variant="caption" color="text.disabled">
              {' '}
              · {STATE_KIND_LABEL[r.kind]}
            </Typography>
          </Typography>
          <Tooltip title={`Started ${formatTime(r.startTs)}${r.endTs === undefined ? '' : `, ended ${formatTime(r.endTs)}`}.`}>
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              {r.durationMs === undefined ? ABSENT : fmtDur(r.durationMs / 1000)}
            </Typography>
          </Tooltip>
          <Chip label={EVIDENCE_LABEL[r.startEvidence]} hint={`Span START — ${EVIDENCE_HINT[r.startEvidence]}`} />
          <Chip label={EVIDENCE_LABEL[r.endEvidence]} hint={`Span END — ${EVIDENCE_HINT[r.endEvidence]}`} />
        </Box>
      ))}
    </Section>
  )
}

/** One effect: its verdict chip, its Tier-A exact figure when one exists, and — only for an
 *  estimate — the delta as a RANGE. The engine's note is the hover, verbatim. */
function EffectRowView({ row }: { row: EffectRow }): React.JSX.Element {
  return (
    <Box sx={{ py: '2px', minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <Typography variant="caption" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
          {row.name}
          <Typography component="span" variant="caption" color="text.disabled">
            {' '}
            · {STATE_KIND_LABEL[row.kind]}
          </Typography>
        </Typography>
        {row.direct !== undefined && (
          <Tooltip title="Tier A — the exact damage of the proc lanes attributed to this state. Measured, not compared.">
            <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 0 }}>
              {row.direct}
            </Typography>
          </Tooltip>
        )}
        {row.delta !== undefined && (
          <Tooltip title={row.detail ?? ''}>
            <Typography variant="caption" noWrap sx={{ flexShrink: 0, color: 'text.primary' }}>
              {row.delta}
            </Typography>
          </Tooltip>
        )}
        <Chip label={row.chip} hint={row.note ?? 'No further note from the engine for this verdict.'} />
      </Box>
      {row.confounds.map((c) => (
        <Typography key={c} variant="caption" color="text.disabled" sx={{ display: 'block', fontSize: 9, pl: 1 }}>
          {c}
        </Typography>
      ))}
    </Box>
  )
}

/**
 * EFFECTS — Tier B, and ZONE-SCOPE ONLY by construction: the engine attaches the report to a
 * zone-session selection because one pull has no inactive sample, so a per-fight counterfactual
 * would be an invitation to read a minute of noise as an effect.
 *
 * EVERY observed state gets a row, including — especially — the ones whose honest answer is "no
 * comparison is possible". Omitting them would leave the tab looking like the feature had
 * nothing to say about stances, when what it has to say is that the log never marks them.
 */
function EffectsSection({ procs }: { procs: ProcsView }): React.JSX.Element | null {
  const report = procs.attribution
  if (!report || report.effects.length === 0) return null
  return (
    <Section title="EFFECTS" right={reportAuditLine(report)}>
      {effectRows(report).map((r) => (
        <EffectRowView key={r.key} row={r} />
      ))}
    </Section>
  )
}

/** True when the analytics half has anything at all to draw. */
export function hasProcAnalytics(procs: ProcsView): boolean {
  return (procs.lanes?.length ?? 0) > 0 || (procs.states?.length ?? 0) > 0 || (procs.attribution?.effects.length ?? 0) > 0
}

/**
 * The analytics half of the Procs tab, in the order the questions get asked: how often does it
 * fire, what does it deliver, what was on at the time, and — for a whole zone session — what
 * can actually be attributed to any of it.
 */
export function ProcAnalytics({
  procs,
  activeSec,
  endTs
}: {
  procs: ProcsView
  /** The segment's active seconds — the ppm denominator, and the meter's own definition. */
  activeSec: number
  /** Segment end in epoch ms, for clipping an OPEN span's displayed length. */
  endTs: number
}): React.JSX.Element {
  return (
    <>
      <RatesSection procs={procs} activeSec={activeSec} />
      <ContributionSection procs={procs} activeSec={activeSec} />
      <StatesSection procs={procs} endTs={endTs} />
      <EffectsSection procs={procs} />
    </>
  )
}

/** The quiet, honest empty state. The tab pair NEVER vanishes (a tab you cannot find is a
 *  feature you do not have), so an empty selection says so in one line instead. */
export function NoProcs(): React.JSX.Element {
  return <QuietNote>No procs observed in this selection.</QuietNote>
}
