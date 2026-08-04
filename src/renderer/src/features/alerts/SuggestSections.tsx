// SuggestSections — the slim sticky section header and the row list under it.
//
// docs/plans/suggest-dialog-redesign.md §2/§3: sections are HEADERS, not cards. A card per
// group costs a border, two paddings and a shadow per group, which is most of the vertical
// budget the redesign is trying to give back to rows. So a section is one slim sticky bar
// (title · count · an optional inline action) over a plain row list.
//
// STICKY, because the list scrolls inside the dialog's fixed-height paper (the perf fix's
// geometry): with four spell sections in one scroll box, the header that names what you are
// looking at has to stay on screen while you scroll through it.

import type { JSX, ReactNode } from 'react'
import { Box, Chip, Stack, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import type { SpellCatalogEntry } from '@shared/types'
import SpellRow, { type RowContext } from './SpellSuggestionRow'
import type { Suggestion } from './suggestions'

/**
 * One collapsible section. `count` is the TRUE match count, so a collapsed or truncated
 * section still says how much is behind it.
 *
 * `open` is not the same thing as "the user expanded it": a live search forces every matching
 * section open (§2), because a hit hidden behind a collapsed header reads as no hit at all.
 */
export function SectionShell({
  title,
  count,
  open,
  onToggle,
  action,
  children
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  /** an inline control that belongs to the section itself (the shared illusion alert). */
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <Box>
      <Stack
        direction="row"
        spacing={0.75}
        alignItems="center"
        onClick={onToggle}
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
          px: 0.5,
          py: 0.25,
          cursor: 'pointer',
          userSelect: 'none',
          '&:hover': { bgcolor: 'action.hover' }
        }}
      >
        {open ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
        <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: 0.4 }}>
          {title.toUpperCase()}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {count}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        {/* The action is the section's own control — clicking it must not fold the section. */}
        {action && <Box onClick={(e) => e.stopPropagation()}>{action}</Box>}
      </Stack>
      {open && <Box sx={{ pt: 0.25 }}>{children}</Box>}
    </Box>
  )
}

/**
 * The rows of one section, plus the honest tail when the shared row budget cut it short
 * (resultSections.ts): saying "+N more" is the difference between a bounded list and a list
 * that quietly lies about what matched.
 */
export function SpellRows({
  rows,
  total,
  existingIds,
  onCreate,
  ctx,
  showType
}: {
  rows: SpellCatalogEntry[]
  total: number
  existingIds: Set<string>
  onCreate: (s: Suggestion) => void
  ctx: RowContext
  showType?: boolean
}): JSX.Element {
  return (
    <>
      {rows.map((e) => (
        <SpellRow
          key={e.key}
          entry={e}
          existingIds={existingIds}
          onCreate={onCreate}
          ctx={ctx}
          showType={showType}
        />
      ))}
      {total > rows.length && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1, py: 0.5 }}>
          +{total - rows.length} more — keep typing to narrow it down.
        </Typography>
      )}
    </>
  )
}

/** The shared illusion alert, offered as the Illusions section's own inline action. */
export function IllusionAction({
  created,
  onCreate
}: {
  created: boolean
  onCreate: () => void
}): JSX.Element {
  return (
    <Chip
      size="small"
      variant={created ? 'filled' : 'outlined'}
      color={created ? 'success' : 'default'}
      clickable={!created}
      disabled={created}
      onClick={onCreate}
      label="When your illusion fades"
      sx={{ height: 20, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }}
    />
  )
}
