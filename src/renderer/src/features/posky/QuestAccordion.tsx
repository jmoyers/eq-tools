// QuestAccordion — ONE Plane of Sky quest, as the Quests tab draws it (see PoskyView.tsx).
//
// Its own file because it is the bulk of that tab: a collapsed summary row that has to answer
// "how close am I, and is anything else competing for these drops?" at a glance, and an expanded
// panel that spells out every required item with who drops it and where. PoskyView owns the
// filtering, sorting and paging; everything below owns the drawing of a single quest.

import { type JSX } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  LinearProgress,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import StarIcon from '@mui/icons-material/Star'
import LinkIcon from '@mui/icons-material/Link'
import { skyQuestPage, wikiPageUrl } from '@shared/wiki'
import type { QuestProgress } from './useProgress'
import { ItemTooltip } from './ItemTooltip'
import { DropperCell, KillTargetCaption } from './DropperCell'
import { questKillTargets, type KillTarget } from './poskyDroppers'
import type { MobTarget } from '../mobs/mobTarget'
import { sharingQuestLabel, type SharedItem } from './sharedItems'
import { FavoriteStar } from '../favorites/FavoriteStar'
import { QuestIgnoreButton, QuestStarButton } from '../favorites/QuestFlagButtons'

// Wiki URLs are built in ONE place (src/shared/wiki.ts) — the verified root-path convention.
function wikiClassPage(className: string): string | undefined {
  return wikiPageUrl(skyQuestPage(className))
}

function ProgressBar({ q }: { q: QuestProgress }): JSX.Element {
  const pct = Math.round(q.ratio * 100)
  const color = q.completed ? 'success' : pct === 0 ? 'inherit' : pct >= 100 ? 'success' : 'primary'
  return (
    <Box sx={{ minWidth: 160 }}>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {q.completed ? 'Turned in' : `${q.haveCount}/${q.needCount} items`}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {pct}%
        </Typography>
      </Stack>
      <LinearProgress variant="determinate" value={Math.min(100, pct)} color={color} />
    </Box>
  )
}

// "Shared items with" (Task #44): a compact, dense section listing each of this
// quest's required items that ANOTHER Plane of Sky quest also needs — so before
// turning in you can see who else is contending for a drop. Currency (Wind Runes) is
// excluded upstream in the derivation.
function SharedItemsSection({
  shared,
  ambiguousNames,
  onSelectQuest
}: {
  shared: SharedItem[]
  ambiguousNames: Set<string>
  onSelectQuest: (name: string) => void
}): JSX.Element {
  return (
    <Box sx={{ mb: 1 }}>
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
        <LinkIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
        <Typography variant="caption" color="text.secondary">
          Shared items — other Sky quests contending for these drops
        </Typography>
      </Stack>
      <Stack spacing={0.5}>
        {shared.map((si) => (
          <Stack key={si.key} direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" sx={{ fontWeight: 600, minWidth: 150 }}>
              {si.name}
            </Typography>
            {si.quests.map((sq) => (
              <Chip
                key={sq.key}
                size="small"
                variant="outlined"
                color="info"
                label={sharingQuestLabel(sq, ambiguousNames)}
                onClick={() => onSelectQuest(sq.name)}
                sx={{ height: 20, fontSize: 11 }}
              />
            ))}
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}

// The collapsed header line: flags, class, name/reward/giver/kill target, the contested-items
// count, the ready/missing chip and the progress bar.
function QuestSummaryRow({
  q,
  killTargets,
  sharedCount,
  favorited,
  onToggleFavorite,
  onToggleIgnore
}: {
  q: QuestProgress
  killTargets: KillTarget[]
  sharedCount: number
  favorited: boolean
  onToggleFavorite: () => void
  onToggleIgnore: () => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={2} alignItems="center">
      {/* Star + ignore lead every row, always visible — the quest-level
          controls the user could not find when the only star lived on an
          item row inside the expanded panel. */}
      <Stack direction="row" alignItems="center" sx={{ minWidth: 48 }}>
        <QuestStarButton favorited={favorited} onToggle={onToggleFavorite} />
        <QuestIgnoreButton ignored={false} onToggle={onToggleIgnore} />
      </Stack>
      <Chip label={q.className} size="small" color="secondary" variant="outlined" sx={{ minWidth: 92 }} />
      <Box sx={{ minWidth: 220 }}>
        <Typography variant="subtitle2">{q.name}</Typography>
        {q.reward && (
          <ItemTooltip name={q.reward} stats={q.rewardStats}>
            <Typography variant="caption" color="primary.main" sx={{ cursor: 'help' }}>
              → {q.reward}
            </Typography>
          </ItemTooltip>
        )}
        {q.giver && (
          <Typography variant="caption" color="text.secondary" display="block">
            Turn in → {q.giver}
          </Typography>
        )}
        {/* Variable-height box already (reward and giver are each optional), so a third
            caption line costs the row nothing it wasn't already prepared to pay. */}
        <KillTargetCaption targets={killTargets} />
      </Box>
      <Box sx={{ flexGrow: 1 }} />
      {sharedCount > 0 && (
        <Tooltip
          title={`Shares ${sharedCount} item${sharedCount === 1 ? '' : 's'} with other Sky quests — expand for details`}
        >
          <Chip
            size="small"
            variant="outlined"
            color="info"
            icon={<LinkIcon />}
            label={sharedCount}
            sx={{ height: 20, fontSize: 11, '& .MuiChip-icon': { fontSize: 14 } }}
          />
        </Tooltip>
      )}
      {q.completed ? (
        <Chip size="small" color="success" variant="outlined" label="Turned in" />
      ) : (
        <Chip
          size="small"
          variant="outlined"
          color={q.missing.length === 0 ? 'success' : 'default'}
          label={q.missing.length === 0 ? 'Ready to turn in' : `${q.missing.length} of ${q.items.length} missing`}
        />
      )}
      <ProgressBar q={q} />
    </Stack>
  )
}

// The second summary line: every required item as a chip, favorites first, each one a
// click-to-favorite toggle that must NOT also expand the accordion (hence stopPropagation).
function QuestItemChips({
  q,
  isFavorite,
  toggleFavorite
}: {
  q: QuestProgress
  isFavorite: (name: string) => boolean
  toggleFavorite: (name: string) => void
}): JSX.Element {
  return (
    // Indent tracks the header's leading columns (buttons + class chip).
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ pl: '164px' }}>
      {[...q.items]
        .sort((a, b) => Number(isFavorite(b.name)) - Number(isFavorite(a.name)))
        .map((it) => {
          const done = it.have >= it.need || q.completed
          const fav = isFavorite(it.name)
          return (
            <ItemTooltip
              key={it.name}
              name={it.name}
              stats={it.stats}
              who={it.who}
              where={it.where}
              droppers={it.droppers}
            >
              <Chip
                size="small"
                variant={fav ? 'filled' : 'outlined'}
                color={fav ? 'warning' : done ? 'success' : 'default'}
                icon={
                  fav ? (
                    <StarIcon />
                  ) : done ? (
                    <CheckCircleIcon />
                  ) : (
                    <RadioButtonUncheckedIcon />
                  )
                }
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFavorite(it.name)
                }}
                label={it.need > 1 ? `${it.name} ${it.have}/${it.need}` : it.name}
                sx={{ opacity: done && !fav ? 0.65 : 1 }}
              />
            </ItemTooltip>
          )
        })}
    </Stack>
  )
}

// The expanded panel's top strip: rune / giver / wiki link, and the manual "turned in" checkbox.
function QuestDetailsToolbar({
  q,
  wikiHref,
  onSetComplete
}: {
  q: QuestProgress
  wikiHref?: string
  onSetComplete: (complete: boolean) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={2} sx={{ mb: 1 }} alignItems="center" flexWrap="wrap" useFlexGap>
      {q.rune && <Chip size="small" label={`Rune: ${q.rune}`} />}
      {q.giver && <Chip size="small" label={`Giver: ${q.giver}`} />}
      {wikiHref && (
        <Link href={wikiHref} target="_blank" rel="noreferrer" variant="caption">
          wiki: {q.className} Plane of Sky Tests
        </Link>
      )}
      <Box sx={{ flexGrow: 1 }} />
      <FormControlLabel
        control={<Checkbox checked={q.completed} onChange={(e) => onSetComplete(e.target.checked)} />}
        label="Turned in / complete"
      />
    </Stack>
  )
}

// The expanded panel's item table — the full "what, how many, who drops it, where" listing.
function QuestItemsTable({
  q,
  isFavorite,
  toggleFavorite,
  onOpenMob
}: {
  q: QuestProgress
  isFavorite: (name: string) => boolean
  toggleFavorite: (name: string) => void
  onOpenMob: (t: MobTarget) => void
}): JSX.Element {
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell padding="checkbox" />
          <TableCell>Item</TableCell>
          <TableCell>Have</TableCell>
          <TableCell>Dropped by</TableCell>
          <TableCell>Where</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {q.items.map((it) => {
          const done = it.have >= it.need
          return (
            <TableRow key={it.name}>
              <TableCell padding="checkbox">
                <FavoriteStar name={it.name} favorited={isFavorite(it.name)} onToggle={toggleFavorite} />
              </TableCell>
              <TableCell sx={{ color: done ? 'success.main' : 'text.primary' }}>
                <ItemTooltip
                  name={it.name}
                  stats={it.stats}
                  who={it.who}
                  where={it.where}
                  droppers={it.droppers}
                >
                  <span style={{ cursor: 'help' }}>{it.name}</span>
                </ItemTooltip>
              </TableCell>
              <TableCell>
                {it.have}/{it.need}
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>
                <DropperCell
                  droppers={it.droppers}
                  who={it.who}
                  where={it.where}
                  onOpenMob={onOpenMob}
                />
              </TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{it.where}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

export function QuestAccordion({
  q,
  shared,
  ambiguousNames,
  favorited,
  onToggleFavorite,
  onToggleIgnore,
  isFavorite,
  toggleFavorite,
  onSetComplete,
  onSelectQuest,
  onOpenMob
}: {
  q: QuestProgress
  shared: SharedItem[]
  ambiguousNames: Set<string>
  favorited: boolean
  onToggleFavorite: () => void
  onToggleIgnore: () => void
  isFavorite: (name: string) => boolean
  toggleFavorite: (name: string) => void
  onSetComplete: (complete: boolean) => void
  onSelectQuest: (name: string) => void
  /** a dropper name → the Mobs tab's page for that catalog row (App-level routing) */
  onOpenMob: (t: MobTarget) => void
}): JSX.Element {
  const wikiHref = wikiClassPage(q.className)
  // A turned-in quest has nothing left to kill for, whatever its item counts say.
  const killTargets = q.completed ? [] : questKillTargets(q.items)
  return (
    <Accordion disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack spacing={0.75} sx={{ width: '100%', pr: 2 }}>
          <QuestSummaryRow
            q={q}
            killTargets={killTargets}
            sharedCount={shared.length}
            favorited={favorited}
            onToggleFavorite={onToggleFavorite}
            onToggleIgnore={onToggleIgnore}
          />
          <QuestItemChips q={q} isFavorite={isFavorite} toggleFavorite={toggleFavorite} />
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <QuestDetailsToolbar q={q} wikiHref={wikiHref} onSetComplete={onSetComplete} />
        {q.rewardStats && (
          <Typography variant="caption" color="text.secondary" component="pre" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>
            {q.rewardStats}
          </Typography>
        )}
        {shared.length > 0 && (
          <SharedItemsSection shared={shared} ambiguousNames={ambiguousNames} onSelectQuest={onSelectQuest} />
        )}
        <QuestItemsTable
          q={q}
          isFavorite={isFavorite}
          toggleFavorite={toggleFavorite}
          onOpenMob={onOpenMob}
        />
      </AccordionDetails>
    </Accordion>
  )
}
