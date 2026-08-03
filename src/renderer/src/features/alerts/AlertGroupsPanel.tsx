// AlertGroupsPanel — the curated one-click alert GROUPS, rendered at the top of the
// suggestions surface (above the per-spell rows).
//
// A group is a small set of alerts that belong together: "Out of range" is the melee notice,
// the spell notice and the line-of-sight notice; "Cast failed" is fizzle, interrupt and
// blocked. One click creates all of them; a partially-created group shows how many it already
// has and the click tops it up. Nothing is deleted here — Undo lives on the created snackbar
// and the alert list.
//
// The catalog itself (with each trigger's VERIFIED log line and the cooldown rationale) is
// shared/alertGroups.ts. Groups whose line does not exist in the real log are `verified:false`
// there and never reach this component.

import type { JSX } from 'react'
import { Box, Button, Chip, Paper, Stack, Tooltip, Typography } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import type { AlertDef } from '@shared/types'
import { VERIFIED_ALERT_GROUPS, alertGroupDefs, type AlertGroup } from '@shared/alertGroups'

/** How many of a group's alerts already exist. */
function createdCount(group: AlertGroup, existingIds: ReadonlySet<string>): number {
  return group.defs.reduce((n, d) => n + (existingIds.has(d.id) ? 1 : 0), 0)
}

function GroupCard({
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
    <Paper variant="outlined" sx={{ p: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
      <Box sx={{ minWidth: 0, flexGrow: 1 }}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
            {group.title}
          </Typography>
          <Chip size="small" variant="outlined" label={`${total} alert${total === 1 ? '' : 's'}`} sx={{ height: 18 }} />
          {have > 0 && !done && (
            <Chip size="small" color="primary" label={`${have} added`} sx={{ height: 18 }} />
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {group.subtitle}
        </Typography>
      </Box>
      <Tooltip title={group.defs.map((d) => `${d.name} — ${d.line}`).join('\n')}>
        <span>
          {done ? (
            <Chip
              size="small"
              icon={<CheckCircleIcon />}
              color="success"
              label="Added"
              disabled
              sx={{ height: 24 }}
            />
          ) : (
            <Button size="small" variant="outlined" onClick={() => onCreate(group, missing)}>
              {have > 0 ? 'Add the rest' : 'Add'}
            </Button>
          )}
        </span>
      </Tooltip>
    </Paper>
  )
}

export default function AlertGroupsPanel({
  existingIds,
  onCreate
}: {
  existingIds: ReadonlySet<string>
  onCreate: (group: AlertGroup, defs: AlertDef[]) => void
}): JSX.Element {
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 0.75 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Ready-made sets
        </Typography>
        <Typography variant="caption" color="text.secondary">
          the things that cost you a pull without saying so
        </Typography>
      </Stack>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 0.75
        }}
      >
        {VERIFIED_ALERT_GROUPS.map((g) => (
          <GroupCard key={g.id} group={g} existingIds={existingIds} onCreate={onCreate} />
        ))}
      </Box>
    </Box>
  )
}
