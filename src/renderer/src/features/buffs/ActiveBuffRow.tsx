// ActiveBuffRow — ONE live buff, as a card: what it is, how long it's been up, and how much
// longer it is estimated to last. Split out of BuffsView because the countdown carries the
// whole of world-model law 1 for this feature: every number here is either message-driven or
// LABELED as an estimate, and an unknown duration says "unknown duration" rather than
// drawing a fake bar.

import type { JSX } from 'react'
import { Box, Chip, LinearProgress, Paper, Stack, Tooltip, Typography } from '@mui/material'
import type { ActiveBuff } from '@shared/types'
import { fmtDuration, remainingFraction, isOverdue, classAccent } from './format'

/** Everything the countdown bar needs, resolved once so nothing downstream re-derives it. */
interface EstimateState {
  /** the estimated duration when we HAVE one (>0), else null — the whole bar hinges on it */
  est: number | null
  /** ± spread from the p25/p75 IQR around the estimate */
  spread: number | null
  overdue: boolean
}

/**
 * Overdue (Task #30 + #34): run past the estimated window → show "past estimate" instead
 * of a bottomed-out countdown. For mined estimates this needs n≥2 past p75; for a DB
 * (authoritative) estimate, being past the DB duration itself is enough (expiry is now
 * message-driven, so a DB buff sits "past estimate" until its wear-off line lands).
 */
function estimateState(buff: ActiveBuff, elapsed: number): EstimateState {
  const est = buff.estimatedMs != null && buff.estimatedMs > 0 ? buff.estimatedMs : null
  const spread = buff.p25 != null && buff.p75 != null ? (buff.p75 - buff.p25) / 2 : null
  const overdue =
    isOverdue(elapsed, buff.p75, buff.n) ||
    (buff.durationSource === 'db' && buff.estimatedMs != null && elapsed > buff.estimatedMs)
  return { est, spread, overdue }
}

/**
 * Permanent illusion (Task #34): a full, steady bar and an explicit label — no countdown,
 * because a self-cast illusion under the Permanent Illusion AA never fades.
 */
function PermanentBar(): JSX.Element {
  return (
    <>
      <LinearProgress
        variant="determinate"
        value={100}
        sx={{ height: 8, borderRadius: 1, '& .MuiLinearProgress-bar': { bgcolor: 'warning.main' } }}
      />
      <Typography variant="caption" color="warning.main">
        permanent · illusion AA
      </Typography>
    </>
  )
}

/** No estimate at all — an indeterminate bar that says so rather than faking a countdown. */
function UnknownBar(): JSX.Element {
  return (
    <>
      <LinearProgress variant="indeterminate" sx={{ height: 8, borderRadius: 1, opacity: 0.5 }} />
      <Typography variant="caption" color="text.disabled">
        unknown duration
      </Typography>
    </>
  )
}

/** The estimated-remaining bar plus its caption: time left (or "past estimate"), ±, source, n. */
function EstimateBar({
  est,
  elapsed,
  state,
  buff
}: {
  est: number
  elapsed: number
  state: EstimateState
  buff: ActiveBuff
}): JSX.Element {
  const remaining = Math.max(0, est - elapsed)
  const frac = remainingFraction(elapsed, est)
  const { overdue, spread } = state
  // Estimate provenance (Task #34): 'db' (authoritative wiki duration) vs 'observed'
  // (recency-weighted max of mined samples). Shown as a small chip on the bar caption.
  const source = buff.durationSource
  return (
    <>
      <LinearProgress
        variant="determinate"
        value={frac * 100}
        sx={{
          height: 8,
          borderRadius: 1,
          // Fade toward warning as the estimated window empties / runs overdue.
          '& .MuiLinearProgress-bar': {
            bgcolor: overdue || frac < 0.2 ? 'warning.main' : 'primary.main'
          }
        }}
      />
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="caption" color={overdue ? 'warning.main' : 'text.secondary'}>
          {overdue ? 'past estimate' : `~${fmtDuration(remaining)} left`}
          {!overdue && spread != null && spread > 1000 ? ` (± ${fmtDuration(spread)})` : ''}
        </Typography>
        <Stack direction="row" spacing={0.5} alignItems="center">
          {source && (
            <Tooltip
              title={
                source === 'db'
                  ? 'Duration from the spell database (authoritative wiki value).'
                  : 'Duration estimated from observed casts (recency-weighted max of samples).'
              }
            >
              <Chip
                size="small"
                label={source === 'db' ? 'db' : 'observed'}
                variant="outlined"
                sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
              />
            </Tooltip>
          )}
          <Typography variant="caption" color="text.disabled">
            n={buff.n}
          </Typography>
        </Stack>
      </Stack>
    </>
  )
}

/** One active-buff row: name, elapsed, estimated remaining bar, ± spread, n. */
export function ActiveRow({ buff, now }: { buff: ActiveBuff; now: number }): JSX.Element {
  const elapsed = Math.max(0, now - buff.startedTs)
  const state = estimateState(buff, elapsed)
  // Provisional (Task #30): shown optimistically the instant we saw the cast begin,
  // before the land timeout confirms it. Dim the row + show a "casting…" hint.
  const provisional = buff.provisional === true

  // Debuff target is INFERRED (castBegin carries no target) — surface it honestly as a
  // "target: inferred" chip, never a silent guess (Task #32 rule 5c).
  const inferred = buff.inferredTarget === true

  // Permanent illusion (Task #34): a self-cast illusion buff while the Permanent Illusion
  // AA is owned lasts forever — no countdown, an explicit "permanent · illusion AA" state.
  const permanent = buff.permanent === true

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        opacity: provisional ? 0.6 : 1,
        borderStyle: provisional ? 'dashed' : 'solid',
        // Class accent: red-ish left border for debuffs, green for pet, gold for self.
        borderLeft: '3px solid',
        borderLeftColor: classAccent(buff.cls)
      }}
    >
      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {buff.spell}
        </Typography>
        {inferred ? (
          <Tooltip title="Target inferred from the pet's current fight target — castBegin carries no target, so this is a best guess, not a confirmed target.">
            <Chip
              size="small"
              label={buff.target ? `target: ${buff.target} (inferred)` : 'target: inferred'}
              variant="outlined"
              color="warning"
              sx={{ height: 18, fontSize: 11, maxWidth: 180, '& .MuiChip-label': { px: 0.75 } }}
            />
          </Tooltip>
        ) : null}
        {provisional && (
          <Chip
            size="small"
            label="casting…"
            variant="outlined"
            color="info"
            sx={{ height: 18, fontSize: 11 }}
          />
        )}
        {buff.messageDriven && !provisional && (
          <Tooltip title="Confirmed by an exact chat message (its landing/heal line), not inferred from cast timing.">
            <Chip
              size="small"
              label="message"
              variant="outlined"
              color="success"
              sx={{ height: 18, fontSize: 11 }}
            />
          </Tooltip>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary">
          {fmtDuration(elapsed)} elapsed
        </Typography>
      </Stack>

      {permanent ? (
        <PermanentBar />
      ) : state.est !== null ? (
        <EstimateBar est={state.est} elapsed={elapsed} state={state} buff={buff} />
      ) : (
        <UnknownBar />
      )}
    </Paper>
  )
}
