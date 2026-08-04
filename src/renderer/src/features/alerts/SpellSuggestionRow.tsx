// SpellSuggestionRow — one spell LINE in the suggested-alerts wizard, and the chips it wears.
//
// Split out of SuggestAlertsDialog.tsx when the levelling intelligence (level chip, most-
// recently-cast rank, rank-pinned template chips) pushed that file past the 400-code-line
// factoring ceiling.
//
// COMPACT (docs/plans/suggest-dialog-redesign.md §3, owner: "more compact so things fit on
// screen"). The row is now ONE LINE and never wraps: `flexWrap` turns overflow into HEIGHT
// (AGENTS.md), which is exactly what made the old row two and three lines tall on a spell with
// several classes. So the contract is the compact-bar one — `nowrap`, the NAME is the single
// shrinkable/ellipsizing group, and the controls (template chips) never shrink.
//
// WHAT THE ROW STATES (never process — AGENTS.md UI conventions):
//   * the spell's line name,
//   * its class levels as one chip per class ("ENC 16"), RESOLVED classes first, with the
//     overflow folded into a "+N" chip whose tooltip names the rest. The spell DB has no
//     per-RANK levels at all, so a rank-III row still shows the LINE's level and says so,
//   * the rank you MOST RECENTLY CAST, when the log has shown one,
//   * how often the buffs model has observed the line.
// Buff/debuff is NOT a chip any more: the section header the row sits under states it, except
// in "From your fights", which mixes both — that section passes `showType`.

import { memo, useMemo, type JSX } from 'react'
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import type { SpellCatalogEntry } from '@shared/types'
import type { ClassAbbr } from '@shared/classCombo'
import { preferredRank, type SpellLine } from '@shared/spellLines'
import { RANK_TEMPLATES, SUGGEST_TEMPLATES, suggestionsFor, type Suggestion } from './suggestions'
import { classLevelChips, type ClassLevelChip } from './lineIntel'

/** Everything a row needs beyond the catalog entry itself (line + loadout context). */
export interface RowContext {
  lines: Map<string, SpellLine>
  resolved: ClassAbbr[]
}

/** How many class-level chips a row shows before folding the rest into "+N". */
const MAX_LEVEL_CHIPS = 2

/** Shared geometry for the row's small chips — the whole point of the redesign is density. */
const CHIP_SX = { height: 18, '& .MuiChip-label': { px: 0.6, fontSize: '0.68rem' } } as const

/** Coarse relative-time label for the usage tooltip's "last seen" (Task #45 recency hint). */
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const min = Math.round(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}

/** "ENC 16" — one class's entry level for this LINE. Yours is coloured; the DB fact is the same. */
function LevelChip({ chip }: { chip: ClassLevelChip }): JSX.Element {
  const title = `${chip.cls} learns this spell line at level ${chip.level}${chip.yours ? ' — one of your resolved classes' : ''}. Ranks within a line have no level of their own in the spell database.`
  return (
    <Tooltip title={title}>
      <Chip
        size="small"
        variant="outlined"
        color={chip.yours ? 'primary' : 'default'}
        label={`${chip.cls} ${chip.level}`}
        sx={CHIP_SX}
      />
    </Tooltip>
  )
}

/** The class-level chips, resolved-first, with the overflow named in a "+N" tooltip. */
function LevelChips({ entry, resolved }: { entry: SpellCatalogEntry; resolved: ClassAbbr[] }): JSX.Element | null {
  const chips = useMemo(() => classLevelChips(entry, resolved), [entry, resolved])
  if (chips.length === 0) return null
  const shown = chips.slice(0, MAX_LEVEL_CHIPS)
  const hidden = chips.slice(MAX_LEVEL_CHIPS)
  return (
    <>
      {shown.map((c) => (
        <LevelChip key={c.cls} chip={c} />
      ))}
      {hidden.length > 0 && (
        <Tooltip title={hidden.map((c) => `${c.cls} ${c.level}`).join(' · ')}>
          <Chip size="small" variant="outlined" label={`+${hidden.length}`} sx={CHIP_SX} />
        </Tooltip>
      )}
    </>
  )
}

/** The "N×" badge, with its observed-count + last-seen tooltip. */
function UsageChip({ entry }: { entry: SpellCatalogEntry }): JSX.Element {
  const title = entry.lastSeenMs
    ? `Observed ${entry.usageCount}× · last seen ${relativeTime(entry.lastSeenMs)}`
    : `Observed ${entry.usageCount}× in your log`
  return (
    <Tooltip title={title}>
      <Chip size="small" color="primary" label={`${entry.usageCount}×`} sx={CHIP_SX} />
    </Tooltip>
  )
}

/** The chip caption for one suggestion — rank-pinned templates name the rank they target. */
function chipLabel(s: Suggestion): string {
  if (s.template === 'illusion') return 'When your illusion fades'
  if (s.rank !== undefined && (s.template === 'castRank' || s.template === 'resistRank')) {
    return RANK_TEMPLATES[s.template].chip(s.rank)
  }
  return s.template === 'wearsOff' || s.template === 'fade' || s.template === 'lands'
    ? SUGGEST_TEMPLATES[s.template].chip
    : s.template
}

/** A one-click template chip; renders checked + disabled once the alert exists. */
export function TemplateChip({
  label,
  created,
  onClick
}: {
  label: string
  created: boolean
  onClick: () => void
}): JSX.Element {
  const sx = { height: 20, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }
  if (created) {
    return (
      <Chip
        size="small"
        icon={<CheckCircleIcon />}
        color="success"
        variant="filled"
        label={label}
        disabled
        sx={sx}
      />
    )
  }
  return <Chip size="small" variant="outlined" clickable onClick={onClick} label={label} sx={sx} />
}

/** A single dense spell row: name, class levels, recency/usage, one-click template chips. */
function SpellRow({
  entry,
  existingIds,
  onCreate,
  ctx,
  showType = false
}: {
  entry: SpellCatalogEntry
  existingIds: Set<string>
  onCreate: (s: Suggestion) => void
  ctx: RowContext
  /** state buff/debuff on the row — for "From your fights", which mixes both. */
  showType?: boolean
}): JSX.Element {
  const isDebuff = entry.spellType === 'Detrimental'
  // The rank the one-click chips target: the MOST RECENTLY CAST rank of this line (the owner's
  // rule), falling back to the highest rank known when the line has never been observed.
  const rank = useMemo(() => preferredRank(ctx.lines.get(entry.key)?.ranks ?? []), [ctx.lines, entry.key])
  // Building the AlertDefs is the row's heaviest work, and it depends only on the entry and the
  // rank — so a re-render that changes neither (a parent re-render, a hover) does none of it.
  const suggestions = useMemo(() => suggestionsFor(entry, rank), [entry, rank])
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'nowrap',
        gap: 0.5,
        px: 0.75,
        py: 0.125,
        minHeight: 26,
        borderRadius: 1,
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, flexGrow: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 0 }} noWrap>
          {entry.name}
        </Typography>
        {showType && (
          <Chip
            size="small"
            label={isDebuff ? 'debuff' : 'buff'}
            color={isDebuff ? 'error' : 'success'}
            variant="outlined"
            sx={CHIP_SX}
          />
        )}
        <LevelChips entry={entry} resolved={ctx.resolved} />
        {rank?.lastCastMs != null && (
          <Tooltip title={`You last cast ${rank.name} ${relativeTime(rank.lastCastMs)}`}>
            <Chip
              size="small"
              variant="outlined"
              color="primary"
              label={rank.suffixed ? rank.name : 'recent'}
              sx={CHIP_SX}
            />
          </Tooltip>
        )}
        {entry.usageCount > 0 && <UsageChip entry={entry} />}
      </Box>
      <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
        {suggestions.map((s) => (
          <TemplateChip
            key={s.def.id}
            label={chipLabel(s)}
            created={existingIds.has(s.def.id)}
            onClick={() => onCreate(s)}
          />
        ))}
      </Stack>
    </Box>
  )
}

/**
 * MEMOIZED (shallow compare on the props). The wizard mounts up to MAX_ROWS of these, so a
 * keystroke that leaves a row's entry in the result set must not re-render it. That only holds
 * while the caller keeps `existingIds`, `onCreate` and `ctx` referentially stable — the dialog
 * memoizes all three; a fresh object literal for any of them silently restores the old cost.
 */
export default memo(SpellRow)
