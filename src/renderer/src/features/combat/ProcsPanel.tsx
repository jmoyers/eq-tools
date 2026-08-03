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
import type { CoatSlot, ProcLane, ProcsView, SlowRollup } from '@shared/combat'
import { formatNum as fmt } from '../../lib/formatRate'
import { CAT_COLOR, KIND_COLOR, QuietNote } from './combatShared'
import { fmtElapsed, slowRollupText } from './copyText'

/** The blade-coat hue, shared with the header's slot-3 pill and the chart's coat markers. */
export const POISON_COLOR = '#c46fd2'
/** The slow hue, shared with the chart's flagged slow marker and the meter's slow chip. */
export const SLOW_COLOR = '#57e0a0'
/** The invocation hue, shared with the header's slot-2 pill. */
const INVOCATION_COLOR = '#a98fe0'

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

/** What was on the blades when the pull opened — the utility slot first, then the venom stack. */
function CoatLine({ coat, combat }: { coat: CoatSlot | undefined; combat: CoatSlot[] }): React.JSX.Element | null {
  if (coat === undefined && combat.length === 0) return null
  const names = [...(coat ? [coat.poison] : []), ...combat.map((c) => c.poison)]
  return (
    <Typography variant="caption" color="text.disabled" noWrap sx={{ display: 'block', mt: 0.25 }}>
      {names.join(' · ')}
    </Typography>
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
 * The PROCS body. Every number is engine-folded (see this file's header), so nothing here is
 * ever an estimate; the section order is the order the user asks the questions in — did the
 * slow land, how does that compare, what else procced, and what changed mid-fight.
 */
export function ProcsBody({
  procs,
  slow,
  isFight
}: {
  procs: ProcsView
  slow: SlowRollup | undefined
  isFight: boolean
}): React.JSX.Element {
  const nothing = procs.strikeCount === 0 && procs.dispelCount === 0 && procs.poisonDamage.length === 0
  return (
    <Box sx={{ overflow: 'auto', flexGrow: 1, minHeight: 0, minWidth: 0 }}>
      <SlowHeadline procs={procs} isFight={isFight} />
      <SlowRolling slow={slow} />
      <CoatLine coat={procs.coatAtEngage} combat={procs.combatAtEngage} />

      {procs.strikes.length > 0 && (
        <ProcSection title="POISON PROCS">
          {procs.strikes.map((s) => (
            // The slow lane wears the slow hue — it is the lane this whole tab is about.
            <ProcRow key={s.name} lane={s} color={s.name.startsWith('Weakening') ? SLOW_COLOR : POISON_COLOR} />
          ))}
        </ProcSection>
      )}

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

      {nothing && <QuietNote>No procs recorded in this segment.</QuietNote>}
    </Box>
  )
}
