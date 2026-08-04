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
// The words are the feature's words: "levels of progress", never xp; "idle", never AFK. And
// "offline" ONLY when the log said so: the hour can contain a logout (the card's window is an
// hour of LOG time, so coming back at 13:00 after camping at 02:52 puts most of an empty chair
// inside it), and when a login line closes one, a chip states it and every rate on the card
// divides by the ONLINE part of the hour. A logout still in progress has no login line yet, so
// it cannot be seen at all and its silence stays idle — the chip's tooltip says that too.
//
// THE PROJECTION LINE IS ALWAYS THERE, and it is an em-dash when it has to be. "~2h 10m to
// level 44" is the answer this card was asked for, so its absence must be visible and
// explainable rather than a line that quietly does not render: the game states a percentage per
// experience gain and never your position in the bar, so without an observed level-up — or with
// an at-cap line anywhere since one — how far into the bar you are is genuinely unknown. Both
// the estimate and the refusal carry the same tooltip slot, and it always says why.
//
// The `~` is not decoration. This projects ONE hour of your play forward and assumes it repeats:
// same mobs, same camp, same share of medding. It is not a countdown to a known instant, and
// past a day it stops pretending to minutes and says '>1 day at this pace'.

import type { JSX } from 'react'
import { Button, Chip, Stack, Tooltip, Typography } from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import { DashCard, QuietNote } from '../combat/combatShared'
import { OFFLINE_TITLE } from '../leveling/rangeStatsRows'
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
      // Same line box as the DPS card's button, and for the same reason: a small Button's default
      // 1.75 line-height makes a card WITH an action 3px taller in the header than one without,
      // which would start the NOW rank's four bodies on different baselines.
      sx={{ minWidth: 0, py: 0, px: 0.75, lineHeight: 1.4 }}
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
      {/* Only ever present when a login line CLOSED a logout inside the hour. Silence the log
          has not explained is idle, not offline, and carries no chip at all. */}
      {state.offline && (
        <Tooltip title={OFFLINE_TITLE}>
          <Chip size="small" variant="outlined" label={state.offline} sx={{ height: 20 }} />
        </Tooltip>
      )}
    </Stack>
  )
}

/** What the estimate line reads when the evidence cannot support one. The tooltip says which
 *  hole caused it — an em-dash is a real answer here, exactly as it is for the rate above. */
const NO_ETA = '— no next-level estimate'

/**
 * The projection and the levels behind it: "~2h 10m to level 44", then "lvl 41→42 13.9h ·
 * 42→43 1.0h · ahead of your recent pace". The history line is omitted entirely when this run
 * holds no completed level — there is nothing to compare against and a placeholder would only
 * claim otherwise.
 */
function LevelingProjection({ state }: { state: OverviewLevelingState }): JSX.Element {
  return (
    <>
      <Tooltip title={state.etaTitle}>
        <Typography
          variant="body2"
          color={state.eta ? 'text.primary' : 'text.secondary'}
          data-testid="overview-leveling-eta"
          sx={{ mt: 0.5, minWidth: 0 }}
        >
          {state.eta ?? NO_ETA}
        </Typography>
      </Tooltip>
      {state.history && (
        <Tooltip title={state.historyTitle}>
          <Typography
            variant="caption"
            color="text.secondary"
            data-testid="overview-leveling-history"
            sx={{ minWidth: 0 }}
          >
            {state.verdict ? `${state.history} · ${state.verdict}` : state.history}
          </Typography>
        </Tooltip>
      )}
    </>
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
          <LevelingProjection state={state} />
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
          {state.zoneCompare && (
            <Typography
              variant="caption"
              color="text.secondary"
              data-testid="overview-leveling-zone-compare"
              title={state.zoneCompare}
              noWrap
              sx={{ minWidth: 0 }}
            >
              {state.zoneCompare}
            </Typography>
          )}
        </>
      )}
    </DashCard>
  )
}
