// SpellSuggestionRow — one spell LINE in the suggested-alerts wizard, and the chips it wears.
//
// Split out of SuggestAlertsDialog.tsx when the levelling intelligence (level chip, most-
// recently-cast rank, rank-pinned template chips) pushed that file past the 400-code-line
// factoring ceiling. Behaviour is unchanged for everything that existed before.
//
// WHAT THE ROW STATES (never process — AGENTS.md UI conventions):
//   * the spell's line name, and buff/debuff,
//   * the LINE's class level ("ENC 16"), or the minimum across candidates when the loadout is
//     not resolved. The spell DB has no per-RANK levels at all, so a rank-III row still shows
//     the line's level and the tooltip says exactly that,
//   * the rank you MOST RECENTLY CAST, when the log has shown one,
//   * how often the buffs model has observed the line.

import type { JSX } from 'react'
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import type { SpellCatalogEntry } from '@shared/types'
import type { ClassAbbr } from '@shared/classCombo'
import { preferredRank, type LineLevel, type SpellLine } from '@shared/spellLines'
import { RANK_TEMPLATES, SUGGEST_TEMPLATES, suggestionsFor, type Suggestion } from './suggestions'
import { levelFor } from './lineIntel'

/** Everything a row needs beyond the catalog entry itself (line + loadout context). */
export interface RowContext {
  lines: Map<string, SpellLine>
  resolved: ClassAbbr[]
}

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

/**
 * The LEVEL chip. It states the level of the spell LINE for the class that learns it. When the
 * loadout is ambiguous, or none of the resolved classes casts the line, it shows the MINIMUM
 * across candidate classes and says "min" rather than claiming a class (world-model law 1).
 */
function LevelChip({ level }: { level: LineLevel }): JSX.Element {
  const label = level.cls ? `${level.cls} ${level.level}` : `min lvl ${level.level}`
  const title = level.ambiguous
    ? "Earliest level any class that casts this line gets it. Your loadout isn't resolved, so this isn't necessarily yours."
    : `${level.cls} learns this spell line at level ${level.level}. Ranks within a line have no level of their own in the spell database.`
  return (
    <Tooltip title={title}>
      <Chip size="small" variant="outlined" label={label} sx={{ height: 20 }} />
    </Tooltip>
  )
}

/** The "used N×" badge, with its observed-count + last-seen tooltip. */
function UsageChip({ entry }: { entry: SpellCatalogEntry }): JSX.Element {
  const title = entry.lastSeenMs
    ? `Observed ${entry.usageCount}× · last seen ${relativeTime(entry.lastSeenMs)}`
    : `Observed ${entry.usageCount}× in your log`
  return (
    <Tooltip title={title}>
      <Chip size="small" color="primary" label={`used ${entry.usageCount}×`} sx={{ height: 20 }} />
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
  if (created) {
    return (
      <Chip
        size="small"
        icon={<CheckCircleIcon />}
        color="success"
        variant="filled"
        label={label}
        disabled
        sx={{ height: 24 }}
      />
    )
  }
  return <Chip size="small" variant="outlined" clickable onClick={onClick} label={label} sx={{ height: 24 }} />
}

/** A single spell row: name, level, buff/debuff + illusion chips, template chips, usage badge. */
export default function SpellRow({
  entry,
  existingIds,
  onCreate,
  ctx
}: {
  entry: SpellCatalogEntry
  existingIds: Set<string>
  onCreate: (s: Suggestion) => void
  ctx: RowContext
}): JSX.Element {
  const isDebuff = entry.spellType === 'Detrimental'
  // The rank the one-click chips target: the MOST RECENTLY CAST rank of this line (the owner's
  // rule), falling back to the highest rank known when the line has never been observed.
  const rank = preferredRank(ctx.lines.get(entry.key)?.ranks ?? [])
  const level = levelFor(entry, ctx.resolved)
  const suggestions = suggestionsFor(entry, rank)
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        flexWrap: 'wrap',
        px: 1,
        py: 0.5,
        borderRadius: 1,
        '&:hover': { bgcolor: 'action.hover' }
      }}
    >
      <Box sx={{ minWidth: 190, display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
          {entry.name}
        </Typography>
      </Box>
      <Chip
        size="small"
        label={isDebuff ? 'debuff' : 'buff'}
        color={isDebuff ? 'error' : 'success'}
        variant="outlined"
        sx={{ height: 20 }}
      />
      {level && <LevelChip level={level} />}
      {entry.illusion && <Chip size="small" label="illusion" variant="outlined" sx={{ height: 20 }} />}
      {rank?.lastCastMs != null && (
        <Tooltip title={`You last cast ${rank.name} ${relativeTime(rank.lastCastMs)}`}>
          <Chip
            size="small"
            variant="outlined"
            color="primary"
            label={rank.suffixed ? rank.name : 'recently cast'}
            sx={{ height: 20 }}
          />
        </Tooltip>
      )}
      {entry.usageCount > 0 && <UsageChip entry={entry} />}
      <Box sx={{ flexGrow: 1 }} />
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
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
