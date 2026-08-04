// AlertGroupsPanel — the curated one-click alert GROUPS, as one dense row of chips.
//
// A group is a small set of alerts that belong together: "Out of range" is the melee notice,
// the spell notice and the line-of-sight notice; "Cast failed" is fizzle, interrupt and
// blocked. One click creates all of them; a partially-created group shows how many it already
// has and the click tops it up. Nothing is deleted here — Undo lives on the created snackbar
// and the alert list.
//
// COMPACTED (docs/plans/suggest-dialog-redesign.md §2.2): this used to be a two-column grid of
// outlined cards, each with a title, a subtitle line, a count chip and a button — six cards
// deep enough to push the actual spell list below the fold. The information a card carried is
// the same information a chip carries (`title · have/total`) plus a subtitle that is now the
// chip's tooltip, so the panel is one wrapping chip row. The CLICK is untouched: it creates
// exactly the defs the group is missing, and never re-writes one the user already has.

import type { JSX } from 'react'
import { Chip, Stack, Tooltip } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import type { AlertDef } from '@shared/types'
import { alertGroupDefs, type AlertGroup } from '@shared/alertGroups'

/** How many of a group's alerts already exist. */
function createdCount(group: AlertGroup, existingIds: ReadonlySet<string>): number {
  return group.defs.reduce((n, d) => n + (existingIds.has(d.id) ? 1 : 0), 0)
}

/** The chip's tooltip: what the set is for, then every alert it would author. */
function groupTooltip(group: AlertGroup): string {
  return [group.subtitle, ...group.defs.map((d) => `${d.name} — ${d.line}`)].join('\n')
}

function GroupChip({
  group,
  existingIds,
  onCreate
}: {
  group: AlertGroup
  existingIds: ReadonlySet<string>
  onCreate: (group: AlertGroup, defs: AlertDef[]) => void
}): JSX.Element {
  const have = createdCount(group, existingIds)
  const total = group.defs.length
  const done = have === total
  // Top-up only: an alert the user already has is never re-written by a group click.
  const missing = alertGroupDefs(group).filter((d) => !existingIds.has(d.id))
  return (
    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{groupTooltip(group)}</span>}>
      {/* The span is load-bearing: a DISABLED child fires no events, so MUI warns (and the
          tooltip dies) unless something enabled sits between it and the Tooltip. */}
      <span>
        <Chip
          size="small"
          variant={done ? 'filled' : 'outlined'}
          color={done ? 'success' : have > 0 ? 'primary' : 'default'}
          icon={done ? <CheckCircleIcon /> : undefined}
          clickable={!done}
          disabled={done}
          onClick={() => onCreate(group, missing)}
          label={done ? group.title : `${group.title} · ${have}/${total}`}
          sx={{ height: 22, '& .MuiChip-label': { px: 0.75, fontSize: '0.72rem' } }}
        />
      </span>
    </Tooltip>
  )
}

export default function AlertGroupsPanel({
  groups,
  existingIds,
  onCreate
}: {
  /** the sets to show — the dialog narrows them with the search box (suggestResults.ts). */
  groups: readonly AlertGroup[]
  existingIds: ReadonlySet<string>
  onCreate: (group: AlertGroup, defs: AlertDef[]) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ px: 0.5, py: 0.25 }}>
      {groups.map((g) => (
        <GroupChip key={g.id} group={g} existingIds={existingIds} onCreate={onCreate} />
      ))}
    </Stack>
  )
}
