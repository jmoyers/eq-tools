// CurrentMobCard — the mob in front of you, and what it drops.
//
// IDENTITY comes from `CombatSnapshot.currentTarget` (world-model law 6's LIVE naming half),
// exposed as a FACT rather than parsed back out of the composed encounter name. Between pulls the
// card says "Last target — X" instead of pretending you are still fighting: the same honesty rule
// the fight head row follows, and the reason `live` is read from `segments`, not from a guess
// about how recent `lastTs` is.
//
// WHAT IT DELIBERATELY DOES NOT SAY (owner decision, 2026-08-03): no con colour, no difficulty
// classification. A con verdict is a statement about the gap between your level and the mob's ON
// THE DAY YOU CONNED IT, and it is wrong the moment you ding. The DURABLE facts are the mob's
// NAME and its LEVEL — so that is all consider-seeded data ever contributes here, exactly as
// RecentlyConsidered was changed to do.
//
// EMPTY STATES ARE NOT DECORATION (law 1). "Still looking up", "no wiki page", "offline" and "the
// page lists no loot" are FOUR different facts and are never collapsed into "no drops". This card
// renders a leaner row set than MobPage — no rarity column, no per-item drill-down, no
// also-looted-by-you section — but it keeps those distinctions intact, because they are the
// difference between a claim and an absence of one.

import type { JSX } from 'react'
import { Box, Chip, CircularProgress, Stack, Typography } from '@mui/material'
import type { MobKnowledge } from '@shared/types'
import { DashCard, QuietNote } from '../combat/combatShared'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import type { MobTarget } from '../mobs/mobTarget'
import type { CurrentMobState } from './useCurrentMob'

/** Drop rows before the "+N more" hands off to the mob page. */
const DROPS_SHOWN = 8

/** The drop list is a growing list, so it lives in a FIXED-height scroll box (AGENTS.md). */
const DROPS_BOX_HEIGHT = 150

export interface CurrentMobCardProps {
  state: CurrentMobState
  onOpenMob: (t: MobTarget) => void
}

/** Level + home zone AS THE SOURCE STATES THEM — a range as often as a number, hence text. */
function LevelZone({ k }: { k?: MobKnowledge }): JSX.Element | null {
  // Falsiness, not nullishness: an empty string from the page says nothing.
  if (!k?.levelText && !k?.zone) return null
  return (
    <Typography variant="caption" color="text.secondary" noWrap>
      {k.levelText && `level ${k.levelText}`}
      {k.levelText && k.zone && ' · '}
      {k.zone}
    </Typography>
  )
}

/** The four distinct honest answers to "why is the drop list empty". */
function DropsEmpty({ state }: { state: CurrentMobState }): JSX.Element {
  const { knowledge, loading } = state
  if (loading && !knowledge) {
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary' }}>
        <CircularProgress size={13} thickness={5} />
        <Typography variant="caption">Looking up this mob…</Typography>
      </Stack>
    )
  }
  if (knowledge?.notFound) return <QuietNote>No wiki page for this mob.</QuietNote>
  if (knowledge?.offline) return <QuietNote>Offline — showing only what’s known locally.</QuietNote>
  if (knowledge?.page) return <QuietNote>The wiki page for this mob lists no loot.</QuietNote>
  return <QuietNote>Nothing known about this one yet.</QuietNote>
}

/** The drop list: the wiki table leads (it is the definitive statement), capped, then "+N more". */
function DropList({ state, onOpen }: { state: CurrentMobState; onOpen: () => void }): JSX.Element {
  const wiki = state.knowledge?.dropsWiki ?? []
  const seenByKey = new Map((state.knowledge?.dropsSeen ?? []).map((d) => [d.item.toLowerCase(), d]))
  return (
    <Box sx={{ height: DROPS_BOX_HEIGHT, overflow: 'auto', minWidth: 0 }}>
      {wiki.length === 0 ? (
        <DropsEmpty state={state} />
      ) : (
        <>
          {wiki.slice(0, DROPS_SHOWN).map((d) => {
            const seen = seenByKey.get(d.item.toLowerCase())
            return (
              <KnownItemTooltip key={d.item} name={d.item}>
                <Stack direction="row" spacing={1} alignItems="baseline" sx={{ py: 0.15, minWidth: 0 }}>
                  <Typography variant="caption" noWrap sx={{ minWidth: 0 }}>
                    {d.item}
                  </Typography>
                  <Box sx={{ flexGrow: 1 }} />
                  {seen && (
                    <Typography variant="caption" sx={{ color: 'success.main', flexShrink: 0 }}>
                      {seen.count}× yours
                    </Typography>
                  )}
                </Stack>
              </KnownItemTooltip>
            )
          })}
          {wiki.length > DROPS_SHOWN && (
            <Typography
              variant="caption"
              role="button"
              tabIndex={0}
              onClick={onOpen}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onOpen()
              }}
              sx={{ display: 'block', mt: 0.25, color: 'primary.main', cursor: 'pointer' }}
            >
              +{wiki.length - DROPS_SHOWN} more
            </Typography>
          )}
        </>
      )}
    </Box>
  )
}

export function CurrentMobCard({ state, onOpenMob }: CurrentMobCardProps): JSX.Element {
  const { target, live, knowledge } = state
  // Everything we already hold travels with the route, so the mob page paints instantly and its
  // own refresh is usually free (MobTarget.seed — the same contract the consider rows use).
  const open = (): void => {
    if (target) onOpenMob(knowledge ? { mob: target.name, seed: knowledge } : { mob: target.name })
  }

  return (
    <DashCard title="Target" testId="overview-mob">
      {!target ? (
        <QuietNote>
          Nothing engaged — the mob you swing at appears here as soon as a hit lands.
        </QuietNote>
      ) : (
        <>
          <Stack direction="row" spacing={0.75} alignItems="baseline" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
            {!live && (
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                Last target —
              </Typography>
            )}
            <Typography
              variant="subtitle1"
              role="button"
              tabIndex={0}
              data-testid="overview-mob-name"
              onClick={open}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') open()
              }}
              sx={{
                fontWeight: 600,
                minWidth: 0,
                cursor: 'pointer',
                textDecoration: 'underline dotted',
                textUnderlineOffset: 3,
                '&:hover': { color: 'primary.main' }
              }}
            >
              {target.name}
            </Typography>
            {/* The encounter's OTHER engaged targets — the '+N' the fight name carries. */}
            {target.others > 0 && (
              <Chip size="small" variant="outlined" label={`+${target.others}`} sx={{ height: 20 }} />
            )}
            {live && <Chip size="small" color="primary" label="live" sx={{ height: 20 }} />}
          </Stack>
          <LevelZone k={knowledge} />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, mb: 0.25 }}>
            Drops
          </Typography>
          <DropList state={state} onOpen={open} />
        </>
      )}
    </DashCard>
  )
}
