// DropperCell — the kill target for one Plane of Sky quest item ("for our sky tracker, we should
// also show the kill target for each item per eql wiki database", owner), and the quest-level
// "Kill: <boss>" caption the collapsed summary row carries.
//
// Its own file so QuestAccordion stays a layout file: this is the ONE place the resolved droppers
// (poskyDroppers.ts) become words, and every surface that names them — the expanded table's
// "Dropped by" column, the collapsed row's chip tooltip, and now the summary row's caption —
// reads it.
//
// ONE LINE, always. Up to DROPPER_DISPLAY_CAP names inline, the rest folded into "+N more"; the
// hover carries the full roster with level and zone. Sky quest items really do drop from several
// bosses (every Efreeti weapon is Noble Dojorn AND Overseer of Air AND the Hand of Veeshan), so
// the overflow is the normal case, not an edge one.
//
// Nothing resolved ⇒ fall back to what the scrape literally said (`who`, e.g. "random drop — any
// Plane of Sky mob" on the wind runes, which is the honest answer: there is no kill target).
// Neither ⇒ render nothing at all. Never a guess.
//
// The NAMES ARE THE LINK. A resolved dropper is a catalog row (`DropperMob.entry`), which is
// exactly what MobPage wants, so the tracker deep-links straight to it — same `{ mob, entry }`
// payload MobsView's own search results send, so a name that names several pages still lands on
// the one this item's loot list came from. Keyboard-reachable like MobResultRow (role=button,
// tabIndex, Enter/Space) because a table of names that only a mouse can follow is not a link.
// Names stay RAW (law 2) — no title-casing, no article stripping.

import type { JSX } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import {
  dropperDisplay,
  dropperFacts,
  islandOf,
  killTargetFacts,
  killTargetLabel,
  type DropperMob,
  type KillTarget
} from './poskyDroppers'
import type { MobTarget } from '../mobs/mobTarget'

/** The hover roster both surfaces share: every fact the catalog states, one mob per line. */
function DropperRoster({ droppers }: { droppers: readonly DropperMob[] }): JSX.Element {
  return (
    <Box>
      {droppers.map((m) => (
        <Typography key={m.page} variant="caption" display="block">
          {dropperFacts(m)}
        </Typography>
      ))}
    </Box>
  )
}

/** One clickable mob name. `stopPropagation` matters where this sits inside a row that has its
 *  own click (the accordion summary) — opening a mob must never also toggle the panel. */
function DropperName({
  mob,
  onOpenMob
}: {
  mob: DropperMob
  onOpenMob: (t: MobTarget) => void
}): JSX.Element {
  const open = (): void => onOpenMob({ mob: mob.name, entry: mob.entry })
  return (
    <Box
      component="span"
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation()
        open()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        e.stopPropagation()
        open()
      }}
      sx={{
        cursor: 'pointer',
        textDecoration: 'underline dotted',
        textUnderlineOffset: 2,
        '&:hover': { color: 'primary.main' },
        '&:focus-visible': { outline: '1px solid', outlineColor: 'primary.main', borderRadius: 0.5 }
      }}
    >
      {mob.name}
    </Box>
  )
}

export interface DropperCellProps {
  droppers: readonly DropperMob[]
  /** the posky scrape's raw `who` — shown verbatim when nothing resolved to a mob */
  who?: readonly string[]
  /** posky's stated location for this item ("Island 3"); the island rides the VISIBLE line */
  where?: string
  onOpenMob: (t: MobTarget) => void
}

export function DropperCell({ droppers, who, where, onOpenMob }: DropperCellProps): JSX.Element | null {
  // "which mob AND ISLAND, at a top level without needing to mouse over" (owner) — so the island
  // is part of the line, not part of the hover. Absent unless posky states one; "Plane of Sky"
  // (the wind runes' honest "anywhere") states none, and the `who` fallback below already says so.
  const island = islandOf(where)
  if (droppers.length === 0) {
    // No mob resolved: posky's own words, plus its island when it states one. A wind rune's
    // "random drop — any Plane of Sky mob" states none and stays exactly as posky wrote it.
    const stated = (who ?? []).join(', ')
    if (stated === '') return null
    return (
      <Typography variant="caption" color="text.secondary" data-testid="posky-dropper">
        {island ? `${stated} · ${island}` : stated}
      </Typography>
    )
  }
  // Same split `dropperLabel` renders as one string — the names become links one at a time, the
  // overflow stays plain text (there is no single mob for "+2 more" to open).
  const { shown, more } = dropperDisplay(droppers)
  return (
    <Tooltip arrow placement="top" title={<DropperRoster droppers={droppers} />}>
      <Typography variant="caption" color="text.secondary" data-testid="posky-dropper">
        {shown.map((m, i) => (
          <Box component="span" key={m.page}>
            {i > 0 && ', '}
            <DropperName mob={m} onOpenMob={onOpenMob} />
          </Box>
        ))}
        {more > 0 && ` +${more} more`}
        {island && ` · ${island}`}
      </Typography>
    </Tooltip>
  )
}

/**
 * The collapsed quest row's kill target: "Kill: Gorgalosk · Island 3" — the mob standing between
 * you and the items this quest STILL needs, and where those drops are
 * (poskyDroppers.questKillTargets). Nothing to say ⇒ nothing rendered, so a wind-rune quest —
 * whose items are honestly a random drop — stays silent here and lets the item rows carry posky's
 * own wording. The hover carries the full roster, each with its own island.
 */
export function KillTargetCaption({ targets }: { targets: readonly KillTarget[] }): JSX.Element | null {
  const label = killTargetLabel(targets)
  if (label === '') return null
  return (
    <Tooltip
      arrow
      placement="top"
      title={
        <Box>
          {targets.map((t) => (
            <Typography key={t.mob.page} variant="caption" display="block">
              {killTargetFacts(t)}
            </Typography>
          ))}
        </Box>
      }
    >
      <Typography
        variant="caption"
        color="text.secondary"
        display="block"
        data-testid="posky-kill-target"
        sx={{ cursor: 'help' }}
      >
        {label}
      </Typography>
    </Tooltip>
  )
}
