// DpsCard — "how hard am I hitting, right now", and the way down to the Combat tab.
//
// It shows DELIBERATELY LESS than the Combat tab: one label, one headline rate, one supporting
// line, three source rows. No scope toggle, no fight selector, no drill-down, no timeline, no
// Outgoing/Incoming switch, no combat log. If you want any of those, that is what the link is
// for (docs/plans/overview-tab.md §3.1).
//
// THE LABEL IS NOT RE-DERIVED. `fightScopeOptions(...).head.label` is the ONE place the honest
// live/last wording is decided ("Current fight (live)" while a pull is open, "Last fight — <name>"
// between pulls), and the Combat tab's head row reads the same function. A second copy of that
// sentence here is exactly the drift `scopeOptions()` exists to prevent — so this card renders it
// VERBATIM, and the two surfaces can never disagree about whether you are in a fight.
//
// Likewise the SUBJECT: the snapshot is pulled with no `selectedId`, so the engine resolves the
// default (open fight, else the most recent finalized one) — by construction the same fight the
// head row names. That identity is what makes "Open in Combat" land on the fight you were
// looking at, and why the button always sends the LIVE_SELECTION sentinel rather than a pinned
// id: the sentinel re-resolves every tick, so it follows you out of this pull and into the next.

import type { JSX } from 'react'
import { Button, Stack, Typography } from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import type { CombatSnapshot, SegmentView } from '@shared/combat'
import { Bar, DashCard, KIND_COLOR, QuietNote, fmtDur } from '../combat/combatShared'
import { LIVE_SELECTION, fightScopeOptions } from '../combat/dashboardData'
import type { CombatFocus } from '../combat/combatFocus'
import { formatNum, formatRate } from '../../lib/formatRate'

/** How many source rows a GLANCE shows. The meter is one click away. */
const TOP_SOURCES = 3

export interface DpsCardProps {
  snap: CombatSnapshot | null
  onOpenCombat: (f: CombatFocus) => void
}

/** total · duration · active-time DPS — the secondary stat, never the headline (law 7). */
function supportingLine(seg: SegmentView): string {
  return `${formatNum(seg.outTotal)} total · ${fmtDur(seg.durationSec)} · ${formatRate(seg.activeDps)} active`
}

function OpenInCombat({ onOpenCombat }: { onOpenCombat: (f: CombatFocus) => void }): JSX.Element {
  return (
    <Button
      size="small"
      data-testid="overview-open-combat"
      endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
      onClick={() => onOpenCombat({ scope: 'fight', selection: LIVE_SELECTION })}
      sx={{ minWidth: 0, py: 0, px: 0.75 }}
    >
      Open in Combat
    </Button>
  )
}

export function DpsCard({ snap, onOpenCombat }: DpsCardProps): JSX.Element {
  const head = fightScopeOptions(snap?.segments ?? []).head
  const seg = snap?.selected ?? null

  return (
    // The link down is offered even with nothing to show: "there are no fights" is a thing the
    // Combat tab says better than a glance card can, and a disappearing button would make the
    // one affordance this card exists for the least reliable thing on it.
    <DashCard title="Damage" testId="overview-dps" right={<OpenInCombat onOpenCombat={onOpenCombat} />}>
      {/* No fights at all ⇒ the same honest quiet state the Combat tab shows. It never borrows
          the zone aggregate to look busy — Overall is a click away and says so there. */}
      {!head || !seg ? (
        <QuietNote>No fights yet — engage something and it’ll appear here.</QuietNote>
      ) : (
        <>
          <Typography variant="caption" color="text.secondary" data-testid="overview-dps-label" noWrap>
            {head.label}
          </Typography>
          <Typography variant="h4" sx={{ color: 'primary.main', lineHeight: 1.15 }} data-testid="overview-dps-value">
            {formatRate(seg.outDps)}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mb: 0.75 }}>
            {supportingLine(seg)}
          </Typography>
          <Stack sx={{ minWidth: 0 }}>
            {seg.entities.slice(0, TOP_SOURCES).map((e, i) => (
              <Bar
                key={e.id}
                color={KIND_COLOR[e.kind] ?? '#888'}
                pct={e.pct}
                rank={i + 1}
                name={e.name}
                right={formatRate(e.dps)}
              />
            ))}
            {seg.entities.length === 0 && <QuietNote>Nothing has landed in this fight yet.</QuietNote>}
          </Stack>
        </>
      )}
    </DashCard>
  )
}
