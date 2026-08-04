// The PROCS tab (Task #64) — the rogue-poison ledger for the selected segment, and the tab
// pair that swaps it with the composition breakdown in the dashboard's second cell.
//
// Split out of CombatDashboard.tsx to keep both files under the factoring limit, and because
// this view has a different SOURCE OF TRUTH from its neighbours: every number here is folded
// on ingest by the engine (ProcsView), never derived from the per-event ring. That is why it
// carries no `~ N of M events` chip and no downsample caveat — the only `~` in this view marks
// a lane whose NAME the game left ambiguous (two Strikes sharing one emote; a dispel tier
// shared across the Cancel Magic family), never a scaled number.

import { type ReactNode } from 'react'
import { Box, Stack, Tooltip, Typography } from '@mui/material'
import type { ProcLane, ProcsView, SlowRollup } from '@shared/combat'
import { formatNum as fmt } from '../../lib/formatRate'
import { formatDateTime, formatTime } from '../../lib/formatDate'
import { CAT_COLOR, KIND_COLOR } from './combatShared'
import { fmtElapsed, slowRollupText } from './copyText'
import { MARKER_COLOR } from './markerStyle'
import { coatRows, type CoatRow } from './procRows'
import { NoProcs, ProcAnalytics, hasProcAnalytics } from './ProcAnalytics'

// The three hues below are the MARKER hues — this panel and the charts are talking about the
// same events, so they read from the one map (markerStyle.ts) instead of keeping copies of the
// hexes, which is how a third copy starts to drift.

/** The blade-coat hue, shared with the header's slot-3 pill and the chart's coat markers. */
export const POISON_COLOR = MARKER_COLOR.coat
/** The slow hue, shared with the chart's flagged slow marker and the meter's slow chip. */
export const SLOW_COLOR = MARKER_COLOR.slow
/** The invocation hue, shared with the header's slot-2 pill. */
const INVOCATION_COLOR = MARKER_COLOR.invocation

/**
 * The card's tab pair. Deliberately the LIGHTEST control in the app's hierarchy — plain text
 * that brightens when active, the same `text` weight the direction filter uses — because it
 * switches what one card shows, and a bordered control here would out-rank the view switch in
 * the header that navigates the whole tab.
 */
export function CardTabs({
  value,
  onChange
}: {
  value: 'breakdown' | 'procs'
  onChange: (v: 'breakdown' | 'procs') => void
}): React.JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
      {(['breakdown', 'procs'] as const).map((k) => (
        <Typography
          key={k}
          variant="caption"
          onClick={() => onChange(k)}
          data-testid={`procs-tab-${k}`}
          sx={{
            cursor: 'pointer',
            userSelect: 'none',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontWeight: 700,
            fontSize: 10,
            color: value === k ? 'text.primary' : 'text.secondary',
            '&:hover': { color: 'text.primary' }
          }}
        >
          {k === 'breakdown' ? 'Breakdown' : 'Procs'}
        </Typography>
      ))}
    </Stack>
  )
}

/** One `label ······ count` row. `~` marks a lane the game refused to name unambiguously. */
function ProcRow({ lane, color, right }: { lane: ProcLane; color: string; right?: string }): React.JSX.Element {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: '1px', minWidth: 0 }}>
      <Box sx={{ width: 6, height: 6, borderRadius: '2px', bgcolor: color, flexShrink: 0 }} />
      <Typography variant="caption" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
        {lane.ambiguous === true ? `~ ${lane.name}` : lane.name}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right', flexShrink: 0 }}>
        {right ?? `×${lane.count}`}
      </Typography>
    </Box>
  )
}

function ProcSection({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <Box sx={{ mt: 0.75 }}>
      <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: 10, letterSpacing: '0.05em' }}>
        {title}
      </Typography>
      {children}
    </Box>
  )
}

/**
 * THE HEADLINE — the question the user actually asked, and the one place this feature can most
 * easily lie. There are FOUR distinct answers and none of them may be rendered as another:
 *   landed        — a measured ms, the thing we are here to report.
 *   not landed    — a slow-capable coat WAS on and the proc has not fired. A fact about dice.
 *   no slow coat  — poison was on, but none that grants Weakening Strike. A fact about the
 *                   loadout; showing it as "not landed" would blame the dice for a choice.
 *   (nothing)     — no poison at all, or a zone aggregate, which has no single engage instant.
 */
function SlowHeadline({ procs, isFight }: { procs: ProcsView; isFight: boolean }): React.JSX.Element {
  const coat = procs.coatAtEngage
  const anyCoat = coat !== undefined || procs.combatAtEngage.length > 0
  if (procs.slowLandMs !== undefined) {
    return (
      <Typography variant="body2" sx={{ color: SLOW_COLOR, fontWeight: 600 }}>
        Slow landed at {fmtElapsed(procs.slowLandMs)}
        {procs.slowLands > 1 && (
          <Typography component="span" variant="caption" color="text.secondary">
            {' '}
            · {procs.slowLands} landings
          </Typography>
        )}
      </Typography>
    )
  }
  if (procs.slowExpected) {
    return (
      <Tooltip title={`A slow-capable coat (${coat?.poison ?? '?'}) was already on when this fight opened, and no slow has landed yet.`}>
        <Typography variant="body2" color="text.secondary">
          Slow: not landed
        </Typography>
      </Tooltip>
    )
  }
  if (isFight && anyCoat) {
    return (
      <Tooltip title="Only Weakening, Binding, Neurotoxic and Paralytic poison can proc a slow (Weakening Strike). None of those was coated when this fight opened.">
        <Typography variant="body2" color="text.disabled">
          Slow: no slow poison coated
        </Typography>
      </Tooltip>
    )
  }
  return (
    <Typography variant="body2" color="text.disabled">
      {procs.slowLands} slow landing{procs.slowLands === 1 ? '' : 's'} this segment
    </Typography>
  )
}

/** The rolling aggregate line. Absent — not zeroed — until a qualifying pull has finished. */
function SlowRolling({ slow }: { slow: SlowRollup | undefined }): React.JSX.Element | null {
  const text = slow ? slowRollupText(slow) : null
  if (!slow || text === null) return null
  return (
    <Tooltip
      title={`Rolling over the last ${slow.window} pulls that opened with a slow-capable coat on. Only the pulls where a slow LANDED are averaged; the rest are counted separately and never folded in as zero.`}
    >
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {text}
      </Typography>
    </Tooltip>
  )
}

/**
 * WHAT WAS ON THE BLADES when the pull opened — one row per coat, up to the game's four (one
 * utility poison plus one venom from each of the three combat lines).
 *
 * This replaced a single dim line of joined names (2026-08-04). The names alone could not
 * answer the question the owner was actually asking of it — which of these is doing anything —
 * so each row now carries the coat's OWN state: when it went on, which Strikes it grants, and
 * how many of each landed in this segment. A granted Strike with no landings stays on the row:
 * "it was on and it never fired" is a finding, and hiding it would make an unlucky coat look
 * like a coat that was never applied.
 *
 * The slow carrier wears the slow hue — it is the one coat the tab's headline is about.
 */
function CoatRowView({ row }: { row: CoatRow }): React.JSX.Element {
  const landings = row.strikes.map((s) => `${s.name} ×${s.count}`).join(' · ')
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: '1px', minWidth: 0 }}>
      <Box
        sx={{
          width: 6,
          height: 6,
          borderRadius: '2px',
          bgcolor: row.slowCarrier ? SLOW_COLOR : POISON_COLOR,
          flexShrink: 0
        }}
      />
      <Typography variant="caption" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
        {row.poison}
        <Typography component="span" variant="caption" color="text.disabled">
          {' '}
          · {row.group}
        </Typography>
      </Typography>
      {landings !== '' && (
        <Tooltip title={`Strikes this coat grants, and how many landed in this selection: ${landings}.`}>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 0 }}>
            {row.strikes.reduce((n, s) => n + s.count, 0)} strikes
          </Typography>
        </Tooltip>
      )}
      <Tooltip title={`Coated ${formatDateTime(row.sinceTs)} — it may have gone on well before this segment opened.`}>
        <Typography variant="caption" color="text.disabled" noWrap sx={{ flexShrink: 0 }}>
          {formatTime(row.sinceTs)}
        </Typography>
      </Tooltip>
    </Box>
  )
}

function CoatSection({ procs }: { procs: ProcsView }): React.JSX.Element | null {
  const rows = coatRows(procs)
  if (rows.length === 0) return null
  return (
    <ProcSection title="COATED">
      {rows.map((r) => (
        <CoatRowView key={r.key} row={r} />
      ))}
    </ProcSection>
  )
}

/** Stance/invocation commits and mid-fight re-coats, as ms since the segment opened. */
function ChangesSection({ procs }: { procs: ProcsView }): React.JSX.Element | null {
  if (procs.coats.length === 0 && procs.stanceSwitches + procs.invocationSwitches === 0) return null
  return (
    <ProcSection title="CHANGES">
      {procs.coats.map((c, i) => (
        <ProcRow
          key={`${c.poison}|${c.tMs}|${i}`}
          lane={{ name: `coated ${c.poison}`, count: 1 }}
          color={POISON_COLOR}
          right={fmtElapsed(c.tMs)}
        />
      ))}
      {procs.stanceSwitches > 0 && (
        <ProcRow lane={{ name: 'stance switches', count: procs.stanceSwitches }} color={KIND_COLOR.you} />
      )}
      {procs.invocationSwitches > 0 && (
        <ProcRow lane={{ name: 'invocation switches', count: procs.invocationSwitches }} color={INVOCATION_COLOR} />
      )}
    </ProcSection>
  )
}

/**
 * The shipped POISON PROCS list. Rendered only when the engine sent NO unified `lanes` array —
 * a lane list is a strict SUPERSET of these rows (it carries the same poison Strikes with their
 * rates attached), so drawing both would list every poison lane twice. Kept for the payload
 * shape that predates the analytics wave, and for the golden fixtures built against it.
 */
function LegacyStrikes({ procs }: { procs: ProcsView }): React.JSX.Element | null {
  if (procs.strikes.length === 0) return null
  return (
    <ProcSection title="POISON PROCS">
      {procs.strikes.map((s) => (
        // The slow lane wears the slow hue — it is the lane this whole tab is about.
        <ProcRow key={s.name} lane={s} color={s.name.startsWith('Weakening') ? SLOW_COLOR : POISON_COLOR} />
      ))}
    </ProcSection>
  )
}

/**
 * Does this selection have NOTHING proc-shaped to say? Every dimension the tab can draw, in one
 * predicate — including `slowExpected`, which is content even with no rows ("you had the poison
 * on and it never landed" is exactly the answer the user asked for, and it is the one answer
 * that has nothing to list).
 */
function nothingToShow(p: ProcsView): boolean {
  return (
    p.strikeCount === 0 &&
    p.dispelCount === 0 &&
    p.poisonDamage.length === 0 &&
    p.coats.length === 0 &&
    !p.slowExpected &&
    p.stanceSwitches + p.invocationSwitches === 0 &&
    !hasProcAnalytics(p)
  )
}

/**
 * The PROCS body. Every number is engine-folded (see this file's header), so nothing here is
 * ever an estimate; the section order is the order the user asks the questions in — did the
 * slow land, how does that compare, what is proccing and how often, what does it deliver, what
 * was on at the time, and what changed mid-fight.
 *
 * The empty case is a QUIET LINE, never a vanished tab (the tab pair renders always now): a
 * feature the owner cannot find in the UI is a feature that does not exist.
 */
export function ProcsBody({
  procs,
  slow,
  isFight,
  activeSec,
  endTs
}: {
  procs: ProcsView
  slow: SlowRollup | undefined
  isFight: boolean
  /** The segment's active seconds — the ppm denominator, in the meter's own definition. */
  activeSec: number
  /** Segment end in epoch ms, or 0 when it is not knowable; only clips an OPEN span's
   *  displayed length, never its evidence chip. */
  endTs: number
}): React.JSX.Element {
  const hasLanes = (procs.lanes?.length ?? 0) > 0
  const nothing = nothingToShow(procs)
  return (
    <Box sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
      <SlowHeadline procs={procs} isFight={isFight} />
      <SlowRolling slow={slow} />
      <CoatSection procs={procs} />

      <ProcAnalytics procs={procs} activeSec={activeSec} endTs={endTs} />

      {!hasLanes && <LegacyStrikes procs={procs} />}

      {procs.poisonDamage.length > 0 && (
        <ProcSection title="POISON DAMAGE">
          {procs.poisonDamage.map((s) => (
            <ProcRow key={s.name} lane={s} color={CAT_COLOR.spell} right={`${s.count} · ${fmt(s.total ?? 0)}`} />
          ))}
        </ProcSection>
      )}

      {procs.dispels.length > 0 && (
        <ProcSection title="DISPELS LANDED">
          {procs.dispels.map((s) => (
            <ProcRow key={s.name} lane={s} color={CAT_COLOR.dot} />
          ))}
          {/* Load-bearing caption, not decoration: this line is what stops a rogue's Procs tab
              from reading as a claim that the rogue dispelled anything. */}
          <Tooltip title="The dispel line names no caster and is shared by every spell in this family — eleven classes and a number of NPCs print it. Your rogue's dispel proc is Banishing Strike, which prints a different line and is counted under POISON PROCS.">
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>
              any caster — not attributed
            </Typography>
          </Tooltip>
        </ProcSection>
      )}

      <ChangesSection procs={procs} />

      {nothing && <NoProcs />}
    </Box>
  )
}
