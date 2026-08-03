// LevelingCard — "how fast am I actually progressing, right now", and the way down to the
// Leveling tab.
//
// It shows DELIBERATELY LESS than that tab: no charts, no drag-selected range, no AA accounting,
// no per-zone table. One headline rate over the last hour of LOG time, the two numbers that
// qualify it (kills/hr, active-vs-idle), and — when the log has named a zone — the same pair for
// the camp you are in now. If you want any of the rest, that is what the link is for.
//
// THE HEADLINE IS THE LAST HOUR **OF THE LOG**, not of the wall clock (`overviewLevelingData`
// anchors on `snap.lastTs`). Someone reading this card has usually alt-tabbed out of the game;
// a wall-clock hour would empty itself the moment they stopped playing and report the result as
// a rate. The zone line's "since <time>" is the one clock-shaped thing here, and it states an
// instant the log actually recorded.
//
// AN EM-DASH IS A REAL ANSWER. A null rate renders as '—' and never as '0.00': at the level cap
// the game prints experience lines with no percentage at all, so the window's progress is
// genuinely unknown rather than zero, and the `at cap` chip says which unknown it is. Every
// string on this card is computed in the pure module beside it — the component adds no
// arithmetic of its own, which is what keeps those rules testable.
//
// The words are the feature's words: "levels of progress", never xp; "idle", never AFK.

import type { JSX } from 'react'
import { Button, Chip, Stack, Tooltip, Typography } from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { DashCard, QuietNote } from '../combat/combatShared'
import type { OverviewLevelingState } from './overviewLevelingData'

export interface LevelingCardProps {
  state: OverviewLevelingState
  onOpenLeveling: () => void
}

/** The chip's tooltip: WHY the rate is an em-dash, in the log's own terms. */
const AT_CAP_TITLE =
  'The game prints a level-bar percentage only while a level bar exists, so progress here is unknown — not zero.'

/** `clipped`: the window reaches past the oldest instant the series still holds in full. */
const CLIPPED_TITLE = 'This hour reaches past the oldest samples still held, so it covers a partial record.'

function OpenLeveling({ onOpenLeveling }: { onOpenLeveling: () => void }): JSX.Element {
  return (
    <Button
      size="small"
      data-testid="overview-open-leveling"
      endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
      onClick={onOpenLeveling}
      sx={{ minWidth: 0, py: 0, px: 0.75 }}
    >
      Open Leveling
    </Button>
  )
}

/** The label row: which window this is, plus the chips that qualify it. */
function LevelingChips({ state }: { state: OverviewLevelingState }): JSX.Element {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" data-testid="overview-leveling-window" noWrap>
        Last hour
      </Typography>
      {state.level != null && (
        <Chip size="small" variant="outlined" label={`Level ${state.level}`} sx={{ height: 20 }} />
      )}
      {state.atCap && (
        <Tooltip title={AT_CAP_TITLE}>
          <Chip size="small" color="warning" variant="outlined" label="at cap" sx={{ height: 20 }} />
        </Tooltip>
      )}
      {state.clipped && (
        <Tooltip title={CLIPPED_TITLE}>
          <Chip size="small" variant="outlined" label="partial record" sx={{ height: 20 }} />
        </Tooltip>
      )}
    </Stack>
  )
}

export function LevelingCard({ state, onOpenLeveling }: LevelingCardProps): JSX.Element {
  // The link down is offered even with nothing to show, for the same reason the DPS card offers
  // it: the one affordance this card exists for must not be the least reliable thing on it.
  return (
    <DashCard title="Leveling" testId="overview-leveling" right={<OpenLeveling onOpenLeveling={onOpenLeveling} />}>
      {state.empty ? (
        <QuietNote>
          No progress recorded yet — levels of progress and credited kills appear here as you play.
        </QuietNote>
      ) : (
        <>
          <LevelingChips state={state} />
          <Typography variant="h4" sx={{ color: 'primary.main', lineHeight: 1.15 }} data-testid="overview-leveling-rate">
            {state.rate}
          </Typography>
          <Tooltip title={`${state.kills} credited kills · ${state.idleCaption}`}>
            <Typography variant="caption" color="text.secondary" data-testid="overview-leveling-sub">
              {state.killRate} · {state.activity}
            </Typography>
          </Tooltip>
          {state.zoneLine && (
            <Typography
              variant="caption"
              color="text.secondary"
              data-testid="overview-leveling-zone"
              title={state.zoneLine}
              noWrap
              sx={{ mt: 0.5, minWidth: 0 }}
            >
              {state.zoneLine}
            </Typography>
          )}
        </>
      )}
    </DashCard>
  )
}
