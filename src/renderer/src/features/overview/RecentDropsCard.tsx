// RecentDropsCard — the newest loot, with the things that matter marked.
//
// FIXED HEIGHT IS A CONTRACT, not styling (AGENTS.md — "a growing list lives in a FIXED-height
// scroll box"). The combat log once sized itself to its 150-line content, couldn't shrink, and
// squeezed the whole dashboard to 0px; an append-only feed on a glance surface is the same bug
// waiting to happen. So the list gets an explicit height and its OWN `overflow: auto`, and the
// e2e harness measures it.
//
// NOT GATED ON HYDRATION, deliberately (docs/plans/overview-tab.md §4). The Now row is, because
// during the startup replay every combat snapshot describes the past. This card is explicitly a
// HISTORY surface: the loot module's snapshot is complete and correct during the replay, so a
// spinner over a list of real past drops would be a lie in the other direction.
//
// ICONS COME FROM THE PERMANENT CACHE. `itemIconUrl()` is the ONE renderer entry point and it
// yields `eqimg://item/<id>`; `img-src` in index.html is exactly `'self' data: eqimg:` so a raw
// https `<img>` would fail visibly instead of silently bypassing the cache. Negatives are never
// cached, so the `onError` hides the icon and the next load retries. Items known only from the
// local posky dataset have no `iconId` at all — the row renders without one rather than
// fabricating a placeholder id.

import { type JSX, useState } from 'react'
import { Box, Stack, Typography } from '@mui/material'
import { DashCard, QuietNote } from '../combat/combatShared'
import { KnownItemTooltip } from '../../lib/KnownItemTooltip'
import { itemIconUrl } from '../../lib/ItemWindow'
import { formatTime } from '../../lib/formatDate'
import type { DropRow } from './overviewData'

/** The scroll box's height. Explicit, and the panel's whole size contract. */
const FEED_HEIGHT = 258

const ICON_PX = 18

export interface RecentDropsCardProps {
  rows: DropRow[]
  onOpenLoot: () => void
}

/** The item icon, or nothing. A 404 hides it (negatives are never cached — the next load retries). */
function DropIcon({ iconId }: { iconId?: number }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (iconId == null || failed) return <Box sx={{ width: ICON_PX, flexShrink: 0 }} />
  return (
    <Box
      component="img"
      src={itemIconUrl(iconId)}
      alt=""
      onError={() => setFailed(true)}
      sx={{ width: ICON_PX, height: ICON_PX, flexShrink: 0, imageRendering: 'pixelated' }}
    />
  )
}

/** `a sand giant · Plane of Sky` — whatever the loot line actually named, nothing invented. */
function provenance(row: DropRow): string {
  return [row.source, row.zone].filter((s): s is string => !!s).join(' · ')
}

function Row({ row, onOpenLoot }: { row: DropRow; onOpenLoot: () => void }): JSX.Element {
  return (
    <KnownItemTooltip name={row.item} knowledge={row.knowledge}>
      <Stack
        direction="row"
        spacing={0.75}
        alignItems="center"
        role="button"
        tabIndex={0}
        data-testid="overview-drop-row"
        onClick={onOpenLoot}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onOpenLoot()
        }}
        sx={{
          minWidth: 0,
          py: 0.3,
          px: 0.5,
          borderRadius: 0.5,
          cursor: 'pointer',
          // The highlight is a LEFT STRIPE plus a tint, not a colour on the name: the name has to
          // stay readable as an item name, and a tint alone is invisible against a busy row.
          ...(row.highlighted
            ? { bgcolor: 'action.hover', borderLeft: 3, borderColor: 'secondary.main', pl: 0.25 }
            : { borderLeft: 3, borderColor: 'transparent', pl: 0.25 }),
          '&:hover': { bgcolor: 'action.selected' }
        }}
      >
        <DropIcon iconId={row.knowledge?.iconId} />
        <Typography variant="caption" noWrap sx={{ fontWeight: row.highlighted ? 700 : 400, minWidth: 0 }}>
          {row.count != null && row.count > 1 && `${String(row.count)}× `}
          {row.item}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 1, minWidth: 0 }}>
          {provenance(row)}
        </Typography>
        <Typography variant="caption" color="text.disabled" sx={{ flexShrink: 0 }}>
          {formatTime(row.ts)}
        </Typography>
      </Stack>
    </KnownItemTooltip>
  )
}

export function RecentDropsCard({ rows, onOpenLoot }: RecentDropsCardProps): JSX.Element {
  return (
    <DashCard
      title="Recent drops"
      right={
        <Typography
          variant="caption"
          role="button"
          tabIndex={0}
          onClick={onOpenLoot}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onOpenLoot()
          }}
          sx={{ color: 'primary.main', cursor: 'pointer', flexShrink: 0 }}
        >
          All loot
        </Typography>
      }
    >
      <Box data-testid="overview-drops" sx={{ height: FEED_HEIGHT, overflow: 'auto', minWidth: 0 }}>
        {rows.length === 0 ? (
          <QuietNote>Nothing looted yet — drops land here as you pick them up.</QuietNote>
        ) : (
          rows.map((row) =>
            row.highlighted ? (
              // The highlight marker is its own node so an assertion can count highlighted rows
              // without parsing style: the row itself keeps the plain `overview-drop-row` id.
              <Box key={row.id} data-testid="overview-drop-highlight">
                <Row row={row} onOpenLoot={onOpenLoot} />
              </Box>
            ) : (
              <Row key={row.id} row={row} onOpenLoot={onOpenLoot} />
            )
          )
        )}
      </Box>
    </DashCard>
  )
}
